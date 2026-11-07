"""Viewer analytics — every view of a document or file, who it was and what they did.

One row per view session (``doc_views``), keyed by the engagement session's ``sid``: the same
page load that ``engage_sessions`` (services/engage.py) aggregates. The two are written by the same
``POST /api/v1/documents/{slug}/engage`` beacon, but they answer different questions and keep
different things for different times:

* ``engage_sessions`` — anonymous, aggregate-shaped numbers behind the analytics tabs (kept 395
  days; the owner's own reading is never in it).
* ``doc_views`` (here) — the per-view detail for the **Viewers** tab: who (a signed-in viewer's
  account id, or an anonymous per-browser id), where from and on what, and an ordered activity
  timeline. Kept :func:`detail_days` (default 180) and then gone; the aggregates stay.

Identity rules (owner decision 2026-11-07):

* A signed-in viewer is stored by account id only; their name and email are looked up when the
  owner reads the list, so an account that no longer exists shows as "Deleted account" and
  :func:`forget_user` scrubs the id outright.
* An anonymous viewer is ``anon``: an HMAC of the browser's random analytics id (or, without one,
  of the IP hash and browser) keyed by the document's owner, so it is stable for one owner's links
  and can't be matched across owners. Never a raw IP; location is city-level at most.
* The owner's own views are kept with ``own: true`` (the tab's "Hide my own views" switch, on by
  default); workspace members' are ``internal: true`` as everywhere else in analytics.
* Encrypted documents keep time, depth and page numbers only: heading ids, copies and links would
  leak their content.

Writes are idempotent per ``seq`` (an upsert filtered on ``seq < incoming``: a retry or a stale
beacon matches nothing and its insert hits the unique key). The timeline is capped at
:data:`TL_MAX` events, :data:`EV_PER_SEND` per beacon.
"""

from __future__ import annotations

import csv
import hashlib
import hmac
import io
import math
import re
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo.errors import DuplicateKeyError, OperationFailure

from app.config import get_settings
from app.services import analytics, geo, traffic
from app.services.engage import aware, merge_segs, union_len

settings = get_settings()

COLL = "doc_views"
TL_MAX = 400
EV_PER_SEND = 60
SEGS_MAX = 400
SEND_CAP_S = 120
SESSION_CAP_S = 4 * 3600
MAX_T = 24 * 3600
LIST_CAP = 5000
DEFAULT_DAYS = 180
# A server-side event (an Ask question, a sign-off) joins the viewer's latest view of the
# document when that view was active this recently.
NOTE_WINDOW = timedelta(hours=3)

# What a view can say it is, beyond engage's kinds: the renderer of a file.
VIEW_KINDS = ("doc", "page", "pdf", "video", "audio", "pptx", "sheet", "html", "image", "text",
              "docx", "bundle", "other")
APPS = ("tab", "pwa", "embed")
WHO = ("all", "signed_in", "anonymous")
COMPLETION = ("any", "low", "mid", "high", "done")
EVENT_KINDS = frozenset({"sec", "pg", "sl", "tab", "play", "pause", "seek", "end", "rate", "fs",
                         "depth", "link", "copy", "dl", "print", "find"})
# Counted per view, for the list's little activity marks.
ACT_KINDS = ("link", "copy", "dl", "print", "ask", "signoff", "fs")

_ANON_IN = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
_LANG = re.compile(r"^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8}){0,3}$")
_TZ = re.compile(r"^[A-Za-z][A-Za-z0-9_+\-/]{1,63}$")
_HOST = re.compile(r"^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$")
_FROM = re.compile(r"^/[A-Za-z0-9_\-\[\]/]{0,119}$")
_ID = re.compile(r"^[0-9a-f]{24}$")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def detail_days() -> int:
    """How long a view's detail is kept (``MARKDROP_VIEW_DETAIL_DAYS``, 7..3650, default 180)."""
    try:
        n = int(getattr(settings, "view_detail_days", DEFAULT_DAYS) or DEFAULT_DAYS)
    except (TypeError, ValueError):
        n = DEFAULT_DAYS
    return max(7, min(3650, n))


# ── Indexes ───────────────────────────────────────────────────────────────────


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    c = db[COLL]
    await c.create_index([("doc_id", 1), ("sid", 1)], unique=True)
    await c.create_index([("doc_id", 1), ("started_at", -1)])
    await c.create_index([("doc_id", 1), ("viewer_id", 1), ("started_at", -1)])
    await c.create_index([("doc_id", 1), ("anon", 1), ("started_at", -1)])
    await c.create_index([("viewer_id", 1), ("last_at", -1)])
    ttl = detail_days() * 24 * 3600
    try:
        await c.create_index("started_at", expireAfterSeconds=ttl, name="doc_views_ttl")
    except OperationFailure:
        # The retention was changed: move the existing TTL index to the new value.
        await db.command({"collMod": COLL, "index": {"name": "doc_views_ttl", "expireAfterSeconds": ttl}})


# ── Parsing the beacon's extras ──────────────────────────────────────────────


def _num(v, lo: float, hi: float) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    try:
        f = float(v)
    except OverflowError:
        return None
    if f != f or f in (math.inf, -math.inf):
        return None
    return max(lo, min(hi, f))


def _int(v, lo: int, hi: int) -> int | None:
    f = _num(v, lo, hi)
    return int(f) if f is not None else None


def _str(v, n: int) -> str | None:
    if not isinstance(v, str):
        return None
    v = v.strip()[:n]
    return v or None


def _host(v) -> str | None:
    v = _str(v, 260)
    if not v:
        return None
    v = v.lower()
    return v if _HOST.match(v) else None


def parse_sys(raw) -> dict:
    """The viewer's screen, language, timezone and app context (``first.sys``), validated."""
    if not isinstance(raw, dict):
        return {}
    out: dict = {}
    for f, hi in (("vw", 20000), ("vh", 20000), ("sw", 20000), ("sh", 20000)):
        n = _int(raw.get(f), 0, hi)
        if n:
            out[f] = n
    dpr = _num(raw.get("dpr"), 0.25, 8)
    if dpr:
        out["dpr"] = round(dpr, 2)
    lang = _str(raw.get("lang"), 35)
    if lang and _LANG.match(lang):
        out["lang"] = lang
    tz = _str(raw.get("tz"), 64)
    if tz and _TZ.match(tz):
        out["tz"] = tz
    if raw.get("app") in APPS:
        out["app"] = raw["app"]
    emb = _host(raw.get("emb"))
    if emb:
        out["emb"] = emb
    frm = _str(raw.get("from"), 120)
    if frm and _FROM.match(frm):
        out["from"] = frm
    if raw.get("touch") is True:
        out["touch"] = True
    pv = _str(raw.get("pv"), 20)
    if pv and re.match(r"^\d{1,3}(\.\d{1,4}){0,3}$", pv):
        out["pv"] = pv
    return out


