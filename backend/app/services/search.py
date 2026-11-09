"""Global search: everything the caller can open, matched fuzzily, in one ranked list.

    GET /api/v1/search   (routers/search.py)   MCP ``search`` (mcp/tools.py)   AI search's retrieval

**What is searched** (owner decisions 2026-11-04): the caller's own documents, pages and files
(private included), what every workspace they belong to lets them read, what is shared with them
by grant (and the inheriting sub-pages below a shared page), the folders and workspaces they are
in, the pages of Markdrop Guides they have a Guides role on, and their Trash (titles only, at the
bottom, marked "In Trash"). Templates never; expired never; another person's public link documents
never (search is "my stuff", not a crawl).

**Access, three walls:**

1. Candidates come from a *live* query on ``documents`` built like ``access.readable_filter``
   (owner / grant / member-and-not-private), so a revoked grant, a narrowed level, a move or a
   delete is in the very next search. Nothing about access is copied into the search index.
2. Every hit that is shown is re-decided with ``access.can(actor, row, "read", ctx)`` (Guides:
   the caller's studio role; folders: membership; Trash: ``trash.manage_role``).
3. Content (snippets, body matches) comes only from ``search_index`` rows of ids that passed (1),
   and never for an encrypted or password-protected document: those match by title only and
   have no snippet. An encrypted document's title is ciphertext, so it matches by its slug.

**Ranking.** Titles (and slugs, filenames, folder and workspace names, Guides page titles) of every
candidate are scored in-process with rapidfuzz: each query word against each title word (exact,
prefix-as-you-type, typo by edit ratio, mid-word), averaged over the query's words, so word order
doesn't matter and "onbording plyabook" finds "Onboarding Playbook". Headings and body text match
through the index's word sets: exact words, the last word as a prefix, and every one-edit variant
of longer words (typos), as indexed point lookups. A word may match in the title, a heading or the
body; the best place counts (title > heading > body). Then small boosts: the current workspace,
mine, recently updated. Measured: ~5k readable items answer in well under 150 ms (tests/test_search).
"""

from __future__ import annotations

import base64
import json
import logging
import math
import os
import re
import time
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo.errors import OperationFailure
from rapidfuzz import fuzz, process

from app.services import teams as teams_service
from app.services import access, publicity, search_chunks, search_index, urls
from app.services import search_text as st

log = logging.getLogger(__name__)

MAX_Q = 200
DEBUG_TIMINGS = bool(os.environ.get("MARKDROP_SEARCH_TIMINGS"))
MAX_TOKENS = 8
MAX_SCAN = 20_000             # documents considered per search (most recently updated first)
MAX_GRANT_DESCENDANTS = 5_000
MAX_LIMIT = 50
MAX_CHECK = 300             # hits re-decided per search beyond the page (to fill the groups)
PER_GROUP = 5
MIN_SCORE = 58.0
SNIPPET_CHARS = 180
TYPO_MIN = 4                  # words shorter than this match exactly or as a prefix only

KINDS = ("page", "doc", "file", "folder", "workspace", "guide")
GROUPS = (("page", "Pages"), ("doc", "Documents"), ("file", "Files"), ("folder", "Folders"),
          ("workspace", "Workspaces"), ("guide", "Guides"), ("trash", "In Trash"))
UPDATED = {"week": timedelta(days=7), "month": timedelta(days=31)}
DOC_KINDS = {"page", "doc", "file"}

_DOC_PROJECTION = {
    "slug": 1, "title": 1, "kind": 1, "editor": 1, "original_filename": 1, "mime": 1, "updated_at": 1,
    "created_at": 1, "owner_id": 1, "workspace_id": 1, "folder_id": 1, "folder_path": 1, "page_path": 1,
    "encrypted": 1, "read_password_hash": 1, "parent_id": 1, "access_inherit": 1, "access_level": 1,
    "expires_at": 1, "page_icon": 1, "template": 1, "hidden_in_listings": 1,
}


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: Any) -> datetime | None:
    return publicity.aware(dt) if isinstance(dt, datetime) else None


# ── The request ───────────────────────────────────────────────────────────────


@dataclass
class Query:
    q: str
    scope: str | None = None            # None = everything; else a workspace id
    kinds: frozenset = frozenset()      # empty = all
    owner: str = "anyone"               # anyone | me
    updated: str = "any"                # any | week | month
    current: str | None = None          # the workspace the person is in (ranked higher)
    offset: int = 0
    limit: int = 20
    trash: bool = True
    snippets: bool = True
    space: str | None = None            # Teams (CONTRACT §3): all | company | team:<id> | project:<id>

    @property
    def text(self) -> str:
        return (self.q or "").replace("\x00", "").strip()[:MAX_Q]


def parse_scope(scope: str | None) -> str | None:
    """"all" / "" → None; "workspace:<id>" or a bare id → the id."""
    s = (scope or "").strip()
    if not s or s == "all":
        return None
    if s.startswith("workspace:"):
        s = s.split(":", 1)[1]
    if not re.fullmatch(r"[0-9a-f]{24}", s):
        raise ValueError("scope must be all or workspace:<id>")
    return s


def parse_kinds(kind: str | None) -> frozenset:
    if not kind:
        return frozenset()
    aliases = {"document": "doc", "documents": "doc", "docs": "doc", "pages": "page", "files": "file",
               "artifact": "file", "folders": "folder", "workspaces": "workspace", "guides": "guide",
               "markdown": "doc"}
    out = set()
    for k in kind.split(","):
        k = aliases.get(k.strip().lower(), k.strip().lower())
        if k:
            if k not in KINDS:
                raise ValueError(f"kind must be one of {', '.join(KINDS)}")
            out.add(k)
    return frozenset(out)


def encode_cursor(offset: int) -> str:
    return base64.urlsafe_b64encode(json.dumps({"o": offset}).encode()).decode().rstrip("=")


def decode_cursor(cursor: str | None) -> int:
    if not cursor:
        return 0
    try:
        return max(0, int(json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))["o"]))
    except Exception:
        raise ValueError("That cursor isn't valid; start again without one.")


# ── Matching ──────────────────────────────────────────────────────────────────


def _fold_char(ch: str) -> str:
    d = unicodedata.normalize("NFKD", ch)
    base = "".join(c for c in d if not unicodedata.combining(c)).lower()
    return base[0] if len(base) >= 1 else ch.lower()


