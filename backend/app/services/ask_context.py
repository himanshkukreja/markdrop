"""What Ask sends beside a search hit's excerpt (AI quality stage 1, .work/briefs/ai-quality-phase2.md).

services/ask_markdrop.py builds numbered sources from a search; the model then had only a title, a kind, where
it lives and an excerpt, so "who wrote it", "which team", "is it approved" and "what did Meera comment" were
guessed from the text. This module adds Markdrop's own records:

* :func:`annotate` (R1) — on every document / page source: who created it, when, who last edited it, its teams,
  its status, its comment threads (open / resolved); on a meeting page: its action items, open and done, with
  their owners (the page's checklist, as the reader sees it).
* :func:`comment_cands` + :func:`add_comments` (R3) — comments as a source: documents whose comment threads match
  the question (words, the people it names, the document's title) join the candidates, and every document
  source brings its open threads (and the threads that matched), who said what and when.
* :func:`people_in` (R6) — the question's names resolved against the workspace's members: one name two members
  share ("Rahul") or a name no member has ("Arun Kapoor") is spelled out so the answer covers each person by
  full name; their full names also join the search terms.

**Access.** Every item is decided again for this asker: ``access.can(read)`` (and ``search.allowed`` /
``access.discoverable`` for a comment's document before it becomes a candidate, under the request's scope and
team space), comment text only when ``comments.perms`` lets them view comments, people's names only inside the
item's circle (``pages.sees_people``), teams only those they can read (``teams.labels``), members only of
workspaces they belong to. Names and comments are other people's words: they reach the model inside
``<untrusted_…>`` tags.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.services import access, search, search_index
from app.services import search_text as st

log = logging.getLogger("markdrop.ask")

MAX_ACTIONS = 12                # a meeting's action items
ACTION_CHARS = 160
COMMENT_DOCS = 12               # sources that may bring comment threads
THREADS_PER_DOC = 4
MESSAGES_PER_THREAD = 3
COMMENT_CHARS = 300
SCAN_THREADS = 1500             # comment search: newest threads read
SCAN_MESSAGES = 6000
COMMENT_CANDS = 4               # documents a comment search may add
MAX_PEOPLE_TERMS = 4

_PERSON = re.compile(r':person\[([^\]]*)\]\{[^}]*\}')
_DATE = re.compile(r":date\[([^\]]*)\]")
_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_ANCHOR = re.compile(r"\s*\{#?[^}]*\}")
_TASK = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+\[( |x|X)\]\s+(.+?)\s*$")
_HEADING = re.compile(r"^\s{0,3}#{1,6}\s+(.*?)\s*$")
_STATUS_BODY = re.compile(r"(?i)\bstatus\b\s*\**\s*[:：]\s*\**\s*([A-Za-z][^\n·|*<>\[\]{}]{0,38})")
_STATUS_KEYS = ("status", "stage", "state")
_OID = re.compile(r"^[0-9a-f]{24}$")
_COMMENTISH = re.compile(r"\b(comment|comments|commented|feedback|thread|threads|replied|reply|replies|said on|"
                         r"objection|objections|concern|concerns|review(?:ed)? comments?)\b", re.I)


def _day(v: Any) -> str | None:
    if isinstance(v, datetime):
        return v.strftime("%Y-%m-%d")
    return str(v)[:10] if v else None


def plain(text: str) -> str:
    """A Markdown line as words: mentions as names, dates as written, links as their labels, no block ids."""
    t = _PERSON.sub(lambda m: m.group(1), text or "")
    t = _DATE.sub(lambda m: m.group(1), t)
    t = _LINK.sub(lambda m: m.group(1), t)
    t = _ANCHOR.sub("", t)
    t = re.sub(r"\s#\d{1,5}\b", "", t)           # a meeting page's "#12" transcript links
    return re.sub(r"\s+", " ", t.replace("**", "").replace("__", "")).strip()


def _short(text: str, n: int) -> str:
    t = re.sub(r"\s+", " ", text or "").strip()
    return t if len(t) <= n else t[:n].rsplit(" ", 1)[0].rstrip(",;:") + "…"


# ── R1: Markdrop's records on each source ─────────────────────────────────────


def status_of(content: str | None) -> str | None:
    """The page's status: its ``status`` / ``stage`` / ``state`` property, else a "Status: …" line near the top."""
    from app.services import page_db, page_props

    try:
        props = page_db.read_values(content or "")
    except Exception:
        props = {}
    for k in _STATUS_KEYS:
        v = props.get(k)
        if isinstance(v, list):
            v = ", ".join(str(x) for x in v if isinstance(x, str) and not _OID.match(x))
        if isinstance(v, str) and v.strip() and not _OID.match(v.strip()):
            return _short(v.strip(), 40)
    _front, body = page_props.split(content or "")
    m = _STATUS_BODY.search(body[:1500])
    if m:
        v = m.group(1).strip().rstrip(".,;")
        return v or None
    return None