def _link(v) -> str | None:
    """host+path of a clicked link (lib/engageCore linkKey's first half)."""
    v = _str(v, 300)
    if not v or "://" in v or v.startswith(("/", "javascript", "data:")):
        return None
    host = v.split("/", 1)[0]
    return v if _HOST.match(host) else None


def parse_events(raw, *, encrypted: bool) -> list[dict]:
    """The beacon's ``ev``: ordered timeline events, each ``{t, k, …}`` (t = seconds since the
    session began, on the viewer's clock). Unknown kinds and bad fields are dropped."""
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for e in raw[:EV_PER_SEND]:
        if not isinstance(e, dict):
            continue
        k = e.get("k")
        t = _num(e.get("t"), 0, MAX_T)
        if k not in EVENT_KINDS or t is None:
            continue
        ev: dict = {"t": round(t, 1), "k": k}
        a = _num(e.get("a"), 0, SESSION_CAP_S)
        if k == "sec":
            h = _str(e.get("h"), 120)
            if encrypted or not h:
                continue
            ev["h"] = h
        elif k == "pg" or k == "sl":
            n = _int(e.get("p" if k == "pg" else "n"), 1, 5000)
            if n is None:
                continue
            ev["n"] = n
            of = _int(e.get("of"), 1, 5000)
            if of:
                ev["of"] = of
        elif k == "tab":
            n = _int(e.get("n"), 0, 500)
            if n is None:
                continue
            ev["n"] = n
            name = _str(e.get("name"), 80)
            if name and not encrypted:
                ev["name"] = name
        elif k in ("play", "pause", "end"):
            s = _num(e.get("s"), 0, MAX_T)
            if s is None:
                continue
            ev["s"] = round(s, 1)
        elif k == "seek":
            s, f = _num(e.get("s"), 0, MAX_T), _num(e.get("f"), 0, MAX_T)
            if s is None:
                continue
            ev["s"] = round(s, 1)
            if f is not None:
                ev["f"] = round(f, 1)
        elif k == "rate":
            r = _num(e.get("r"), 0.0625, 16)
            if r is None:
                continue
            ev["r"] = round(r, 2)
        elif k == "fs":
            ev["on"] = e.get("on") is True
        elif k == "depth":
            v = _int(e.get("v"), 0, 100)
            if v not in (25, 50, 75, 100):
                continue
            ev["v"] = v
        elif k == "link":
            if encrypted:
                continue
            u = _link(e.get("u"))
            if not u:
                continue
            ev["u"] = u
            h = _str(e.get("h"), 120)
            if h:
                ev["h"] = h
        elif k == "copy":
            if encrypted:
                continue
            h = _str(e.get("h"), 120)
            if h:
                ev["h"] = h
        elif k == "dl":
            f = _str(e.get("f"), 12)
            if f and re.match(r"^[a-z0-9]+$", f):
                ev["f"] = f
        if k in ("sec", "pg", "sl", "tab"):
            if not a:
                continue
            ev["a"] = round(a, 1)
        out.append(ev)
    return out


# ── Who, where, what with ─────────────────────────────────────────────────────


def anon_id(owner_id: str | None, browser_id: str | None, ip_hash: str | None, ua: str) -> str:
    """The anonymous viewer key: keyed by the owner, so it can't be matched across owners."""
    if browser_id and _ANON_IN.match(browser_id):
        basis = "b:" + browser_id
    else:
        basis = "i:" + (ip_hash or "") + "|" + (ua or "")[:200]
    mac = hmac.new(settings.ip_hash_salt.encode(), f"view:{owner_id or ''}:{basis}".encode(), hashlib.sha256)
    return mac.hexdigest()[:20]


_INAPP = (
    ("Slack", r"Slack[/_]"), ("WhatsApp", r"WhatsApp"), ("LinkedIn", r"LinkedInApp"),
    ("Instagram", r"Instagram"), ("Facebook", r"FBAN|FBAV|FB_IAB"), ("Microsoft Teams", r"Teams/"),
    ("Telegram", r"Telegram"), ("WeChat", r"MicroMessenger"), ("LINE", r"\bLine/"),
    ("Discord", r"Discord/"), ("Snapchat", r"Snapchat"), ("X", r"Twitter"), ("Google app", r"\bGSA/"),
    ("Outlook", r"\bOutlook-"), ("Notion", r"\bNotion/"),
)


def _ver(m: re.Match | None, parts: int = 1) -> str | None:
    if not m:
        return None
    v = m.group(1).replace("_", ".").split(".")
    return ".".join(v[:parts])


def ua_detail(ua: str, sysinfo: dict | None = None) -> dict:
    """Device, OS + version, browser + version and the in-app browser (Slack, WhatsApp, …).

    The User-Agent's frozen parts stay unsaid rather than wrong: macOS is reported without a
    version (every browser says 10.15.7) unless the browser told its real one (``sys.pv``,
    User-Agent Client Hints), and Windows 10 and 11 look the same without it. An iPad that asks
    for desktop pages says "Macintosh"; a touch screen gives it away (``sys.touch``)."""
    ua = ua or ""
    sysinfo = sysinfo or {}
    base = traffic.parse_ua(ua)
    device, os_name, browser = base["device"], base["os"], base["browser"]
    pv = sysinfo.get("pv")
    os_ver: str | None = None
    if os_name == "macOS" and sysinfo.get("touch"):
        device, os_name = "Tablet", "iPadOS"
    if os_name == "iOS":
        os_ver = _ver(re.search(r"OS (\d+(?:_\d+)?)", ua), 2)
        if "iPad" in ua:
            os_name = "iPadOS"
    elif os_name == "Android":
        os_ver = _ver(re.search(r"Android (\d+(?:\.\d+)?)", ua), 1)
    elif os_name == "Windows":
        nt = re.search(r"Windows NT (\d+\.\d+)", ua)
        if nt and nt.group(1) == "10.0":
            os_ver = ("11" if int(pv.split(".")[0]) >= 13 else "10") if pv else "10/11"
        elif nt:
            os_ver = {"6.3": "8.1", "6.2": "8", "6.1": "7"}.get(nt.group(1))
    elif os_name == "macOS":
        if pv:
            os_ver = ".".join(pv.split(".")[:2]).removesuffix(".0")
        else:
            m = re.search(r"Mac OS X (\d+)[_.](\d+)", ua)
            if m and not (m.group(1) == "10" and m.group(2) == "15"):
                os_ver = f"{m.group(1)}.{m.group(2)}"
    elif os_name == "ChromeOS" and pv:
        os_ver = pv.split(".")[0]
    browser_ver = None
    for name, rx in (("Edge", r"Edg(?:A|iOS)?/(\d+)"), ("Opera", r"OPR/(\d+)"),
                     ("Samsung Internet", r"SamsungBrowser/(\d+)"), ("Firefox", r"(?:Firefox|FxiOS)/(\d+)"),
                     ("Chrome", r"(?:CriOS|Chrome)/(\d+)"), ("Safari", r"Version/(\d+(?:\.\d+)?)")):
        if browser == name:
            browser_ver = _ver(re.search(rx, ua), 2 if name == "Safari" else 1)
            break
    inapp = None
    for name, rx in _INAPP:
        if re.search(rx, ua):
            inapp = name
            break
    if inapp and browser in ("Instagram", "Facebook", "LinkedIn", "X (in-app)"):
        browser = inapp
    return {"device": device, "os": os_name, "os_ver": os_ver, "browser": browser,
            "browser_ver": browser_ver, "inapp": inapp}


