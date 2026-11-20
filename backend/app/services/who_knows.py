"""Who knows about X? (AI quality stage 4)

    Ask: "who knows about index sharding?", "who should I talk to about the Globex renewal?" → a "People connected to
    this topic" section in the index block, built from the items the search found for the question.
    MCP ``who_knows(workspace, topic)``

From the matching items (already decided readable for this asker), the people connected to them, scored: who created
an item (3), edited it (1), spoke in the matching transcript lines (2 a line, up to 3 lines), owns an action item on it
(2), started or joined a comment thread on it (1), attended a matching meeting (0.5); an item's weight falls with its
rank. Names only where the asker may see people on that item (``pages.sees_people``), only workspace members.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from motor.motor_asyncio import AsyncIOMotorDatabase

from app.services import access, ai_index

EXPERT = re.compile(
    r"\bwho(?:'s| is| are)? (?:knows?|would know|(?:the |our )?(?:expert|experts|go-to|best person|right person|point person)|"
    r"(?:most )?familiar with|has context|have context)\b"
    r"|\bwho (?:should|can|could|do) (?:i|we) (?:ask|talk to|speak (?:to|with)|contact|go to|reach out to)\b"
    r"|\bwho(?:'s| has| have)? (?:been )?(?:worked|working|work) on\b", re.I)
MAX_ITEMS = 15
MAX_PEOPLE = 5
W = {"created": 3.0, "edited": 1.0, "spoke": 2.0, "owns": 2.0, "comment": 1.0, "attended": 0.5}


def is_expert_question(question: str) -> bool:
    return bool(EXPERT.search(question or ""))


@dataclass
class _P:
    name: str
    score: float = 0.0
    why: list[str] = field(default_factory=list)


async def connected(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx,
                    items: list[tuple[Any, str | None, list[str]]], *, limit: int = MAX_PEOPLE) -> list[dict]:
    """``items``: (document id, its label like "[3]" or None, the speakers of its matching transcript lines), best
    first, every one already decided readable for this asker. → [{id, name, score, why: [str]}], best first."""
    from app.services import ask_route, workspace_memory

    items = [(ai_index._oid(d), lab, sp) for d, lab, sp in items[:MAX_ITEMS]]
    items = [x for x in items if x[0] is not None]
    if not items or not actor.user_id:
        return []
    ids = [d for d, _l, _s in items]
    rows = {r["doc"]: r for r in await db[ai_index.COLL].find({"t": "doc", "doc": {"$in": ids}}).to_list(length=len(ids))}
    raws = {r["_id"]: r for r in await db["documents"].find({"_id": {"$in": ids}}, {"content": 0}).to_list(length=len(ids))}
    acts: dict[Any, list[dict]] = {}
    for r in await db[ai_index.COLL].find({"t": "action", "doc": {"$in": ids}}, {"doc": 1, "owner": 1, "text": 1, "done": 1}).to_list(length=2000):
        acts.setdefault(r["doc"], []).append(r)
    coms: dict[Any, list[dict]] = {}
    for r in await db[ai_index.COLL].find({"t": "comment", "doc": {"$in": ids}}, {"doc": 1, "author": 1, "participants": 1}).to_list(length=2000):
        coms.setdefault(r["doc"], []).append(r)
    wss = sorted({r.get("workspace_id") for r in raws.values() if r.get("workspace_id")})
    members: dict[str, str] = {}
    by_name: dict[str, str] = {}
    for w in wss:
        if await ctx.role(w, actor.user_id) is None:
            continue
        for m in await workspace_memory.members_of(db, w):
            members.setdefault(m["id"], m["name"])
            by_name.setdefault((m.get("name") or "").casefold(), m["id"])
    names = ask_route._Names(db, actor, ctx)
    people: dict[str, _P] = {}

    def add(uid: str | None, pts: float, why: str) -> None:
        if not uid or uid not in members:
            return
        p = people.setdefault(uid, _P(members[uid]))
        p.score += pts
        if why not in p.why:
            p.why.append(why)

    for rank, (d, lab, speakers) in enumerate(items):
        raw = raws.get(d)
        if raw is None or raw.get("workspace_id") not in wss or not await names.sees(raw):
            continue
        k = 1.0 / (1.0 + 0.15 * rank)
        row = rows.get(d) or {}
        title = row.get("mtitle") or row.get("title") or raw.get("title") or "Untitled"
        ref = f"“{title}”" + (f" {lab}" if lab else "")
        meeting = row.get("kind") == "meeting"
        if not meeting and row.get("system") is None:
            add(row.get("creator"), W["created"] * k, f"created {ref}")
            for e in (row.get("editors") or [])[:10]:
                if e != row.get("creator"):
                    add(e, W["edited"] * k, f"edited {ref}")
        for sp in dict.fromkeys(s for s in speakers if s):
            uid = by_name.get(sp.casefold().strip())
            n = sum(1 for s in speakers if s == sp)
            add(uid, W["spoke"] * k * min(3, n), f"spoke about it in {ref}")
        if meeting:
            for a in (row.get("attendees") or [])[:30]:
                add(a, W["attended"] * k, f"attended {ref}")
        for a in acts.get(d, [])[:20]:
            add(a.get("owner"), W["owns"] * k, f"{'did' if a.get('done') else 'owns'} “{a.get('text')}” ({ref})")
        for c in coms.get(d, [])[:20]:
            for u in dict.fromkeys([c.get("author"), *(c.get("participants") or [])]):
                add(u, W["comment"] * k, f"commented on {ref}")
    ranked = sorted(people.items(), key=lambda kv: -kv[1].score)[:limit]
    return [{"id": uid, "name": p.name, "score": round(p.score, 2), "why": p.why[:5]} for uid, p in ranked if p.score >= 1.0]


def lines(found: list[dict]) -> list[str]:
    return [f"{p['name']} — " + "; ".join(p["why"]) for p in found]