def action_items(content: str | None, *, limit: int = MAX_ACTIONS) -> list[tuple[bool, str]]:
    """A meeting page's "Action items" checklist as (done, plain text), in order."""
    out: list[tuple[bool, str]] = []
    inside = False
    fence = False
    for line in (content or "").split("\n"):
        if line.lstrip().startswith(("```", "~~~")):
            fence = not fence
            continue
        if fence:
            continue
        h = _HEADING.match(line)
        if h:
            inside = bool(re.search(r"\b(action items?|next steps?)\b", h.group(1), re.I))
            continue
        if not inside:
            continue
        m = _TASK.match(line)
        if not m:
            continue
        text = plain(m.group(2))
        if text:
            out.append((m.group(1) != " ", _short(text, ACTION_CHARS)))
            if len(out) >= limit:
                break
    return out


def _nkey(text: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (text or "").casefold()).strip()[:60]


def actions_text(items: list[tuple[bool, str]], notes: dict[str, str] | None = None) -> str:
    """``notes``: {normalised text: "likely done: …"} for open items that look done (services/likely_done.py)."""
    if not items:
        return ""
    lines = [f"- [{'done' if done else 'open'}] {text}"
             + (f" ({(notes or {})[_nkey(text)]})" if not done and _nkey(text) in (notes or {}) else "") for done, text in items]
    n_open = sum(1 for d, _ in items if not d)
    return (f"Action items on this meeting's page ({n_open} open, {len(items) - n_open} done; the person named first "
            f"owns it):\n" + "\n".join(lines))


async def _names(db: AsyncIOMotorDatabase, ids) -> dict[str, str]:
    from app.services.comments import service as comments

    return {k: v["name"] for k, v in (await comments.people_map(db, [i for i in ids if i])).items()}


async def _last_edits(db: AsyncIOMotorDatabase, ids: list[ObjectId]) -> dict[str, dict]:
    """doc id → its newest saved version by a person ({author_id, author_name, ts})."""
    out: dict[str, dict] = {}
    if not ids:
        return out
    pipe = [{"$match": {"doc_id": {"$in": [str(i) for i in ids]}, "author_kind": "user"}},
            {"$sort": {"ts": -1}},
            {"$group": {"_id": "$doc_id", "author_id": {"$first": "$author_id"}, "author_name": {"$first": "$author_name"},
                        "ts": {"$first": "$ts"}}}]
    try:
        async for r in db["document_versions"].aggregate(pipe):
            out[str(r["_id"])] = r
    except Exception:
        log.warning("ask: last edits failed", exc_info=True)
    return out


def _doc_sources(sources: list) -> list:
    return [s for s in sources if getattr(s, "tag", None) == "document" and s.cand is not None
            and s.cand.kind in search.DOC_KINDS and s.cand.raw and s.cand.raw.get("_id") is not None]


