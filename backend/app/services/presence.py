"""Who is on a document right now (creator analytics "live").

Fed by the engagement beacon (``POST /documents/{slug}/engage``): every send
refreshes its session's entry, and a ``final`` send removes it. An entry is
live for :data:`TTL_S` seconds after its last beacon — the tracker sends every
15 s while the page is visible, so a reader who closed the tab without a final
beacon drops off within a minute.

In-process, like ``services/live.py``: correct for the single uvicorn worker
this API runs as. Nothing here is persisted; the live feed of the last 30
minutes is derived from ``engage_sessions`` and ``events`` instead.

Entries hold no identity: a position (video second, heading id or page), a
country code, a coarse device class and the tracked kind.
"""

from __future__ import annotations

import time

TTL_S = 45.0
#: Hard bound on what one process holds; the oldest documents' entries go
#: first when it is reached (a flood of forged sids can't grow it forever).
MAX_ENTRIES = 50_000

# doc_id → sid → entry
_presence: dict[str, dict[str, dict]] = {}
_count = 0


def _now() -> float:
    return time.monotonic()


def _prune_doc(doc_id: str, now: float) -> None:
    global _count
    entries = _presence.get(doc_id)
    if not entries:
        _presence.pop(doc_id, None)
        return
    stale = [sid for sid, e in entries.items() if now - e["ts"] > TTL_S]
    for sid in stale:
        entries.pop(sid, None)
        _count -= 1
    if not entries:
        _presence.pop(doc_id, None)


def _prune_all(now: float) -> None:
    for doc_id in list(_presence):
        _prune_doc(doc_id, now)


def touch(doc_id: str, sid: str, *, pos: dict | None, country: str | None,
          device: str | None, kind: str, internal: bool = False) -> None:
    """Mark ``sid`` live on ``doc_id`` now (keeping its last known position
    when this beacon carries none)."""
    global _count
    now = _now()
    if _count >= MAX_ENTRIES:
        _prune_all(now)
        while _count >= MAX_ENTRIES and _presence:
            oldest = next(iter(_presence))
            _count -= len(_presence.pop(oldest))
    entries = _presence.setdefault(doc_id, {})
    prev = entries.get(sid)
    if prev is None:
        _count += 1
    entries[sid] = {
        "ts": now,
        "pos": pos if pos is not None else (prev or {}).get("pos"),
        "country": country,
        "device": device,
        "kind": kind,
        "internal": bool(internal),
    }


def remove(doc_id: str, sid: str) -> None:
    global _count
    entries = _presence.get(doc_id)
    if entries and entries.pop(sid, None) is not None:
        _count -= 1
        if not entries:
            _presence.pop(doc_id, None)


def snapshot(doc_ids, *, include_internal: bool = False) -> dict[str, list[dict]]:
    """``{doc_id: [{pos, country, device, kind}, ...]}`` for the live entries of
    each asked-for document (documents with nobody on them are left out)."""
    now = _now()
    out: dict[str, list[dict]] = {}
    for doc_id in doc_ids:
        if doc_id not in _presence:
            continue
        _prune_doc(doc_id, now)
        entries = _presence.get(doc_id) or {}
        rows = [
            {"pos": e["pos"], "country": e["country"], "device": e["device"], "kind": e["kind"]}
            for e in entries.values()
            if include_internal or not e["internal"]
        ]
        if rows:
            out[doc_id] = rows
    return out


def count(doc_id: str, *, include_internal: bool = False) -> int:
    return len(snapshot([doc_id], include_internal=include_internal).get(doc_id, []))


def clear() -> None:
    """Forget everything (tests)."""
    global _count
    _presence.clear()
    _count = 0
