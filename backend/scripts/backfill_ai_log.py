"""One-off: fill Admin › AI › Requests (``ai_log``) with the conversations from before it existed.

The readable AI request log (services/ai_log.py, 30-day TTL) only has calls made since it shipped.
Two places already keep what was said before that:

* ``ask_threads`` (90 days): every Ask / assistant / meetings-chat conversation a signed-in person
  saved — each turn's question, the answer as shown, its citations, and the ``request_id`` of the AI
  call that wrote it. The call's ledger row (``ai_requests``, 180 days) has the rest: feature, kind,
  model, tokens, cost, latency, outcome, who made it (actor / test tagging), workspace or meeting.
* the ledger's own docs Ask AI rows (``feature: docs_ask``): they carry the question, the answer and
  its citations themselves, and the docs conversation id (``--no-docs`` leaves these out).

Each turn from the last 30 days whose ledger row exists becomes one ``ai_log`` row written by the live
writer (``ai_log.write``): the same label, actor, workspace, conversation grouping (``t:<thread id>`` /
``d:<docs conversation>``), masking (secrets; other people's email addresses and phone numbers) and the
admin's content-capture setting (off: metadata only) — plus ``backfilled: true``. A turn already in the
log (its ``request_id``) is left alone, so running it again adds nothing. Turns with no ledger row are
skipped: no model call was made (e.g. "My action items" with nothing open) or it was never metered.
What can't be rebuilt is left out: the list of sources sent to the model (only meetings' is known).

Dry run by default (counts and examples); ``--apply`` writes.

    cd backend && .venv/bin/python -m scripts.backfill_ai_log [--apply] [--days 30] [--no-docs] [--examples 12]
"""

from __future__ import annotations

import asyncio
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Any

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings  # noqa: F401  (loads .env before the services)
from app.database import connect, get_database
from app.services import ai_log, ai_usage

THREADS = "ask_threads"
WHO_KEYS = ("actor", "actor_kind", "test", "test_reason", "job", "app")


def _aware(d: Any) -> datetime | None:
    if not isinstance(d, datetime):
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _oid(v: Any) -> ObjectId | None:
    return ObjectId(str(v)) if v and ObjectId.is_valid(str(v)) else None


async def who_of(db: AsyncIOMotorDatabase, row: dict) -> dict:
    """Who made the call, as the ledger row says (classified live, or by the startup backfill); a row
    without an actor yet gets one by the same rules (services/ai_log.backfill)."""
    if row.get("actor"):
        return {k: row[k] for k in WHO_KEYS if k in row}
    feature, uid = row.get("feature") or "", row.get("user_id")
    if feature in ai_log.SYSTEM_FEATURES or row.get("visitor") == "system" or row.get("via") == "background" \
            or row.get("system"):
        return {"actor": "system", "actor_kind": "system", "test": False, "job": ai_log.job_name(feature, row)}
    if not uid:
        return {"actor": "public", "actor_kind": "public", "test": False}
    kind = "api" if row.get("via") in ("mcp", "api") else "user"
    email = (await ai_log.user_info(db, uid)).get("email") or ""
    conf = await ai_log.settings(db)
    reason = "test_domain" if ai_log.test_email(email) else (
        "internal" if email and email.lower() in conf["internal_emails"] else None)
    out = {"actor": "test" if reason else kind, "actor_kind": kind, "test": bool(reason)}
    if reason:
        out["test_reason"] = reason
    if kind == "api":
        out["app"] = "AI app"
    return out


async def _cited_workspace(db: AsyncIOMotorDatabase, citations: list) -> str | None:
    """The one workspace every cited document is in (an Ask scoped to a workspace doesn't save which)."""
    ids = {_oid(str(c.get("key"))[2:]) for c in citations or [] if isinstance(c, dict)
           and str(c.get("key") or "").startswith("d:")}
    ids.discard(None)
    if not ids:
        return None
    rows = await db["documents"].find({"_id": {"$in": list(ids)}}, {"workspace_id": 1}).to_list(length=len(ids))
    wss = {r.get("workspace_id") for r in rows}
    return next(iter(wss)) if len(wss) == 1 and None not in wss else None


