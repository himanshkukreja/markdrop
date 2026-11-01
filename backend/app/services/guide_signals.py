"""Reader signals for Markdrop Guides: how far readers get down a page, where videos lose their
viewers, which code gets copied, and the guide's broken links. What the Fix list
(services/guide_fixes.py) reads, next to Insights' own page views, searches, feedback and Ask AI
questions (services/guide_insights.py).

Same rules as Insights. First-party, cookieless, nothing stored in the reader's browser, no
visitor hash at all (a signal is never tied to a reader, not even for a day), no text a reader
typed, no address, no user agent. The engine (frontend/src/docs/client/Signals.tsx) sends nothing
when the browser asks not to be tracked (Do Not Track, Global Privacy Control), and the API drops a
beacon that carries either header too. Only a guide with Insights on has the endpoint in its
site.json, and a beacon for a guide with Insights off is dropped here.

One beacon per page view, sent when the reader leaves the page (or after a while on it), so a
reading session costs one request:

    {k: "read", p, n, d, h?, t?, w?, c?, v?}
        p   the page path
        n   how many sections (h2/h3 headings in the article) the page has
        d   the deepest section the reader reached: -1 = still in the introduction, 0..n-1 a
            section (by its place on the page), n = the end of the page
        h   that section's heading id (the slug of the heading the author wrote)
        t   seconds the page was on screen (capped)
        w   the sampling weight (1 = every view is measured; a guide sampling 1 in 4 sends 4)
        c   copy-code clicks: [[section index, code block index on the page], ...]
        v   videos played: [{i: video id, l: length in seconds, b: 40 watched slices as 10 hex digits}]
        e   embedded Markdrop files on the page (videos, PDFs; see Embeds below)
    {k: "broken", p, f?}
        a page that doesn't exist (the guide's 404 page): p the address, f the guide page the
        reader came from (same guide only, path only)
    {k: "embed", p, w?, e: [embed entries]}
        embeds' signals on their own, for an embed that reports outside the page's read beacon

Embeds (a guide page's live blocks of Markdrop files: an uploaded video, a PDF; one entry each,
keyed by the embed's stable id, never a reader's):

    {i: embed id, k: "video", l: length (s), b: 40 slices as 10 hex digits | q: furthest quartile
     reached 1-4 | s: furthest second reached, name?: the file's title}
    {i: embed id, k: "pdf", n: pages, r: the furthest page the reader reached, name?}

A video embed becomes a retention curve like a docs-player video (id ``embed:<id>``), so the Fix
list's "loses most viewers at 0:42" covers both; a PDF a histogram of the furthest page reached
("readers stop at page 3").

AI agents. Agents and AI assistants read docs too, often more than people. They are counted apart
from readers and never as one: the docs edge reports, server side, a page view whose user agent is a
known AI agent (``/hit``, routers/guide_insights.py) and every request for a page's Markdown twin,
llms.txt or the docs MCP server (``/agent``); the docs MCP server reports its searches that found
nothing (``agent_search``, the query normalised like a reader's search). Kept: the path, how it was
read (page | markdown | llms | mcp) and the agent's family ("ChatGPT", "Claude", "Other tool"...),
never its address or full user agent.

Storage: the beacons are raw events in ``guide_events`` (90 days, like the rest of Insights); a
background job rolls each complete day into ``guide_signal_daily`` (13 months): per page a
histogram of how deep readers got, per video a retention curve, per PDF a histogram of pages
reached, per code block its copies, per missing address its hits, agent reads per page and family,
and agents' searches with no results.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from motor.motor_asyncio import AsyncIOMotorDatabase

from app.services import guide_insights as gi

log = logging.getLogger("markdrop.guide_signals")

DAILY = "guide_signal_daily"
KINDS = ("read", "broken", "embed")
STORED_KINDS = ("read", "broken", "embed", "agent", "agent_search")
MAX_SECTIONS = 200
MAX_COPIES = 20
MAX_VIDEOS = 6
MAX_EMBEDS = 10
MAX_PDF_PAGES = 5000
VIA = ("page", "markdown", "llms", "mcp")
SLICES = 40                 # a video's watched slices (2.5% each)
MAX_SECONDS = 4 * 3600
MAX_WEIGHT = 20
ROLLUP_KEEP = 500

_ID = re.compile(r"^[\w\-.:~%]{1,120}$", re.UNICODE)
_HEX = re.compile(r"^[0-9a-f]{10}$")
_CTRL = re.compile(r"[\x00-\x1f\x7f]")

# Known AI agents and assistants, by family (their published user-agent tokens).
AGENTS: tuple[tuple[str, re.Pattern], ...] = tuple((name, re.compile(rx, re.I)) for name, rx in (
    ("ChatGPT", r"ChatGPT-User|OAI-SearchBot|GPTBot|OpenAI"),
    ("Claude", r"Claude-User|Claude-SearchBot|ClaudeBot|Claude-Web|anthropic-ai|Claude/"),
    ("Perplexity", r"Perplexity-User|PerplexityBot"),
    ("Gemini", r"Google-Extended|Gemini|GoogleAgent|Google-CloudVertexBot|Google-NotebookLM"),
    ("Copilot", r"Copilot|MicrosoftPreview"),
    ("Meta AI", r"meta-externalagent|meta-externalfetcher|FacebookBot"),
    ("Mistral", r"MistralAI-User"),
    ("DuckDuckGo AI", r"DuckAssistBot"),
    ("Apple", r"Applebot-Extended"),
    ("Amazon", r"Amazonbot"),
    ("Cohere", r"cohere-ai|cohere-training"),
    ("You.com", r"YouBot"),
    ("Cursor", r"Cursor/"),
    ("Common Crawl", r"CCBot"),
    ("ByteDance", r"Bytespider"),
))
_TOOL = re.compile(r"curl|wget|python|node|axios|go-http-client|okhttp|java/|httpx|aiohttp|deno|bun/|undici|fetch", re.I)


def now() -> datetime:
    return gi.now()


# ── Cleaning a beacon ─────────────────────────────────────────────────────────


def _int(v: Any, lo: int, hi: int) -> int | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    try:
        n = int(v)
    except (OverflowError, ValueError):
        return None
    return n if lo <= n <= hi else None


def clean_id(v: Any) -> str | None:
    """A heading or video id: the author's slug, nothing a reader typed."""
    if not isinstance(v, str):
        return None
    v = v.strip()
    return v if _ID.match(v) else None


