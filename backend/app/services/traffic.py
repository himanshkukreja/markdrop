"""First-party site traffic: visitors, sessions, page views and product events.

Vercel's free tier shows page views, referrers and geography; the parts that
answer "where do our users actually come from and what do they do" — UTM
campaigns, channels, funnels, retention, filters — are paid. This collects
enough to answer those ourselves, into our own database, with nothing shared
with a third party.

What is stored, and what deliberately is not:

* A **visitor id** — random, generated in the browser, kept in localStorage.
  Browsers signalling Global Privacy Control or Do Not Track get a
  session-only id instead, so their visits are never linked across days.
* **Paths are route shapes.** A document's URL *is* its capability
  (markdrop.in/<slug> grants access), so slugs are redacted to `/[slug]` here
  as well as in the browser — an old or hostile client can't write one in.
  On a workspace's own domain every path is a document, so all of it goes.
* No IP address, no query string, no page titles. Geography comes from the
  request IP at ingest and only the country / region / city are kept.

Collections (all written only by `ingest`):
  traffic_visitors   one per visitor id: first/last seen, first channel, user
  traffic_sessions   one per session: entry/exit, source, device, geo, counts
  traffic_pageviews  one per page view, with the session's attributes copied
                     on so any breakdown can be filtered by any other
  traffic_events     product events (published, signed up, share started…)
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from urllib.parse import urlsplit

from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo import ReturnDocument

from app.config import get_settings
from app.services import geo
from app.services.analytics import clean_referrer

settings = get_settings()

# Every real top-level route. Anything else with a single segment is a
# document slug. Mirror of frontend/src/lib/analyticsPath.ts — keep in step.
APP_ROUTES = {
    "", "admin", "auth", "builder", "dashboard", "enterprise", "extension", "h",
    "invite", "login", "new", "settings", "share", "upload",
}

_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
_EVENT = re.compile(r"^[a-z][a-z0-9_]{0,39}$")
_PATH_SAFE = re.compile(r"[^A-Za-z0-9/_\-\[\].]")

# ── Classification ────────────────────────────────────────────────────────────

_SEARCH = ("google.", "bing.com", "duckduckgo.com", "yahoo.", "yandex.", "baidu.com",
           "ecosia.org", "search.brave.com", "startpage.com", "qwant.com")
_SOCIAL = ("t.co", "x.com", "twitter.com", "facebook.com", "fb.com", "linkedin.com",
           "lnkd.in", "reddit.com", "instagram.com", "youtube.com", "threads.net",
           "news.ycombinator.com", "telegram.org", "t.me", "whatsapp.com", "discord.com",
           "slack.com", "mastodon.", "bsky.app", "producthunt.com", "medium.com")
_AI = ("chatgpt.com", "chat.openai.com", "perplexity.ai", "claude.ai", "gemini.google.com",
       "copilot.microsoft.com", "you.com", "phind.com", "poe.com")
_EMAIL = ("mail.google.com", "outlook.", "mail.yahoo.", "mail.proton")


def _host_matches(host: str, patterns: tuple[str, ...]) -> bool:
    for p in patterns:
        if p.endswith("."):
            if host.startswith(p) or f".{p}" in f".{host}":
                return True
        elif host == p or host.endswith("." + p):
            return True
    return False


def channel_for(ref_host: str | None, utm_source: str | None, utm_medium: str | None) -> str:
    """The marketing channel a session arrived through."""
    medium = (utm_medium or "").lower()
    source = (utm_source or "").lower()
    if medium in ("email", "e-mail", "newsletter") or source in ("email", "newsletter", "resend"):
        return "Email"
    if medium in ("cpc", "ppc", "paid", "paidsocial", "display", "ads"):
        return "Paid"
    host = (ref_host or source).lower()
    if not host:
        return "Campaign" if utm_source else "Direct"
    if _host_matches(host, _AI):
        return "AI assistants"
    if _host_matches(host, _EMAIL):
        return "Email"
    if _host_matches(host, _SEARCH) and "accounts.google" not in host and "mail.google" not in host:
        return "Search"
    if _host_matches(host, _SOCIAL) or medium == "social":
        return "Social"
    if utm_source and not ref_host:
        return "Campaign"
    return "Referral"


def parse_ua(ua: str) -> dict:
    """Coarse device / OS / browser. Deliberately coarse: enough to answer
    "are people on phones", not enough to fingerprint anyone."""
    ua = ua or ""
    if re.search(r"iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))", ua):
        device = "Tablet"
    elif re.search(r"Mobi|iPhone|iPod|Android.*Mobile|Windows Phone", ua):
        device = "Mobile"
    else:
        device = "Desktop"
    os = (
        "iOS" if re.search(r"iPhone|iPad|iPod", ua)
        else "Android" if "Android" in ua
        else "ChromeOS" if "CrOS" in ua
        else "macOS" if re.search(r"Mac OS X|Macintosh", ua)
        else "Windows" if "Windows" in ua
        else "Linux" if "Linux" in ua
        else "Other"
    )
    browser = (
        "Edge" if "Edg/" in ua
        else "Samsung Internet" if "SamsungBrowser" in ua
        else "Opera" if "OPR/" in ua
        else "Instagram" if "Instagram" in ua
        else "Facebook" if re.search(r"FBAN|FBAV", ua)
        else "X (in-app)" if "Twitter" in ua
        else "LinkedIn" if "LinkedInApp" in ua
        else "Firefox" if re.search(r"Firefox|FxiOS", ua)
        else "Chrome" if re.search(r"CriOS|Chrome/", ua)
        else "Safari" if "Safari/" in ua
        else "Other"
    )
    return {"device": device, "os": os, "browser": browser}


def _own_host(host: str) -> bool:
    own = (urlsplit(settings.frontend_url).hostname or "").lower().removeprefix("www.")
    host = host.lower().removeprefix("www.")
    return host == own or host in ("localhost", "127.0.0.1")


def clean_path(path: str, host: str) -> str | None:
    """Route shape of a path, or None if it isn't one."""
    if not isinstance(path, str) or not path.startswith("/"):
        return None
    path = path.split("?", 1)[0].split("#", 1)[0][:200]
    if not _own_host(host):
        # A workspace's own domain: every path is a (possibly foldered) document.
        return "/" if path == "/" else "/[workspace-doc]"
    segments = [s for s in path.split("/") if s]
    if not segments:
        return "/"
    if segments[0] == "share" and len(segments) > 1:
        return "/share/[id]"
    if segments[0] == "invite" and len(segments) > 1:
        return "/invite/[token]"
    if segments[0] == "h":
        return "/h/[workspace-doc]"
    if len(segments) == 1 and segments[0] not in APP_ROUTES:
        return "/[slug]"
    return _PATH_SAFE.sub("", "/" + "/".join(segments))[:120] or "/"