async def _meeting(db: AsyncIOMotorDatabase, meeting_id: Any, cache: dict) -> dict | None:
    key = str(meeting_id or "")
    if key not in cache:
        m = await db["meetings"].find_one({"_id": _oid(key)}, {"title": 1, "doc_id": 1}) if _oid(key) else None
        if m is not None:
            page = await db["documents"].find_one({"_id": _oid(m.get("doc_id"))}, {"slug": 1}) if _oid(m.get("doc_id")) else None
            m["slug"] = (page or {}).get("slug")
        cache[key] = m
    return cache[key]


async def turn_log(db: AsyncIOMotorDatabase, row: dict, thread: dict, turn: dict, meetings: dict) -> dict:
    """What the live code passed as ``log`` for this call (services/ask_markdrop, meetings_ai, assistant),
    rebuilt from the saved turn and its ledger row."""
    feature = row.get("feature")
    cites = [c for c in turn.get("citations") or [] if isinstance(c, dict)]
    scope = turn.get("scope") if isinstance(turn.get("scope"), dict) else {}
    out: dict[str, Any] = {"input": turn.get("q") or "", "output": turn.get("a") or "", "citations": cites,
                           "conversation_id": f"t:{thread['_id']}", "backfilled": True}
    if scope.get("label"):
        out["scope_label"] = str(scope["label"])
    if feature == "search_ai":
        if row.get("scope") == "workspace":
            ws = await _cited_workspace(db, cites)
            if ws:
                out["workspace_id"] = ws
        elif "scope_label" not in out and row.get("ask") != "page":
            out["scope_label"] = "Everything"
    elif feature == "meetings_ai" and row.get("kind") == "ask" and row.get("meeting_id"):
        m = await _meeting(db, row["meeting_id"], meetings)
        title = (m or {}).get("title") or "Meeting"
        out["subject"] = title
        out.setdefault("scope_label", f"This meeting: {title}")
        if m is not None:
            out["context"] = [{"kind": "meeting", "title": title, "id": str(m["_id"]),
                               **({"url": f"/{m['slug']}"} if m.get("slug") else {})}]
    return out


def _label(row: dict, who: dict, log_in: dict, ws_names: dict) -> str:
    """The label ai_log.write will give it (for the dry run)."""
    feature = row["feature"]
    kind = ai_log.kind_of(feature, row)
    subject = log_in.get("subject")
    ws = log_in.get("workspace_id") or row.get("workspace_id")
    if subject is None and ws and feature not in ("docs_ask", "docs_editor"):
        subject = ws_names.get(ws)
    return ai_log.label_of(feature, kind, subject, public=who.get("actor_kind") == "public")


