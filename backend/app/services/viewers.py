"""Who's viewing a document right now ("presence", like Google Docs).

Rides on the live socket (routers/live.py, ``/ws/docs/{slug}``). A page that
wants presence says ``hello``; from then on it gets ``presence`` snapshots of
everyone on the document, and tells us where it is (a heading, a PDF page, a
point in a video) and whether its tab is visible.

Who appears by name (decided here, never by the client)
-------------------------------------------------------
Only someone with a real relationship to the document: its owner, a member of
its workspace whose role lets them read it, or a person it was shared with by
email — exactly ``access.facts(...).role is not None``. Everyone else, signed
in or not, is "Anonymous <Animal>". For them no name, email, picture or user
id leaves this module. A viewer who qualifies can still ask to be shown as
anonymous (``anon``).

The account behind a socket is the one named in the ``presence_ticket`` a
signed-in read returned (services/tickets.py), sent in ``hello``. The
relationship is re-checked from the database when the socket says hello and
every :data:`RECHECK_S` seconds after, so a removed member or grant drops to
anonymous within a minute even when nothing pinged the socket.

What everyone sees
------------------
``{"type": "presence", "on": true, "total": N, "viewers": [...], "you": id,
"me": {...}}`` — at most :data:`MAX_LISTED` entries (named people merged across
their tabs, then anonymous tabs; active before away), plus the total. On an
end-to-end encrypted document only ``{"count_only": true, "total": N}``: names
and sections never, since its headings are content the server must not hold.
With the owner's "Show who's viewing" off: ``{"on": false}`` and nothing else.

The anonymous animal and the colour come from a hash of the tab's own random
nonce (kept in its sessionStorage) and the slug, with the server's secret: the
same tab keeps its animal across reconnects, different documents give it
different animals, and nothing about the account goes into it.

State is in memory only, in this process (the single uvicorn worker, like
services/live.py). Nothing here is logged, stored or sent to analytics. If the
API ever runs more than one worker, this must move behind Redis pub/sub along
with services/live.py.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import re
import secrets
import time
from dataclasses import dataclass, field

from app.config import get_settings

HEARTBEAT_S = 15.0          # the page pings this often (documented for the client)
TIMEOUT_S = 40.0            # an active tab silent this long drops off the list
AWAY_TIMEOUT_S = 75.0       # a hidden tab: browsers slow its timers to about once a minute
RECHECK_S = 60.0            # re-decide who may appear by name
SWEEP_S = 5.0
FLUSH_S = 0.75              # at most one snapshot per document this often
MAX_LISTED = 50             # entries in one snapshot (plus the total)
MAX_PER_ROOM = 300          # listed + counted on one document; more only watch
MAX_PER_IP = 25             # per document and client address; more only watch
MAX_MESSAGE_BYTES = 1024
BUCKET = 20.0               # messages a socket may send in a burst…
REFILL_PER_S = 1 / 1.5      # …and after that, one every 1.5 s
DROP_LIMIT = 60             # a socket that keeps flooding past the limit is closed
LABEL_MAX = 120
NAME_MAX = 60
COLORS = 6                  # the client maps 0..5 onto six design-system hues (lib/presence.ts)

ANIMALS = (
    "Otter", "Fox", "Owl", "Panda", "Koala", "Tiger", "Lion", "Rabbit", "Hedgehog", "Penguin",
    "Dolphin", "Whale", "Octopus", "Turtle", "Frog", "Badger", "Raccoon", "Llama", "Sloth",
    "Flamingo", "Parrot", "Swan", "Eagle", "Duck", "Bee", "Butterfly", "Ladybug", "Crab", "Seal",
    "Squirrel", "Zebra", "Giraffe", "Kangaroo", "Hippo", "Camel", "Elephant", "Bear", "Wolf",
    "Monkey", "Deer", "Bison", "Beaver", "Shark", "Lobster", "Snail", "Peacock", "Hamster",
    "Unicorn", "Dodo", "Mammoth", "Chick", "Bat", "Boar", "Gorilla", "Orangutan", "Skunk",
    "Moose", "Rhino", "Lizard", "Shrimp",
)

_NONCE = re.compile(r"^[A-Za-z0-9_-]{8,40}$")
_HEADING = re.compile(r"^user-content-[^\s<>\"']{1,200}$")
_STATES = ("active", "away")


def _now() -> float:
    return time.monotonic()


def _h(*parts: str) -> int:
    key = (get_settings().auth_secret or "markdrop").encode()
    msg = "\x00".join(parts).encode()
    return int.from_bytes(hmac.new(key, msg, hashlib.sha256).digest()[:8], "big")


@dataclass(eq=False)
class Conn:
    queue: asyncio.Queue
    ip: str
    id: str = field(default_factory=lambda: secrets.token_urlsafe(6))
    nonce: str = ""
    joined: bool = False            # said hello
    user_id: str | None = None      # from a valid presence ticket only
    named: bool = False             # appears by name (relationship holds, not anon)
    anon_pref: bool = False
    name: str | None = None
    picture: str | None = None
    owner: bool = False
    animal: str | None = None
    color: int = 0
    state: str = "active"
    sec: dict | None = None
    sec_at: float = 0.0
    last: float = field(default_factory=_now)
    at: float = field(default_factory=_now)
    present: bool = False           # listed (fresh, within the caps)
    checked_at: float = 0.0
    tokens: float = BUCKET
    tok_at: float = field(default_factory=_now)
    dropped: int = 0


@dataclass(eq=False)
class Room:
    slug: str
    doc_id: str
    enabled: bool = True
    encrypted: bool = False
    kind: str = "markdown"
    conns: dict = field(default_factory=dict)        # conn.id → Conn
    titles: dict | None = None
    titles_at: float = 0.0
    flush_handle: asyncio.TimerHandle | None = None
    last_flush: float = 0.0


_rooms: dict[str, Room] = {}
_sweeper: asyncio.Task | None = None


# ── Identity ──────────────────────────────────────────────────────────────────


def display_name(user) -> str:
    name = (getattr(user, "name", None) or "").strip()
    if not name:
        email = getattr(user, "email", "") or ""
        name = email.split("@", 1)[0] or "Someone"
    return name[:NAME_MAX]


async def relationship(db, raw: dict, user_id: str | None) -> dict | None:
    """``{"name", "picture", "owner"}`` when this account may appear by name on
    ``raw`` (owner, workspace member who can read it, or granted by email);
    None otherwise."""
    if not user_id:
        return None
    from app.services import access
    from app.services import user as user_service

    user = await user_service.get_user_by_id(db, user_id)
    if user is None:
        return None
    try:
        f = await access.facts(access.Actor.of(user), raw, access.Ctx(db))
    except Exception:
        return None
    if f.role is None:
        return None
    pic = user.picture if isinstance(user.picture, str) and user.picture.startswith("https://") else None
    return {"name": display_name(user), "picture": pic, "owner": bool(f.is_owner)}


def _animal_for(room: Room, conn: Conn) -> str:
    start = _h("animal", room.slug, conn.nonce) % len(ANIMALS)
    taken = {c.animal for c in room.conns.values() if c is not conn and c.joined and not c.named}
    for i in range(len(ANIMALS)):
        a = ANIMALS[(start + i) % len(ANIMALS)]
        if a not in taken:
            return a
    return ANIMALS[start]


def _color_for(room: Room, conn: Conn, seed: int) -> int:
    """The seeded colour, or the next one nobody else on the document has (while any is free).
    A named person keeps the colour their other tabs already have."""
    if conn.named and conn.user_id:
        for c in room.conns.values():
            if c is not conn and c.joined and c.named and c.user_id == conn.user_id:
                return c.color
    taken = {c.color for c in room.conns.values()
             if c is not conn and c.joined and not (conn.named and c.named and c.user_id == conn.user_id)}
    for i in range(COLORS):
        if (seed + i) % COLORS not in taken:
            return (seed + i) % COLORS
    return seed % COLORS


def _apply_identity(room: Room, conn: Conn, rel: dict | None) -> None:
    named = rel is not None and not conn.anon_pref
    was = (conn.named, conn.animal)
    conn.named = named
    if named:
        conn.name, conn.picture, conn.owner = rel["name"], rel["picture"], rel["owner"]
        conn.animal = None
        seed = _h("color", conn.user_id or "")
    else:
        conn.name = conn.picture = None
        conn.owner = False
        if conn.animal is None:
            conn.animal = _animal_for(room, conn)
        seed = _h("color", room.slug, conn.nonce)
    # Keep a colour once given (a re-check mustn't repaint someone), unless who they are changed.
    if (conn.named, conn.animal) != was or conn.id not in room.conns or not conn.joined:
        conn.color = _color_for(room, conn, seed)


# ── Rooms ─────────────────────────────────────────────────────────────────────


def room(slug: str) -> Room | None:
    return _rooms.get(slug)


def _room_for(slug: str, raw: dict) -> Room:
    r = _rooms.get(slug)
    if r is None or r.doc_id != str(raw["_id"]):
        r = Room(slug=slug, doc_id=str(raw["_id"]))
        _rooms[slug] = r
    r.enabled = raw.get("show_presence") is not False
    r.encrypted = bool(raw.get("encrypted"))
    r.kind = raw.get("kind") or "markdown"
    return r


def _admit(r: Room, conn: Conn) -> bool:
    """Within the caps? (Otherwise the socket only watches.)"""
    listed = [c for c in r.conns.values() if c.present and c is not conn]
    if len(listed) >= MAX_PER_ROOM:
        return False
    return sum(1 for c in listed if c.ip == conn.ip) < MAX_PER_IP


def _take_token(conn: Conn, now: float) -> bool:
    conn.tokens = min(BUCKET, conn.tokens + (now - conn.tok_at) * REFILL_PER_S)
    conn.tok_at = now
    if conn.tokens < 1:
        conn.dropped += 1
        return False
    conn.tokens -= 1
    return True


async def _titles(db, r: Room, *, force: bool = False) -> dict:
    now = _now()
    if r.titles is not None and not force:
        return r.titles
    if r.titles is not None and now - r.titles_at < 5:
        return r.titles  # a miss reloads at most every 5 s
    from bson import ObjectId

    from app.services import md_outline

    try:
        raw = await db["documents"].find_one({"_id": ObjectId(r.doc_id)}, {"content": 1})
    except Exception:
        raw = None
    r.titles = md_outline.heading_titles((raw or {}).get("content") or "") if raw else {}
    r.titles_at = now
    return r.titles


def _fmt_time(s: int) -> str:
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m}:{sec:02d}"


async def _section(db, r: Room, value) -> tuple[bool, dict | None]:
    """(valid, section) for a client's ``sec``. Labels are always made here: a
    heading's from the document itself, never text a viewer sent."""
    if value is None:
        return True, None
    if not isinstance(value, dict) or r.encrypted:
        return False, None
    h = value.get("h")
    if isinstance(h, str) and r.kind != "artifact":
        if not _HEADING.match(h):
            return False, None
        titles = await _titles(db, r)
        if h not in titles:
            titles = await _titles(db, r, force=True)
        label = titles.get(h)
        if not label:
            return False, None
        return True, {"h": h, "label": label[:LABEL_MAX]}
    p = value.get("p")
    if isinstance(p, int) and not isinstance(p, bool) and 1 <= p <= 100_000:
        return True, {"p": p, "label": f"Page {p}"}
    s = value.get("s")
    if isinstance(s, (int, float)) and not isinstance(s, bool) and 0 <= s <= 7 * 24 * 3600:
        sec = int(s) // 5 * 5
        return True, {"s": sec, "label": f"At {_fmt_time(sec)}"}
    return False, None


