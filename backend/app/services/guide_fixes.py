"""The Fix list for Markdrop Guides: one ranked list of what to fix next in a guide.

Read from what Insights and the reader signals already collect (services/guide_insights.py,
services/guide_signals.py; same privacy rules: nothing here identifies a reader) and from the live
build itself, re-detected once a day (the background job) and when the list is opened after a day
without a check. Each problem is an *item* in ``guide_fixes``:

    type       drop | search | ask | not_helpful | video | pdf | broken | stale | heavy |
               agent_unanswered | agent_unfriendly
    key        what makes it the same problem from one day to the next ("drop:/start#install",
               "video:product-tour", "search:sso"...); clustered searches and questions also keep
               ``aliases`` (every wording they grouped) so a cluster whose most frequent wording
               changes is still the same item
    evidence   the numbers behind it (a section drop curve, a video retention curve, the queries,
               the comments...), as the item drawer draws it
    impact     readers affected x severity x recency (below), and a level: high / medium / low
    status     open, in_progress, fixed or dismissed (with a reason); detected_at, history

Detection rules (all over the last ``WINDOW_DAYS`` days, pure functions below, unit tested):

    drop         a page measured at least MIN_READS times, with 3+ sections: the share of readers
                 whose deepest point was section k (they left there) is abnormal against the page's
                 own curve: >= 15%, >= 1.8x the page's median leave rate and 8+ points above it, 8+
                 readers. The last section and the end of the page never count (that's finishing).
    search       searches with no results, clustered by meaning (shared rare words), 3+ in a cluster
    ask          Ask AI questions it couldn't answer, clustered the same way, 2+ in a cluster
    not_helpful  "Did this page help?": 3+ votes, 2+ "no", and helpful <= 60%; open comments attached
    video        a video played 8+ times whose retention falls 15+ points within 5% of its length
                 (and 2x its average fall) before the last 12.5%: "loses most viewers at 0:42"
                 (docs-player videos and embedded Markdrop videos alike)
    pdf          an embedded PDF opened 15+ times where an abnormal share of readers stop at one
                 page (>= 20%, 1.8x the median, 6+ readers), the last page excepted
    agent_unanswered  the docs MCP server's searches (AI agents asking on someone's behalf) that
                 found nothing, clustered, 2+ in a cluster
    agent_unfriendly  a page AI agents read 10+ times that is hard for them to use: long with no
                 headings, mostly images or video with little text, or hidden from llms.txt
    broken       an address in the guide readers hit that doesn't exist (2+ hits, or 1 from a link on
                 one of its own pages), and links in the live pages to a page that doesn't exist
    stale        a page not edited in STALE_DAYS that is read a lot (25+ readers, top half of pages)
    heavy        a very long or media-heavy page that people read (cheap to tell from the Markdown)

Confidence: every item says how sure it is (low / medium / high: its sample is at least the
type's minimum, twice it, four times it), and below the minimum nothing is flagged at all: the list
shows those as "needs more readers" (pages, videos and PDFs collecting toward their minimum).

Agents are counted apart from readers (services/guide_signals.py) and never in a reader number.

Scoring: ``impact = readers affected x severity x recency``. Readers affected is what the evidence
counts (readers who left at that section, searches that found nothing, viewers lost...). Severity
is per type (SEVERITY). Recency halves every RECENCY_HALF_LIFE days since the evidence was last
seen. Level: high when impact >= max(10, 5% of the window's readers), medium >= max(3, 1%).

Lifecycle: a new problem is ``open``. An editor can start it (in_progress), mark it fixed or dismiss
it with a reason. "Open in editor" with an AI-drafted fix (services/guide_fix_drafts.py) moves it to
in_progress and remembers the page; the next publish that changes that page marks it fixed
(:func:`reconcile_applied`, from the publish and from every check). A fixed item whose problem comes
back reopens: event-based problems need fresh evidence from the days after it was fixed; build-based
ones (broken links in the pages, stale, heavy) need a publish after the fix that still has them. A
dismissed item stays dismissed. An open item no longer detected for QUIET_DAYS is closed as fixed
("no longer seen").
"""

from __future__ import annotations

import logging
import math
import re
import statistics
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher
from typing import Any

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo import ReturnDocument

from app.services import guide_insights as gi
from app.services import guide_signals as gs

log = logging.getLogger("markdrop.guide_fixes")

FIXES = "guide_fixes"
STATE = "guide_fix_state"

TYPES = ("drop", "search", "ask", "not_helpful", "video", "pdf", "broken", "stale", "heavy", "agent_unanswered",
         "agent_unfriendly")
STATUSES = ("open", "in_progress", "fixed", "dismissed")
DISMISS_REASONS = ("not_a_problem", "wont_fix", "duplicate", "other")

WINDOW_DAYS = 30
CHECK_EVERY = timedelta(hours=20)
MANUAL_CHECK_EVERY = timedelta(minutes=2)
QUIET_DAYS = 7
RECENCY_HALF_LIFE = 14.0
STALE_DAYS = 180
HISTORY_KEEP = 20
ITEMS_MAX = 300
RECHECK_GROUPS = 6

SEVERITY = {"drop": 0.6, "search": 0.7, "ask": 0.8, "not_helpful": 0.5, "video": 0.5, "pdf": 0.5, "broken": 1.0,
            "stale": 0.3, "heavy": 0.2, "agent_unanswered": 0.6, "agent_unfriendly": 0.4}
# Problems the live build has (re-checked against a publish), as opposed to ones readers report.
BUILD_TYPES = {"stale", "heavy", "agent_unfriendly"}

# drop
MIN_READS = 25
DROP_MIN_SHARE = 0.15
DROP_RATIO = 1.8
DROP_MARGIN = 0.08
DROP_MIN_READERS = 8
# video
VIDEO_MIN_PLAYS = 8
VIDEO_MIN_FALL = 0.15
# search / ask
SEARCH_MIN = 3
ASK_MIN = 2
CLUSTER_SIM = 0.5
SAMPLES = 6
# not helpful
HELPFUL_MIN_VOTES = 3
HELPFUL_MIN_NO = 2
HELPFUL_MAX_PCT = 60
# pdf
PDF_MIN = 15
PDF_MIN_SHARE = 0.2
PDF_MIN_READERS = 6
# agents
AGENT_ASK_MIN = 2
AGENT_READS_MIN = 10
AGENT_NO_HEADINGS_WORDS = 400
AGENT_MEDIA_HEAVY = 3
AGENT_MEDIA_WORDS = 150
# stale / heavy
STALE_MIN_READERS = 25
HEAVY_WORDS = 6000
HEAVY_MEDIA = 30
HEAVY_MIN_READERS = 10

# Addresses every guide serves besides its pages (the engine's own routes).
ENGINE_PATHS = ("/changelog", "/llms.txt", "/llms-full.txt", "/sitemap.xml", "/robots.txt", "/search-index.json",
                "/skill.md", "/mcp", "/md", "/og", "/docs-assets", "/api-reference", "/_next")


def now() -> datetime:
    return gi.now()


def aware(ts: datetime | None) -> datetime | None:
    if ts is None:
        return None
    return ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)


# ── Scoring ───────────────────────────────────────────────────────────────────


def recency(last_seen: datetime | None, at: datetime) -> float:
    """1.0 for evidence seen today, halving every RECENCY_HALF_LIFE days (never below 0.1)."""
    if last_seen is None:
        return 1.0
    days = max(0.0, (at - aware(last_seen)).total_seconds() / 86400)
    return max(0.1, 0.5 ** (days / RECENCY_HALF_LIFE))