async def run(db: AsyncIOMotorDatabase, *, apply: bool = False, days: int = ai_log.RETENTION_DAYS,
              docs: bool = True, examples: int = 12, now: datetime | None = None) -> dict:
    """Plan (and with ``apply``, write) the entries. Returns the counts and a few examples."""
    days = max(1, min(int(days), ai_log.RETENTION_DAYS))   # older rows would expire at once
    now = _aware(now) or datetime.now(timezone.utc)
    cutoff = now - timedelta(days=days)
    conf = await ai_log.settings(db)
    R, L = db[ai_usage.REQUESTS], db[ai_log.COLL]
    st: Counter = Counter()
    by_label: Counter = Counter()
    convs: set[str] = set()
    ex: list[dict] = []
    seen: set[str] = set()
    meetings: dict = {}
    ws_names: dict = {}
    plan: list[tuple[datetime, dict, dict, dict]] = []   # (ts, ledger row, who, log)

    async def consider(row: dict, log_in: dict | None, conv: str, preview: str) -> None:
        rid = row["request_id"]
        if rid in seen:
            st["duplicate"] += 1
            return
        seen.add(rid)
        who = await who_of(db, row)
        ws = (log_in or {}).get("workspace_id") or row.get("workspace_id")
        if ws and ws not in ws_names:
            ws_names[ws] = await ai_log.workspace_name(db, ws)
        label = _label(row, who, log_in or {}, ws_names)
        plan.append((_aware(row["ts"]), row, who, log_in or {"backfilled": True}))
        convs.add(conv)
        by_label[label.split(" · ")[0]] += 1
        if len(ex) < examples:
            ex.append({"ts": _aware(row["ts"]).strftime("%Y-%m-%d %H:%M"), "label": label,
                       "actor": who.get("actor"), "conversation": conv, "outcome": row.get("outcome"),
                       "preview": " ".join(ai_log.redact(preview).split())[:90] if conf["content"] else "(content off)"})

    # 1. Saved Ask / assistant / meetings conversations.
    async for th in db[THREADS].find({"updated_at": {"$gte": cutoff.replace(tzinfo=None)}}):
        st["threads"] += 1
        turns = [t for t in th.get("turns") or [] if isinstance(t, dict)]
        rids = [t["request_id"] for t in turns if t.get("request_id")]
        st["turns"] += len(turns)
        st["no_request_id"] += len(turns) - len(rids)
        ledger = {r["request_id"]: r async for r in R.find({"request_id": {"$in": rids}})} if rids else {}
        logged = {r["_id"] async for r in L.find({"_id": {"$in": rids}}, {"_id": 1})} if rids else set()
        for t in turns:
            rid = t.get("request_id")
            if not rid:
                continue
            row = ledger.get(rid)
            if row is None:
                st["no_ledger_row"] += 1
                continue
            if (_aware(row.get("ts")) or cutoff) < cutoff:
                st["older"] += 1
                continue
            if rid in logged:
                st["already_logged"] += 1
                continue
            await consider(row, await turn_log(db, row, th, t, meetings), f"t:{th['_id']}", t.get("q") or "")
    st["ask_turns"] = len(plan)

    # 2. Docs Ask AI: the ledger row is the whole record (question, answer, citations, conversation).
    if docs:
        q = {"feature": "docs_ask", "ts": {"$gte": cutoff.replace(tzinfo=None)}}
        async for row in R.find(q).sort("ts", 1):
            st["docs_rows"] += 1
            if await L.find_one({"_id": row["request_id"]}, {"_id": 1}):
                st["docs_already_logged"] += 1
                continue
            conv = f"d:{row['conversation_id']}" if row.get("conversation_id") else f"r:{row['request_id']}"
            await consider(row, None, conv, row.get("question") or "")
        st["docs_turns"] = len(plan) - st["ask_turns"]

    plan.sort(key=lambda p: p[0])
    written = 0
    if apply:
        for _ts, row, who, log_in in plan:
            if await L.find_one({"_id": row["request_id"]}, {"_id": 1}):   # logged live meanwhile
                continue
            await ai_log.write(db, row, who, dict(log_in))
            written += 1
    return {"apply": apply, "days": days, "since": cutoff.isoformat(timespec="minutes"), "content": conf["content"],
            "counts": dict(st), "entries": len(plan), "conversations": len(convs), "written": written,
            "by_label": dict(by_label.most_common()), "examples": ex}


def report(out: dict) -> str:
    c = out["counts"]
    lines = [
        f"AI request log backfill — {'APPLY' if out['apply'] else 'dry run'} — turns since {out['since']} "
        f"({out['days']} days); content capture {'ON' if out['content'] else 'OFF (metadata only)'}",
        f"Ask conversations (ask_threads): {c.get('threads', 0)} threads, {c.get('turns', 0)} saved turns",
        f"  → {c.get('ask_turns', 0)} to add · {c.get('already_logged', 0)} already in the log · "
        f"{c.get('no_ledger_row', 0)} no ledger row (no model call) · {c.get('older', 0)} older than {out['days']} days · "
        f"{c.get('no_request_id', 0)} without a request id",
    ]
    if "docs_rows" in c:
        lines.append(f"Docs Ask AI (ledger): {c['docs_rows']} calls → {c.get('docs_turns', 0)} to add · "
                     f"{c.get('docs_already_logged', 0)} already in the log")
    else:
        lines.append("Docs Ask AI: skipped (--no-docs)")
    lines.append(f"Total: {out['entries']} entries in {out['conversations']} conversations"
                 + (f"; written {out['written']}" if out["apply"] else " (nothing written; --apply to write)"))
    if out["by_label"]:
        lines.append("  by feature: " + ", ".join(f"{k} {v}" for k, v in out["by_label"].items()))
    for e in out["examples"]:
        lines.append(f"  e.g. {e['ts']} · {e['label']} · {e['actor']} · {e['conversation']} · {e['outcome']} · "
                     f"{e['preview']!r}")
    return "\n".join(lines)


async def main(argv: list[str]) -> int:
    get_settings()
    await connect()
    days = int(argv[argv.index("--days") + 1]) if "--days" in argv else ai_log.RETENTION_DAYS
    n_ex = int(argv[argv.index("--examples") + 1]) if "--examples" in argv else 12
    out = await run(get_database(), apply="--apply" in argv, days=days, docs="--no-docs" not in argv, examples=n_ex)
    print(report(out))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