_ASCII_LOWER = {i: i + 32 for i in range(65, 91)}
_FOLDED: dict[str, str] = {}


def fold(text: str) -> str:
    """Lower case, accents off, ONE character per character (positions stay valid)."""
    if text.isascii():
        return text.lower()
    # One em dash or curly quote used to send the whole text (20,000 characters a result, every
    # keystroke) through a Python loop per character: fold each distinct character once instead, and
    # let str.translate do the rest. Same result character for character.
    table: dict[int, str | int] = dict(_ASCII_LOWER)
    for ch in set(text):
        if ord(ch) > 127:
            f = _FOLDED.get(ch)
            if f is None:
                f = _fold_char(ch)
                if len(_FOLDED) < 50_000:
                    _FOLDED[ch] = f
            table[ord(ch)] = f
    return text.translate(table)


@dataclass
class Terms:
    """The query cut into words, with what each word may match as."""

    raw: str
    tokens: list[str]
    weights: list[float]
    prefix_last: bool
    # word → [(token index, quality)] for heading / body lookups (exact, typo variants).
    expand: dict[str, list[tuple[int, float]]] = field(default_factory=dict)

    @property
    def norm(self) -> str:
        return " ".join(self.tokens)

    @property
    def prefixes(self) -> tuple:
        """The last word, matched as the start of a word while it is being typed."""
        if self.prefix_last and self.tokens and len(self.tokens[-1]) >= 2:
            return (self.tokens[-1],)
        return ()

    @property
    def marks(self) -> set:
        """Words worth highlighting: the query's words and their typo variants, without the small
        words of a sentence ("how", "we", "the") unless that's all there is."""
        content = {t for t in self.tokens if t not in st.STOPWORDS}
        if not content:
            return set(self.expand)
        return {w for w, pairs in self.expand.items() if any(self.tokens[i] in content for i, _q in pairs)}

    def hits(self, word: str) -> bool:
        return word in self.expand or (bool(self.prefixes) and word.startswith(self.prefixes))


def terms_of(q: str) -> Terms:
    toks: list[str] = []
    for w in st.words(q):
        if w not in toks and len(w) <= st.MAX_WORD:
            toks.append(w)
        if len(toks) >= MAX_TOKENS:
            break
    # A lone stopword ("the") still searches; stopwords alongside real words weigh little.
    weights = [0.25 if (w in st.STOPWORDS and len(toks) > 1) else float(min(len(w), 8)) for w in toks]
    t = Terms(raw=q, tokens=toks, weights=weights, prefix_last=bool(q) and not q[-1].isspace())
    for i, w in enumerate(toks):
        t.expand.setdefault(w, []).append((i, 100.0))
        if len(w) >= TYPO_MIN and i < 4:
            quality = 84.0 if len(w) >= 5 else 74.0
            for v in st.edits1(w):
                t.expand.setdefault(v, []).append((i, quality))
    return t


def token_scores(terms: Terms, vocab: list[str]) -> list[dict[str, float]]:
    """For each query word, vocab word → match score (0..100), only scores ≥ 60 kept."""
    out: list[dict[str, float]] = []
    if not vocab:
        return [{} for _ in terms.tokens]
    for i, q in enumerate(terms.tokens):
        scores: dict[str, float] = {}
        ql = len(q)
        if ql >= 3:
            ratios = process.cdist([q], vocab, scorer=fuzz.ratio, dtype="float32")[0]
            for j, r in enumerate(ratios):
                if r >= 72:
                    scores[vocab[j]] = float(r)
        for w in vocab:
            if w.startswith(q):
                s = 100.0 if len(w) == ql else 90.0 + 9.0 * ql / len(w)
                if s > scores.get(w, 0):
                    scores[w] = s
        if ql >= TYPO_MIN:
            # A typo while still typing: "onbor" ~ "onboarding", "plyab" ~ "playbook".
            heads = [w[:ql] for w in vocab]
            pr = process.cdist([q], heads, scorer=fuzz.ratio, dtype="float32")[0]
            for j, r in enumerate(pr):
                if r >= 74 and len(vocab[j]) > ql:
                    s = float(r) * 0.9
                    if s > scores.get(vocab[j], 0):
                        scores[vocab[j]] = s
            # Inside a word ("board" in "onboarding").
            mid = process.cdist([q], vocab, scorer=fuzz.partial_ratio, dtype="float32")[0]
            for j, r in enumerate(mid):
                if r >= 90 and len(vocab[j]) > ql + 1:
                    s = float(r) * 0.72
                    if s > scores.get(vocab[j], 0):
                        scores[vocab[j]] = s
        out.append(scores)
    return out


def marks_for(text: str | None, words_hit, prefixes: tuple = ()) -> list[list[int]]:
    """[start, end) ranges in ``text`` of the words in ``words_hit`` or starting with a prefix."""
    if not text or not (words_hit or prefixes):
        return []
    f = fold(text)
    out: list[list[int]] = []
    for m in re.finditer(r"[^\W_]+", f):
        w = m.group(0)
        if w in words_hit:
            out.append([m.start(), m.end()])
        elif prefixes and w.startswith(prefixes):
            p = max((p for p in prefixes if w.startswith(p)), key=len)
            out.append([m.start(), m.start() + len(p)])
    return out