def where(ip: str | None, headers=None) -> dict:
    """Country / region / city from the IP at ingest (MaxMind), else Cloudflare's visitor-location
    headers when the request came through it. The IP itself is never kept."""
    loc = geo.lookup(ip)
    if not loc.get("country") and headers is not None:
        cc = (headers.get("cf-ipcountry") or "").strip().upper()
        if re.match(r"^[A-Z]{2}$", cc) and cc not in ("XX", "T1"):
            loc = {"country": cc, "region": _str(headers.get("cf-region"), 80),
                   "city": _str(headers.get("cf-ipcity"), 80)}
    return {"country": loc.get("country"), "region": loc.get("region"), "city": loc.get("city")}


# Referrer host → the name people know it by.
_SOURCES = (
    ("slack.com", "Slack"), ("linkedin.com", "LinkedIn"), ("lnkd.in", "LinkedIn"),
    ("mail.google.com", "Gmail"), ("outlook.", "Outlook"), ("teams.microsoft.com", "Microsoft Teams"),
    ("teams.live.com", "Microsoft Teams"), ("google.", "Google"), ("bing.com", "Bing"),
    ("duckduckgo.com", "DuckDuckGo"), ("t.co", "X"), ("x.com", "X"), ("twitter.com", "X"),
    ("facebook.com", "Facebook"), ("fb.com", "Facebook"), ("instagram.com", "Instagram"),
    ("whatsapp.com", "WhatsApp"), ("wa.me", "WhatsApp"), ("t.me", "Telegram"),
    ("telegram.org", "Telegram"), ("discord.com", "Discord"), ("reddit.com", "Reddit"),
    ("news.ycombinator.com", "Hacker News"), ("github.com", "GitHub"), ("notion.so", "Notion"),
    ("chatgpt.com", "ChatGPT"), ("chat.openai.com", "ChatGPT"), ("claude.ai", "Claude"),
    ("perplexity.ai", "Perplexity"), ("youtube.com", "YouTube"), ("medium.com", "Medium"),
)

# An in-app route shape (lib/analyticsPath) → where on Markdrop the viewer came from.
_FROM_WORDS = (
    ("/w/", "Markdrop workspace"), ("/f/", "Markdrop folder link"), ("/dashboard", "Markdrop dashboard"),
    ("/shared", "Markdrop shared with me"), ("/recent", "Markdrop recents"), ("/guides", "Markdrop Guides"),
    ("/[slug]", "Another Markdrop link"), ("/h/", "Markdrop workspace"), ("/", "Markdrop"),
)


def source_for(ref: str | None, utm_source: str | None, inapp: str | None, sysinfo: dict) -> str:
    """One word for where a view came from: Slack, LinkedIn, Google, Email, Direct, a Markdrop
    page, a site that embeds it, …"""
    src = (utm_source or "").lower()
    if src == "markdrop-guides":
        return "Markdrop Guide"
    if sysinfo.get("app") == "embed" and sysinfo.get("emb"):
        return f"Embedded on {sysinfo['emb']}"
    host = (urlsplit(ref).hostname or "").lower() if ref else ""
    if host:
        for pat, name in _SOURCES:
            if (pat.endswith(".") and (host.startswith(pat) or f".{pat}" in f".{host}")) \
                    or host == pat or host.endswith("." + pat):
                return name
        return host.removeprefix("www.")
    if src in ("email", "newsletter", "resend") or (src and "mail" in src):
        return "Email"
    if src:
        return utm_source[:40]
    if inapp:
        return inapp
    frm = sysinfo.get("from")
    if frm:
        for prefix, word in _FROM_WORDS:
            if frm == prefix or (prefix != "/" and frm.startswith(prefix)):
                return word
    return "Direct"


# ── Ingest ────────────────────────────────────────────────────────────────────


def view_kind(raw_doc: dict) -> str:
    if raw_doc.get("kind") != "artifact":
        page = raw_doc.get("editor") == "blocks" or bool(raw_doc.get("page"))
        return "page" if page and not raw_doc.get("encrypted") else "doc"
    from app.services import artifact

    r = artifact.renderer_for(raw_doc.get("mime") or "")
    return r if r in VIEW_KINDS else "other"