# ── Snapshots ─────────────────────────────────────────────────────────────────


def _entries(r: Room) -> list[dict]:
    """One entry per named person (their tabs merged) and per anonymous tab,
    each with the ids of the connections it stands for."""
    named: dict[str, dict] = {}
    out: list[dict] = []
    for c in sorted(r.conns.values(), key=lambda c: c.at):
        if not c.present:
            continue
        if c.named and c.user_id:
            e = named.get(c.user_id)
            if e is None:
                e = {"id": c.id, "name": c.name, "owner": c.owner, "color": c.color,
                     "state": c.state, "sec": c.sec, "_sec_at": c.sec_at, "_conns": {c.id}, "_at": c.at}
                if c.picture:
                    e["pic"] = c.picture
                named[c.user_id] = e
                out.append(e)
            else:
                e["_conns"].add(c.id)
                if c.state == "active":
                    e["state"] = "active"
                if c.sec is not None and c.sec_at >= e["_sec_at"]:
                    e["sec"], e["_sec_at"] = c.sec, c.sec_at
        else:
            out.append({"id": c.id, "animal": c.animal, "color": c.color, "state": c.state,
                        "sec": c.sec, "_conns": {c.id}, "_at": c.at})
    out.sort(key=lambda e: (e["state"] != "active", "name" not in e, e["_at"]))
    return out