async def annotate(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, sources: list) -> int:
    """R1: Markdrop's own records on each document / page / meeting source (its ``attrs`` and, for a meeting,
    its action items at the top of its text). Returns how many sources got something."""
    from app.services import pages, teams as teams_service
    from app.services.comments import perms as comment_perms

    picks = _doc_sources(sources)
    if not picks or not actor.user_id:
        return 0
    ids = list({s.cand.raw["_id"] for s in picks})
    raws = {r["_id"]: r for r in await db["documents"].find({"_id": {"$in": ids}}).to_list(length=len(ids))}
    edits = await _last_edits(db, ids)
    names = await _names(db, {r.get("owner_id") for r in raws.values()} | {e.get("author_id") for e in edits.values()})
    done = 0
    for s in picks:
        raw = raws.get(s.cand.raw["_id"])
        if raw is None or raw.get("deleted_at") is not None or search_index.title_only(raw):
            continue
        if not (await access.can(actor, raw, "read", ctx)).allowed:
            continue
        a: dict[str, Any] = {}
        meeting = bool(raw.get("meeting_id"))
        transcript = meeting and raw.get("meeting_role") == "transcript"
        sees = await pages.sees_people(actor, raw, ctx)
        if raw.get("todo_team_id") or raw.get("todo_user_id"):
            a["created_by"] = "Markdrop (a to-do page it keeps)"
        elif raw.get("backlog_team_id"):
            a["created_by"] = "Markdrop (a team backlog it keeps)"
        elif not meeting and sees and raw.get("owner_id") in names:
            a["created_by"] = names[raw["owner_id"]]
        if not meeting and raw.get("created_at"):
            a["created"] = _day(raw["created_at"])
        e = edits.get(str(raw["_id"]))
        if e and sees and not meeting and not a.get("created_by", "").startswith("Markdrop"):
            who = names.get(e.get("author_id")) or e.get("author_name")
            if who:
                a["last_edited_by"] = f"{who} on {_day(e.get('ts'))}"
        if raw.get("workspace_id"):
            view = await ctx.team_view(raw["workspace_id"], actor.user_id)
            labs = [(x["kind"], x.get("name")) for x in teams_service.labels(view, raw) if x.get("name")]
            if labs:
                a["teams"] = ", ".join(n if k == "team" else f"{n} (project)" for k, n in labs)
        if not meeting:
            stt = status_of(raw.get("content"))
            if stt:
                a["status"] = stt
        counts = raw.get("comment_counts") or {}
        if (counts.get("open") or counts.get("resolved")) and not transcript:
            if (await comment_perms.perms_for(db, actor, raw, ctx)).view:
                a["comments"] = f"{int(counts.get('open') or 0)} open, {int(counts.get('resolved') or 0)} resolved"
        if meeting and not transcript:
            content = await pages.content_for(actor, raw, ctx)
            txt = actions_text(action_items(content), await _likely_notes(db, actor, ctx, raw["_id"]))
            if txt:
                s.text = txt + ("\n\n" + s.text if s.text else "")
        if a:
            # The model reads them right after title / kind / where (attrs keep insertion order).
            s.attrs.update(a)
        if a or meeting:
            done += 1
    return done


async def _likely_notes(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, doc_id: Any) -> dict[str, str]:
    """{normalised action text: "likely done: …"} for this (readable) meeting page's open items whose evidence the
    asker may open (services/likely_done.py)."""
    from app.services import ai_index, likely_done

    try:
        rows = await db[ai_index.COLL].find({"t": "action", "doc": doc_id, "done": False}).to_list(length=200)
        evs = await likely_done.for_rows(db, actor, ctx, rows)
    except Exception:
        log.warning("ask: likely-done notes failed", exc_info=True)
        return {}
    return {_nkey(r.get("text")): likely_done.note(evs[r["_id"]]) for r in rows if r["_id"] in evs}


# ── R3: comments as a source ──────────────────────────────────────────────────


def _stem(w: str) -> str:
    return w[:6] if len(w) > 6 else w


def query_words(*texts: str) -> set[str]:
    out = set()
    for t in texts:
        for w in st.words(t):
            if len(w) >= 3 and w not in st.STOPWORDS:
                out.add(_stem(w))
    return out