def score(readers: float, severity: float, last_seen: datetime | None, at: datetime) -> tuple[float, float]:
    """(impact, recency): readers affected x severity x recency, one decimal."""
    r = recency(last_seen, at)
    return round(max(0.0, readers) * severity * r, 1), round(r, 3)


def level(impact: float, total_readers: int) -> str:
    if impact >= max(10.0, 0.05 * total_readers):
        return "high"
    if impact >= max(3.0, 0.01 * total_readers):
        return "medium"
    return "low"


# ── Text helpers ──────────────────────────────────────────────────────────────


def strip_frontmatter(md: str) -> str:
    if md.startswith("---"):
        m = re.match(r"^---\r?\n.*?\r?\n---\r?\n?", md, re.S)
        if m:
            return md[m.end():]
    return md


def headings_of(markdown: str) -> list[dict]:
    """[{id, text, depth, line}] of a page body, with the engine's ids (docs_index.scan_headings)."""
    from app.services.docs_index import scan_headings

    return [{"id": h.id, "text": h.text, "depth": h.depth, "line": h.line} for h in scan_headings(strip_frontmatter(markdown or ""))]


def section_of(markdown: str, section_id: str | None) -> dict | None:
    """The Markdown of one section (its heading to the next heading of the same or higher level),
    or of the introduction (``section_id`` None: everything before the first heading). Line
    numbers are in the body (frontmatter removed). None when the heading isn't there."""
    body = strip_frontmatter(markdown or "")
    lines = re.split(r"\r?\n", body)
    hs = headings_of(markdown)
    if section_id is None:
        end = hs[0]["line"] if hs else len(lines)
        return {"id": None, "heading": None, "depth": 0, "start": 0, "end": end,
                "markdown": "\n".join(lines[:end]).strip("\n")}
    for i, h in enumerate(hs):
        if h["id"] == section_id:
            end = next((o["line"] for o in hs[i + 1:] if o["depth"] <= h["depth"]), len(lines))
            return {"id": h["id"], "heading": h["text"], "depth": h["depth"], "start": h["line"], "end": end,
                    "markdown": "\n".join(lines[h["line"]:end]).strip("\n")}
    return None


def word_count(markdown: str) -> int:
    from app.services.docs_index import plain_text

    return len(plain_text(strip_frontmatter(markdown or "")).split())


_IMG = re.compile(r"!\[[^\]]*\]\([^)]+\)|::(?:video|clip|image|figure)\b", re.I)
_LINK = re.compile(r"\]\((/[^)\s#?]*)[^)]*\)|href=\"(/[^\"#?]*)[^\"]*\"")


def media_count(markdown: str) -> int:
    return len(_IMG.findall(markdown or ""))


def internal_links(markdown: str) -> list[str]:
    """Paths of the links in a page that point inside the guide ("/x/y"), code excluded."""
    from app.services.docs_index import walk_lines

    out: list[str] = []
    for raw, _i, code in walk_lines(strip_frontmatter(markdown or "")):
        if code:
            continue
        for m in _LINK.finditer(raw):
            p = (m.group(1) or m.group(2) or "").rstrip("/") or "/"
            if p.startswith("//"):
                continue
            out.append(p)
    return out


def humanize(ident: str) -> str:
    s = re.sub(r"[-_]+", " ", ident or "").strip()
    return s[:1].upper() + s[1:] if s else ident


def clock(seconds: float) -> str:
    s = max(0, int(round(seconds)))
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60}:{s % 60:02d}"


# ── Clustering (searches with no results, unanswered questions) ──────────────


# Words readers put in any question that say nothing about what it is about.
_QUESTION_STOP = frozenset({"support", "use", "work", "setup", "set", "way", "guide", "doc", "docs", "page", "help",
                            "find", "add", "change", "see", "show", "go", "anyone", "someone", "thank"})


def _tokens(text: str) -> frozenset[str]:
    from app.services.docs_index import tokenize

    return frozenset(t for t in tokenize(text) if t not in _QUESTION_STOP)


def idf_of(corpus: list[str]) -> dict[str, float]:
    df: dict[str, int] = {}
    for t in corpus:
        for w in _tokens(t):
            df[w] = df.get(w, 0) + 1
    n = max(1, len(corpus))
    return {w: math.log(1 + n / (1 + c)) + 0.1 for w, c in df.items()}


def similarity(a: frozenset[str], b: frozenset[str], idf: dict[str, float]) -> float:
    """Weighted Jaccard: rare shared words count, common ones ("connect", "set") barely do. A
    wording whose words are all in the other ("terraform" in "terraform provider") gets a little
    more, as long as its words carry enough of the other's weight."""
    if not a or not b:
        return 0.0
    w = lambda s: sum(idf.get(t, 1.0) for t in s)  # noqa: E731
    sim = w(a & b) / w(a | b)
    if a <= b or b <= a:
        small, large = (a, b) if a <= b else (b, a)
        sim = max(sim, min(1.0, w(small) / w(large) + 0.15))
    return sim


def cluster(entries: list[dict], *, corpus: list[str] | None = None, threshold: float = CLUSTER_SIM) -> list[dict]:
    """Group entries ({text, n, last?, page?}) that mean the same thing. Same words (case, spacing,
    trailing ?) always group; then each wording, most frequent first, joins the cluster whose
    representative (its most frequent wording) is most similar, if at least ``threshold``.

    Returns clusters, biggest first: {key, text, n, last, aliases, samples: [{text, n}], pages}."""
    groups: dict[str, dict] = {}
    for e in entries:
        key = gi._question_key(e.get("text") or "")
        if not key:
            continue
        g = groups.get(key)
        if g is None:
            g = groups[key] = {"key": key, "text": (e.get("text") or "").strip()[:300], "n": 0, "last": None, "pages": {}}
        g["n"] += int(e.get("n") or 1)
        last = aware(e.get("last"))
        if last and (g["last"] is None or last > g["last"]):
            g["last"] = last
        if e.get("page"):
            g["pages"][e["page"]] = g["pages"].get(e["page"], 0) + int(e.get("n") or 1)
    idf = idf_of([*(corpus or []), *(g["text"] for g in groups.values())])
    out: list[dict] = []
    for g in sorted(groups.values(), key=lambda g: (-g["n"], g["key"])):
        toks = _tokens(g["text"])
        best, best_sim = None, 0.0
        for c in out:
            s = similarity(toks, c["_toks"], idf)
            if s > best_sim:
                best, best_sim = c, s
        if best is not None and best_sim >= threshold:
            best["n"] += g["n"]
            best["aliases"].append(g["key"])
            best["samples"].append({"text": g["text"], "n": g["n"]})
            if g["last"] and (best["last"] is None or g["last"] > best["last"]):
                best["last"] = g["last"]
            for p, k in g["pages"].items():
                best["pages"][p] = best["pages"].get(p, 0) + k
        else:
            out.append({"key": g["key"], "text": g["text"], "n": g["n"], "last": g["last"], "aliases": [g["key"]],
                        "samples": [{"text": g["text"], "n": g["n"]}], "pages": dict(g["pages"]), "_toks": toks})
    for c in out:
        c.pop("_toks", None)
        c["samples"] = sorted(c["samples"], key=lambda s: (-s["n"], s["text"]))[:SAMPLES]
    return sorted(out, key=lambda c: (-c["n"], c["key"]))


# ── Detection (pure: data in, candidates out) ────────────────────────────────


def confidence(sample: float | None, need: float | None) -> str:
    """How sure an item is: its sample against the type's minimum (x4 high, x2 medium, else low).
    Deterministic findings (a link to a missing page, a page's age) pass no sample: high."""
    if sample is None or not need:
        return "high"
    r = sample / need
    return "high" if r >= 4 else "medium" if r >= 2 else "low"