async def record(db: AsyncIOMotorDatabase, raw_doc: dict, msg: dict, *, ip: str | None, ua: str,
                 headers=None, viewer_id: str | None, internal: bool, own: bool) -> str:
    """Fold one engagement beacon into its view row. Returns stored | dup."""
    doc_id = str(raw_doc["_id"])
    encrypted = bool(raw_doc.get("encrypted"))
    now = _now()
    d = msg.get("d") or {}
    first = msg.get("first") or {}
    sysinfo = parse_sys(first.get("sys")) if isinstance(first, dict) else {}

    sets: dict = {"seq": msg["seq"], "last_at": now}
    inc: dict = {}
    mx: dict = {}
    push: dict = {}
    a = _num(d.get("active_s"), 0, SEND_CAP_S)
    if a:
        inc["active_s"] = round(a, 1)
    depth = _int(d.get("depth"), 0, 100)
    if depth:
        mx["depth"] = depth
    for f, src in (("npages", "npages"), ("pmax", "pmax"), ("nsl", "nsl"), ("smax", "smax"), ("ntab", "ntab")):
        n = _int(d.get(src), 1, 5000)
        if n:
            mx[f] = n
    if isinstance(d.get("tabs"), list):
        tabs = [n for n in (_int(x, 0, 500) for x in d["tabs"][:50]) if n is not None]
        if tabs:
            push["tabs_seen"] = {"$each": tabs}
    media = d.get("media") if isinstance(d.get("media"), dict) else None
    if media:
        dur = _num(media.get("dur"), 0, MAX_T)
        if dur:
            mx["dur"] = round(dur, 2)
        segs = []
        for seg in (media.get("segs") or [])[:50] if isinstance(media.get("segs"), list) else []:
            if isinstance(seg, (list, tuple)) and len(seg) == 2:
                s, e = _num(seg[0], 0, MAX_T), _num(seg[1], 0, MAX_T)
                if s is not None and e is not None and e > s:
                    segs.append([round(s, 2), round(e, 2)])
        if segs:
            push["segs"] = {"$each": segs, "$slice": SEGS_MAX}
        for f in ("plays", "ended"):
            n = _int(media.get(f), 0, 100)
            if n:
                inc["m_" + f] = n
    pos = msg.get("pos") or {}
    if isinstance(pos, dict) and "s" in pos:
        sets["mpos"] = pos["s"]
    events = parse_events(msg.get("ev"), encrypted=encrypted)
    if events:
        push["tl"] = {"$each": events, "$slice": TL_MAX}
        inc["n_ev"] = len(events)
        for ev in events:
            if ev["k"] in ACT_KINDS:
                inc["acts." + ev["k"]] = inc.get("acts." + ev["k"], 0) + 1
    if msg.get("final"):
        sets["ended"] = True
    if viewer_id:
        sets["viewer_id"] = viewer_id
    if internal:
        sets["internal"] = True

    ip_hash = analytics._hash_ip(ip)
    on_insert: dict = {
        "doc_id": doc_id, "sid": msg["sid"], "owner_id": raw_doc.get("owner_id"),
        "kind": view_kind(raw_doc), "started_at": now, "own": bool(own),
        "anon": anon_id(raw_doc.get("owner_id"), msg.get("a"), ip_hash, ua),
    }
    if raw_doc.get("kind") == "artifact":
        current = int(raw_doc.get("file_version") or 1)
        on_insert["ver"] = msg["ver"] if msg.get("ver") and msg["ver"] <= current else current
    if not viewer_id:
        on_insert["viewer_id"] = None
    if not internal:
        on_insert["internal"] = False
    if msg["seq"] == 1 or first:
        # First touch: where from and on what (also on a first beacon that arrives late).
        system = ua_detail(ua, sysinfo)
        ref = analytics.clean_referrer(_str(first.get("ref"), 2048)) if isinstance(first, dict) else None
        utm = first.get("utm") if isinstance(first.get("utm"), dict) else {}
        usrc = _str(utm.get("source"), 100)
        umed = _str(utm.get("medium"), 100)
        ref_host = urlsplit(ref).hostname if ref else None
        on_insert.update({
            **where(ip, headers), **system,
            "sys": sysinfo, "ref": ref, "utm_source": usrc.lower() if usrc else None,
            "utm_medium": umed.lower() if umed else None, "utm_campaign": _str(utm.get("campaign"), 100),
            "channel": traffic.channel_for(ref_host, usrc, umed),
            "source": source_for(ref, usrc, system.get("inapp"), sysinfo),
        })
    else:
        system = ua_detail(ua, {})
        on_insert.update({**where(ip, headers), **system, "sys": {}, "ref": None, "utm_source": None,
                          "utm_medium": None, "utm_campaign": None, "channel": "Direct",
                          "source": source_for(None, None, system.get("inapp"), {})})
    if sysinfo.get("pv") and msg["seq"] > 1:
        sets["sys.pv"] = sysinfo["pv"]
    for k in list(on_insert):
        if k in sets or any(s.startswith(k + ".") for s in sets):
            on_insert.pop(k)

    update: dict = {"$set": sets, "$setOnInsert": on_insert}
    if inc:
        update["$inc"] = inc
    if mx:
        update["$max"] = mx
    if push:
        update["$push"] = push
    try:
        await db[COLL].update_one({"doc_id": doc_id, "sid": msg["sid"], "seq": {"$lt": msg["seq"]}},
                                  update, upsert=True)
    except DuplicateKeyError:
        return "dup"
    return "stored"


async def note(db: AsyncIOMotorDatabase, doc_id: str, user_id: str | None, event: dict) -> bool:
    """Add a server-side event (an Ask question, a sign-off) to this person's latest view of the
    document, when that view was active within :data:`NOTE_WINDOW`."""
    if not user_id:
        return False
    now = _now()
    row = await db[COLL].find_one({"doc_id": doc_id, "viewer_id": user_id, "last_at": {"$gte": now - NOTE_WINDOW}},
                                  {"started_at": 1}, sort=[("last_at", -1)])
    if not row:
        return False
    started = aware(row.get("started_at")) or now
    ev = {"t": round(max(0.0, min(MAX_T, (now - started).total_seconds())), 1), **event}
    await db[COLL].update_one({"_id": row["_id"]}, {
        "$push": {"tl": {"$each": [ev], "$slice": TL_MAX}},
        "$inc": {"n_ev": 1, "acts." + event["k"]: 1}, "$set": {"last_at": now}})
    return True


async def note_for_slug(db: AsyncIOMotorDatabase, slug: str | None, user_id: str | None, event: dict) -> None:
    """:func:`note` by the document's address; never raises (it rides along other requests)."""
    if not slug or not user_id:
        return
    try:
        raw = await db["documents"].find_one({"slug": slug}, {"_id": 1})
        if raw:
            await note(db, str(raw["_id"]), user_id, event)
    except Exception:  # pragma: no cover - analytics never breaks the request it rides on
        import logging

        logging.getLogger(__name__).warning("view note failed", exc_info=True)


async def forget_document(db: AsyncIOMotorDatabase, doc_id: str) -> None:
    await db[COLL].delete_many({"doc_id": doc_id})


async def forget_user(db: AsyncIOMotorDatabase, user_id: str) -> int:
    """Take a person's account off every view they made (their views stay, as anonymous ones)."""
    res = await db[COLL].update_many({"viewer_id": user_id}, {"$set": {"viewer_id": None, "forgot": True}})
    return res.modified_count


# ── Who may see viewers ───────────────────────────────────────────────────────