def watched(hexstr: Any) -> list[int] | None:
    """10 hex digits → the indexes (0..39) of the slices watched; None when malformed or empty."""
    if not isinstance(hexstr, str) or not _HEX.match(hexstr.lower()):
        return None
    bits = int(hexstr, 16)
    out = [i for i in range(SLICES) if bits >> i & 1]
    return out or None


def agent_family(ua: str | None) -> str | None:
    """The family of a known AI agent's user agent ("ChatGPT", "Claude", ...), else None."""
    for name, rx in AGENTS:
        if ua and rx.search(ua):
            return name
    return None


def tool_family(ua: str | None) -> str:
    """Who read a machine-readable output (a Markdown twin, llms.txt, the MCP server): a known AI
    agent's family, "Other tool" for a script or HTTP library, else "Browser or other"."""
    fam = agent_family(ua)
    if fam:
        return fam
    if not (ua or "").strip() or _TOOL.search(ua or ""):
        return "Other tool"
    return "Browser or other"


def agent_path(path: Any, via: str) -> str | None:
    """The guide page an agent read: a Markdown twin's address (/md/x, /x.md) is its page's."""
    if via == "llms":
        return "/llms.txt"
    if via == "mcp":
        return "/mcp"
    p = gi.clean_path(path)
    if p is None:
        return None
    if via == "markdown":
        if p.startswith("/md/") or p == "/md":
            p = p[3:] or "/"
        if p.endswith(".md"):
            p = p[:-3] or "/"
        p = p.removesuffix("/index") or "/"
    return p


def clean_name(v: Any) -> str | None:
    """An embed's title (the author's file name), short and plain."""
    if not isinstance(v, str):
        return None
    v = _CTRL.sub("", v).strip()[:120]
    return v or None