def _public(e: dict) -> dict:
    return {k: v for k, v in e.items() if not k.startswith("_")}


def snapshots(r: Room) -> dict[str, dict]:
    """conn id → the snapshot that socket gets (they differ only in ``you``/``me``)."""
    out: dict[str, dict] = {}
    joined = [c for c in r.conns.values() if c.joined]
    if not r.enabled:
        for c in joined:
            out[c.id] = {"type": "presence", "on": False}
        return out
    entries = _entries(r)
    total = len(entries)
    if r.encrypted:
        for c in joined:
            out[c.id] = {"type": "presence", "on": True, "count_only": True, "total": total}
        return out
    listed = [_public(e) for e in entries[:MAX_LISTED]]
    by_conn = {cid: e for e in entries for cid in e["_conns"]}
    for c in joined:
        mine = by_conn.get(c.id)
        out[c.id] = {"type": "presence", "on": True, "total": total, "viewers": listed,
                     "you": mine["id"] if mine else None,
                     "me": _public(mine) if mine else None}
    return out


def flush(slug: str) -> None:
    """Send every joined socket its snapshot now."""
    r = _rooms.get(slug)
    if r is None:
        return
    if r.flush_handle is not None:
        r.flush_handle.cancel()
        r.flush_handle = None
    r.last_flush = _now()
    for cid, snap in snapshots(r).items():
        c = r.conns.get(cid)
        if c is not None:
            try:
                c.queue.put_nowait(snap)
            except asyncio.QueueFull:  # unbounded — defensive only
                pass