async def access_level(db: AsyncIOMotorDatabase, actor, raw: dict | None) -> str | None:
    """What this person may see of an item's viewers (owner decision 2026-11-07):

    * ``"full"`` — identities and timelines: the item's owner; for an item filed in a workspace,
      also the workspace's owner and admins and anyone who can edit it (members, editor grants).
    * ``"counts"`` — totals only: someone who can only view a workspace item (a viewer-role
      member, a viewer grant).
    * ``None`` — nothing (anyone else, and every non-owner of an item outside a workspace).

    The edit secret isn't a person and gives nothing here."""
    from app.services import access

    if raw is None or not actor.user_id:
        return None
    f = await access.facts(actor, raw, access.Ctx(db))
    if f.is_owner:
        return "full"
    if not f.ws_id:
        return None
    if f.ws_role in ("owner", "admin") or f.role in ("editor", "owner"):
        return "full"
    if f.role == "viewer":
        return "counts"
    return None


# ── Reading: one view's numbers ───────────────────────────────────────────────


def completion(row: dict) -> float | None:
    """How much of the item this view got through, 0..100, or None when there's no measure."""
    kind = row.get("kind")
    if kind in ("doc", "page"):
        return float(row.get("depth") or 0)
    if kind == "pdf":
        n = row.get("npages")
        return round(100.0 * min(1.0, (row.get("pmax") or 0) / n), 1) if n else None
    if kind == "pptx":
        n = row.get("nsl")
        return round(100.0 * min(1.0, (row.get("smax") or 0) / n), 1) if n else None
    if kind == "sheet":
        n = row.get("ntab")
        seen = len(set(row.get("tabs_seen") or [])) or (1 if n else 0)
        return round(100.0 * min(1.0, seen / n), 1) if n else None
    if kind in ("video", "audio"):
        dur = row.get("dur")
        if not dur:
            return None
        return round(100.0 * min(1.0, union_len(row.get("segs") or []) / dur), 1)
    return None


def _bucket(c: float | None) -> str | None:
    if c is None:
        return None
    if c >= 90:
        return "done"
    if c >= 75:
        return "high"
    if c >= 25:
        return "mid"
    return "low"


def _key(row: dict) -> str:
    return f"u:{row['viewer_id']}" if row.get("viewer_id") else f"a:{row.get('anon') or ''}"


def anon_label(anon: str | None) -> str:
    return "Visitor " + (anon or "????")[:4].upper()


def system_line(row: dict) -> str:
    """"Chrome 131 on macOS 15" (the browser in an app: "Slack app on iOS 18")."""
    b = row.get("browser") or "Unknown browser"
    if row.get("inapp"):
        b = f"{row['inapp']} app"
    elif row.get("browser_ver"):
        b = f"{b} {row['browser_ver']}"
    o = row.get("os") or "Other"
    if row.get("os_ver"):
        o = f"{o} {row['os_ver']}"
    return f"{b} on {o}"


def place_line(row: dict) -> str | None:
    parts = [p for p in (row.get("city"), row.get("region")) if p]
    if row.get("country"):
        parts.append(_country_name(row["country"]))
    seen: list[str] = []
    for p in parts:
        if p not in seen:
            seen.append(p)
    return ", ".join(seen) or None


def _country_name(cc: str) -> str:
    try:
        import pycountry  # type: ignore

        c = pycountry.countries.get(alpha_2=cc)
        return getattr(c, "common_name", None) or c.name if c else cc
    except Exception:
        return _COUNTRIES.get(cc, cc)


_COUNTRIES = {
    "US": "United States", "GB": "United Kingdom", "IN": "India", "DE": "Germany", "FR": "France",
    "CA": "Canada", "AU": "Australia", "NL": "Netherlands", "ES": "Spain", "IT": "Italy", "BR": "Brazil",
    "JP": "Japan", "SG": "Singapore", "AE": "United Arab Emirates", "IE": "Ireland", "SE": "Sweden",
    "CH": "Switzerland", "PL": "Poland", "PT": "Portugal", "MX": "Mexico", "ID": "Indonesia",
    "PH": "Philippines", "PK": "Pakistan", "BD": "Bangladesh", "NG": "Nigeria", "ZA": "South Africa",
    "KR": "South Korea", "CN": "China", "HK": "Hong Kong", "IL": "Israel", "TR": "Türkiye",
    "RU": "Russia", "UA": "Ukraine", "NZ": "New Zealand", "AR": "Argentina", "BE": "Belgium",
    "AT": "Austria", "DK": "Denmark", "NO": "Norway", "FI": "Finland", "CZ": "Czechia",
}


async def _people(db: AsyncIOMotorDatabase, ids: list[str]) -> dict[str, dict]:
    oids = [ObjectId(i) for i in {i for i in ids if i and ObjectId.is_valid(i)}]
    if not oids:
        return {}
    rows = await db["users"].find({"_id": {"$in": oids}}, {"name": 1, "email": 1, "avatar_url": 1}) \
        .to_list(length=len(oids))
    return {str(r["_id"]): r for r in rows}


def _viewer(row: dict, people: dict[str, dict]) -> dict:
    vid = row.get("viewer_id")
    if vid:
        u = people.get(vid)
        if not u:
            return {"type": "user", "id": vid, "name": "Deleted account", "email": None, "deleted": True}
        return {"type": "user", "id": vid, "name": (u.get("name") or "").strip() or None,
                "email": u.get("email"), "avatar": u.get("avatar_url")}
    return {"type": "anonymous", "id": row.get("anon"), "name": anon_label(row.get("anon")), "email": None}


def _iso(dt) -> str | None:
    dt = aware(dt)
    return dt.isoformat() if dt else None