def _clean_str(v, n: int = 100) -> str | None:
    if not isinstance(v, str):
        return None
    v = v.strip()[:n]
    return v or None


def _clean_props(props) -> dict:
    if not isinstance(props, dict):
        return {}
    out = {}
    for k, v in list(props.items())[:8]:
        if not isinstance(k, str) or not _EVENT.match(k):
            continue
        if isinstance(v, bool) or isinstance(v, (int, float)):
            out[k] = v
        elif isinstance(v, str):
            out[k] = v[:100]
    return out


# ── Ingest ────────────────────────────────────────────────────────────────────

async def ingest(
    db: AsyncIOMotorDatabase,
    body: dict,
    *,
    ip: str | None,
    user_agent: str,
    user_id: str | None,
) -> None:
    vid = body.get("vid")
    sid = body.get("sid")
    if not (isinstance(vid, str) and _ID.match(vid) and isinstance(sid, str) and _ID.match(sid)):
        return
    items = body.get("events")
    if not isinstance(items, list) or not items:
        return
    items = items[:25]
    host = (_clean_str(body.get("host"), 120) or "").lower()
    now = datetime.now(timezone.utc)

    pageviews: list[str] = []
    events: list[tuple[str, str | None, dict]] = []
    engaged_ms = 0
    for it in items:
        if not isinstance(it, dict):
            continue
        kind = it.get("k")
        path = clean_path(it.get("p", ""), host) if it.get("p") else None
        if kind == "pv" and path:
            pageviews.append(path)
        elif kind == "ev" and isinstance(it.get("n"), str) and _EVENT.match(it["n"]):
            events.append((it["n"], path, _clean_props(it.get("props"))))
        elif kind == "leave":
            d = it.get("d")
            if isinstance(d, (int, float)) and 0 < d < 6 * 3600 * 1000:
                engaged_ms += int(d)

    # Session attributes are fixed by the session's first beat: where it came
    # from, on what, from where. Later beats only move counters and the exit.
    entry = body.get("entry") if isinstance(body.get("entry"), dict) else {}
    referrer = clean_referrer(_clean_str(entry.get("ref"), 2048))
    ref_host = urlsplit(referrer).hostname if referrer else None
    utm = {k: _clean_str(entry.get(k), 100) for k in
           ("utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content")}
    utm = {k: v.lower() if k in ("utm_source", "utm_medium") and v else v for k, v in utm.items()}
    ua = parse_ua(user_agent)
    loc = geo.lookup(ip)

    visitor_before = await db["traffic_visitors"].find_one_and_update(
        {"_id": vid},
        {
            "$setOnInsert": {
                "first_seen": now,
                "first_channel": channel_for(ref_host, utm["utm_source"], utm["utm_medium"]),
                "ephemeral": bool(body.get("eph")),
            },
            "$set": {"last_seen": now, **({"user_id": user_id} if user_id else {})},
        },
        upsert=True,
        return_document=ReturnDocument.BEFORE,
    )

    # Mongo keeps milliseconds, so "was this upsert an insert" can't be read
    # back off started_at; ask first. One indexed lookup per beat.
    new_session = await db["traffic_sessions"].count_documents({"_id": sid}, limit=1) == 0
    first_path = pageviews[0] if pageviews else (events[0][1] if events else None)
    set_fields: dict = {"last_seen": now}
    if pageviews:
        set_fields["exit_path"] = pageviews[-1]
    if user_id:
        set_fields["user_id"] = user_id
    session = await db["traffic_sessions"].find_one_and_update(
        {"_id": sid},
        {
            "$setOnInsert": {
                "vid": vid,
                "started_at": now,
                "entry_path": first_path or "/",
                "host": host or None,
                "referrer": referrer,
                "ref_host": ref_host,
                "channel": channel_for(ref_host, utm["utm_source"], utm["utm_medium"]),
                **utm,
                "country": loc["country"],
                "region": loc["region"],
                "city": loc["city"],
                **ua,
                "new_visitor": visitor_before is None,
            },
            "$set": set_fields,
            "$inc": {"pageviews": len(pageviews), "events": len(events), "engaged_ms": engaged_ms},
        },
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )
    if new_session:
        await db["traffic_visitors"].update_one({"_id": vid}, {"$inc": {"sessions": 1}})

    # Copy the session's attributes onto each row so every breakdown can be
    # filtered by every other without a join.
    attrs = {k: session.get(k) for k in (
        "host", "channel", "ref_host", "utm_source", "utm_medium", "utm_campaign",
        "country", "region", "city", "device", "os", "browser", "new_visitor", "entry_path",
    )}
    attrs["signed_in"] = bool(session.get("user_id"))
    if pageviews:
        await db["traffic_pageviews"].insert_many(
            [{"sid": sid, "vid": vid, "path": p, "ts": now, **attrs} for p in pageviews]
        )
    if events:
        await db["traffic_events"].insert_many(
            [{"sid": sid, "vid": vid, "name": n, "path": p, "props": props, "ts": now, **attrs}
             for n, p, props in events]
        )