def _schedule(r: Room) -> None:
    """Coalesce changes: one snapshot per :data:`FLUSH_S`."""
    if r.flush_handle is not None:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        flush(r.slug)
        return
    delay = max(0.0, r.last_flush + FLUSH_S - _now())
    r.flush_handle = loop.call_later(delay, flush, r.slug)


# ── The socket's side ─────────────────────────────────────────────────────────


def connect(queue: asyncio.Queue, ip: str) -> Conn:
    """A socket admitted to a document (not yet in any room until hello)."""
    return Conn(queue=queue, ip=ip or "?")


async def handle(db, slug: str, raw: dict | None, conn: Conn, text: str) -> str | None:
    """One message from the page. Returns "close" when the socket must go
    (flooding or oversized); otherwise None. Anything malformed is ignored."""
    now = _now()
    if len(text) > MAX_MESSAGE_BYTES:
        return "close"
    if not _take_token(conn, now):
        return "close" if conn.dropped > DROP_LIMIT else None
    try:
        msg = json.loads(text)
    except ValueError:
        return None
    if not isinstance(msg, dict):
        return None
    kind = msg.get("type")
    r = _rooms.get(slug)
    if kind == "hello":
        if raw is None:
            return None
        await _hello(db, slug, raw, conn, msg, now)
        return None
    if not conn.joined or r is None or conn.id not in r.conns:
        return None
    conn.last = now
    changed = False
    if not conn.present and _admit(r, conn):
        conn.present = True
        changed = True
    if kind == "ping":
        pass
    elif kind == "state":
        v = msg.get("v")
        if v in _STATES and v != conn.state:
            conn.state, changed = v, True
    elif kind == "sec":
        if r.enabled:
            ok, sec = await _section(db, r, msg.get("sec"))
            if ok and sec != conn.sec:
                conn.sec, conn.sec_at, changed = sec, now, True
    elif kind == "anon":
        v = msg.get("v") is True
        if v != conn.anon_pref:
            conn.anon_pref = v
            rel = await relationship(db, raw, conn.user_id) if raw is not None and conn.user_id else None
            _apply_identity(r, conn, rel)
            changed = True
    if changed and conn.present:
        _schedule(r)
    return None