def summary(row: dict, people: dict[str, dict], visit_n: int | None = None) -> dict:
    """One view, as the Viewers list (and the MCP tool, and the CSV) shows it."""
    c = completion(row)
    sysinfo = row.get("sys") or {}
    active = min(SESSION_CAP_S, float(row.get("active_s") or 0))
    started = aware(row.get("started_at"))
    last = aware(row.get("last_at")) or started
    out = {
        "id": str(row["_id"]),
        "viewer": _viewer(row, people),
        "own": bool(row.get("own")),
        "internal": bool(row.get("internal")),
        "kind": row.get("kind"),
        "ver": row.get("ver"),
        "started_at": _iso(started),
        "last_at": _iso(last),
        "open_s": round((last - started).total_seconds(), 1) if started and last else 0,
        "active_s": round(active, 1),
        "completion": c,
        "ended": bool(row.get("ended")),
        "visit_n": visit_n,
        "location": {"country": row.get("country"), "region": row.get("region"), "city": row.get("city"),
                     "timezone": sysinfo.get("tz"), "label": place_line(row)},
        "system": {"device": row.get("device"), "os": row.get("os"), "os_version": row.get("os_ver"),
                   "browser": row.get("browser"), "browser_version": row.get("browser_ver"),
                   "in_app": row.get("inapp"), "app": sysinfo.get("app") or "tab",
                   "embed_host": sysinfo.get("emb"), "viewport": _wxh(sysinfo.get("vw"), sysinfo.get("vh")),
                   "screen": _wxh(sysinfo.get("sw"), sysinfo.get("sh")), "language": sysinfo.get("lang"),
                   "label": system_line(row)},
        "source": row.get("source") or "Direct",
        "channel": row.get("channel") or "Direct",
        "referrer": row.get("ref"),
        "utm": {k: row.get(f"utm_{k}") for k in ("source", "medium", "campaign") if row.get(f"utm_{k}")} or None,
        "acts": {k: int((row.get("acts") or {}).get(k) or 0) for k in ACT_KINDS if (row.get("acts") or {}).get(k)},
    }
    if row.get("kind") in ("video", "audio") and row.get("dur"):
        out["watched_s"] = round(union_len(row.get("segs") or []), 1)
        out["duration_s"] = row.get("dur")
    return out


def _wxh(w, h) -> str | None:
    return f"{w}×{h}" if w and h else None


# ── Reading: lists ────────────────────────────────────────────────────────────


def base_match(doc_id: str, start, end, *, who: str = "all", own: bool = False, internal: bool = True,
               filters: dict | None = None) -> dict:
    m: dict = {"doc_id": doc_id}
    ts: dict = {}
    if start is not None:
        ts["$gte"] = start
    if end is not None:
        ts["$lt"] = end
    if ts:
        m["started_at"] = ts
    if who == "signed_in":
        m["viewer_id"] = {"$ne": None}
    elif who == "anonymous":
        m["viewer_id"] = None
    if not own:
        m["own"] = {"$ne": True}
    if not internal:
        m["internal"] = {"$ne": True}
    for f, field in (("country", "country"), ("device", "device"), ("os", "os"), ("browser", "browser"),
                     ("source", "source")):
        v = (filters or {}).get(f)
        if v:
            if f == "device" and v in ("Phone", "Mobile"):
                m["device"] = "Mobile"
            elif f == "browser":
                m["$or"] = [{"browser": v}, {"inapp": v}]
            else:
                m[field] = v
    return m


async def _load(db: AsyncIOMotorDatabase, match: dict, cap: int = LIST_CAP) -> tuple[list[dict], bool]:
    rows = await db[COLL].find(match, {"tl": 0}).sort("started_at", -1).limit(cap + 1).to_list(length=cap + 1)
    return rows[:cap], len(rows) > cap


async def _visit_numbers(db: AsyncIOMotorDatabase, doc_id: str, rows: list[dict], own: bool) -> dict[str, int]:
    """Each row's place among its viewer's views of this document (1 = first visit)."""
    users = list({r["viewer_id"] for r in rows if r.get("viewer_id")})
    anons = list({r["anon"] for r in rows if not r.get("viewer_id") and r.get("anon")})
    if not rows:
        return {}
    ors = []
    if users:
        ors.append({"viewer_id": {"$in": users}})
    if anons:
        ors.append({"viewer_id": None, "anon": {"$in": anons}})
    if not ors:
        return {}
    q: dict = {"doc_id": doc_id, "$or": ors}
    if not own:
        q["own"] = {"$ne": True}
    allrows = await db[COLL].find(q, {"viewer_id": 1, "anon": 1, "started_at": 1}).sort("started_at", 1) \
        .limit(LIST_CAP * 4).to_list(length=LIST_CAP * 4)
    count: dict[str, int] = defaultdict(int)
    out: dict[str, int] = {}
    for r in allrows:
        k = _key(r)
        count[k] += 1
        out[str(r["_id"])] = count[k]
    return out


def _top(counter: Counter, n: int = 8) -> list[dict]:
    return [{"key": k, "views": v} for k, v in counter.most_common(n)]


def breakdowns(rows: list[dict]) -> dict:
    """Views by country, city, device, OS, browser and source, for the filtered period."""
    country, city, device, os_c, browser, source, app = (Counter() for _ in range(7))
    for r in rows:
        country[r.get("country") or "Unknown"] += 1
        if r.get("city"):
            city[", ".join(p for p in (r["city"], r.get("country")) if p)] += 1
        device[r.get("device") or "Unknown"] += 1
        os_c[r.get("os") or "Other"] += 1
        browser[r.get("inapp") or r.get("browser") or "Other"] += 1
        source[r.get("source") or "Direct"] += 1
        app[(r.get("sys") or {}).get("app") or "tab"] += 1
    return {"country": _top(country, 12), "city": _top(city, 12), "device": _top(device),
            "os": _top(os_c), "browser": _top(browser), "source": _top(source, 10), "app": _top(app, 3)}


async def listing(db: AsyncIOMotorDatabase, raw: dict, start, end, *, who: str = "all", completion_f: str = "any",
                  own: bool = False, internal: bool = True, filters: dict | None = None,
                  offset: int = 0, limit: int = 50) -> dict:
    doc_id = str(raw["_id"])
    rows, sampled = await _load(db, base_match(doc_id, start, end, who=who, own=own, internal=internal,
                                               filters=filters))
    if completion_f and completion_f != "any":
        rows = [r for r in rows if _bucket(completion(r)) == completion_f
                or (completion_f == "high" and _bucket(completion(r)) == "done")]
    total = len(rows)
    page = rows[offset: offset + limit]
    visits = await _visit_numbers(db, doc_id, page, own)
    people = await _people(db, [r.get("viewer_id") for r in page])
    views = [summary(r, people, visits.get(str(r["_id"]))) for r in page]
    signed = sum(1 for r in rows if r.get("viewer_id"))
    keys = {_key(r) for r in rows}
    actives = [min(SESSION_CAP_S, float(r.get("active_s") or 0)) for r in rows]
    comps = [c for c in (completion(r) for r in rows) if c is not None]
    own_n = 0
    if not own:
        own_n = await db[COLL].count_documents({**base_match(doc_id, start, end), "own": True})
    return {
        "views": views,
        "total": total,
        "offset": offset,
        "next": offset + limit if offset + limit < total else None,
        "sampled": sampled,
        "totals": {"views": total, "people": len(keys), "signed_in": signed, "anonymous": total - signed,
                   "avg_active_s": round(sum(actives) / len(actives), 1) if actives else 0,
                   "avg_completion": round(sum(comps) / len(comps), 1) if comps else None,
                   "own_hidden": own_n},
        "breakdowns": breakdowns(rows),
        "retention_days": detail_days(),
    }