def clean_embed(e: Any) -> dict | None:
    """One embed entry (see Embeds above) as stored, or None."""
    if not isinstance(e, dict):
        return None
    i = clean_id(e.get("i"))
    kind = e.get("k")
    if not i or kind not in ("video", "pdf"):
        return None
    out: dict = {"i": i, "k": kind}
    name = clean_name(e.get("name"))
    if name:
        out["name"] = name
    if kind == "video":
        length = _int(e.get("l"), 1, 6 * 3600)
        if not length:
            return None
        slices = watched(e.get("b"))
        if slices is None and e.get("q") is not None:
            q = _int(e.get("q"), 1, 4)
            slices = list(range(q * SLICES // 4)) if q else None
        if slices is None and e.get("s") is not None:
            s = _int(e.get("s"), 1, length)
            slices = list(range(max(1, min(SLICES, -(-s * SLICES // length))))) if s else None
        if not slices:
            return None
        out.update(l=length, b=slices)
        return out
    n = _int(e.get("n"), 1, MAX_PDF_PAGES)
    r = _int(e.get("r"), 1, n) if n else None
    if not n or not r:
        return None
    out.update(n=n, r=r)
    return out


def clean_embed_beacon(body: dict) -> dict | None:
    """A standalone {k: "embed", p, w?, e: [entries]} beacon as stored."""
    p = gi.clean_path(body.get("p"))
    raw = body.get("e") if isinstance(body.get("e"), list) else []
    e = [x for x in map(clean_embed, raw[:MAX_EMBEDS]) if x]
    if p is None or not e:
        return None
    return {"p": p, "w": _int(body.get("w"), 1, MAX_WEIGHT) or 1, "e": e}


def clean_read(body: dict) -> dict | None:
    """A "read" beacon as stored (minus site and time), or None when it can't be used."""
    p = gi.clean_path(body.get("p"))
    n = _int(body.get("n"), 0, MAX_SECTIONS)
    if p is None or n is None:
        return None
    d = _int(body.get("d"), -1, n)
    if d is None:
        return None
    out: dict = {"p": p, "n": n, "d": d, "w": _int(body.get("w"), 1, MAX_WEIGHT) or 1}
    h = clean_id(body.get("h"))
    if h and 0 <= d < n:
        out["h"] = h
    t = _int(body.get("t"), 0, 10**7)
    if t is not None:
        out["t"] = min(t, MAX_SECONDS)
    copies = []
    for c in (body.get("c") or [])[:MAX_COPIES] if isinstance(body.get("c"), list) else []:
        if isinstance(c, list) and len(c) == 2:
            s, b = _int(c[0], -1, MAX_SECTIONS), _int(c[1], 0, 1000)
            if s is not None and b is not None:
                copies.append([s, b])
    if copies:
        out["c"] = copies
    vids = []
    for v in (body.get("v") or [])[:MAX_VIDEOS] if isinstance(body.get("v"), list) else []:
        if not isinstance(v, dict):
            continue
        vid, length, slices = clean_id(v.get("i")), _int(v.get("l"), 1, 6 * 3600), watched(v.get("b"))
        if vid and length and slices:
            vids.append({"i": vid, "l": length, "b": slices})
    if vids:
        out["v"] = vids
    embeds = [x for x in map(clean_embed, (body.get("e") or [])[:MAX_EMBEDS] if isinstance(body.get("e"), list) else []) if x]
    if embeds:
        out["e"] = embeds
    return out


def clean_broken(body: dict) -> dict | None:
    p = gi.clean_path(body.get("p"))
    if p is None or p == "/":
        return None
    f = gi.clean_path(body.get("f")) if body.get("f") else None
    return {"p": p, "f": f if f != p else None}


async def record(db: AsyncIOMotorDatabase, site: str, kind: str, data: dict) -> bool:
    ts = now()
    day = gi.day_key(ts)
    if not gi._within_cap(site, day):
        return False
    await db[gi.RAW].insert_one({"site": site, "k": kind, "ts": ts, "day": day, **data})
    return True


# ── Rollups ───────────────────────────────────────────────────────────────────


def _facets() -> list[dict]:
    return [{"$facet": {
        "reading": [
            {"$match": {"k": "read"}},
            {"$group": {"_id": {"p": "$p", "d": "$d"}, "m": {"$sum": "$w"}, "n": {"$max": "$n"},
                        "h": {"$first": "$h"}, "t": {"$sum": {"$multiply": [{"$ifNull": ["$t", 0]}, "$w"]}}}},
        ],
        "copies": [
            {"$match": {"k": "read", "c": {"$exists": True}}},
            {"$unwind": "$c"},
            {"$group": {"_id": {"p": "$p", "s": {"$arrayElemAt": ["$c", 0]}, "b": {"$arrayElemAt": ["$c", 1]}},
                        "n": {"$sum": "$w"}}},
            {"$sort": {"n": -1}}, {"$limit": ROLLUP_KEEP},
        ],
        "videos": [
            {"$match": {"k": "read", "v": {"$exists": True}}},
            {"$unwind": "$v"},
            {"$group": {"_id": {"i": "$v.i", "p": "$p"}, "plays": {"$sum": "$w"}, "l": {"$max": "$v.l"}}},
            {"$sort": {"plays": -1}}, {"$limit": 200},
        ],
        "slices": [
            {"$match": {"k": "read", "v": {"$exists": True}}},
            {"$unwind": "$v"},
            {"$unwind": "$v.b"},
            {"$group": {"_id": {"i": "$v.i", "p": "$p", "s": "$v.b"}, "n": {"$sum": "$w"}}},
        ],
        "broken": [
            {"$match": {"k": "broken"}},
            {"$group": {"_id": {"p": "$p", "f": "$f"}, "n": {"$sum": 1}, "last": {"$max": "$ts"}}},
            {"$sort": {"n": -1}}, {"$limit": ROLLUP_KEEP},
        ],
        "embed_videos": [
            {"$match": {"k": {"$in": ["read", "embed"]}, "e.k": "video"}},
            {"$unwind": "$e"}, {"$match": {"e.k": "video"}},
            {"$group": {"_id": {"i": "$e.i", "p": "$p"}, "plays": {"$sum": "$w"}, "l": {"$max": "$e.l"},
                        "name": {"$max": "$e.name"}}},
            {"$sort": {"plays": -1}}, {"$limit": 200},
        ],
        "embed_slices": [
            {"$match": {"k": {"$in": ["read", "embed"]}, "e.k": "video"}},
            {"$unwind": "$e"}, {"$match": {"e.k": "video"}}, {"$unwind": "$e.b"},
            {"$group": {"_id": {"i": "$e.i", "p": "$p", "s": "$e.b"}, "n": {"$sum": "$w"}}},
        ],
        "pdfs": [
            {"$match": {"k": {"$in": ["read", "embed"]}, "e.k": "pdf"}},
            {"$unwind": "$e"}, {"$match": {"e.k": "pdf"}},
            {"$group": {"_id": {"i": "$e.i", "p": "$p", "r": "$e.r"}, "m": {"$sum": "$w"}, "n": {"$max": "$e.n"},
                        "name": {"$max": "$e.name"}}},
            {"$limit": 5000},
        ],
        "agents": [
            {"$match": {"k": "agent"}},
            {"$group": {"_id": {"p": "$p", "via": "$via", "a": "$a"}, "n": {"$sum": 1}}},
            {"$sort": {"n": -1}}, {"$limit": ROLLUP_KEEP * 4},
        ],
        "agent_searches": [
            {"$match": {"k": "agent_search", "n": 0}},
            {"$group": {"_id": "$q", "n": {"$sum": 1}, "last": {"$max": "$ts"}}},
            {"$sort": {"n": -1}}, {"$limit": ROLLUP_KEEP},
        ],
    }}]


def _shape(f: dict) -> dict:
    """The facet output → {reading, copies, videos, broken} as stored in a daily row."""
    pages: dict[str, dict] = {}
    for r in f.get("reading") or []:
        p, d = r["_id"]["p"], r["_id"]["d"]
        if p is None or d is None:
            continue
        pg = pages.setdefault(p, {"p": p, "n": 0, "m": 0, "t": 0, "hist": {}, "ids": {}})
        pg["n"] = max(pg["n"], int(r.get("n") or 0))
        pg["m"] += int(r["m"])
        pg["t"] += int(r.get("t") or 0)
        pg["hist"][str(d)] = pg["hist"].get(str(d), 0) + int(r["m"])
        if r.get("h"):
            pg["ids"][str(d)] = r["h"]
    curves: dict[tuple, list[int]] = {}
    for r in f.get("slices") or []:
        key = (r["_id"]["i"], r["_id"]["p"])
        i = r["_id"].get("s")
        if isinstance(i, int) and 0 <= i < SLICES:
            curves.setdefault(key, [0] * SLICES)[i] += int(r["n"])
    videos = [{"i": r["_id"]["i"], "p": r["_id"]["p"], "l": int(r.get("l") or 0), "plays": int(r["plays"]),
               "curve": curves.get((r["_id"]["i"], r["_id"]["p"]), [0] * SLICES)}
              for r in f.get("videos") or [] if r["_id"].get("i")]
    ecurves: dict[tuple, list[int]] = {}
    for r in f.get("embed_slices") or []:
        key = (r["_id"]["i"], r["_id"]["p"])
        i = r["_id"].get("s")
        if isinstance(i, int) and 0 <= i < SLICES:
            ecurves.setdefault(key, [0] * SLICES)[i] += int(r["n"])
    for r in f.get("embed_videos") or []:
        if not r["_id"].get("i"):
            continue
        videos.append({"i": f"embed:{r['_id']['i']}", "p": r["_id"]["p"], "l": int(r.get("l") or 0),
                       "plays": int(r["plays"]), "name": r.get("name"),
                       "curve": ecurves.get((r["_id"]["i"], r["_id"]["p"]), [0] * SLICES)})
    pdfs: dict[tuple, dict] = {}
    for r in f.get("pdfs") or []:
        key = (r["_id"]["i"], r["_id"]["p"])
        if not key[0] or r["_id"].get("r") is None:
            continue
        d = pdfs.setdefault(key, {"i": key[0], "p": key[1], "n": 0, "name": None, "hist": {}})
        d["n"] = max(d["n"], int(r.get("n") or 0))
        d["name"] = d["name"] or r.get("name")
        d["hist"][str(r["_id"]["r"])] = d["hist"].get(str(r["_id"]["r"]), 0) + int(r["m"])
    return {
        "pdfs": list(pdfs.values()),
        "agents": [{"p": r["_id"].get("p"), "via": r["_id"].get("via"), "a": r["_id"].get("a"), "n": int(r["n"])}
                   for r in f.get("agents") or []],
        "agent_searches": [{"q": r["_id"], "n": int(r["n"]), "last": r.get("last")}
                           for r in f.get("agent_searches") or [] if r["_id"]],
        "reading": sorted(pages.values(), key=lambda x: -x["m"])[:ROLLUP_KEEP],
        "copies": [{"p": r["_id"]["p"], "s": r["_id"]["s"], "b": r["_id"]["b"], "n": int(r["n"])}
                   for r in f.get("copies") or [] if r["_id"].get("p")],
        "videos": videos,
        "broken": [{"p": r["_id"]["p"], "f": r["_id"].get("f"), "n": int(r["n"]), "last": r.get("last")}
                   for r in f.get("broken") or [] if r["_id"].get("p")],
    }


async def _aggregate(db: AsyncIOMotorDatabase, site: str, days: list[str], since: datetime | None = None) -> dict:
    if not days:
        return _shape({})
    match: dict = {"site": site, "day": {"$in": days}, "k": {"$in": list(STORED_KINDS)}}
    if since is not None:
        match["ts"] = {"$gte": since}
    rows = await db[gi.RAW].aggregate([{"$match": match}, *_facets()]).to_list(1)
    return _shape(rows[0] if rows else {})


async def rollup_day(db: AsyncIOMotorDatabase, site: str, day: str) -> dict:
    row = {"site": site, "day": day, **(await _aggregate(db, site, [day])), "rolled_at": now(),
           "expires_at": gi._day_start(day) + timedelta(days=gi.ROLLUP_TTL_DAYS)}
    await db[DAILY].replace_one({"_id": f"{site}:{day}"}, {"_id": f"{site}:{day}", **row}, upsert=True)
    return row


async def rollup_due(db: AsyncIOMotorDatabase, today: datetime | None = None) -> int:
    """Roll up every guide with signal events on one of the last few complete days that has no
    signal row for it yet."""
    t = (today or now()).astimezone(timezone.utc)
    written = 0
    for i in range(1, gi.ROLLUP_LOOKBACK_DAYS + 1):
        day = gi.day_key(t - timedelta(days=i))
        sites = set(await db[gi.RAW].distinct("site", {"day": day, "k": {"$in": list(STORED_KINDS)}}))
        if not sites:
            continue
        done = set(await db[DAILY].distinct("site", {"day": day}))
        for site in sorted(sites - done):
            try:
                await rollup_day(db, site, day)
                written += 1
            except Exception:
                log.warning("signals rollup failed for %s %s", site, day, exc_info=True)
    return written


# ── Reading a window ──────────────────────────────────────────────────────────


def merge(parts: list[dict]) -> dict:
    """Daily rows (and today's live aggregate) → one window: reading per page, copies per block,
    a retention curve per video (summed over the pages it is on), hits per missing address."""
    pages: dict[str, dict] = {}
    copies: dict[tuple, dict] = {}
    videos: dict[str, dict] = {}
    broken: dict[tuple, dict] = {}
    pdfs: dict[str, dict] = {}
    agents: dict[tuple, int] = {}
    asearch: dict[str, dict] = {}

    def later(a, b):
        if b is None:
            return a
        b = b if b.tzinfo else b.replace(tzinfo=timezone.utc)
        return max(a, b) if a else b

    for part in parts:
        for r in part.get("pdfs") or []:
            d = pdfs.setdefault(r["i"], {"i": r["i"], "pages": {}, "n": 0, "name": None, "hist": {}})
            d["n"] = max(d["n"], int(r.get("n") or 0))
            d["name"] = d["name"] or r.get("name")
            total = sum(int(c) for c in (r.get("hist") or {}).values())
            d["pages"][r.get("p")] = d["pages"].get(r.get("p"), 0) + total
            for k, c in (r.get("hist") or {}).items():
                d["hist"][k] = d["hist"].get(k, 0) + int(c)
        for r in part.get("agents") or []:
            key = (r.get("p"), r.get("via"), r.get("a"))
            agents[key] = agents.get(key, 0) + int(r.get("n") or 0)
        for r in part.get("agent_searches") or []:
            a = asearch.setdefault(r["q"], {"q": r["q"], "n": 0, "last": None})
            a["n"] += int(r.get("n") or 0)
            a["last"] = later(a["last"], r.get("last"))
        for r in part.get("reading") or []:
            pg = pages.setdefault(r["p"], {"p": r["p"], "n": 0, "m": 0, "t": 0, "hist": {}, "ids": {}})
            pg["n"] = max(pg["n"], int(r.get("n") or 0))
            pg["m"] += int(r.get("m") or 0)
            pg["t"] += int(r.get("t") or 0)
            for d, c in (r.get("hist") or {}).items():
                pg["hist"][d] = pg["hist"].get(d, 0) + int(c)
            for d, h in (r.get("ids") or {}).items():
                pg["ids"][d] = h
        for r in part.get("copies") or []:
            key = (r["p"], r.get("s"), r.get("b"))
            c = copies.setdefault(key, {"p": r["p"], "s": r.get("s"), "b": r.get("b"), "n": 0})
            c["n"] += int(r.get("n") or 0)
        for r in part.get("videos") or []:
            v = videos.setdefault(r["i"], {"i": r["i"], "pages": {}, "l": 0, "plays": 0, "curve": [0] * SLICES, "name": None})
            v["name"] = v["name"] or r.get("name")
            v["l"] = max(v["l"], int(r.get("l") or 0))
            v["plays"] += int(r.get("plays") or 0)
            v["pages"][r.get("p")] = v["pages"].get(r.get("p"), 0) + int(r.get("plays") or 0)
            for i, c in enumerate((r.get("curve") or [])[:SLICES]):
                v["curve"][i] += int(c)
        for r in part.get("broken") or []:
            key = (r["p"], r.get("f"))
            b = broken.setdefault(key, {"p": r["p"], "f": r.get("f"), "n": 0, "last": None})
            b["n"] += int(r.get("n") or 0)
            last = r.get("last")
            if last is not None:
                last = last if last.tzinfo else last.replace(tzinfo=timezone.utc)
                b["last"] = max(b["last"], last) if b["last"] else last
    return {"reading": pages, "copies": list(copies.values()), "videos": videos, "broken": list(broken.values()),
            "pdfs": pdfs, "agents": [{"p": k[0], "via": k[1], "a": k[2], "n": n} for k, n in agents.items()],
            "agent_searches": sorted(asearch.values(), key=lambda a: -a["n"])}


async def window(db: AsyncIOMotorDatabase, site: str, days: list[str]) -> dict:
    """Signals over ``days``: stored daily rows where they exist, raw events for the rest."""
    today = gi.day_key(now())
    stored = {r["day"]: r async for r in db[DAILY].find({"site": site, "day": {"$in": [d for d in days if d < today]}})}
    for r in stored.values():
        for b in [*(r.get("broken") or []), *(r.get("agent_searches") or [])]:
            if b.get("last") is None:
                b["last"] = gi._day_start(r["day"]) + timedelta(hours=12)
    live = await _aggregate(db, site, [d for d in days if d not in stored])
    return merge([*stored.values(), live])


async def clear(db: AsyncIOMotorDatabase, site: str) -> int:
    return (await db[DAILY].delete_many({"site": site})).deleted_count


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[DAILY].create_index([("site", 1), ("day", 1)])
    await db[DAILY].create_index("expires_at", expireAfterSeconds=0)