async def _hello(db, slug: str, raw: dict, conn: Conn, msg: dict, now: float) -> None:
    from app.services import tickets

    r = _room_for(slug, raw)
    nonce = msg.get("n")
    if not conn.nonce:
        conn.nonce = nonce if isinstance(nonce, str) and _NONCE.match(nonce) else secrets.token_urlsafe(12)
    conn.user_id = tickets.presence_user(msg.get("pt"), raw)
    conn.anon_pref = msg.get("anon") is True
    st = msg.get("state")
    conn.state = st if st in _STATES else "active"
    rel = await relationship(db, raw, conn.user_id) if conn.user_id else None
    conn.checked_at = now
    first = conn.id not in r.conns
    if first:
        r.conns[conn.id] = conn
        conn.at = now
    conn.joined = True
    conn.last = now
    _apply_identity(r, conn, rel)
    if r.enabled:
        ok, sec = await _section(db, r, msg.get("sec"))
        conn.sec = sec if ok else None
        conn.sec_at = now
    conn.present = conn.present or _admit(r, conn)
    _ensure_sweeper()
    # The newcomer gets its first snapshot at once (everyone else with it).
    if first:
        flush(slug)
    else:
        _schedule(r)


def leave(slug: str, conn: Conn) -> None:
    r = _rooms.get(slug)
    if r is None or r.conns.get(conn.id) is not conn:
        return
    r.conns.pop(conn.id, None)
    if not r.conns:
        if r.flush_handle is not None:
            r.flush_handle.cancel()
        _rooms.pop(slug, None)
        return
    if conn.present:
        _schedule(r)


# ── Changes from elsewhere ────────────────────────────────────────────────────


def set_enabled(slug: str | None, on: bool) -> None:
    """The owner's "Show who's viewing" switch: everyone hears at once."""
    r = _rooms.get(slug or "")
    if r is None:
        return
    r.enabled = bool(on)
    if not r.enabled:
        for c in r.conns.values():
            c.sec = None
    flush(r.slug)


def drop(slug: str | None) -> None:
    """Who may read it narrowed, or it's gone: every socket on it is being
    closed (services/live.py), so nobody is listed from this moment."""
    r = _rooms.pop(slug or "", None)
    if r is not None and r.flush_handle is not None:
        r.flush_handle.cancel()


def content_changed(slug: str | None) -> None:
    r = _rooms.get(slug or "")
    if r is not None:
        r.titles = None


# ── Expiry and re-checks ──────────────────────────────────────────────────────


def sweep(now: float | None = None) -> None:
    """Drop tabs that stopped pinging (their sockets stay open: a later ping
    lists them again)."""
    now = _now() if now is None else now
    for r in list(_rooms.values()):
        changed = False
        for c in r.conns.values():
            limit = AWAY_TIMEOUT_S if c.state == "away" else TIMEOUT_S
            if c.present and now - c.last > limit:
                c.present = False
                changed = True
        if changed:
            _schedule(r)


async def recheck(db, now: float | None = None) -> None:
    """Re-decide who appears by name (a removed member or grant goes anonymous)."""
    now = _now() if now is None else now
    from bson import ObjectId

    for r in list(_rooms.values()):
        due = [c for c in r.conns.values() if c.joined and c.user_id and now - c.checked_at >= RECHECK_S]
        if not due:
            continue
        try:
            raw = await db["documents"].find_one({"_id": ObjectId(r.doc_id)})
        except Exception:
            continue
        if raw is None:
            continue
        r.enabled = raw.get("show_presence") is not False
        changed = False
        for c in due:
            c.checked_at = now
            before = (c.named, c.name, c.picture, c.owner)
            _apply_identity(r, c, await relationship(db, raw, c.user_id))
            if (c.named, c.name, c.picture, c.owner) != before:
                changed = True
        if changed:
            _schedule(r)


def _ensure_sweeper() -> None:
    global _sweeper
    if _sweeper is not None and not _sweeper.done():
        return
    try:
        _sweeper = asyncio.get_running_loop().create_task(_sweep_loop())
    except RuntimeError:
        _sweeper = None


async def _sweep_loop() -> None:
    from app.database import get_database

    last_recheck = _now()
    while _rooms:
        await asyncio.sleep(SWEEP_S)
        try:
            sweep()
            if _now() - last_recheck >= RECHECK_S / 2:
                last_recheck = _now()
                await recheck(get_database())
        except Exception:  # never let one bad room stop expiry for the rest
            pass


def clear() -> None:
    """Forget everything (tests)."""
    global _sweeper
    for r in _rooms.values():
        if r.flush_handle is not None:
            r.flush_handle.cancel()
    _rooms.clear()
    if _sweeper is not None:
        _sweeper.cancel()
        _sweeper = None