async def people_rollup(db: AsyncIOMotorDatabase, raw: dict, start, end, *, who: str = "all", own: bool = False,
                        internal: bool = True, filters: dict | None = None, limit: int = 200) -> dict:
    """All views by a person (or one anonymous visitor): how many, total time, best completion."""
    rows, sampled = await _load(db, base_match(str(raw["_id"]), start, end, who=who, own=own, internal=internal,
                                               filters=filters))
    groups: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        groups[_key(r)].append(r)
    people = await _people(db, [g[0].get("viewer_id") for g in groups.values()])
    out = []
    for key, g in groups.items():
        comps = [c for c in (completion(r) for r in g) if c is not None]
        last = max(g, key=lambda r: aware(r.get("started_at")) or datetime.min.replace(tzinfo=timezone.utc))
        out.append({
            "key": key, "viewer": _viewer(g[0], people), "views": len(g),
            "active_s": round(min(SESSION_CAP_S * len(g), sum(float(r.get("active_s") or 0) for r in g)), 1),
            "best_completion": max(comps) if comps else None,
            "first_at": _iso(min(aware(r.get("started_at")) for r in g)),
            "last_at": _iso(aware(last.get("started_at"))),
            "last_view": str(last["_id"]), "place": place_line(last), "system": system_line(last),
            "internal": any(r.get("internal") for r in g), "own": any(r.get("own") for r in g),
        })
    out.sort(key=lambda p: p["last_at"] or "", reverse=True)
    return {"people": out[:limit], "total": len(out), "sampled": sampled}


# ── Reading: one view's timeline ──────────────────────────────────────────────


def clock(s: float | None) -> str:
    s = int(round(s or 0))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m}:{sec:02d}"


def span(s: float | None) -> str:
    s = int(round(s or 0))
    if s < 60:
        return f"{s}s"
    m, sec = divmod(s, 60)
    if m < 60:
        return f"{m}m {sec}s" if sec else f"{m}m"
    h, m = divmod(m, 60)
    return f"{h}h {m}m" if m else f"{h}h"


def _section_title(h: str | None, titles: dict[str, str]) -> str:
    from app.services import md_outline

    if not h:
        return "the top"
    return titles.get(h) or md_outline.pretty_heading_id(h)


def assemble(row: dict, titles: dict[str, str], order: list[str]) -> list[dict]:
    """The view's events as readable steps: "Read Intro · 1m 20s", "Jumped to Pricing",
    "Watched 0:00–3:10", "Downloaded the file", "Asked: …". ``order`` is the heading ids in
    document order (a jump is a section that isn't next to the one before)."""
    started = aware(row.get("started_at")) or _now()
    tl = sorted(row.get("tl") or [], key=lambda e: e.get("t") or 0)
    items: list[dict] = []

    def add(t: float, kind: str, text: str, **extra) -> None:
        items.append({"t": round(t, 1), "at": _iso(started + timedelta(seconds=t)), "kind": kind,
                      "text": text, **extra})

    src = row.get("source")
    add(0, "open", "Opened" + (f" from {src}" if src and src != "Direct" else ""))
    pos = {h: i for i, h in enumerate(order)}
    prev_unit: tuple[str, int] | None = None
    playing_from: float | None = None
    play_t = 0.0
    last_unit_item: dict | None = None
    for e in tl:
        k, t = e.get("k"), float(e.get("t") or 0)
        if k in ("sec", "pg", "sl", "tab"):
            if k == "sec":
                label = _section_title(e.get("h"), titles)
                idx = pos.get(e.get("h") or "", -1)
            elif k == "pg":
                label, idx = f"page {e['n']}", e["n"]
            elif k == "sl":
                label, idx = f"slide {e['n']}", e["n"]
            else:
                label, idx = (f"sheet “{e['name']}”" if e.get("name") else f"sheet {e['n'] + 1}"), e["n"]
            unit = (k, idx)
            if last_unit_item is not None and prev_unit == unit and last_unit_item is items[-1]:
                last_unit_item["active_s"] = round(last_unit_item["active_s"] + float(e.get("a") or 0), 1)
                last_unit_item["text"] = f"{last_unit_item['verb']} {last_unit_item['label']} · " \
                                         f"{span(last_unit_item['active_s'])}"
                continue
            jump = prev_unit is not None and prev_unit[0] == k and idx >= 0 and prev_unit[1] >= 0 \
                and abs(idx - prev_unit[1]) > 1
            back = jump and idx < prev_unit[1]
            verb = ("Went back to" if back else "Jumped to") if jump else ("Read" if k in ("sec", "pg") else "Viewed")
            label_cap = label if verb != "Read" or k != "sec" else label
            add(t, {"sec": "section", "pg": "page", "sl": "slide", "tab": "tab"}[k],
                f"{verb} {label_cap} · {span(e.get('a'))}", label=label, verb=verb,
                active_s=float(e.get("a") or 0), jump=jump, ref=e.get("h") if k == "sec" else e.get("n"))
            last_unit_item = items[-1]
            prev_unit = unit
            continue
        if k == "play":
            if playing_from is None:
                playing_from, play_t = float(e["s"]), t
            continue
        if k in ("pause", "end", "seek"):
            stop = float(e.get("f") if k == "seek" and e.get("f") is not None else e.get("s") or 0)
            if playing_from is not None and stop > playing_from + 0.5:
                add(play_t, "watch", f"Watched {clock(playing_from)}–{clock(stop)}", start=playing_from, end=stop)
            if k == "seek":
                frm = e.get("f")
                if frm is not None and e["s"] > frm:
                    add(t, "seek", f"Skipped ahead from {clock(frm)} to {clock(e['s'])}", start=frm, end=e["s"])
                elif frm is not None:
                    add(t, "seek", f"Went back from {clock(frm)} to {clock(e['s'])}", start=frm, end=e["s"])
                else:
                    add(t, "seek", f"Jumped to {clock(e['s'])}", end=e["s"])
                playing_from = float(e["s"]) if playing_from is not None else None
                play_t = t
            elif k == "end":
                add(t, "end", "Watched to the end")
                playing_from = None
            else:
                add(t, "pause", f"Paused at {clock(e['s'])}", at_s=e["s"])
                playing_from = None
            continue
        if k == "rate":
            add(t, "rate", f"Changed speed to {e['r']:g}×")
        elif k == "fs":
            add(t, "fullscreen", "Went full screen" if e.get("on") else "Left full screen")
        elif k == "depth":
            add(t, "depth", f"Scrolled to {e['v']}%" if e["v"] < 100 else "Reached the end")
        elif k == "link":
            add(t, "link", f"Opened a link: {e['u']}", url=e["u"],
                section=_section_title(e.get("h"), titles) if e.get("h") else None)
        elif k == "copy":
            add(t, "copy", "Copied a code block" + (f" in {_section_title(e['h'], titles)}" if e.get("h") else ""))
        elif k == "dl":
            add(t, "download", "Downloaded " + ({"pdf": "it as PDF", "md": "the markdown"}.get(e.get("f") or "",
                                                                                            "the file")))
        elif k == "print":
            add(t, "print", "Printed it")
        elif k == "find":
            add(t, "find", "Searched in it")
        elif k == "ask":
            add(t, "ask", f"Asked: “{e.get('q') or ''}”", question=e.get("q"), thread=e.get("thread"))
        elif k == "signoff":
            add(t, "signoff", f"Signed off: {e.get('o')}" if e.get("o") else "Cleared their sign-off",
                option=e.get("o"))
    if playing_from is not None and row.get("mpos") is not None and float(row["mpos"]) > playing_from + 0.5:
        add(play_t, "watch", f"Watched {clock(playing_from)}–{clock(row['mpos'])}", start=playing_from,
            end=float(row["mpos"]))
    items.sort(key=lambda i: i["t"])
    for i in items:
        i.pop("verb", None)
    last = aware(row.get("last_at"))
    if row.get("ended") and last:
        t = max(items[-1]["t"] if items else 0, (last - started).total_seconds())
        add(t, "leave", f"Left after {span(min(SESSION_CAP_S, row.get('active_s') or 0))} of active time")
    return items