async def comment_cands(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, w: search.World,
                        question: str, terms: list[str], scope: str | None, keep=None,
                        people: list[dict] | None = None) -> tuple[list[search.Cand], dict[str, list[str]]]:
    """Documents whose comment threads match the question, best first (each discoverable by the asker under
    the request's scope and team space, its comments viewable by them), and doc key → the matching thread ids."""
    from app.services.comments import model as cm, perms as comment_perms

    uid = actor.user_id
    if not uid:
        return [], {}
    wss = [scope] if scope else list(w.member_ws)
    qwords = query_words(question, *terms)
    named = {p["id"] for p in people or []}
    commentish = bool(_COMMENTISH.search(question or ""))
    if not qwords and not named:
        return [], {}
    tq: dict[str, Any] = {"deleted_at": None}
    tq["$or"] = [{"workspace_id": {"$in": wss}}] + ([] if scope else [{"participants": uid}])
    threads = await db[cm.THREADS].find(tq, {"doc_id": 1, "status": 1}).sort("updated_at", -1).limit(
        SCAN_THREADS).to_list(length=SCAN_THREADS)
    if not threads:
        return [], {}
    by_id = {t["_id"]: t for t in threads}
    msgs = await db[cm.MESSAGES].find({"thread_id": {"$in": list(by_id)}, "deleted_at": None},
                                      {"thread_id": 1, "body": 1, "author_id": 1}).limit(SCAN_MESSAGES).to_list(length=SCAN_MESSAGES)
    tscore: dict[Any, tuple[int, bool]] = {}
    for m in msgs:
        bw = query_words(m.get("body") or "")
        hit = len(qwords & bw)
        by = m.get("author_id") in named
        prev = tscore.get(m["thread_id"], (0, False))
        tscore[m["thread_id"]] = (max(prev[0], hit), prev[1] or by)
    doc_ids = {by_id[t]["doc_id"] for t, (hit, by) in tscore.items() if hit or by}
    oids = [ObjectId(d) for d in doc_ids if ObjectId.is_valid(d)]
    if not oids:
        return [], {}
    filt = await search.doc_filter(db, actor, ctx, w.member_ws, search.Query(q="", scope=scope))
    if filt is None:
        return [], {}
    rows = await db["documents"].find({"$and": [filt, {"_id": {"$in": oids}, "deleted_at": None}]},
                                      search._DOC_PROJECTION).to_list(length=len(oids))
    titles = {str(r["_id"]): query_words(r.get("title") or "") for r in rows}
    scored: dict[str, tuple[float, list[str]]] = {}
    for t, (hit, by) in tscore.items():
        d = by_id[t]["doc_id"]
        if d not in titles:
            continue
        tw = len(qwords & titles[d])
        if not (hit >= 1 or (commentish and (by or tw >= 1))):
            continue
        score = hit + 0.5 * tw + (2 if by else 0) + (1 if commentish else 0)
        if score < 2:
            continue
        best, ts = scored.get(d, (0.0, []))
        scored[d] = (max(best, score), ts + [str(t)])
    out: list[search.Cand] = []
    matched: dict[str, list[str]] = {}
    raws = {str(r["_id"]): r for r in rows}
    for d in sorted(scored, key=lambda k: -scored[k][0]):
        raw = raws[d]
        if raw.get("encrypted") or search_index.title_only(raw):
            continue
        c = search._doc_cand(raw, uid)
        if keep is not None and not keep(c):
            continue
        if not await search.allowed(db, w, c):        # access.discoverable: can(read) + the team rule
            continue
        full = await db["documents"].find_one({"_id": raw["_id"]})
        if full is None or not (await comment_perms.perms_for(db, actor, full, ctx)).view:
            continue
        out.append(c)
        matched[c.key] = scored[d][1]
        if len(out) >= COMMENT_CANDS:
            break
    return out, matched