def _cand(type_: str, key: str, *, path: str | None, title: str, summary: str, readers: float,
          evidence: dict, last: datetime | None, section: str | None = None, section_title: str | None = None,
          aliases: list[str] | None = None, severity: float | None = None, sample: float | None = None,
          need: float | None = None) -> dict:
    return {"type": type_, "key": key, "aliases": aliases or [key], "path": path, "section": section,
            "section_title": section_title, "title": title, "summary": summary, "readers": round(readers, 1),
            "severity": SEVERITY[type_] if severity is None else round(severity, 3), "evidence": evidence,
            "last_seen": aware(last), "confidence": confidence(sample, need),
            "sample": {"have": round(sample), "need": need} if sample is not None and need else None}


def _pct(x: float) -> int:
    return int(round(100 * x))


def _page_label(pages: dict, path: str | None) -> str:
    if path is None:
        return "the guide"
    return (pages.get(path) or {}).get("title") or path


def drop_curve(rec: dict, heading_titles: dict[str, str]) -> list[dict]:
    """A page's reading histogram → its curve: for the intro (-1), each section and the end, the
    share of measured readers who reached it and the share who left there."""
    n = int(rec.get("n") or 0)
    hist = {int(k): int(v) for k, v in (rec.get("hist") or {}).items()}
    total = sum(hist.values())
    out = []
    reached = total
    for k in range(-1, n + 1):
        left = hist.get(k, 0)
        sid = None if k < 0 or k >= n else (rec.get("ids") or {}).get(str(k))
        label = "Introduction" if k == -1 else "End of page" if k == n else (heading_titles.get(sid or "") or (humanize(sid) if sid else f"Section {k + 1}"))
        out.append({"i": k, "id": sid, "title": label, "reached": reached, "left": left if k < n else 0,
                    "reached_pct": _pct(reached / total) if total else 0, "left_pct": _pct(left / total) if total and k < n else 0})
        reached -= left
    return out


def detect_drops(data: dict) -> list[dict]:
    out = []
    for path, rec in (data.get("reading") or {}).items():
        n = int(rec.get("n") or 0)
        hist = {int(k): int(v) for k, v in (rec.get("hist") or {}).items()}
        total = sum(hist.values())
        if n < 3 or total < MIN_READS:
            continue
        positions = list(range(-1, n - 1))  # not the last section, not the end
        shares = {k: hist.get(k, 0) / total for k in positions}
        base = statistics.median(shares.values())
        page = (data.get("pages") or {}).get(path) or {}
        titles = {h["id"]: h["text"] for h in page.get("headings") or []}
        best = None
        for k in positions:
            s = shares[k]
            if s >= DROP_MIN_SHARE and s >= DROP_RATIO * base and s - base >= DROP_MARGIN and hist.get(k, 0) >= DROP_MIN_READERS:
                if best is None or s > shares[best]:
                    best = k
        if best is None:
            continue
        sid = None if best < 0 else (rec.get("ids") or {}).get(str(best))
        if best >= 0 and not sid:
            continue  # can't say which section (no beacon named it)
        stitle = "the introduction" if best < 0 else titles.get(sid) or humanize(sid)
        label = _page_label(data.get("pages") or {}, path)
        left = hist.get(best, 0)
        out.append(_cand(
            "drop", f"drop:{path}#{sid or '_intro'}", path=path, section=sid, section_title=stitle,
            title=f"Readers leave at “{stitle}”" if best >= 0 else f"Readers leave “{label}” before the first section",
            summary=f"{_pct(shares[best])}% of readers stop here on “{label}”; on the rest of the page it’s about {_pct(base)}% per section.",
            readers=left, last=data.get("now"), severity=SEVERITY["drop"] * (0.7 if best < 0 else 1.0),
            sample=total, need=MIN_READS,
            evidence={"measured": total, "left": left, "left_pct": _pct(shares[best]), "typical_pct": _pct(base),
                      "curve": drop_curve(rec, titles), "seconds": round(rec.get("t", 0) / total) if total else None}))
    return out


def detect_searches(data: dict) -> list[dict]:
    rows = data.get("empty_searches") or []
    corpus = [p.get("title") or "" for p in (data.get("pages") or {}).values()]
    out = []
    for c in cluster([{"text": r["q"], "n": r["n"], "last": r.get("last")} for r in rows], corpus=corpus):
        if c["n"] < SEARCH_MIN:
            continue
        others = len(c["aliases"]) - 1
        out.append(_cand(
            "search", f"search:{c['key']}", aliases=[f"search:{a}" for a in c["aliases"]], path=None,
            title=f"People search for “{c['text']}” and find nothing",
            summary=f"{c['n']} searches found no results" + (f" ({others + 1} wordings)" if others else "") + ".",
            readers=c["n"], last=c["last"], sample=c["n"], need=SEARCH_MIN,
            evidence={"searches": c["n"], "samples": c["samples"], "wordings": len(c["aliases"])}))
    return out


def detect_asks(data: dict) -> list[dict]:
    qs = data.get("questions") or []
    corpus = [p.get("title") or "" for p in (data.get("pages") or {}).values()] + [q["q"] for q in data.get("asked") or []]
    out = []
    for c in cluster([{"text": q["q"], "n": 1, "last": q.get("ts"), "page": q.get("page")} for q in qs], corpus=corpus):
        if c["n"] < ASK_MIN:
            continue
        page = max(c["pages"].items(), key=lambda kv: kv[1])[0] if c["pages"] else None
        out.append(_cand(
            "ask", f"ask:{c['key']}", aliases=[f"ask:{a}" for a in c["aliases"]],
            path=page if page in (data.get("pages") or {}) else None,
            title=f"Ask AI couldn’t answer “{c['text']}”",
            summary=f"Asked {c['n']} times without an answer" + (f", in {len(c['aliases'])} wordings" if len(c["aliases"]) > 1 else "") + ".",
            readers=c["n"], last=c["last"], sample=c["n"], need=ASK_MIN,
            evidence={"questions": c["n"], "samples": c["samples"], "pages": [
                {"path": p, "title": _page_label(data.get("pages") or {}, p), "n": k}
                for p, k in sorted(c["pages"].items(), key=lambda kv: -kv[1])[:5]]}))
    return out


def detect_not_helpful(data: dict) -> list[dict]:
    out = []
    pages = data.get("pages") or {}
    for path, (yes, no) in (data.get("votes") or {}).items():
        votes = yes + no
        pct = round(100 * yes / votes) if votes else None
        if votes < HELPFUL_MIN_VOTES or no < HELPFUL_MIN_NO or pct is None or pct > HELPFUL_MAX_PCT:
            continue
        comments = (data.get("comments") or {}).get(path) or []
        last = max((aware(c["ts"]) for c in comments if c.get("ts")), default=None) or (data.get("vote_last") or {}).get(path)
        readers = max(no, (pages.get(path) or {}).get("readers", 0) * no / votes)
        label = _page_label(pages, path)
        out.append(_cand(
            "not_helpful", f"helpful:{path}", path=path,
            title=f"“{label}” marked not helpful",
            summary=f"{no} of {votes} readers said it didn’t help ({pct}% helpful)" + (f"; {len(comments)} left a comment." if comments else "."),
            readers=readers, last=last, severity=SEVERITY["not_helpful"] * (1 + no / votes),
            sample=votes, need=HELPFUL_MIN_VOTES,
            evidence={"yes": yes, "no": no, "helpful_pct": pct, "comments": [
                {"id": c.get("id"), "text": c["comment"], "ts": gi.iso(aware(c.get("ts")))} for c in comments[:SAMPLES]]}))
    return out