async def timeline(db: AsyncIOMotorDatabase, raw: dict, view_id: str) -> dict | None:
    if not _ID.match(view_id or ""):
        return None
    row = await db[COLL].find_one({"_id": ObjectId(view_id), "doc_id": str(raw["_id"])})
    if not row:
        return None
    from app.services import md_outline

    titles = md_outline.doc_heading_titles(raw)
    order = list(titles.keys())
    people = await _people(db, [row.get("viewer_id")])
    visits = await _visit_numbers(db, str(raw["_id"]), [row], True)
    head = summary(row, people, visits.get(view_id))
    # This viewer's other views of the item (newest first).
    q = {"doc_id": str(raw["_id"]), "_id": {"$ne": row["_id"]}}
    q.update({"viewer_id": row["viewer_id"]} if row.get("viewer_id") else {"viewer_id": None, "anon": row.get("anon")})
    others = await db[COLL].find(q, {"started_at": 1, "active_s": 1}).sort("started_at", -1).limit(20) \
        .to_list(length=20)
    head["other_views"] = [{"id": str(o["_id"]), "started_at": _iso(o.get("started_at")),
                            "active_s": round(float(o.get("active_s") or 0), 1)} for o in others]
    steps = assemble(row, titles, order)
    head["steps"] = steps
    head["truncated"] = int(row.get("n_ev") or 0) > len(row.get("tl") or [])
    head["text"] = " · ".join(s["text"] for s in steps)
    return head


# ── CSV ───────────────────────────────────────────────────────────────────────

CSV_FIELDS = ["started_at", "viewer", "email", "signed_in", "own", "workspace_member", "visit", "active_seconds",
              "open_seconds", "completion_pct", "kind", "version", "country", "region", "city", "timezone",
              "device", "os", "os_version", "browser", "browser_version", "in_app", "app", "embedded_on",
              "viewport", "screen", "language", "source", "channel", "referrer", "utm_source", "utm_medium",
              "utm_campaign", "links", "copies", "downloads", "prints", "asks", "signoffs"]


def _cell(v) -> str:
    s = "" if v is None else str(v)
    # Spreadsheet formula injection: a cell that starts like a formula is quoted as text.
    return "'" + s if s[:1] in ("=", "+", "-", "@", "\t", "\r") else s


async def views_csv(db: AsyncIOMotorDatabase, raw: dict, start, end, **kw) -> str:
    res = await listing(db, raw, start, end, offset=0, limit=LIST_CAP, **kw)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(CSV_FIELDS)
    for v in res["views"]:
        s, loc, a = v["system"], v["location"], v["acts"]
        vw = v["viewer"]
        w.writerow([_cell(x) for x in (
            v["started_at"], vw["name"] or vw.get("email") or "", vw.get("email") or "",
            vw["type"] == "user", v["own"], v["internal"], v["visit_n"], v["active_s"], v["open_s"],
            v["completion"], v["kind"], v.get("ver"), loc["country"], loc["region"], loc["city"], loc["timezone"],
            s["device"], s["os"], s["os_version"], s["browser"], s["browser_version"], s["in_app"], s["app"],
            s["embed_host"], s["viewport"], s["screen"], s["language"], v["source"], v["channel"], v["referrer"],
            (v["utm"] or {}).get("source"), (v["utm"] or {}).get("medium"), (v["utm"] or {}).get("campaign"),
            a.get("link", 0), a.get("copy", 0), a.get("dl", 0), a.get("print", 0), a.get("ask", 0),
            a.get("signoff", 0))])
    return buf.getvalue()


# ── A viewer's own history ────────────────────────────────────────────────────


async def my_history(db: AsyncIOMotorDatabase, user_id: str, limit: int = 100) -> dict:
    rows = await db[COLL].find({"viewer_id": user_id, "own": {"$ne": True}},
                               {"doc_id": 1, "started_at": 1, "active_s": 1, "kind": 1}) \
        .sort("started_at", -1).limit(limit).to_list(length=limit)
    ids = [ObjectId(r["doc_id"]) for r in rows if ObjectId.is_valid(r.get("doc_id") or "")]
    docs = {str(d["_id"]): d for d in await db["documents"].find(
        {"_id": {"$in": ids}}, {"slug": 1, "title": 1, "original_filename": 1, "encrypted": 1, "content": 1,
                                "kind": 1}).to_list(length=len(ids))}
    from app.services import md_outline

    out = []
    for r in rows:
        d = docs.get(r["doc_id"])
        out.append({"started_at": _iso(r.get("started_at")), "active_s": round(float(r.get("active_s") or 0), 1),
                    "kind": r.get("kind"), "slug": d["slug"] if d else None,
                    "title": md_outline.display_title(d) if d else "A deleted item"})
    total = await db[COLL].count_documents({"viewer_id": user_id, "own": {"$ne": True}})
    return {"views": out, "total": total, "retention_days": detail_days()}