async def add_comments(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, sources: list,
                       matched: dict[str, list[str]] | None = None) -> int:
    """R3: each document source's open comment threads (and the threads a comment search matched, open or
    resolved), who said what and when, at the end of its text. Only when the asker may view its comments."""
    from app.services.comments import model as cm, perms as comment_perms, service as comments

    if matched is None:
        matched = {s.key: s.comment_threads for s in sources if getattr(s, "comment_threads", None)}
    picks = _doc_sources(sources)[:COMMENT_DOCS]
    picks += [s for s in _doc_sources(sources) if s.key in matched and s not in picks]
    if not picks or not actor.user_id:
        return 0
    added = 0
    for s in picks:
        raw = await db["documents"].find_one({"_id": s.cand.raw["_id"]})
        if raw is None or raw.get("meeting_role") == "transcript":
            continue
        want = set(matched.get(s.key) or [])
        counts = raw.get("comment_counts") or {}
        if not counts.get("open") and not want:
            continue
        if not (await comment_perms.perms_for(db, actor, raw, ctx)).view:
            continue
        q: dict[str, Any] = {"doc_id": str(raw["_id"]), "deleted_at": None}
        ors: list[dict] = [{"status": "open"}]
        if want:
            ors.append({"_id": {"$in": [ObjectId(t) for t in want if ObjectId.is_valid(t)]}})
        q["$or"] = ors
        threads = await db[cm.THREADS].find(q).sort("updated_at", -1).limit(30).to_list(length=30)
        threads.sort(key=lambda t: (str(t["_id"]) not in want, t.get("status") != "open"))
        threads = threads[:THREADS_PER_DOC]
        if not threads:
            continue
        msgs: dict[str, list[dict]] = {}
        async for m in db[cm.MESSAGES].find({"thread_id": {"$in": [t["_id"] for t in threads]}, "deleted_at": None}).sort(
                [("created_at", 1), ("_id", 1)]):
            msgs.setdefault(str(m["thread_id"]), []).append(m)
        names = await comments.people_map(db, {m.get("author_id") for ms in msgs.values() for m in ms})
        lines = []
        for t in threads:
            ms = msgs.get(str(t["_id"])) or []
            if not ms:
                continue
            quote = ((t.get("original") or {}).get("exact") or "").strip()
            head = f"- Thread ({t.get('status') or 'open'}" + (f", on “{_short(quote, 80)}”" if quote else "") + "):"
            parts = []
            for m in ms[:MESSAGES_PER_THREAD]:
                who = (names.get(m.get("author_id") or "") or {}).get("name") or m.get("author_name") or "Someone"
                if m.get("ai"):
                    who = "Markdrop AI"
                parts.append(f"  {who} ({_day(m.get('created_at'))}): {_short(plain(m.get('body') or ''), COMMENT_CHARS)}")
            if len(ms) > MESSAGES_PER_THREAD:
                parts.append(f"  (+{len(ms) - MESSAGES_PER_THREAD} more replies)")
            lines.append("\n".join([head, *parts]))
        if lines:
            s.text = (s.text + "\n\n" if s.text else "") + "Comments on this item:\n" + "\n".join(lines)
            added += 1
    return added


# ── R6: names in the question, against the members ────────────────────────────


@dataclass
class People:
    """Members the question names (``named``: [{id, name}]), the note for the model, extra search terms."""

    named: list[dict] = field(default_factory=list)
    note: str = ""
    terms: list[str] = field(default_factory=list)
    ambiguous: bool = False


def _q_words(question: str) -> list[str]:
    return st.words(re.sub(r"[’']s\b", "", question or ""))


def resolve_names(question: str, members: list[dict]) -> tuple[list[dict], list[tuple[str, list[dict], bool]]]:
    """(members named unambiguously, [(the words, the members they may mean, no exact match)]).

    "Rahul" with two Rahuls → ambiguous (both); "Rahul Das" → him; "Arun Kapoor" when the members are Arun
    Sharma and Arjun Kapoor → no exact match (both); "Arjun" with one Arjun → him."""
    qw = _q_words(question)
    qs = set(qw)
    firsts: dict[str, list[dict]] = {}
    lasts: dict[str, list[dict]] = {}
    for m in members:
        parts = st.words(m.get("name"))
        if not parts:
            continue
        firsts.setdefault(parts[0], []).append(m)
        if len(parts) > 1:
            lasts.setdefault(parts[-1], []).append(m)
    sure: dict[str, dict] = {}
    unclear: list[tuple[str, list[dict], bool]] = []
    used: set[str] = set()
    # Full names first ("Rahul Das"); a first + last pair no member has ("Arun Kapoor") is unclear.
    for i in range(len(qw) - 1):
        a, b = qw[i], qw[i + 1]
        if a in firsts and b in lasts:
            exact = [m for m in firsts[a] if st.words(m.get("name"))[-1] == b]
            if exact:
                for m in exact:
                    sure[m["id"]] = m
            else:
                both = list({m["id"]: m for m in firsts[a] + lasts[b]}.values())
                unclear.append((f"{a} {b}".title(), both, True))
            used.update((a, b))
    for m in members:
        n = " ".join(st.words(m.get("name")))
        if n and len(n.split()) > 1 and f" {n} " in f" {' '.join(qw)} ":
            sure[m["id"]] = m
            used.update(n.split())
    for w_ in qw:
        if w_ in used or w_ in st.STOPWORDS or len(w_) < 2:
            continue
        if w_ in firsts:
            ms = firsts[w_]
            if len(ms) == 1:
                sure[ms[0]["id"]] = ms[0]
            elif not any(m["id"] in sure for m in ms):
                unclear.append((w_.title(), ms, False))
            used.add(w_)
        elif w_ in lasts and len(w_) >= 4 and len(lasts[w_]) == 1 and w_ in qs:
            sure[lasts[w_][0]["id"]] = lasts[w_][0]
            used.add(w_)
    return list(sure.values()), unclear