def video_fall(curve: list[int], plays: int) -> tuple[int, float, float] | None:
    """(slice, fall, average fall) of the steepest drop over two slices (5%), outside the last
    12.5%; None when nothing stands out."""
    if plays <= 0 or len(curve) < gs.SLICES:
        return None
    r = [min(1.0, c / plays) for c in curve]
    end = gs.SLICES - 5  # slices 35..39 are the ending
    falls = [(b, r[b - 1] - r[b + 1]) for b in range(1, end)]
    if not falls:
        return None
    avg = max(0.0, (r[0] - r[end]) / ((end - 1) / 2))
    b, fall = max(falls, key=lambda x: (x[1], -x[0]))
    if fall >= VIDEO_MIN_FALL and fall >= 2 * avg:
        return b, fall, avg
    return None


def detect_videos(data: dict) -> list[dict]:
    out = []
    titles = data.get("video_titles") or {}
    pages = data.get("pages") or {}
    for vid, v in (data.get("videos") or {}).items():
        plays = int(v.get("plays") or 0)
        if plays < VIDEO_MIN_PLAYS:
            continue
        hit = video_fall(v.get("curve") or [], plays)
        if hit is None:
            continue
        b, fall, avg = hit
        length = int(v.get("l") or 0)
        at = length * b / gs.SLICES
        title = titles.get(vid) or v.get("name") or humanize(vid.removeprefix("embed:"))
        page = max((v.get("pages") or {}).items(), key=lambda kv: kv[1])[0] if v.get("pages") else None
        lost = round(plays * fall)
        out.append(_cand(
            "video", f"video:{vid}", path=page,
            title=f"“{title}” loses most viewers at {clock(at)}",
            summary=f"{_pct(fall)}% of viewers stop around {clock(at)} of {clock(length)}" + (f" on “{_page_label(pages, page)}”." if page else "."),
            readers=lost, last=data.get("now"), sample=plays, need=VIDEO_MIN_PLAYS,
            evidence={"embed": vid.startswith("embed:"), "video": vid, "video_title": title, "plays": plays, "length": length, "at": round(at, 1),
                      "fall_pct": _pct(fall), "typical_pct": _pct(avg),
                      "curve": [_pct(min(1.0, c / plays)) for c in v.get("curve") or []]}))
    return out


def closest_path(target: str, paths: list[str]) -> str | None:
    best, best_r = None, 0.0
    for p in paths:
        r = SequenceMatcher(None, target, p).ratio()
        tail = target.rsplit("/", 1)[-1]
        if tail and tail == p.rsplit("/", 1)[-1]:
            r += 0.3
        if r > best_r:
            best, best_r = p, r
    return best if best_r >= 0.55 else None


def known_path(p: str, paths: set[str], redirects: set[str]) -> bool:
    return p in paths or p in redirects or any(p == e or p.startswith(e + "/") for e in ENGINE_PATHS)


def detect_broken(data: dict) -> list[dict]:
    pages = data.get("pages") or {}
    paths = set(pages)
    redirects = set(data.get("redirects") or [])
    acc: dict[str, dict] = {}
    for h in data.get("broken_hits") or []:
        p = h["p"]
        if known_path(p, paths, redirects):
            continue  # it exists now (published since)
        a = acc.setdefault(p, {"hits": 0, "from": {}, "last": None, "links": []})
        a["hits"] += int(h.get("n") or 0)
        if h.get("f") and h["f"] in paths:
            a["from"][h["f"]] = a["from"].get(h["f"], 0) + int(h.get("n") or 0)
        last = aware(h.get("last"))
        if last and (a["last"] is None or last > a["last"]):
            a["last"] = last
    for link in data.get("links") or []:
        if known_path(link["target"], paths, redirects):
            continue
        a = acc.setdefault(link["target"], {"hits": 0, "from": {}, "last": None, "links": []})
        if link["page"] not in a["links"]:
            a["links"].append(link["page"])
    out = []
    for target, a in acc.items():
        if not a["links"] and a["hits"] < 2 and not a["from"]:
            continue
        on = a["links"] or sorted(a["from"], key=lambda p: -a["from"][p])
        page = on[0] if on else None
        fix = closest_path(target, sorted(paths))
        page_readers = sum((pages.get(p) or {}).get("readers", 0) for p in a["links"])
        readers = a["hits"] if a["hits"] else 0.1 * page_readers
        where = f" on “{_page_label(pages, page)}”" if page else ""
        out.append(_cand(
            "broken", f"broken:{target}", path=page,
            title=f"Broken link to {target}",
            summary=(f"{a['hits']} readers hit a page that doesn’t exist" if a["hits"] else "A link points to a page that doesn’t exist") + where + ".",
            readers=max(readers, 1), last=a["last"] or data.get("now"),
            sample=a["hits"] if a["hits"] and not a["links"] else None, need=2 if a["hits"] and not a["links"] else None,
            severity=SEVERITY["broken"] if a["hits"] else 0.6,
            evidence={"target": target, "hits": a["hits"], "suggested": fix,
                      "pages": [{"path": p, "title": _page_label(pages, p), "link": p in a["links"], "hits": a["from"].get(p, 0)}
                                for p in list(dict.fromkeys([*a["links"], *a["from"]]))[:6]]}))
    return out