def snippet(text: str, hit_words, prefixes: tuple = (), *, width: int = SNIPPET_CHARS) -> dict | None:
    """The densest ``width``-character window of ``text`` around the hit words, cut on word
    boundaries, with the hits' ranges relative to it. None when nothing matches."""
    if not text:
        return None
    f = fold(text)
    pos: list[tuple[int, int]] = []
    for m in re.finditer(r"[^\W_]+", f):
        w = m.group(0)
        if w in hit_words or (prefixes and w.startswith(prefixes)):
            pos.append((m.start(), m.end()))
            if len(pos) >= 400:
                break
    if not pos:
        return None
    best_i, best_n = 0, 0
    j = 0
    for i in range(len(pos)):
        while pos[i][0] - pos[j][0] > width * 0.7:
            j += 1
        if i - j + 1 > best_n:
            best_n, best_i = i - j + 1, j
    start = max(0, pos[best_i][0] - width // 4)
    end = min(len(text), start + width)
    start = max(0, min(start, end - width))
    if start > 0:
        sp = text.rfind(" ", 0, start + 1)
        start = sp + 1 if sp >= 0 and start - sp < 20 else start
    if end < len(text):
        sp = text.find(" ", end)
        end = sp if 0 <= sp - end < 20 else end
    piece = text[start:end]
    lead = "…" if start > 0 else ""
    tail = "…" if end < len(text) else ""
    # Snippets are one line.
    flat = piece.replace("\n", " ")
    marks = [[a - start + len(lead), b - start + len(lead)] for a, b in pos if a >= start and b <= end]
    return {"text": f"{lead}{flat}{tail}", "marks": marks}


def recency_boost(updated: datetime | None, now: datetime) -> float:
    if updated is None:
        return 0.0
    days = max(0.0, (now - updated).total_seconds() / 86400.0)
    return 4.0 * math.exp(-days / 30.0)


# ── Candidates ────────────────────────────────────────────────────────────────


@dataclass(slots=True)
class Cand:
    key: str
    kind: str
    title: str | None
    words: tuple                      # title / slug / filename words (all count as the title)
    extra_words: tuple                # weaker title-ish words (slug of a titled doc)
    updated: datetime | None
    raw: dict | None = None           # documents row (projection) / folder / workspace / guide page
    ws_id: str | None = None
    mine: bool = False
    content_id: Any = None            # search_index _id (None: title only)
    score: float = 0.0
    title_hits: set = field(default_factory=set)
    body_hits: bool = False
    head_hits: bool = False
    where: str = "title"
    extra: dict = field(default_factory=dict)


def _doc_cand(raw: dict, uid: str | None) -> Cand:
    kind = search_index.doc_kind(raw)
    enc = bool(raw.get("encrypted"))
    title = None if enc else (raw.get("title") or (raw.get("original_filename") if raw.get("kind") == "artifact" else None))
    words = st.title_words(title) if title else ()
    slug_words = st.title_words(raw.get("slug") or "")
    fname = raw.get("original_filename") if raw.get("kind") == "artifact" else None
    if fname and fname != title:
        words = words + st.title_words(fname)
    if not words:
        words, slug_words = slug_words, ()
    return Cand(key=f"d:{raw['_id']}", kind=kind, title=title, words=words, extra_words=slug_words,
                updated=_aware(raw.get("updated_at")), raw=raw, ws_id=raw.get("workspace_id"),
                mine=bool(uid) and raw.get("owner_id") == uid,
                content_id=None if search_index.title_only(raw) else raw["_id"])


async def _granted_descendants(db: AsyncIOMotorDatabase, roots: list[ObjectId]) -> list[ObjectId]:
    """Inheriting sub-pages below shared pages (a grant on a page opens them too)."""
    out: list[ObjectId] = []
    frontier = list(roots)
    seen = set(frontier)
    for _ in range(access.MAX_PAGE_DEPTH):
        if not frontier or len(out) >= MAX_GRANT_DESCENDANTS:
            break
        kids = await db["documents"].find(
            {"parent_id": {"$in": frontier}, "access_inherit": {"$ne": False}}, {"_id": 1}
        ).to_list(length=MAX_GRANT_DESCENDANTS)
        frontier = [k["_id"] for k in kids if k["_id"] not in seen]
        seen.update(frontier)
        out.extend(frontier)
    return out


async def doc_filter(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, member_ws: list[str],
                     q: Query) -> dict | None:
    """The Mongo filter for documents this person may read (a superset never wider than
    ``access.readable_filter`` per workspace + own + granted), with the request's filters."""
    uid = actor.user_id
    if not uid:
        return None
    granted = await access.granted_ids(actor, ctx)
    descendants = await _granted_descendants(db, granted) if granted else []
    ors: list[dict] = [{"owner_id": uid}]
    if granted or descendants:
        ors.append({"_id": {"$in": granted + descendants}})
    views = [await ctx.team_view(w, uid) for w in member_ws]
    admin_ws = [v.workspace_id for v in views if v.admin]
    other = [v for v in views if not v.admin]
    if admin_ws:
        ors.append({"workspace_id": {"$in": admin_ws}, "access_level": {"$ne": "private"}})
    if other:
        # Teams (CONTRACT §2): the membership reaches company-wide items and readable teams / projects.
        ors.append({"$and": [{"workspace_id": {"$in": [v.workspace_id for v in other]}, "access_level": {"$ne": "private"}},
                             teams_service.multi_clause(other)]})
    clauses: list[dict] = [{"$or": ors}, access.not_expired_clause(ctx.now), access.NOT_TEMPLATE]
    if q.space:
        sp = teams_service.parse_space(q.space)
        if sp.kind != "all":
            view = next((v for v in views if (sp.kind == "team" and sp.id in v.teams)
                         or (sp.kind == "project" and sp.id in v.projects)
                         or (sp.kind == "company" and v.workspace_id == (actor.tenant_ws or q.scope))), None)
            if view is None and sp.kind == "company" and views:
                view = views[0]
            if view is None or not teams_service.space_ok(view, sp):
                return {"_id": {"$in": []}}
            clauses.append(teams_service.space_clause(view, sp))
    scope = actor.tenant_ws or q.scope
    if scope:
        clauses.append({"workspace_id": scope})
    if q.owner == "me":
        clauses.append({"owner_id": uid})
    if q.updated in UPDATED:
        clauses.append({"updated_at": {"$gte": (ctx.now - UPDATED[q.updated]).replace(tzinfo=None)}})
    kinds = (q.kinds or set(KINDS)) & DOC_KINDS
    if kinds != DOC_KINDS:
        ors_k = []
        if "file" in kinds:
            ors_k.append({"kind": "artifact"})
        if "page" in kinds:
            ors_k.append({"kind": {"$ne": "artifact"}, "editor": "blocks"})
        if "doc" in kinds:
            ors_k.append({"kind": {"$ne": "artifact"}, "editor": {"$ne": "blocks"}})
        clauses.append({"$or": ors_k})
    return {"$and": clauses}


# ── The search ────────────────────────────────────────────────────────────────


@dataclass
class World:
    """Who is asking, resolved once per search."""

    actor: access.Actor
    ctx: access.Ctx
    memberships: list                 # [(Workspace, role)]
    ws_names: dict[str, str]
    member_ws: list[str]


async def world_of(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx) -> World:
    from app.services import workspace as ws_service

    mems = await ws_service.list_for_user(db, actor.user_id) if actor.user_id else []
    if actor.tenant_ws:
        mems = [(w, r) for w, r in mems if w.id == actor.tenant_ws]
    return World(actor, ctx, mems, {w.id: w.name for w, _ in mems}, [w.id for w, _ in mems])


# Databases whose covering word indexes were found missing → when (monotonic). Their lookups run
# unhinted until the indexes are back, or for HINTS_RETRY_S when putting them back failed.
_hints_off: dict[str, float] = {}
HINTS_RETRY_S = 60.0


def _hints_ok(db: AsyncIOMotorDatabase) -> bool:
    off = _hints_off.get(getattr(db, "name", ""))
    return off is None or time.monotonic() - off > HINTS_RETRY_S


async def _restore_indexes(db: AsyncIOMotorDatabase) -> None:
    try:
        await search_index.ensure_indexes(db)
        _hints_off.pop(getattr(db, "name", ""), None)
    except Exception:
        log.warning("search: could not recreate the word indexes", exc_info=True)


CONTENT_LIMIT = 3000          # ids per (word, field) lookup: a word in thousands of bodies says little
TYPO_IF_FEWER = 25            # look for typo variants of a word found in fewer items than this


async def _content_hits(db: AsyncIOMotorDatabase, terms: Terms, ids: list) -> dict[Any, dict]:
    """Which of ``ids`` hold each query word in a heading (``h``) or the body (``b``), and how
    well: id → {"h": [score per word], "b": [...]}. Exact words, one-edit typo variants and the
    last word as a prefix, each an indexed lookup returning ids only, run concurrently."""
    import asyncio

    n = len(terms.tokens)
    if not ids or not n:
        return {}
    variants: dict[int, list[str]] = {}
    for word, pairs in terms.expand.items():
        for i, quality in pairs:
            if quality < 100:
                variants.setdefault(i, []).append(word)
    live = [i for i, tok in enumerate(terms.tokens) if not (n > 1 and tok in st.STOPWORDS)]
    coll = db[search_index.COLL]
    filt_ids = {"$in": ids}
    out: dict[Any, dict] = {}
    # Windows of long texts (services/search_chunks.py): looked up by word over the windows, kept only
    # for these ids (and an "around" window only when its page is among them too).
    idset = set(ids)
    chunk_filter: dict = {"p": {"$in": ids}} if len(ids) <= 2000 else {}
    chunks = db[search_chunks.COLL]

    async def chunk_rows(cond: dict) -> list:
        try:
            cur = chunks.find({**chunk_filter, "w": cond}, {"p": 1, "g": 1}).limit(CONTENT_LIMIT * 2)
            rows = await cur.to_list(length=CONTENT_LIMIT * 2)
        except OperationFailure:
            return []
        return [{"_id": r["p"]} for r in rows if r.get("p") in idset and (r.get("g") is None or r["g"] in idset)]

    async def run(jobs: list[tuple[str, int, float, dict]]) -> dict[int, int]:
        """Runs the lookups; returns, per query word, how many items it hit."""
        async def one(f: str, cond: dict) -> list:
            if f == "cw":
                return await chunk_rows(cond)
            cur = coll.find({"_id": filt_ids, f: cond}, {"_id": 1}).limit(CONTENT_LIMIT)
            if _hints_ok(db):
                try:
                    return await cur.hint(f"{f}_id").to_list(length=CONTENT_LIMIT)
                except OperationFailure:
                    # The covering index is missing (a dropped collection): answer without it, and
                    # put the indexes back in the background (once per database at a time).
                    if _hints_ok(db):
                        _hints_off[getattr(db, "name", "")] = time.monotonic()
                        asyncio.get_running_loop().create_task(_restore_indexes(db))
                    cur = coll.find({"_id": filt_ids, f: cond}, {"_id": 1}).limit(CONTENT_LIMIT)
            return await cur.to_list(length=CONTENT_LIMIT)

        results = await asyncio.gather(*(one(f, cond) for f, _i, _q, cond in jobs))
        found: dict[int, int] = {}
        for (f, i, quality, _cond), rows in zip(jobs, results):
            key = "h" if f == "hw" else "b"
            if f == "cw":
                rows = list({r["_id"]: r for r in rows}.values())
            found[i] = found.get(i, 0) + len(rows)
            for r in rows:
                hit = out.get(r["_id"])
                if hit is None:
                    hit = out[r["_id"]] = {"h": [0.0] * n, "b": [0.0] * n}
                if quality > hit[key][i]:
                    hit[key][i] = quality
        return found

    # 1. The words as typed (and the last one as a prefix).
    jobs = [(f, i, 100.0, {"$in": [terms.tokens[i]]}) for i in live for f in ("w", "hw", "cw")]
    for p in terms.prefixes:
        if (n - 1) in live:
            jobs += [(f, n - 1, 92.0, {"$regex": "^" + re.escape(p)}) for f in ("w", "hw", "cw")]
    found = await run(jobs)
    # 2. Typos: one-edit variants, only for words that are rare or missing as typed.
    jobs = []
    for i in live:
        if found.get(i, 0) < TYPO_IF_FEWER and variants.get(i):
            quality = max(q for w in variants[i] for j, q in terms.expand[w] if j == i)
            jobs += [(f, i, quality, {"$in": variants[i]}) for f in ("w", "hw", "cw")]
    if jobs:
        await run(jobs)
    return out


def _rank(cands: list[Cand], terms: Terms, content: dict, q: Query, now: datetime) -> list[Cand]:
    vocab_set: dict[str, None] = {}
    for c in cands:
        for w in c.words:
            vocab_set[w] = None
        for w in c.extra_words:
            vocab_set[w] = None
    vocab = list(vocab_set)
    per_tok = token_scores(terms, vocab)
    n = len(terms.tokens)
    zeros = [0.0] * n
    wsum = sum(terms.weights) or 1.0
    matched = set()
    for sc in per_tok:
        matched.update(sc)
    out: list[Cand] = []
    for c in cands:
        hit = content.get(c.content_id) if c.content_id is not None else None
        if hit is None and not any(w in matched for w in c.words) and not any(w in matched for w in c.extra_words):
            continue
        title = [0.0] * n
        hits: set = set()
        for i in range(n):
            sc = per_tok[i]
            best, best_w = 0.0, None
            for w in c.words:
                s = sc.get(w, 0.0)
                if s > best:
                    best, best_w = s, w
            for w in c.extra_words:
                s = sc.get(w, 0.0) * 0.9
                if s > best:
                    best, best_w = s, w
            title[i] = best
            if best_w is not None:
                hits.add(best_w)
        head, body = (hit["h"], hit["b"]) if hit else (zeros, zeros)
        best = [max(title[i], 0.86 * head[i], 0.72 * body[i]) for i in range(n)]
        base = sum(b * w for b, w in zip(best, terms.weights)) / wsum
        if base < MIN_SCORE - 12:
            continue
        # Phrase-ish bonus: the whole query is the title, or starts it.
        tnorm = " ".join(c.words)
        if tnorm and terms.norm:
            if tnorm == terms.norm:
                base += 6
            elif tnorm.startswith(terms.norm):
                base += 3
        if n > 1 and all(t >= 70 for t in title):
            base += 2
        if base < MIN_SCORE:
            continue
        c.title_hits, c.head_hits, c.body_hits = hits, max(head) > 0, max(body) > 0
        c.where = ("title" if max(title) >= max(0.86 * max(head), 0.72 * max(body)) else
                   "heading" if 0.86 * max(head) >= 0.72 * max(body) else "body")
        boost = recency_boost(c.updated, now)
        if q.current and c.ws_id == q.current:
            boost += 6.0
        if c.mine:
            boost += 2.0
        if c.kind == "workspace":
            boost += 1.0
        c.score = round(base + boost, 3)
        out.append(c)
    out.sort(key=lambda c: (-c.score, -(c.updated.timestamp() if c.updated else 0)))
    return out


async def _folder_cands(db: AsyncIOMotorDatabase, w: World, q: Query) -> list[Cand]:
    from app.services import folder as folder_service

    out = []
    for ws, _role in w.memberships:
        if q.scope and ws.id != q.scope:
            continue
        flist = await folder_service.list_folders(db, ws.id)
        by_id = {f.id: f for f in flist}
        tview = await w.ctx.team_view(ws.id, w.actor.user_id)
        tfold = {str(r["_id"]): r for r in await db["folders"].find(
            {"workspace_id": ws.id, "$or": [{"team_ids": {"$exists": True}}, {"project_ids": {"$exists": True}}]},
            {"team_ids": 1, "project_ids": 1}).to_list(length=5000)}
        for f in flist:
            if f.id in tfold and not teams_service.item_ok(tview, tfold[f.id]):
                continue
            names = [f.name]
            p = by_id.get(f.parent_id) if f.parent_id else None
            guard = 0
            while p is not None and guard < 12:
                names.insert(0, p.name)
                p = by_id.get(p.parent_id) if p.parent_id else None
                guard += 1
            out.append(Cand(key=f"f:{f.id}", kind="folder", title=f.name, words=st.title_words(f.name),
                            extra_words=(), updated=_aware(getattr(f, "updated_at", None)), ws_id=ws.id,
                            extra={"id": f.id, "path": names[:-1], "workspace": {"id": ws.id, "name": ws.name}}))
    return out


def _workspace_cands(w: World, q: Query) -> list[Cand]:
    return [Cand(key=f"w:{ws.id}", kind="workspace", title=ws.name, words=st.title_words(ws.name or ""), extra_words=(),
                 updated=_aware(getattr(ws, "updated_at", None)), ws_id=ws.id,
                 extra={"id": ws.id, "role": role})
            for ws, role in w.memberships if not q.scope or ws.id == q.scope]


async def readable_sites(db: AsyncIOMotorDatabase, w: World) -> dict[Any, dict]:
    """Guides sites this person has a Guides role on (any role reads drafts): id → site row."""
    from app.services import docs_studio_roles as roles

    uid = w.actor.user_id
    if not uid or w.actor.tenant_ws:
        return {}
    rows = await db["docs_sites"].find(
        {"deleted_at": None, "$or": [{"workspace_id": {"$in": w.member_ws}},
                                     {"workspace_id": None, "owner_id": uid}]},
        {"workspace_id": 1, "owner_id": 1, "name": 1, "title": 1, "slug": 1}).to_list(length=500)
    ws_roles = {ws.id: role for ws, role in w.memberships}
    resolved = await roles.resolve_many(db, uid, rows, ws_roles)
    return {r["_id"]: r for r in rows if resolved.get(r["_id"]) and resolved[r["_id"]].role is not None}


async def _guide_cands(db: AsyncIOMotorDatabase, w: World, q: Query) -> list[Cand]:
    sites = await readable_sites(db, w)
    if q.scope:
        sites = {k: v for k, v in sites.items() if v.get("workspace_id") == q.scope}
    if not sites:
        return []
    filt: dict = {"site_id": {"$in": list(sites)}, "deleted_at": None}
    if q.updated in UPDATED:
        filt["draft.updated_at"] = {"$gte": (w.ctx.now - UPDATED[q.updated]).replace(tzinfo=None)}
    pages = await db["docs_pages"].find(filt, {"title": 1, "path": 1, "site_id": 1, "draft.updated_at": 1,
                                               "icon": 1}).to_list(length=MAX_SCAN)
    out = []
    for p in pages:
        site = sites[p["site_id"]]
        out.append(Cand(key=f"g:{p['_id']}", kind="guide", title=p.get("title") or "Untitled",
                        words=st.title_words(p.get("title") or ""), extra_words=st.title_words(p.get("path") or ""),
                        updated=_aware((p.get("draft") or {}).get("updated_at")), raw=p,
                        ws_id=site.get("workspace_id"), content_id=f"g:{p['_id']}",
                        extra={"site": site}))
    return out


async def _trash_cands(db: AsyncIOMotorDatabase, w: World, terms: Terms, q: Query) -> list[dict]:
    """Trash rows this person may see (``trash.manage_role``) whose title matches: titles only."""
    from app.services import trash

    actor = w.actor
    if not actor.user_id or actor.tenant_ws:
        return []
    admin_of = [ws.id for ws, role in w.memberships if role in ("owner", "admin")]
    ors: list[dict] = [{"owner_id": actor.user_id, "type": {"$ne": trash.FOLDER}}]
    if admin_of:
        ors.append({"workspace_id": {"$in": admin_of}})
    filt: dict = {"$or": ors}
    if q.scope:
        filt["workspace_id"] = q.scope
    rows = await db[trash.COLL].find(filt, {"doc.content": 0}).sort("deleted_at", -1).to_list(length=2000)
    cands: list[Cand] = []
    for r in rows:
        if trash.is_folder(r):
            title = (r.get("folder") or {}).get("name")
            kind = "folder"
        else:
            doc = r.get("doc") or {}
            title = None if doc.get("encrypted") else (doc.get("title") or doc.get("original_filename"))
            kind = search_index.doc_kind(doc)
        if not title:
            continue
        if q.kinds and kind not in q.kinds:
            continue
        cands.append(Cand(key=f"t:{r['_id']}", kind=kind, title=title, words=st.title_words(title), extra_words=(),
                          updated=_aware(r.get("deleted_at")), raw=r, ws_id=r.get("workspace_id")))
    ranked = _rank(cands, terms, {}, Query(q=q.q), w.ctx.now)
    out = []
    for c in ranked[:20]:
        role = await trash.manage_role(actor, c.raw, w.ctx)
        if role is None:
            continue
        r = c.raw
        if role == "admin" and not trash.is_folder(r):
            # An admin restores what was deleted from their workspace, but a title they couldn't
            # read stays hidden: such a row never matches a search.
            if not (await access.can(actor, r.get("doc") or {}, "read", w.ctx)).allowed:
                continue
        out.append({
            "key": trash.key_of(r), "kind": c.kind, "group": "trash", "title": c.title,
            "title_marks": marks_for(c.title, c.title_hits), "in_trash": True,
            "deleted_at": r.get("deleted_at"), "days_left": trash.days_left(r),
            "workspace": {"id": r.get("workspace_id"), "name": w.ws_names.get(r.get("workspace_id") or "")}
            if r.get("workspace_id") else None,
            "url": "/trash", "score": c.score,
        })
        if len(out) >= 5:
            break
    return out


async def run(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, q: Query) -> dict:
    """The search. Returns ``{query, items, groups, trash, next_cursor, took_ms, ai_suggested}``."""
    t0 = time.perf_counter()
    stages: dict[str, int] = {}
    last = [t0]

    def _mark(name: str) -> None:
        t = time.perf_counter()
        stages[name] = int((t - last[0]) * 1000)
        last[0] = t

    text = q.text
    terms = terms_of(text)
    empty = {"query": text, "items": [], "groups": [], "trash": [], "next_cursor": None,
             "total": 0, "took_ms": 0, "ai_suggested": False}
    if not terms.tokens or not actor.user_id:
        return empty
    w = await world_of(db, actor, ctx)
    _mark("world")
    want = q.kinds or frozenset(KINDS)

    async def docs() -> list[Cand]:
        if not want & DOC_KINDS:
            return []
        filt = await doc_filter(db, actor, ctx, w.member_ws, q)
        if filt is None:
            return []
        rows = await db["documents"].find(filt, _DOC_PROJECTION).sort("updated_at", -1).limit(
            MAX_SCAN).to_list(length=MAX_SCAN)
        return [_doc_cand(r, actor.user_id) for r in rows]

    async def folders() -> list[Cand]:
        return await _folder_cands(db, w, q) if ("folder" in want and q.owner != "me" and q.updated == "any") else []

    async def guides() -> list[Cand]:
        return await _guide_cands(db, w, q) if ("guide" in want and q.owner != "me") else []

    import asyncio

    parts = await asyncio.gather(docs(), folders(), guides())
    _mark("candidates")
    cands: list[Cand] = [c for part in parts for c in part]
    if "workspace" in want and q.owner != "me" and q.updated == "any":
        cands += _workspace_cands(w, q)
    content_ids = [c.content_id for c in cands if c.content_id is not None]
    content = await _content_hits(db, terms, content_ids)
    _mark("content")
    ranked = _rank(cands, terms, content, q, ctx.now)
    _mark("rank")
    # Whole-title similarity for the front of the list (catches joined / split words).
    for c in ranked[:300]:
        if c.title:
            wr = fuzz.WRatio(terms.norm, st.norm(c.title))
            if wr * 0.92 > c.score - 4:
                c.score = max(c.score, round(wr * 0.92 + 4, 3))
    ranked.sort(key=lambda c: (-c.score, -(c.updated.timestamp() if c.updated else 0)))

    # Wall 2: each shown hit is re-decided now.
    need = q.offset + q.limit + 1
    shown: list[Cand] = []
    per_group: dict[str, int] = {}
    group_take: list[Cand] = []
    kinds_present = {c.kind for c in ranked}
    checked = 0
    seen_keys = {c.key for c in ranked}
    for c in ranked:
        if c.raw is not None and c.raw.get("hidden_in_listings"):
            # A meeting's transcript isn't a result of its own: a hit in it finds its meeting page.
            c = await _owner_page(db, c, seen_keys)
            if c is None:
                continue
        groups_full = all(per_group.get(k, 0) >= PER_GROUP for k in kinds_present)
        if len(shown) >= need and (groups_full or checked >= MAX_CHECK):
            break
        checked += 1
        if not await _allowed(db, w, c):
            continue
        shown.append(c)
        if per_group.get(c.kind, 0) < PER_GROUP:
            per_group[c.kind] = per_group.get(c.kind, 0) + 1
            group_take.append(c)
    page = shown[q.offset:q.offset + q.limit]
    more = len(shown) > q.offset + q.limit
    _mark("allowed")
    shaper = Shaper(db, w)
    keyed = {c.key: c for c in page + group_take}
    shaped = await shaper.shape(list(keyed.values()), terms, snippets=q.snippets)
    items = [shaped[c.key] for c in page if c.key in shaped]
    groups = []
    for key, label in GROUPS[:-1]:
        g_items = [shaped[c.key] for c in group_take if c.kind == key and c.key in shaped]
        if g_items:
            groups.append({"key": key, "label": label, "items": g_items,
                           "more": sum(1 for c in shown if c.kind == key) > len(g_items)})
    _mark("shape")
    trash_items = await _trash_cands(db, w, terms, q) if (q.trash and q.offset == 0) else []
    _mark("trash")
    return {
        "query": text,
        "items": items,
        "groups": groups,
        "trash": trash_items,
        "next_cursor": encode_cursor(q.offset + q.limit) if more else None,
        "total": len(shown) if not more else None,
        "took_ms": int((time.perf_counter() - t0) * 1000),
        "ai_suggested": st.looks_like_question(text),
        **({"stages": stages} if DEBUG_TIMINGS else {}),
    }


async def _owner_page(db: AsyncIOMotorDatabase, c: Cand, seen: set) -> Cand | None:
    """The page a hidden sub-page belongs to, as a result with the sub-page's score (None when that
    page is already among the results, or gone)."""
    pid = c.raw.get("parent_id")
    if pid is None:
        return None
    parent = await db["documents"].find_one({"_id": pid, "deleted_at": None}, _DOC_PROJECTION)
    if parent is None:
        return None
    pc = _doc_cand(parent, None)
    if pc.key in seen:
        return None
    seen.add(pc.key)
    pc.mine, pc.score, pc.body_hits = c.mine and parent.get("owner_id") == c.raw.get("owner_id"), c.score, True
    pc.extra["via"] = c.raw          # the transcript: its best moment is the result's snippet (if readable)
    return pc


async def _allowed(db: AsyncIOMotorDatabase, w: World, c: Cand) -> bool:
    if c.kind in DOC_KINDS:
        return await access.discoverable(w.actor, c.raw, w.ctx)
    if c.kind in ("folder", "workspace"):
        return c.ws_id in w.member_ws
    if c.kind == "guide":
        return True   # sites were resolved for this caller (readable_sites) in this request
    return False


async def doc_and_guide_cands(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx,
                              q: Query) -> tuple[list[Cand], World]:
    """Documents and Guides pages this person may read (wall 1), for AI search's retrieval."""
    w = await world_of(db, actor, ctx)
    cands: list[Cand] = []
    if not actor.user_id:
        return cands, w
    filt = await doc_filter(db, actor, ctx, w.member_ws, q)
    if filt is not None:
        rows = await db["documents"].find(filt, _DOC_PROJECTION).sort("updated_at", -1).limit(
            MAX_SCAN).to_list(length=MAX_SCAN)
        cands += [_doc_cand(r, actor.user_id) for r in rows]
    if not q.kinds or "guide" in q.kinds:
        cands += await _guide_cands(db, w, q)
    return cands, w


async def rank_text(db: AsyncIOMotorDatabase, cands: list[Cand], text: str, q: Query,
                    now: datetime) -> list[Cand]:
    """``cands`` matching ``text``, best first (copies: the same candidates rank per query)."""
    terms = terms_of(text)
    if not terms.tokens:
        return []
    fresh = [Cand(key=c.key, kind=c.kind, title=c.title, words=c.words, extra_words=c.extra_words,
                  updated=c.updated, raw=c.raw, ws_id=c.ws_id, mine=c.mine, content_id=c.content_id,
                  extra=c.extra) for c in cands]
    content = await _content_hits(db, terms, [c.content_id for c in fresh if c.content_id is not None])
    return _rank(fresh, terms, content, q, now)


async def allowed(db: AsyncIOMotorDatabase, w: World, c: Cand) -> bool:
    return await _allowed(db, w, c)


# ── Shaping ───────────────────────────────────────────────────────────────────


class Shaper:
    """Result rows. Owner names follow the presence rule (a relationship to the item, else none);
    folder names are workspace metadata, shown only to the workspace's members."""

    def __init__(self, db: AsyncIOMotorDatabase, w: World):
        self.db, self.w = db, w
        self.hosts = urls.HostCache(db)
        self._folders: dict[str, dict] = {}

    async def folder_names(self, ws_id: str | None) -> dict:
        if not ws_id or ws_id not in self.w.member_ws:
            return {}
        if ws_id not in self._folders:
            from app.services import folder as folder_service

            flist = await folder_service.list_folders(self.db, ws_id)
            by_id = {f.id: f for f in flist}
            out = {}
            for f in flist:
                names = [f.name]
                p = by_id.get(f.parent_id) if f.parent_id else None
                guard = 0
                while p is not None and guard < 12:
                    names.insert(0, p.name)
                    p = by_id.get(p.parent_id) if p.parent_id else None
                    guard += 1
                out[f.id] = {"id": f.id, "name": f.name, "path": names}
            self._folders[ws_id] = out
        return self._folders[ws_id]

    async def shape(self, cands: list[Cand], terms: Terms, *, snippets: bool = True) -> dict[str, dict]:
        from app.services import workspace_items as items_service

        docs = [c for c in cands if c.kind in DOC_KINDS]
        names = await items_service.owner_cards(self.db, [c.raw.get("owner_id") for c in docs])
        texts: dict[Any, dict] = {}
        want = [c.content_id for c in cands if c.content_id is not None and snippets]
        if want:
            rows = await self.db[search_index.COLL].find({"_id": {"$in": want}}, {"x": 1, "hd": 1, "nc": 1}).to_list(
                length=len(want))
            texts = {r["_id"]: r for r in rows}
        self.windows = await self.best_windows(cands, texts, terms) if snippets else {}
        out: dict[str, dict] = {}
        for c in cands:
            if c.kind in DOC_KINDS:
                out[c.key] = await self._doc(c, names, texts, terms)
            elif c.kind == "folder":
                out[c.key] = {"key": c.key, "kind": "folder", "group": "folder", "id": c.extra["id"],
                              "title": c.title, "title_marks": marks_for(c.title, c.title_hits),
                              "workspace": c.extra["workspace"], "folder": {"path": c.extra["path"]},
                              "url": f"/w/{c.ws_id}/f/{c.extra['id']}", "updated_at": c.updated,
                              "score": c.score, "match": c.where}
            elif c.kind == "workspace":
                out[c.key] = {"key": c.key, "kind": "workspace", "group": "workspace", "id": c.extra["id"],
                              "title": c.title, "title_marks": marks_for(c.title, c.title_hits),
                              "role": c.extra["role"], "url": f"/w/{c.extra['id']}", "updated_at": c.updated,
                              "score": c.score, "match": c.where}
            elif c.kind == "guide":
                out[c.key] = self._guide(c, texts, terms)
        for row in out.values():
            # `url` is what the app opens (app paths stay relative); `web_url` is always a full link.
            u = row.get("url") or ""
            row["web_url"] = u if u.startswith("http") else urls.markdrop_url(u.lstrip("/"))
        return out

    async def gate_ok(self, page_id) -> bool:
        raw = await self.db["documents"].find_one({"_id": page_id, "deleted_at": None})
        return raw is not None and (await access.can(self.w.actor, raw, "read", self.w.ctx)).allowed

    async def best_windows(self, cands: list[Cand], texts: dict, terms: Terms, per: int = 1) -> dict:
        """Candidate key → its best windows (services/search_chunks.py) for a whole-length match: a
        file's page, a video's minute, a meeting's transcript moment (only when the transcript is
        readable by this person)."""
        want: dict[Any, str] = {}
        for c in cands:
            if c.kind not in DOC_KINDS or c.raw is None or search_index.title_only(c.raw):
                continue
            via = c.extra.get("via") if c.extra else None
            if via is not None:
                if not (await access.can(self.w.actor, via, "read", self.w.ctx)).allowed:
                    continue
                want[via["_id"]] = c.key
            elif (texts.get(c.content_id) or {}).get("nc") or c.raw.get("kind") == "artifact":
                want[c.content_id] = c.key
        if not want:
            return {}
        got = await search_chunks.best(self.db, list(want), terms, per=per, gate_ok=self.gate_ok)
        return {want[p]: rows for p, rows in got.items() if p in want}

    def _window_snippet(self, c: Cand, terms: Terms) -> tuple[dict | None, str | None]:
        rows = (getattr(self, "windows", None) or {}).get(c.key) or []
        if not rows:
            return None, None
        r = search_chunks.focus(rows[0], terms)
        sn = snippet(r.get("x") or "", terms.marks, terms.prefixes)
        if not sn:
            return None, None
        where = search_chunks.where(r)
        if where and r.get("src") != "around":
            lead = f"{where[3:] if where.startswith('at ') else where.capitalize()} · "
            sn = {"text": lead + sn["text"], "marks": [[a + len(lead), b + len(lead)] for a, b in sn["marks"]],
                  "where": where}
        return sn, r.get("f") if r.get("src") != "around" else None

    def _snippet(self, c: Cand, texts: dict, terms: Terms) -> tuple[dict | None, str | None]:
        if c.body_hits:
            sn, frag = self._window_snippet(c, terms)
            if sn:
                return sn, frag
        row = texts.get(c.content_id) if c.content_id is not None else None
        if not row:
            return None, None
        if c.where == "heading" and c.head_hits:
            for h in row.get("hd") or []:
                if any(terms.hits(w) for w in st.words(h.get("t"))):
                    return {"text": h["t"], "marks": marks_for(h["t"], terms.marks, terms.prefixes)}, h.get("id")
        x = row.get("x") or ""
        # The text usually opens with the title as its first heading: the row shows it already.
        if c.title and fold(x[:len(c.title) + 2]).strip().startswith(fold(c.title).strip()):
            x = x[len(c.title):].lstrip()
        if c.body_hits or c.head_hits:
            sn = snippet(x, terms.marks, terms.prefixes)
            if sn:
                return sn, None
        x = x.strip()
        if x:
            first = x.split("\n", 1)[0][:SNIPPET_CHARS]
            return {"text": first + ("…" if len(first) < len(x) else ""), "marks": []}, None
        return None, None

    async def _doc(self, c: Cand, names: dict, texts: dict, terms: Terms) -> dict:
        from app.services import artifact as art_service

        raw = c.raw
        f = await access.facts(self.w.actor, raw, self.w.ctx)
        card = names.get(raw.get("owner_id") or "") or {}
        if c.mine:
            owner = {"name": card.get("name"), "is_you": True}
        elif f.role is None:
            owner = {"name": None, "is_you": False}       # the presence rule
        else:
            owner = {"name": card.get("name"), "is_you": False}
        ws = f.ws if f.ws_id else None
        folder = None
        if raw.get("folder_id"):
            fo = (await self.folder_names(raw.get("workspace_id"))).get(raw["folder_id"])
            if fo:
                folder = {"id": fo["id"], "name": fo["name"], "path": fo["path"]}
        url = await urls.workspace_url(self.db, raw, self.hosts) or urls.markdrop_url(raw["slug"])
        sn, anchor = self._snippet(c, texts, terms)
        moment_url = None
        via = c.extra.get("via") if c.extra else None
        if anchor and via is not None and sn and sn.get("where"):
            # A transcript moment: the result stays the meeting page; the moment links into the transcript.
            moment_url = urls.markdrop_url(f"{via.get('slug')}#{anchor}") if via.get("slug") else None
        elif anchor:
            url = f"{url}#{anchor}"
        is_file = raw.get("kind") == "artifact"
        title = c.title
        if title is None and not raw.get("encrypted"):
            # An untitled page: its first heading, as the listings show it.
            hd = (texts.get(c.content_id) or {}).get("hd") or []
            title = hd[0]["t"] if hd else None
        return {
            "key": c.key, "kind": c.kind, "group": c.kind, "slug": raw["slug"],
            "title": title, "title_marks": marks_for(title, c.title_hits),
            "encrypted": bool(raw.get("encrypted")), "has_password": bool(raw.get("read_password_hash")),
            "icon": raw.get("page_icon"), "mime": raw.get("mime") if is_file else None,
            "type_label": art_service.label_for(raw.get("mime") or "") if is_file else None,
            "workspace": {"id": f.ws_id, "name": ws.name} if ws is not None else None,
            "folder": folder, "owner": owner, "updated_at": raw.get("updated_at"),
            "snippet": sn, "match": c.where, "url": url, "score": c.score,
            **({"moment_url": moment_url} if moment_url else {}),
        }

    def _guide(self, c: Cand, texts: dict, terms: Terms) -> dict:
        p, site = c.raw, c.extra["site"]
        sn, anchor = self._snippet(c, texts, terms)
        url = f"/guides/{site['_id']}?page={p['_id']}"
        return {
            "key": c.key, "kind": "guide", "group": "guide", "id": str(p["_id"]),
            "title": c.title, "title_marks": marks_for(c.title, c.title_hits),
            "guide": {"id": str(site["_id"]), "name": site.get("name") or site.get("title") or site.get("slug")},
            "path": p.get("path"), "icon": p.get("icon"),
            "workspace": {"id": site.get("workspace_id"), "name": self.w.ws_names.get(site.get("workspace_id") or "")}
            if site.get("workspace_id") else None,
            "updated_at": c.updated, "snippet": sn, "match": c.where, "url": url, "score": c.score,
        }