async def people_in(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, question: str,
                    scope: str | None = None) -> People:
    """R6: the members the question names, in the workspaces in scope the asker belongs to. Teams only those the
    asker can read (a private team's name and members stay with its members)."""
    from app.services import pages_ai, teams as teams_service, workspace as ws_service, workspace_memory

    out = People()
    uid = actor.user_id
    if not uid or not st.words(question):
        return out
    wss = [scope] if scope else [w.id for w, _r in await ws_service.list_for_user(db, uid)]
    seen: dict[str, dict] = {}
    unclear_all: list[tuple[str, list[dict], bool]] = []
    teams_of: dict[str, list[str]] = {}
    for wid in wss[:10]:
        if await ctx.role(wid, uid) is None:
            continue
        members = await workspace_memory.members_of(db, wid)
        sure, unclear = resolve_names(question, members)
        if not sure and not unclear:
            continue
        view = await ctx.team_view(wid, uid)
        for tid in view.readable_teams:
            t = view.teams.get(tid) or {}
            if teams_service.is_general(t):
                continue
            for mid in t.get("member_ids") or []:
                lead = mid in (t.get("lead_ids") or [])
                teams_of.setdefault(mid, []).append(f"{t.get('name')}{' (lead)' if lead else ''}")
        for m in sure:
            seen.setdefault(m["id"], m)
        unclear_all += unclear
    if not seen and not unclear_all:
        return out

    def card(m: dict) -> str:
        tms = sorted(set(teams_of.get(m["id"]) or []))
        return m["name"] + (f" (teams: {', '.join(tms)})" if tms else "")

    lines: list[str] = []
    done_ids: set[str] = set()
    for words, ms, none_exact in unclear_all:
        ms = [m for m in ms if m["id"] not in done_ids]
        if len(ms) < 2 and not none_exact:
            continue
        if none_exact:
            lines.append(f"- “{words}”: no member has that name. The members it may mean: "
                         + "; ".join(card(m) for m in ms) + ".")
        else:
            lines.append(f"- “{words}” matches {len(ms)} members: " + "; ".join(card(m) for m in ms) + ".")
        done_ids.update(m["id"] for m in ms)
        out.ambiguous = True
    for m in seen.values():
        if m["id"] not in done_ids:
            lines.append(f"- {card(m)}")
            done_ids.add(m["id"])
    everyone = {m["id"]: m for m in [*seen.values(), *(m for _w, ms, _n in unclear_all for m in ms)]}
    out.named = [{"id": k, "name": m["name"]} for k, m in everyone.items() if k in done_ids]
    # The search looks for every person a name may mean (the question's own words already find the rest).
    out.terms = [m["name"] for m in out.named if m["id"] not in seen][:MAX_PEOPLE_TERMS] if out.ambiguous else []
    head = ("The people the question names, as the workspace's members (Markdrop's own records; teams as this "
            "person can see them).")
    if out.ambiguous:
        head += (" Where one name fits several members, answer for each of them separately by full name "
                 "(\"There are two …: … ; …\"); never pick one silently, never merge them, don't ask which one.")
    out.note = pages_ai.wrap("people", head + "\n" + "\n".join(lines))
    return out