def detect_stale(data: dict) -> list[dict]:
    pages = data.get("pages") or {}
    at = data.get("now") or now()
    read = sorted((p.get("readers", 0) for p in pages.values() if p.get("readers")), reverse=True)
    half = read[len(read) // 2] if read else 0
    out = []
    for path, p in pages.items():
        upd = aware(p.get("updated_at"))
        readers = p.get("readers", 0)
        if not upd or readers < STALE_MIN_READERS or readers < half:
            continue
        age = (at - upd).days
        if age < STALE_DAYS:
            continue
        months = age // 30
        out.append(_cand(
            "stale", f"stale:{path}", path=path,
            title=f"“{p.get('title') or path}” hasn’t been updated in {months} months",
            summary=f"Last edited {upd.date().isoformat()}, and {readers} readers opened it in the last {WINDOW_DAYS} days.",
            readers=readers, last=at, evidence={"updated_at": gi.iso(upd), "age_days": age, "readers": readers}))
    return out


def detect_heavy(data: dict) -> list[dict]:
    out = []
    for path, p in (data.get("pages") or {}).items():
        words, media = p.get("words", 0), p.get("media", 0)
        readers = p.get("readers", 0)
        if readers < HEAVY_MIN_READERS or (words < HEAVY_WORDS and media < HEAVY_MEDIA):
            continue
        what = ", ".join(x for x in (f"{words:,} words" if words >= HEAVY_WORDS else "",
                                      f"{media} images and videos" if media >= HEAVY_MEDIA else "") if x)
        out.append(_cand(
            "heavy", f"heavy:{path}", path=path,
            title=f"“{p.get('title') or path}” is long and heavy",
            summary=f"{what}: slow on phones and hard to scan. Consider splitting it.",
            readers=readers, last=data.get("now"), evidence={"words": words, "media": media, "readers": readers}))
    return out


def detect_pdfs(data: dict) -> list[dict]:
    """Embedded PDFs: the page most readers stop at, against the document's own curve."""
    out = []
    pages = data.get("pages") or {}
    for pid, d in (data.get("pdfs") or {}).items():
        n = int(d.get("n") or 0)
        hist = {int(k): int(v) for k, v in (d.get("hist") or {}).items() if str(k).isdigit()}
        total = sum(hist.values())
        if n < 3 or total < PDF_MIN:
            continue
        positions = list(range(1, n))  # the last page is finishing
        shares = {r: hist.get(r, 0) / total for r in positions}
        base = statistics.median(shares.values())
        best = None
        for r in positions:
            s = shares[r]
            if s >= PDF_MIN_SHARE and s >= DROP_RATIO * base and s - base >= DROP_MARGIN and hist.get(r, 0) >= PDF_MIN_READERS:
                if best is None or s > shares[best]:
                    best = r
        if best is None:
            continue
        name = d.get("name") or humanize(pid)
        page = max((d.get("pages") or {}).items(), key=lambda kv: kv[1])[0] if d.get("pages") else None
        reached, curve = total, []
        for r in range(1, n + 1):
            curve.append({"page": r, "reached_pct": _pct(reached / total), "left_pct": _pct(hist.get(r, 0) / total) if r < n else 0})
            reached -= hist.get(r, 0)
        out.append(_cand(
            "pdf", f"pdf:{pid}", path=page,
            title=f"Readers stop at page {best} of “{name}”",
            summary=f"{_pct(shares[best])}% of readers go no further than page {best} of {n}; about {_pct(base)}% stop at a typical page.",
            readers=hist.get(best, 0), last=data.get("now"), sample=total, need=PDF_MIN,
            evidence={"embed": pid, "name": name, "pages_total": n, "page": best, "readers_pdf": total,
                      "left_pct": _pct(shares[best]), "typical_pct": _pct(base), "curve": curve[:200]}))
    return out


def detect_agent_searches(data: dict) -> list[dict]:
    """What AI agents searched the docs for (the docs MCP server) and found nothing."""
    rows = data.get("agent_searches") or []
    corpus = [p.get("title") or "" for p in (data.get("pages") or {}).values()]
    out = []
    for c in cluster([{"text": r["q"], "n": r["n"], "last": r.get("last")} for r in rows], corpus=corpus):
        if c["n"] < AGENT_ASK_MIN:
            continue
        out.append(_cand(
            "agent_unanswered", f"agent_unanswered:{c['key']}", aliases=[f"agent_unanswered:{a}" for a in c["aliases"]], path=None,
            title=f"Agents search for “{c['text']}” and nothing answers it",
            summary=f"AI assistants searched your docs for this {c['n']} times through the docs MCP server and found nothing.",
            readers=c["n"], last=c["last"], sample=c["n"], need=AGENT_ASK_MIN,
            evidence={"searches": c["n"], "samples": c["samples"], "wordings": len(c["aliases"])}))
    return out


def agent_reads(data: dict) -> dict[str, dict]:
    """page path → {n, families: {name: n}, via: {page|markdown: n}} over the window."""
    out: dict[str, dict] = {}
    for r in data.get("agents") or []:
        p = r.get("p")
        if not p or r.get("via") in ("llms", "mcp"):
            continue
        a = out.setdefault(p, {"n": 0, "families": {}, "via": {}})
        a["n"] += int(r.get("n") or 0)
        a["families"][r.get("a") or "Other"] = a["families"].get(r.get("a") or "Other", 0) + int(r.get("n") or 0)
        a["via"][r.get("via") or "page"] = a["via"].get(r.get("via") or "page", 0) + int(r.get("n") or 0)
    return out


def detect_agent_unfriendly(data: dict) -> list[dict]:
    """Pages agents read that are hard for them to use."""
    out = []
    pages = data.get("pages") or {}
    for path, a in agent_reads(data).items():
        p = pages.get(path)
        if not p or a["n"] < AGENT_READS_MIN:
            continue
        words, media = p.get("words", 0), p.get("media", 0)
        heads = [h for h in p.get("headings") or [] if h.get("depth") in (2, 3)]
        why = None
        if p.get("hidden"):
            why = ("hidden", "it’s hidden, so it isn’t in llms.txt or the sidebar, and agents can’t find it from there")
        elif media >= AGENT_MEDIA_HEAVY and words < AGENT_MEDIA_WORDS:
            why = ("media", f"most of it is in {media} images or videos, with only {words} words of text they can read")
        elif words >= AGENT_NO_HEADINGS_WORDS and not heads:
            why = ("no_headings", f"it’s {words:,} words with no headings, so they can’t jump to the part that answers the question")
        if why is None:
            continue
        label = p.get("title") or path
        fams = sorted(a["families"].items(), key=lambda kv: -kv[1])
        out.append(_cand(
            "agent_unfriendly", f"agent_unfriendly:{path}", path=path,
            title=f"Agents read “{label}” but it’s hard for them to use",
            summary=f"AI agents read it {a['n']} times, but {why[1]}.",
            readers=a["n"], last=data.get("now"),
            evidence={"reason": why[0], "agent_reads": a["n"], "families": [{"name": k, "n": v} for k, v in fams[:6]],
                      "via": a["via"], "words": words, "media": media, "headings": len(heads)}))
    return out


DETECTORS = (detect_drops, detect_searches, detect_asks, detect_not_helpful, detect_videos, detect_pdfs, detect_broken,
             detect_stale, detect_heavy, detect_agent_searches, detect_agent_unfriendly)


def pending(data: dict, limit: int = 12) -> list[dict]:
    """What's collecting toward a minimum and can't be judged yet ("needs more readers"): pages
    measured fewer than MIN_READS times, videos and PDFs under theirs, pages with a few votes."""
    out = []
    pages = data.get("pages") or {}
    for path, rec in (data.get("reading") or {}).items():
        total = sum(int(v) for v in (rec.get("hist") or {}).values())
        if 0 < total < MIN_READS and int(rec.get("n") or 0) >= 3:
            out.append({"type": "drop", "path": path, "title": _page_label(pages, path), "have": total, "need": MIN_READS})
    for vid, v in (data.get("videos") or {}).items():
        plays = int(v.get("plays") or 0)
        if 0 < plays < VIDEO_MIN_PLAYS:
            out.append({"type": "video", "path": None, "title": (data.get("video_titles") or {}).get(vid) or v.get("name")
                        or humanize(vid.removeprefix("embed:")), "have": plays, "need": VIDEO_MIN_PLAYS})
    for pid, d in (data.get("pdfs") or {}).items():
        total = sum(int(c) for c in (d.get("hist") or {}).values())
        if 0 < total < PDF_MIN:
            out.append({"type": "pdf", "path": None, "title": d.get("name") or humanize(pid), "have": total, "need": PDF_MIN})
    for path, (yes, no) in (data.get("votes") or {}).items():
        if no and yes + no < HELPFUL_MIN_VOTES:
            out.append({"type": "not_helpful", "path": path, "title": _page_label(pages, path), "have": yes + no,
                        "need": HELPFUL_MIN_VOTES})
    return sorted(out, key=lambda x: (-x["have"] / x["need"], x["title"] or ""))[:limit]


def agents_summary(data: dict) -> dict:
    """AI agents over the window, apart from readers: total reads, by family, by how they read,
    and the pages they read most."""
    fam: dict[str, int] = {}
    via: dict[str, int] = {}
    for r in data.get("agents") or []:
        n = int(r.get("n") or 0)
        fam[r.get("a") or "Other"] = fam.get(r.get("a") or "Other", 0) + n
        via[r.get("via") or "page"] = via.get(r.get("via") or "page", 0) + n
    pages = data.get("pages") or {}
    top = sorted(agent_reads(data).items(), key=lambda kv: -kv[1]["n"])[:8]
    return {"total": sum(fam.values()), "families": [{"name": k, "n": v} for k, v in sorted(fam.items(), key=lambda kv: -kv[1])[:8]],
            "via": via, "pages": [{"path": p, "title": _page_label(pages, p), "n": a["n"]} for p, a in top],
            "readers": int(data.get("total_readers") or 0)}


def detect_all(data: dict) -> list[dict]:
    """Every candidate problem in ``data`` (see :func:`gather`), scored, biggest impact first."""
    at = data.get("now") or now()
    total = int(data.get("total_readers") or 0)
    out = []
    for fn in DETECTORS:
        try:
            found = fn(data)
        except Exception:
            log.warning("fix list: %s failed", fn.__name__, exc_info=True)
            continue
        for c in found:
            c["impact"], c["recency"] = score(c["readers"], c["severity"], c["last_seen"], at)
            c["level"] = level(c["impact"], total)
            p = (data.get("pages") or {}).get(c["path"] or "") or {}
            c["page_id"] = p.get("page_id")
            c["page_title"] = p.get("title")
            if c.get("sample"):
                c["evidence"] = {**c["evidence"], "sample": c["sample"]}
            out.append(c)
    return sorted(out, key=lambda c: (-c["impact"], c["key"]))


# ── Gathering the data ────────────────────────────────────────────────────────


def window_days(at: datetime, n: int = WINDOW_DAYS, after: datetime | None = None) -> list[str]:
    days = [gi.day_key(at - timedelta(days=i)) for i in range(n - 1, -1, -1)]
    if after is not None:
        first = gi.day_key(aware(after))
        days = [d for d in days if d > first]
    return days


async def gather(db: AsyncIOMotorDatabase, site_row: dict, *, at: datetime | None = None,
                 after: datetime | None = None, base: dict | None = None) -> dict:
    """Everything the detectors read, for the guide's last WINDOW_DAYS days (only the days after
    ``after`` when given: a fixed item's re-check). ``base``: a gather already made this run, whose
    build-side parts (pages, links, titles) are reused."""
    from app.services import ai_usage, docs_agent
    from app.services.docs_site_pages import live_snapshot
    from app.services.docs_site_store import PAGES

    at = at or now()
    site = str(site_row["_id"])
    days = window_days(at, after=after)
    since = gi._day_start(days[0]) if days else at
    data: dict = {"now": at, "days": days, "since": since}
    if not days:
        return {**data, **{k: v for k, v in (base or {}).items() if k in ("pages", "links", "redirects", "video_titles")},
                "total_readers": 0}

    t = await gi.traffic(db, site, days)
    readers = {p["k"]: int(p.get("v") or 0) or int(p.get("n") or 0) for p in t["pages"]}
    data["total_readers"] = int(t["visitors"]) or int(t["views"])

    if base is not None:
        pages = {p: {**v, "readers": readers.get(p, 0)} for p, v in base["pages"].items()}
        data.update(links=base["links"], redirects=base["redirects"], video_titles=base["video_titles"])
    else:
        pages = {}
        snap = await live_snapshot(db, site_row, markdown=True)
        drafts = {str(r["_id"]): r async for r in db[PAGES].find(
            {"site_id": site_row["_id"], "deleted_at": None}, {"path": 1, "title": 1, "draft.updated_at": 1}).limit(5000)}
        links = []
        for p in (snap or {}).get("pages") or []:
            path = p.get("path")
            if not path:
                continue
            md = p.get("markdown") or ""
            d = drafts.get(p.get("page_id") or "") or {}
            pages[path] = {"title": p.get("title") or d.get("title"), "page_id": p.get("page_id"), "hidden": bool(p.get("hidden")),
                           "readers": readers.get(path, 0), "headings": headings_of(md), "words": word_count(md),
                           "media": media_count(md), "hash": p.get("hash"),
                           "updated_at": aware((d.get("draft") or {}).get("updated_at"))}
            for target in internal_links(md):
                links.append({"page": path, "target": target})
        settings = site_row.get("settings") or {}
        extra = site_row.get("engine_extra") or {}
        redirects = set()
        for r in [*(settings.get("redirects") or []), *(extra.get("redirects") or [])]:
            src = r.get("from") or r.get("source") if isinstance(r, dict) else None
            if isinstance(src, str):
                redirects.add(src.rstrip("/") or "/")
        vids = extra.get("videos") if isinstance(extra.get("videos"), dict) else {}
        data.update(links=links, redirects=sorted(redirects),
                    video_titles={k: (v or {}).get("title") for k, v in vids.items() if isinstance(v, dict) and v.get("title")})
    data["pages"] = pages

    sig = await gs.window(db, site, days)
    data["reading"] = sig["reading"]
    data["videos"] = sig["videos"]
    data["broken_hits"] = sig["broken"]
    data["copies"] = sig["copies"]
    data["pdfs"] = sig.get("pdfs") or {}
    data["agents"] = sig.get("agents") or []
    data["agent_searches"] = [{**a, "last": aware(a.get("last"))} for a in sig.get("agent_searches") or []]

    data["empty_searches"] = [{"q": r["_id"], "n": int(r["n"]), "last": aware(r["last"])} async for r in db[gi.RAW].aggregate([
        {"$match": {"site": site, "day": {"$in": days}, "k": "search", "n": 0}},
        {"$group": {"_id": "$q", "n": {"$sum": 1}, "last": {"$max": "$ts"}}},
        {"$sort": {"n": -1}}, {"$limit": 2000},
    ]) if r["_id"]]
    if not data["empty_searches"]:
        # Rolled-up days only (raw events gone): counts without times.
        data["empty_searches"] = [{"q": e["q"], "n": e["n"], "last": None} for e in t["empty"]]

    window = {"$gte": since}
    asked, missed = [], []
    async for r in db[ai_usage.REQUESTS].find(
            {"feature": docs_agent.FEATURE, "site": site, "ts": window, "insights": True,
             "outcome": {"$in": ["answered", "no_answer"]}},
            {"question": 1, "outcome": 1, "ts": 1, "page_path": 1}).sort("ts", -1).limit(gi.QUESTIONS_SCAN):
        q = (r.get("question") or "").strip()
        if not q:
            continue
        row = {"q": q[:300], "ts": aware(r.get("ts")), "page": r.get("page_path")}
        (missed if r.get("outcome") == "no_answer" else asked).append(row)
    data["questions"] = missed
    data["asked"] = asked

    votes: dict[str, tuple[int, int]] = {}
    vote_last: dict[str, datetime] = {}
    async for r in db[gi.FEEDBACK].aggregate([
        {"$match": {"site": site, "ts": window}},
        {"$group": {"_id": "$path", "yes": {"$sum": {"$cond": ["$helpful", 1, 0]}},
                    "no": {"$sum": {"$cond": ["$helpful", 0, 1]}}, "last": {"$max": "$ts"}}},
    ]):
        if r["_id"]:
            votes[r["_id"]] = (int(r["yes"]), int(r["no"]))
            vote_last[r["_id"]] = aware(r["last"])
    comments: dict[str, list] = {}
    async for r in db[gi.FEEDBACK].find({"site": site, "ts": window, "helpful": False, "comment": {"$ne": None},
                                         "resolved": False}).sort("ts", -1).limit(500):
        comments.setdefault(r["path"], []).append({"id": str(r["_id"]), "comment": r["comment"], "ts": r["ts"]})
    data.update(votes=votes, vote_last=vote_last, comments=comments)
    return data


# ── The store ─────────────────────────────────────────────────────────────────


def _history(status: str, by: str, note: str | None, at: datetime) -> dict:
    return {"at": at, "status": status, "by": by, **({"note": note} if note else {})}


def _push_history(entry: dict) -> dict:
    return {"$each": [entry], "$slice": -HISTORY_KEEP}


FIELDS = ("type", "path", "page_id", "page_title", "section", "section_title", "title", "summary", "readers",
          "severity", "recency", "impact", "level", "evidence", "confidence")


def _match(items: list[dict], c: dict) -> dict | None:
    for it in items:
        if it["type"] != c["type"]:
            continue
        if it["key"] == c["key"] or it["key"] in c["aliases"] or c["key"] in (it.get("aliases") or []):
            return it
    return None


def recurred(item: dict, recheck: dict[str, set[str]], published_after_fix: bool) -> bool:
    """Is a fixed item's problem back? ``recheck``: fixed day → the keys detected over only the
    days after it (event-based problems); build-based problems need a publish after the fix."""
    if item["type"] in BUILD_TYPES or (item["type"] == "broken" and not (item.get("evidence") or {}).get("hits")):
        return published_after_fix
    fixed = aware(item.get("fixed_at"))
    keys = recheck.get(gi.day_key(fixed)) if fixed else None
    if keys is None:
        return False
    return item["key"] in keys or any(a in keys for a in item.get("aliases") or [])


async def reconcile(db: AsyncIOMotorDatabase, site: str, candidates: list[dict], *, at: datetime,
                    recheck: dict[str, set[str]] | None = None, last_published: datetime | None = None) -> dict:
    """Write one detection run: new problems open, known ones get fresh evidence, fixed ones that
    came back reopen, open ones not seen for QUIET_DAYS close. Returns counts."""
    items = await db[FIXES].find({"site": site}).to_list(ITEMS_MAX * 4)
    seen: set = set()
    stats = {"new": 0, "updated": 0, "reopened": 0, "closed": 0}
    for c in candidates[:ITEMS_MAX]:
        it = _match(items, c)
        sets = {k: c.get(k) for k in FIELDS}
        sets.update(last_seen_at=c.get("last_seen"), checked_at=at, quiet_since=None)
        if it is None:
            doc = {"site": site, "key": c["key"], "aliases": c["aliases"], **sets, "status": "open", "status_at": at,
                   "detected_at": at, "reopened": 0, "history": [_history("open", "detector", None, at)]}
            res = await db[FIXES].insert_one(doc)
            doc["_id"] = res.inserted_id
            items.append(doc)
            seen.add(res.inserted_id)
            stats["new"] += 1
            continue
        if it["_id"] in seen:
            continue  # two candidates matched one item (a cluster split): the first, biggest wins
        seen.add(it["_id"])
        update: dict = {"$set": sets, "$addToSet": {"aliases": {"$each": c["aliases"]}}}
        if it.get("status") == "fixed":
            pub = bool(last_published and it.get("fixed_at") and aware(last_published) > aware(it["fixed_at"]))
            if recurred({**it, **sets}, recheck or {}, pub):
                update["$set"].update(status="open", status_at=at, reopened_at=at, applied=None)
                update["$inc"] = {"reopened": 1}
                update["$push"] = {"history": _push_history(_history("open", "detector", "Came back after it was fixed", at))}
                stats["reopened"] += 1
        await db[FIXES].update_one({"_id": it["_id"]}, update)
        stats["updated"] += 1
    quiet_before = at - timedelta(days=QUIET_DAYS)
    for it in items:
        if it["_id"] in seen or it.get("status") not in ("open", "in_progress"):
            continue
        q = aware(it.get("quiet_since"))
        if q is None:
            await db[FIXES].update_one({"_id": it["_id"]}, {"$set": {"quiet_since": at}})
        elif q <= quiet_before and it.get("status") == "open":
            await db[FIXES].update_one({"_id": it["_id"]}, {
                "$set": {"status": "fixed", "status_at": at, "fixed_at": at, "fixed_by": "detector"},
                "$push": {"history": _push_history(_history("fixed", "detector", f"Not seen for {QUIET_DAYS} days", at))}})
            stats["closed"] += 1
    return stats


async def reconcile_applied(db: AsyncIOMotorDatabase, site_row: dict, at: datetime | None = None) -> int:
    """In-progress items whose drafted fix was applied in the editor: fixed once a publish after
    that changed the page (or, for a new page, put it live). Returns how many it marked fixed."""
    from app.services.docs_site_pages import live_snapshot

    at = at or now()
    site = str(site_row["_id"])
    pending = await db[FIXES].find({"site": site, "status": "in_progress", "applied.page_id": {"$ne": None}}).to_list(200)
    published = aware(site_row.get("last_published_at"))
    if not pending or not published:
        return 0
    snap = await live_snapshot(db, site_row)
    hashes = {p.get("page_id"): p.get("hash") for p in (snap or {}).get("pages") or []}
    number = None
    if site_row.get("live_build_id"):
        from app.services.docs_site_store import BUILDS

        b = await db[BUILDS].find_one({"_id": site_row["live_build_id"]}, {"number": 1})
        number = (b or {}).get("number")
    done = 0
    for it in pending:
        ap = it.get("applied") or {}
        when = aware(ap.get("at"))
        pid = ap.get("page_id")
        if not when or published <= when or pid not in hashes or hashes[pid] == ap.get("live_hash"):
            continue
        note = f"Published in #{number}" if number else "Published"
        await db[FIXES].update_one({"_id": it["_id"], "status": "in_progress"}, {
            "$set": {"status": "fixed", "status_at": at, "fixed_at": at, "fixed_by": "publish", "fixed_build": number},
            "$push": {"history": _push_history(_history("fixed", "publish", note, at))}})
        done += 1
    return done


async def state(db: AsyncIOMotorDatabase, site: str) -> dict:
    return await db[STATE].find_one({"_id": site}) or {}


async def check(db: AsyncIOMotorDatabase, site_row: dict, *, at: datetime | None = None) -> dict:
    """One detection run for a guide: gather, detect, re-check what was fixed, write."""
    at = at or now()
    site = str(site_row["_id"])
    data = await gather(db, site_row, at=at)
    candidates = detect_all(data)
    fixed = await db[FIXES].find({"site": site, "status": "fixed", "fixed_at": {"$gte": at - timedelta(days=WINDOW_DAYS)}},
                                 {"fixed_at": 1}).to_list(500)
    recheck: dict[str, set[str]] = {}
    for day in sorted({gi.day_key(aware(f["fixed_at"])) for f in fixed}, reverse=True)[:RECHECK_GROUPS]:
        sub = await gather(db, site_row, at=at, after=gi._day_start(day), base=data)
        recheck[day] = {k for c in detect_all(sub) if c["type"] not in BUILD_TYPES for k in c["aliases"]}
    stats = await reconcile(db, site, candidates, at=at, recheck=recheck,
                            last_published=aware(site_row.get("last_published_at")))
    stats["fixed_by_publish"] = await reconcile_applied(db, site_row, at)
    await db[STATE].update_one({"_id": site}, {"$set": {"checked_at": at, "stats": stats,
                                                        "readers": data.get("total_readers", 0),
                                                        "pending": pending(data), "agents": agents_summary(data)}},
                               upsert=True)
    return stats


async def check_if_due(db: AsyncIOMotorDatabase, site_row: dict) -> bool:
    st = await state(db, str(site_row["_id"]))
    last = aware(st.get("checked_at"))
    if last and now() - last < CHECK_EVERY:
        return False
    await check(db, site_row)
    return True


async def check_due(db: AsyncIOMotorDatabase) -> int:
    """The background job: every guide with Insights on that had readers lately (or open items),
    checked once a day."""
    from app.services.docs_site_store import SITES

    since = gi.day_key(now() - timedelta(days=WINDOW_DAYS))
    active = set(await db[gi.RAW].distinct("site", {"day": {"$gte": since}}))
    active |= set(await db[gi.DAILY].distinct("site", {"day": {"$gte": since}}))
    active |= set(await db[FIXES].distinct("site", {"status": {"$in": ["open", "in_progress"]}}))
    n = 0
    for sid in sorted(active):
        if not ObjectId.is_valid(sid):
            continue
        row = await db[SITES].find_one({"_id": ObjectId(sid), "deleted_at": None})
        if not row or not gi.enabled(row):
            continue
        try:
            n += await check_if_due(db, row)
        except Exception:
            log.warning("fix list check failed for %s", sid, exc_info=True)
    return n


# ── Views and changes ─────────────────────────────────────────────────────────


def _iso_deep(v: Any) -> Any:
    if isinstance(v, datetime):
        return gi.iso(v)
    if isinstance(v, dict):
        return {k: _iso_deep(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_iso_deep(x) for x in v]
    if isinstance(v, ObjectId):
        return str(v)
    return v


def view(it: dict, *, full: bool = False) -> dict:
    out = {
        "id": str(it["_id"]), "type": it["type"], "key": it["key"], "status": it.get("status", "open"),
        "title": it.get("title"), "summary": it.get("summary"), "path": it.get("path"), "page_id": it.get("page_id"),
        "page_title": it.get("page_title"), "section": it.get("section"), "section_title": it.get("section_title"),
        "readers": it.get("readers", 0), "severity": it.get("severity", 0), "recency": it.get("recency", 1),
        "impact": it.get("impact", 0), "level": it.get("level", "low"), "confidence": it.get("confidence") or "high",
        "detected_at": gi.iso(aware(it.get("detected_at"))), "last_seen_at": gi.iso(aware(it.get("last_seen_at"))),
        "status_at": gi.iso(aware(it.get("status_at"))), "reason": it.get("reason"), "note": it.get("note"),
        "reopened": int(it.get("reopened") or 0), "fixed_by": it.get("fixed_by"), "fixed_build": it.get("fixed_build"),
        "quiet": it.get("quiet_since") is not None, "has_draft": bool(it.get("draft")),
        "applied": _iso_deep(it.get("applied")) if it.get("applied") else None,
    }
    if full:
        out["evidence"] = _iso_deep(it.get("evidence") or {})
        out["history"] = _iso_deep(it.get("history") or [])
        out["draft"] = _iso_deep(it.get("draft")) if it.get("draft") else None
    else:
        ev = it.get("evidence") or {}
        # What a row draws without opening the drawer: a few numbers, never the curves.
        out["evidence"] = {k: ev[k] for k in ("left_pct", "typical_pct", "searches", "questions", "helpful_pct", "no",
                                             "yes", "fall_pct", "at", "length", "hits", "target", "age_days", "words",
                                             "page", "pages_total", "agent_reads", "reason", "sample", "embed")
                           if k in ev}
        if ev.get("samples"):
            out["evidence"]["samples"] = ev["samples"][:3]
    return out


async def listing(db: AsyncIOMotorDatabase, site_row: dict, *, status: str = "active", type_: str | None = None,
                  path: str | None = None) -> dict:
    site = str(site_row["_id"])
    q: dict = {"site": site}
    rows = await db[FIXES].find(q).sort([("impact", -1), ("_id", 1)]).to_list(ITEMS_MAX * 2)
    counts = {s: 0 for s in STATUSES}
    by_type = {t: 0 for t in TYPES}
    pages: dict[str, dict] = {}
    for r in rows:
        counts[r.get("status", "open")] = counts.get(r.get("status", "open"), 0) + 1
        if r.get("status") in ("open", "in_progress"):
            by_type[r["type"]] = by_type.get(r["type"], 0) + 1
            if r.get("path"):
                pg = pages.setdefault(r["path"], {"path": r["path"], "title": r.get("page_title"), "n": 0})
                pg["n"] += 1

    def keep(r: dict) -> bool:
        st = r.get("status", "open")
        if status == "active" and st not in ("open", "in_progress"):
            return False
        if status in STATUSES and st != status:
            return False
        if type_ and r["type"] != type_:
            return False
        if path and r.get("path") != path:
            return False
        return True

    st = await state(db, site)
    return {
        "items": [view(r) for r in rows if keep(r)][:ITEMS_MAX],
        "counts": counts,
        "types": by_type,
        "pages": sorted(pages.values(), key=lambda p: (-p["n"], p["path"]))[:50],
        "checked_at": gi.iso(aware(st.get("checked_at"))),
        "readers": st.get("readers"),
        "pending": st.get("pending") or [],
        "agents": st.get("agents") or None,
        "window_days": WINDOW_DAYS,
    }


async def get_item(db: AsyncIOMotorDatabase, site: str, item_id: str) -> dict | None:
    if not ObjectId.is_valid(item_id):
        return None
    return await db[FIXES].find_one({"_id": ObjectId(item_id), "site": site})


async def set_status(db: AsyncIOMotorDatabase, site: str, item_id: str, status: str, user_id: str, *,
                     reason: str | None = None, note: str | None = None) -> dict | None:
    at = now()
    it = await get_item(db, site, item_id)
    if it is None:
        return None
    sets: dict = {"status": status, "status_at": at, "status_by": user_id}
    if status == "dismissed":
        sets.update(reason=reason or "other", note=(note or "").strip()[:500] or None)
    else:
        sets.update(reason=None)
    if status == "fixed":
        sets.update(fixed_at=at, fixed_by="person")
    if status == "open":
        sets.update(applied=None)
    words = {"dismissed": f"Dismissed: {(reason or 'other').replace('_', ' ')}", "fixed": "Marked fixed",
             "in_progress": "Started", "open": "Reopened"}[status]
    r = await db[FIXES].find_one_and_update(
        {"_id": it["_id"]},
        {"$set": sets, "$push": {"history": _push_history(_history(status, user_id, words, at))}},
        return_document=ReturnDocument.AFTER)
    return r


async def mark_applied(db: AsyncIOMotorDatabase, site_row: dict, item_id: str, page_id: str, user_id: str) -> dict | None:
    """The drafted fix is in the page (the editor's Accept, or a new page made from it): in progress
    until a publish changes that page."""
    from app.services.docs_site_pages import live_hashes

    site = str(site_row["_id"])
    it = await get_item(db, site, item_id)
    if it is None:
        return None
    at = now()
    live = (await live_hashes(db, site_row)).get(page_id)
    entry = _history("in_progress", user_id, "Fix applied in the editor", at)
    return await db[FIXES].find_one_and_update(
        {"_id": it["_id"]},
        {"$set": {"status": "in_progress", "status_at": at, "status_by": user_id, "reason": None,
                  "applied": {"page_id": page_id, "at": at, "live_hash": live, "by": user_id}},
         "$push": {"history": _push_history(entry)}},
        return_document=ReturnDocument.AFTER)


async def open_counts(db: AsyncIOMotorDatabase, sites: list[str]) -> dict[str, dict]:
    """site → {open, high} (the badge on the site bar and the Guides home cards)."""
    out: dict[str, dict] = {}
    if not sites:
        return out
    async for r in db[FIXES].aggregate([
        {"$match": {"site": {"$in": sites}, "status": "open"}},
        {"$group": {"_id": "$site", "open": {"$sum": 1}, "high": {"$sum": {"$cond": [{"$eq": ["$level", "high"]}, 1, 0]}}}},
    ]):
        out[r["_id"]] = {"open": int(r["open"]), "high": int(r["high"])}
    return out


async def clear(db: AsyncIOMotorDatabase, site: str) -> int:
    await db[STATE].delete_one({"_id": site})
    return (await db[FIXES].delete_many({"site": site})).deleted_count


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[FIXES].create_index([("site", 1), ("status", 1), ("impact", -1)])
    await db[FIXES].create_index([("site", 1), ("key", 1)])
