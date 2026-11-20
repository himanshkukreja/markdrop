"""⌘K AI search and Slack ``/markdrop ask`` on Ask's engine (AI quality stage 4, R9).

    POST /api/v1/search/ask (SSE, routers/search.py)  → :func:`palette`
    Slack /markdrop ask (services/slack_events._ask)   → :func:`slack`

Both used to run the one-shot AI search (services/search_ai.ask): no who's-asking, no Team memory, no index, no
deals or Jira — the same question answered differently per surface. They now run Ask Markdrop
(services/ask_markdrop.ask: the same access rules, budget ``search_ai``, ledger rows with ``via`` "palette" /
"slack"), without saving a thread, and keep their own contracts:

* ⌘K: events ``status {stage: expanding | searching | answering}``, ``results {items}`` (search items with ``n``),
  ``delta``, ``done {request_id, usage, answer, citations [{n, key, title, url, kind, slug}], ranked, truncated}``,
  ``limit``, ``error`` — answers cite ``[n]`` only (a transcript line ``[n-sK]`` becomes its item ``[n]``);
  ``done`` also carries ``intent`` and ``people`` (person cards) for the palette to use when it wants.
* Slack: the answer in Slack's mrkdwn with ``[n]`` and the sources by ``n``.

``settings.search_ai_engine = "search"`` switches both back to the older engine.
"""

from __future__ import annotations

import re
from typing import AsyncIterator

from motor.motor_asyncio import AsyncIOMotorDatabase

from app.services import access

STAGES = {"understanding": "expanding", "planning": "searching", "searching": "searching", "answering": "answering"}
_LINE = re.compile(r"\[(\d{1,3})-s\d{1,5}\]")
_TWICE = re.compile(r"(\[\d{1,3}\])(?:\s*\1)+")


def engine() -> str:
    from app.config import get_settings

    return "search" if (get_settings().search_ai_engine or "ask") == "search" else "ask"


def flat(text: str) -> str:
    """``[n-sK]`` → ``[n]``, and the same ``[n]`` twice in a row once."""
    return _TWICE.sub(r"\1", _LINE.sub(r"[\1]", text or ""))


class _Stream:
    """Flattens labels in streamed text: an unfinished ``[12-s`` waits for its ``]`` (``done`` brings the whole answer,
    deduplicated, which the palette shows in the end)."""

    def __init__(self):
        self.held = ""

    def push(self, piece: str) -> str:
        text = self.held + piece
        br = text.rfind("[")
        if br >= 0 and "]" not in text[br:] and len(text) - br < 12:
            text, self.held = text[:br], text[br:]
        else:
            self.held = ""
        return _LINE.sub(r"[\1]", text)

    def end(self) -> str:
        out, self.held = _LINE.sub(r"[\1]", self.held), ""
        return out


def _citations(cits: list[dict]) -> list[dict]:
    out: dict[int, dict] = {}
    for c in cits or []:
        n = c.get("n")
        if not isinstance(n, int) or n in out:
            continue
        out[n] = {"n": n, "key": c.get("key"), "title": c.get("title"), "url": c.get("url"), "kind": c.get("kind"),
                  "slug": c.get("slug")}
    return list(out.values())


async def palette(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, question: str, *,
                  scope: str | None = None, via: str = "palette") -> AsyncIterator[tuple[str, dict]]:
    """Ask's events in ⌘K's contract (see the module docstring)."""
    from app.services import ask_markdrop

    flow = _Stream()
    async for event, data in ask_markdrop.ask(db, actor, ctx, question, scope=scope, via=via, save=False):
        if event == "status":
            out = {"stage": STAGES.get(data.get("stage"), "searching")}
            if data.get("terms"):
                out["terms"] = data["terms"]
            yield event, out
        elif event == "delta":
            text = flow.push(data.get("text") or "")
            if text:
                yield event, {"text": text}
        elif event == "done":
            rest = flow.end()
            if rest:
                yield "delta", {"text": rest}
            ranked = [{"key": it.get("key"), "title": it.get("title"), "url": it.get("url"), "kind": it.get("kind"),
                       "slug": it.get("slug"), "n": it.get("n")} for it in data.get("ranked") or []]
            yield event, {"request_id": data.get("request_id"), "usage": data.get("usage"), "answer": flat(data.get("answer") or ""),
                          "citations": _citations(data.get("citations") or []), "ranked": ranked,
                          "truncated": bool(data.get("truncated")), "intent": data.get("intent"),
                          "people": data.get("people") or []}
        else:
            yield event, data


_BOLD = re.compile(r"\*\*([^*\n]+)\*\*")
_HEAD = re.compile(r"^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$", re.M)
_BULLET = re.compile(r"^(\s*)[-*]\s+", re.M)


def mrkdwn(text: str) -> str:
    """Ask's Markdown in Slack's mrkdwn: **bold** → *bold*, headings bold, bullets as •."""
    t = _HEAD.sub(r"**\1**", text or "")
    t = _BOLD.sub(r"*\1*", t)
    return _BULLET.sub(r"\1• ", t)


async def slack(db: AsyncIOMotorDatabase, actor: access.Actor, ctx: access.Ctx, question: str, *,
                scope: str | None = None) -> dict:
    """The done data for Slack: ``answer`` (mrkdwn, ``[n]``), ``citations`` by ``n``. Raises pages_ai.AIError."""
    from app.services import ask_markdrop

    done = await ask_markdrop.answer(db, actor, ctx, question, scope=scope, via="slack", save=False)
    return {**done, "answer": mrkdwn(flat(done.get("answer") or "")), "citations": _citations(done.get("citations") or [])}
