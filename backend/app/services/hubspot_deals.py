"""HubSpot Phase 2 (owner go 2026-11-17, brief .work/briefs/hubspot-v2.md): the deal side.

**Suggested deal updates** (:func:`suggest`). After a HubSpot-team call matched to a deal has its summary
(hubspot.meeting_ready), one Meetings AI call (the ``meetings_ai`` client, ledger and caps; kind
``hubspot_suggest``) proposes changes to the deal: its stage (only a stage of the deal's own pipeline),
close date, amount, next step, and the portal's own competitor / budget / decision-maker fields when
the portal has them (read from HubSpot's deal properties: only properties that exist and can be
written). Its input is the call's notes (summary, details, decisions, action items, open questions:
lines ``[nN]``) and the transcript lines that may matter (``[sN]``: money, dates, competitors,
decisions, and the lines the notes cite), never the whole transcript. Every suggestion carries its
evidence (the quoted line and, for the transcript, its time and link); one without evidence, for a
field not offered, with a value HubSpot wouldn't take, or equal to the deal's current value is dropped.
The same call also notes the account's objections and risks (for the account page).

Suggestions are **never applied automatically**: Apply (a person who may use HubSpot on the meeting)
PATCHes the deal with that one property (scope ``crm.objects.deals.write``; refused → the connection
records the scope as missing and the card says so); Dismiss hides it. Both are remembered per
suggestion (``state``: open, applying, applied, dismissed, failed), and asking again keeps them.

**The pipeline** (:func:`pipeline`): the account's open deals (and those closed in the last two weeks)
with stage, amount, close date, owner, HubSpot's last contact and the team's last call in Markdrop
(only meetings the whole team can read), cached :data:`PIPELINE_TTL` per workspace (HubSpot's rate
limits). Ask Markdrop reads it for questions about deals (:func:`ask_sources`, only for people who may
use HubSpot); the HubSpot team's weekly brief gets a Pipeline section (:func:`brief_lines`: deals that
moved stage since last week's snapshot, deals at risk: no call for :data:`RISK_DAYS` days or the close
date passed), shown only to people who may use HubSpot (services/team_briefs.py).

Collections
    meetings.hubspot.suggestions  {portal_id, deal_id, state (done | failed | skipped), reason, at, by,
                                   items: [{id, field, label, kind, value, display, current, why,
                                   evidence: [{ref, quote, at, href}], state, at, by, error}],
                                   account: {objections: [...], risks: [...]}}
    hubspot_snapshots             _id "<workspace>:<week>": {workspace_id, week, stages {deal id: stage id}, at}
    hubspot_connections           deal_props [{name, label, type, options}] + deal_props_at (cache);
                                  denied [scopes HubSpot refused since]; stats.applied
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import time as _time
from datetime import date, datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.services import hubspot as H
from app.services.hubspot_api import HubSpotError

log = logging.getLogger("markdrop.hubspot")

KIND = "hubspot_suggest"
RESERVE = 0.02
MAX_TOKENS = 2500
MAX_SUGGESTIONS = 6
MAX_EVIDENCE = 3
EVIDENCE_LINES = 80
NOTES_CHARS = 12_000
TEXT_MAX = 300
PROPS_TTL = timedelta(hours=6)
PIPELINE_TTL = 600.0            # seconds
PIPELINE_MAX = 200
RISK_DAYS = 14
SNAPSHOTS = "hubspot_snapshots"
WRITE_SCOPE = "crm.objects.deals.write"
CUSTOM = (("competitor", re.compile(r"competitor", re.I)), ("budget", re.compile(r"budget", re.I)),
          ("decision_maker", re.compile(r"decision[ _-]?maker", re.I)))
_WORDS = re.compile(r"(\$|₹|€|£|\d+\s?k\b|budget|price|pricing|cost|quote|discount|contract|sign|signature|close|"
                    r"quarter|q[1-4]\b|month|week|january|february|march|april|may|june|july|august|september|"
                    r"october|november|december|deadline|timeline|competitor|alternative|vendor|decision|approve|"
                    r"approval|legal|procurement|security|proposal|pilot|trial|renew|seats|licen[cs]e|go live|"
                    r"next step|follow up|ceo|cfo|cto|vp|director|stakeholder)", re.I)
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


# ── The portal's deal fields ──────────────────────────────────────────────────


async def deal_properties(db, conn: dict) -> list[dict] | None:
    """The portal's deal properties [{name, label, type, field_type, options, writable}] (cached for a
    few hours on the connection); None when HubSpot didn't answer."""
    at = H._aware(conn.get("deal_props_at"))
    if conn.get("deal_props") is not None and at and now_utc() - at < PROPS_TTL:
        return conn["deal_props"]
    try:
        got = await H.call(db, conn, "GET", "crm/v3/properties/deals") or {}
    except HubSpotError as exc:
        if exc.auth or exc.limited:
            raise
        return None
    out = []
    for p in got.get("results") or []:
        mm = p.get("modificationMetadata") or {}
        out.append({"name": str(p.get("name") or ""), "label": str(p.get("label") or p.get("name") or ""),
                    "type": p.get("type"), "field_type": p.get("fieldType"),
                    "options": [{"value": str(o.get("value")), "label": str(o.get("label") or o.get("value"))}
                                for o in p.get("options") or [] if not o.get("hidden")][:50],
                    "writable": not (mm.get("readOnlyValue") or p.get("calculated") or p.get("hidden"))})
    conn["deal_props"], conn["deal_props_at"] = out, now_utc()
    if db is not None and not conn.get("_dry"):
        await db[H.CONNS].update_one({"_id": conn["_id"]}, {"$set": {"deal_props": out, "deal_props_at": conn["deal_props_at"]}})
    return out


def fields_for(props: list[dict] | None, stages: list[dict], pipeline_id: str | None) -> list[dict]:
    """What the model may propose for a deal: [{name, label, kind (stage|date|number|text|enum), options}]."""
    by = {p["name"]: p for p in props or []}
    known = props is not None
    out: list[dict] = []
    opts = [{"value": s["id"], "label": s["label"]} for s in stages if not pipeline_id or s.get("pipeline_id") == pipeline_id]
    if opts:
        out.append({"name": "dealstage", "label": "Stage", "kind": "stage", "options": opts})
    out.append({"name": "closedate", "label": "Close date", "kind": "date", "options": []})
    out.append({"name": "amount", "label": "Amount", "kind": "number", "options": []})
    if not known or "hs_next_step" in by:
        out.append({"name": "hs_next_step", "label": (by.get("hs_next_step") or {}).get("label") or "Next step",
                    "kind": "text", "options": []})
    taken = {f["name"] for f in out}
    for _key, rx in CUSTOM:
        for p in props or []:
            if p["name"] in taken or not p.get("writable") or p.get("type") not in ("string", "enumeration"):
                continue
            if p.get("field_type") in ("file", "html", "calculation_equation"):
                continue
            if rx.search(p["name"]) or rx.search(p["label"]):
                kind = "enum" if p.get("type") == "enumeration" and p.get("options") else "text"
                if p.get("type") == "enumeration" and not p.get("options"):
                    continue
                out.append({"name": p["name"], "label": p["label"], "kind": kind, "options": p.get("options") or []})
                taken.add(p["name"])
                break
    return out


# ── The model's input ─────────────────────────────────────────────────────────


def notes_lines(row: dict) -> list[tuple[str, str]]:
    """The call's notes as numbered lines [(ref "nN", text)]: summary, details, decisions, action items,
    open questions (Google's notes when the AI wrote none)."""
    gen = row.get("generated") or {}
    notes = row.get("notes") or {}
    out: list[str] = []
    summary = gen.get("summary") or notes.get("summary")
    for para in str(summary or "").split("\n\n"):
        if H._plain(para):
            out.append("Summary: " + H._plain(para))
    for d in notes.get("details") or []:
        if H._plain(d):
            out.append("Detail: " + H._plain(d))
    for sec in gen.get("details") or []:
        for pt in (sec.get("points") or []) if isinstance(sec, dict) else []:
            if isinstance(pt, dict) and H._plain(pt.get("text")):
                out.append(f"Detail ({H._plain(sec.get('title'))}): " + H._plain(pt.get("text")))
    for d in gen.get("decisions") or []:
        t = d.get("text") if isinstance(d, dict) else d
        if H._plain(t):
            out.append("Decision: " + H._plain(t))
    for it in H.items_of(row):
        extra = " · ".join(x for x in (it.get("owner"), f"due {it['due']}" if it.get("due") else None) if x)
        out.append("Action item: " + it["text"] + (f" ({extra})" if extra else ""))
    for q in gen.get("open_questions") or []:
        t = q.get("text") if isinstance(q, dict) else q
        if H._plain(t):
            out.append("Open question: " + H._plain(t))
    lines, n = [], 0
    for i, t in enumerate(out, 1):
        n += len(t)
        if n > NOTES_CHARS:
            break
        lines.append((f"n{i}", t))
    return lines


def _cited(row: dict) -> set[int]:
    gen = row.get("generated") or {}
    out: set[int] = set()
    for key in ("decisions", "action_items", "open_questions"):
        for it in gen.get(key) or []:
            m = re.match(r"^\s*\[?s?(\d{1,5})\]?\s*$", str((it or {}).get("cite") or "")) if isinstance(it, dict) else None
            if m:
                out.add(int(m.group(1)))
    return out


def evidence_segments(row: dict, limit: int = EVIDENCE_LINES) -> list[int]:
    """The transcript lines worth showing the model (1-based): lines the notes cite and lines about money,
    dates, competitors, decisions… with one line after each; in order, at most ``limit``."""
    segs = row.get("segments") or []
    want: list[int] = []
    for i in sorted(_cited(row)):
        if 1 <= i <= len(segs):
            want.append(i)
    for i, s in enumerate(segs, 1):
        if _WORDS.search(str(s.get("text") or "")):
            want += [i, i + 1]
    seen: list[int] = []
    for i in want:
        if 1 <= i <= len(segs) and i not in seen:
            seen.append(i)
        if len(seen) >= limit:
            break
    return sorted(seen)


def _seg_line(row: dict, i: int) -> str:
    from app.services import meeting_parse as mp

    s = (row.get("segments") or [])[i - 1]
    t = mp.clock(s.get("t")) if s.get("t") is not None else "-"
    return f"[s{i}] {t} {s.get('speaker') or 'Unknown'}: {s.get('text') or ''}"


def _deal_text(deal: dict, stage_label: str | None, fields: list[dict], current: dict) -> str:
    lines = [f"Name: {deal.get('name')}", f"Stage: {stage_label or current.get('dealstage') or 'none'} (id {current.get('dealstage') or 'none'})",
             f"Amount: {current.get('amount') or 'none'} {deal.get('currency') or ''}".rstrip(),
             f"Close date: {deal.get('close_date') or 'none'}"]
    for f in fields:
        if f["name"] not in ("dealstage", "amount", "closedate"):
            lines.append(f"{f['label']} ({f['name']}): {current.get(f['name']) or 'none'}")
    return "\n".join(lines)


def _fields_text(fields: list[dict]) -> str:
    out = []
    for f in fields:
        line = f"- {f['name']} ({f['label']}; {f['kind']})"
        if f["options"]:
            line += ": one of " + ", ".join(f"{o['value']} = {o['label']}" for o in f["options"][:40])
        out.append(line)
    return "\n".join(out)


def system_prompt() -> str:
    from app.services import meetings_ai as MA

    return f"""You keep a HubSpot deal up to date after a sales call in Markdrop, a workspace app. You get the deal as it is in HubSpot now (inside <untrusted_deal>), the fields you may propose changes to (inside <untrusted_fields>), the call's title and date (inside <untrusted_meeting_facts>), the team's notes of the call (inside <untrusted_notes>, lines "[nN] …") and transcript lines that may matter (inside <untrusted_transcript>, lines "[sN] time Speaker: words").

{MA.DATA_NOT_INSTRUCTIONS}

{MA.ENGLISH}

Return only JSON, no prose and no code fence:
{{"updates": [{{"field": "a field name from the list", "value": "the new value", "why": "one short sentence", "evidence": ["s12", "n3"]}}],
 "account": {{"objections": [{{"text": "an objection the customer raised, one sentence", "cite": "sN or nN"}}],
             "risks": [{{"text": "a risk to the deal, one sentence", "cite": "sN or nN"}}]}}}}
Rules: propose a change only when the call clearly supports it (someone said it); each update needs 1-3 evidence lines ([sN] or [nN]) that show it; dealstage: only an id from its list, and only a move the call shows; closedate: YYYY-MM-DD, only when a date or timeframe was said (resolve it against the call's date); amount: a plain number in the deal's currency, only when a figure was said for this deal; text fields: one short sentence; fields with options: only one of their values; never repeat the current value; at most {MAX_SUGGESTIONS} updates; empty lists are fine; never invent names, dates or numbers."""


# ── Validating what came back ─────────────────────────────────────────────────


def _num(v: Any) -> float | None:
    try:
        s = str(v).replace(",", "").replace("$", "").strip()
        f = float(s)
        return f if f > 0 and f < 1e13 else None
    except (TypeError, ValueError):
        return None


def _same(a: Any, b: Any) -> bool:
    return H._plain(a).casefold() == H._plain(b).casefold()


def clean_value(f: dict, value: Any, current: Any) -> tuple[str, str] | None:
    """(the value HubSpot gets, how it reads) or None when it's not a valid change of field ``f``."""
    if value in (None, ""):
        return None
    kind = f["kind"]
    if kind in ("stage", "enum"):
        v = str(value).strip()
        opt = next((o for o in f["options"] if o["value"] == v), None) or next(
            (o for o in f["options"] if o["label"].casefold() == v.casefold()), None)
        if opt is None or opt["value"] == str(current or ""):
            return None
        return opt["value"], opt["label"]
    if kind == "date":
        v = str(value).strip()[:10]
        if not _DATE.match(v):
            return None
        try:
            d = date.fromisoformat(v)
        except ValueError:
            return None
        cur = H._from_hs_time(current)
        if cur is not None and cur.date() == d:
            return None
        return v, d.strftime("%b %-d, %Y")
    if kind == "number":
        n = _num(value)
        if n is None:
            return None
        if _num(current) is not None and abs(_num(current) - n) < 0.005:
            return None
        s = f"{n:.2f}".rstrip("0").rstrip(".")
        return s, f"{n:,.2f}".rstrip("0").rstrip(".")
    v = H._plain(value)[:TEXT_MAX]
    if not v or _same(v, current):
        return None
    return v, v


def _evidence(row: dict, refs: Any, notes: dict[str, str], offered: set[int]) -> list[dict]:
    from app.services import meeting_parse as mp
    from app.services import meetings_ai as MA

    out: list[dict] = []
    segs = row.get("segments") or []
    ts = row.get("transcript_slug")
    for r in refs if isinstance(refs, list) else [refs]:
        ref = str(r or "").strip().strip("[]").lower()
        if ref.startswith("s") and ref[1:].isdigit():
            i = int(ref[1:])
            if i in offered and 1 <= i <= len(segs):
                s = segs[i - 1]
                out.append({"ref": f"s{i}", "quote": MA._quote(s.get("text")), "speaker": s.get("speaker") or None,
                            "at": mp.clock(s["t"]) if s.get("t") is not None else None,
                            "href": f"/{ts}#{H_anchor(i)}" if ts else None})
        elif ref.startswith("n") and ref in notes:
            out.append({"ref": ref, "quote": MA._quote(notes[ref]), "speaker": None, "at": None, "href": None})
        if len(out) >= MAX_EVIDENCE:
            break
    seen, uniq = set(), []
    for e in out:
        if e["ref"] not in seen:
            seen.add(e["ref"])
            uniq.append(e)
    return uniq


def H_anchor(i: int) -> str:
    from app.services import meetings

    return meetings.anchor(i)


def sid(field: str, value: str) -> str:
    return hashlib.sha1(f"{field}|{value}".casefold().encode("utf-8")).hexdigest()[:12]


def parse(raw: str, fields: list[dict], current: dict, row: dict, notes: dict[str, str], offered: set[int]) -> tuple[list[dict], dict] | None:
    """The model's answer → (valid suggestions, account notes); None when it isn't JSON."""
    m = re.search(r"\{.*\}", raw or "", re.S)
    if not m:
        return None
    try:
        data = json.loads(m.group(0))
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    by = {f["name"]: f for f in fields}
    items: list[dict] = []
    for u in data.get("updates") or []:
        if not isinstance(u, dict):
            continue
        f = by.get(str(u.get("field") or ""))
        if f is None or any(i["field"] == f["name"] for i in items):
            continue
        got = clean_value(f, u.get("value"), current.get(f["name"]))
        if got is None:
            continue
        ev = _evidence(row, u.get("evidence"), notes, offered)
        if not ev:
            continue
        value, display = got
        cur = current.get(f["name"])
        cur_display = None
        if cur not in (None, ""):
            if f["kind"] in ("stage", "enum"):
                cur_display = next((o["label"] for o in f["options"] if o["value"] == str(cur)), str(cur))
            elif f["kind"] == "date":
                dt = H._from_hs_time(cur)
                cur_display = dt.strftime("%b %-d, %Y") if dt else str(cur)
            else:
                cur_display = H._plain(cur)[:TEXT_MAX]
        items.append({"id": sid(f["name"], value), "field": f["name"], "label": f["label"], "kind": f["kind"],
                      "value": value, "display": display, "current": cur_display, "why": H._plain(u.get("why"))[:300] or None,
                      "evidence": ev, "state": "open", "at": None, "by": None})
        if len(items) >= MAX_SUGGESTIONS:
            break
    acct: dict[str, list[dict]] = {"objections": [], "risks": []}
    a = data.get("account") if isinstance(data.get("account"), dict) else {}
    for key in ("objections", "risks"):
        for it in (a.get(key) or [])[:6]:
            t = H._plain(it.get("text") if isinstance(it, dict) else it)[:TEXT_MAX]
            if t:
                ev = _evidence(row, [it.get("cite")] if isinstance(it, dict) else [], notes, offered)
                acct[key].append({"text": t, "ref": ev[0] if ev else None})
    return items, acct


# ── Suggest ───────────────────────────────────────────────────────────────────


async def suggest_after(db: AsyncIOMotorDatabase, conn: dict, meeting_id: str, m: dict) -> None:
    """hubspot.meeting_ready: suggestions for a call matched to a deal (high or medium confidence, or a
    person's pick), once (asking again is on the panel)."""
    from app.services import meetings

    if not H.switch(conn, "suggest") or not m.get("deal_id"):
        return
    if m.get("confidence") not in ("high", "medium"):
        return
    row = await meetings.get_row(db, meeting_id)
    if row is None or ((row.get("hubspot") or {}).get("suggestions") or {}).get("deal_id") == m["deal_id"]:
        return
    who = row.get("imported_by") or row.get("created_by")
    await suggest(db, conn, row, m, user_id=str(who) if who else None, via="auto")


async def suggest(db: AsyncIOMotorDatabase, conn: dict, row: dict, m: dict, *, user_id: str | None, via: str) -> dict:
    """One AI call → the meeting's suggestions (kept: what people applied or dismissed). Returns the stored
    suggestions. Never raises for the model or the limits (the state says what happened)."""
    from app.services import meetings, meetings_ai as MA, pages_ai

    base = {"portal_id": conn["portal_id"], "deal_id": m.get("deal_id"), "at": now_utc(), "by": user_id if via != "auto" else None}
    old = (row.get("hubspot") or {}).get("suggestions") or {}
    kept = [i for i in old.get("items") or [] if i.get("state") in ("applied", "dismissed")
            and old.get("deal_id") == m.get("deal_id") and old.get("portal_id") == conn["portal_id"]]

    async def store(extra: dict, items: list[dict] | None = None, account: dict | None = None) -> dict:
        ids = {i["id"] for i in kept}
        out = {**base, **extra, "items": kept + [i for i in items or [] if i["id"] not in ids],
               "account": account if account is not None else (old.get("account") if old.get("deal_id") == m.get("deal_id") else None)}
        await db[meetings.COLL].update_one({"_id": row["_id"]}, {"$set": {"hubspot.suggestions": out}})
        return out

    if not m.get("deal_id"):
        return await store({"state": "skipped", "reason": "no_deal"})
    reason = await MA.limit_for(db, user_id, row["workspace_id"], reserve=RESERVE)
    if reason:
        return await store({"state": "skipped", "reason": reason, "message": MA.message(reason)})
    deals = await H.batch_read(db, conn, "deals", [m["deal_id"]], [*H.DEAL_PROPS, "hs_next_step"])
    if not deals:
        return await store({"state": "skipped", "reason": "no_deal"})
    raw_deal = deals[0]
    cur = dict(raw_deal.get("properties") or {})
    stages = await H.stages(db, conn)
    stage_by = {s["id"]: s for s in stages}
    pipe = str(cur.get("pipeline") or (stage_by.get(str(cur.get("dealstage") or "")) or {}).get("pipeline_id") or "") or None
    props = await deal_properties(db, conn)
    fields = fields_for(props, stages, pipe)
    for f in fields:
        if f["name"] not in cur:
            cur[f["name"]] = None
    if any(f["name"] not in (*H.DEAL_PROPS, "hs_next_step") for f in fields):
        extra = [f["name"] for f in fields if f["name"] not in cur or cur.get(f["name"]) is None]
        more = await H.batch_read(db, conn, "deals", [m["deal_id"]], extra) if extra else []
        if more:
            cur.update({k: v for k, v in (more[0].get("properties") or {}).items() if k in extra})
    deal = H._deal_view(conn, raw_deal, stage_by, {})
    notes = notes_lines(row)
    seg_ids = evidence_segments(row)
    if not notes and not seg_ids:
        return await store({"state": "skipped", "reason": "no_notes"})
    blocks = [
        pages_ai.wrap("deal", _deal_text(deal, (stage_by.get(str(cur.get("dealstage") or "")) or {}).get("label"), fields, cur)),
        pages_ai.wrap("fields", _fields_text(fields)),
        pages_ai.wrap("meeting_facts", f"Title: {row.get('title') or ''}\nDate: {row.get('date') or ''}"),
        pages_ai.wrap("notes", "\n".join(f"[{r}] {t}" for r, t in notes) or "(none)"),
        pages_ai.wrap("transcript", "\n".join(_seg_line(row, i) for i in seg_ids) or "(none)"),
        "Propose the deal updates this call supports, and the account's objections and risks. JSON only.",
    ]
    run = MA.Run(db, user_id, KIND, via, {"meeting_id": str(row["_id"]), "workspace_id": row["workspace_id"]}, RESERVE)
    title = row.get("title") or "Meeting"
    run.job = "HubSpot deal suggestions" if via == "auto" else None
    run.log.update(subject=title, output_format="json",
                   description=f"Suggested HubSpot deal updates after the call '{title}'",
                   context=[{"kind": "meeting", "title": title, "id": str(row["_id"]),
                             "url": f"/{row['slug']}" if row.get("slug") else None}])
    run.hold()
    try:
        try:
            text, _stop = await MA._stream(run, MA._params(system_prompt(), blocks, MAX_TOKENS))
        except pages_ai.Upstream as exc:
            await run.record("error", error_code=exc.code)
            return await store({"state": "failed", "reason": "upstream", "message": exc.detail})
        got = parse(text, fields, cur, row, dict(notes), set(seg_ids))
        if got is None:
            await run.record("error", error_code="bad_json")
            return await store({"state": "failed", "reason": "bad_output", "message": "The suggestions couldn't be read. Try again."})
        items, account = got
        run.log.update(output=json.dumps([{k: i[k] for k in ("field", "value", "why")} for i in items]),
                       results={"suggestions": len(items)})
        await run.record("ok", suggestions=len(items))
        return await store({"state": "done", "reason": None}, items, account)
    finally:
        run.release()


def suggestions_view(row: dict, conn: dict, m: dict | None, on: bool) -> dict | None:
    """The panel's "Suggested updates": open ones first, then what was applied or dismissed."""
    s = (row.get("hubspot") or {}).get("suggestions") or {}
    if s.get("portal_id") != conn["portal_id"] or (m and s.get("deal_id") != m.get("deal_id")):
        s = {}
    items = [{k: i.get(k) for k in ("id", "field", "label", "kind", "value", "display", "current", "why", "evidence", "state", "error")}
             | {"at": H.iso(i.get("at"))} for i in s.get("items") or []]
    order = {"open": 0, "failed": 0, "applying": 1, "applied": 2, "dismissed": 3}
    items.sort(key=lambda i: order.get(i["state"] or "open", 4))
    return {"enabled": on, "state": s.get("state"), "reason": s.get("reason"), "message": s.get("message"),
            "at": H.iso(s.get("at")), "items": items, "can_suggest": bool(m and m.get("deal_id"))}


async def request(db: AsyncIOMotorDatabase, user, actor, ctx, meeting_id: str) -> dict:
    """Suggest updates (the panel's button, MCP): again for this meeting's deal."""
    row, conn = await H._usable(db, user, actor, ctx, meeting_id)
    hs = row.get("hubspot") or {}
    m = hs.get("match") if (hs.get("match") or {}).get("portal_id") == conn["portal_id"] else None
    try:
        if m is None:
            m = await H.match(db, conn, row)
        if not m.get("deal_id"):
            raise HTTPException(status_code=409, detail="Pick the deal first: suggestions are changes to the deal.")
        await suggest(db, conn, row, m, user_id=user.id, via="web")
    except HubSpotError as exc:
        raise H._http_error(exc)
    return await H.panel(db, user, actor, ctx, meeting_id)


async def _item(db, row: dict, conn: dict, item_id: str) -> tuple[dict, dict]:
    s = (row.get("hubspot") or {}).get("suggestions") or {}
    if s.get("portal_id") != conn["portal_id"]:
        raise HTTPException(status_code=404, detail="That suggestion isn't there any more.")
    it = next((i for i in s.get("items") or [] if i.get("id") == item_id), None)
    if it is None:
        raise HTTPException(status_code=404, detail="That suggestion isn't there any more.")
    return s, it


async def _set_state(db, row: dict, item_id: str, sets: dict, *, only: list[str] | None = None) -> bool:
    from app.services import meetings

    q: dict[str, Any] = {"_id": row["_id"]}
    el: dict[str, Any] = {"id": item_id}
    if only:
        # An Apply that never finished (a stopped process) can be tried again after a couple of minutes.
        el["$or"] = [{"state": {"$in": only}}, {"state": "applying", "at": {"$lt": now_utc() - timedelta(minutes=2)}}]
    q["hubspot.suggestions.items"] = {"$elemMatch": el}
    res = await db[meetings.COLL].update_one(q, {"$set": {f"hubspot.suggestions.items.$.{k}": v for k, v in sets.items()}})
    return res.modified_count > 0


def to_hubspot(it: dict) -> str:
    """The value as HubSpot stores it: a date is midnight UTC in epoch milliseconds."""
    if it["kind"] == "date":
        d = date.fromisoformat(it["value"])
        return str(int(datetime(d.year, d.month, d.day, tzinfo=timezone.utc).timestamp() * 1000))
    return str(it["value"])


async def apply(db: AsyncIOMotorDatabase, user, actor, ctx, meeting_id: str, item_id: str) -> dict:
    """Apply one suggestion: PATCH the deal with that one property (a person's click; never automatic)."""
    row, conn = await H._usable(db, user, actor, ctx, meeting_id)
    s, it = await _item(db, row, conn, item_id)
    if it.get("state") == "applied":
        return await H.panel(db, user, actor, ctx, meeting_id)
    if not await _set_state(db, row, item_id, {"state": "applying", "at": now_utc(), "by": user.id}, only=["open", "failed"]):
        raise HTTPException(status_code=409, detail="That suggestion was already applied or dismissed.")
    try:
        if it["kind"] == "stage":
            # Still a stage of the deal's own pipeline (pipelines change).
            ds = await H.batch_read(db, conn, "deals", [s["deal_id"]], ["dealstage", "pipeline"])
            pipe = str(((ds[0] if ds else {}).get("properties") or {}).get("pipeline") or "")
            ok = {st["id"] for st in await H.stages(db, conn) if not pipe or st.get("pipeline_id") == pipe}
            if it["value"] not in ok:
                raise HTTPException(status_code=409, detail="That stage isn't in the deal's pipeline any more.")
        await H.call(db, conn, "PATCH", f"crm/v3/objects/deals/{s['deal_id']}", json={"properties": {it["field"]: to_hubspot(it)}})
    except HubSpotError as exc:
        err = H._http_error(exc)
        if exc.scope:
            await db[H.CONNS].update_one({"_id": conn["_id"]}, {"$addToSet": {"denied": WRITE_SCOPE}})
            err = HTTPException(status_code=409, detail=(
                f"The HubSpot key can't change deals yet: a HubSpot admin adds the {WRITE_SCOPE} scope to the key "
                "(Integrations › HubSpot lists it), then Apply works."))
        await _set_state(db, row, item_id, {"state": "failed", "error": str(err.detail)[:300]})
        raise err
    except HTTPException as exc:
        await _set_state(db, row, item_id, {"state": "failed", "error": str(exc.detail)[:300]})
        raise
    await _set_state(db, row, item_id, {"state": "applied", "at": now_utc(), "by": user.id, "error": None})
    await db[H.CONNS].update_one({"_id": conn["_id"]}, {"$inc": {"stats.applied": 1}, "$pull": {"denied": WRITE_SCOPE}})
    forget_pipeline(conn["_id"])
    log.info("hubspot: workspace %s applied %s on deal %s", conn["_id"], it["field"], s["deal_id"])
    return await H.panel(db, user, actor, ctx, meeting_id)


async def dismiss(db: AsyncIOMotorDatabase, user, actor, ctx, meeting_id: str, item_id: str) -> dict:
    row, conn = await H._usable(db, user, actor, ctx, meeting_id)
    await _item(db, row, conn, item_id)
    await _set_state(db, row, item_id, {"state": "dismissed", "at": now_utc(), "by": user.id}, only=["open", "failed"])
    return await H.panel(db, user, actor, ctx, meeting_id)


# ── The pipeline ──────────────────────────────────────────────────────────────


_PIPE: dict[str, tuple[float, list[dict]]] = {}
PIPE_PROPS = [*H.DEAL_PROPS, "notes_last_contacted", "hs_next_step"]


def forget_pipeline(workspace_id: str) -> None:
    _PIPE.pop(str(workspace_id), None)


async def forget(db: AsyncIOMotorDatabase, workspace_id: str) -> None:
    forget_pipeline(workspace_id)
    await db[SNAPSHOTS].delete_many({"workspace_id": str(workspace_id)})


async def last_calls(db: AsyncIOMotorDatabase, conn: dict, deal_ids: list[str]) -> dict[str, dict]:
    """{deal id: {date, title, slug}}: the team's latest call matched to each deal (meetings the whole team
    can read: not restricted)."""
    from app.services import meetings

    if not deal_ids:
        return {}
    out: dict[str, dict] = {}
    cur = db[meetings.COLL].find({"workspace_id": conn["_id"], "team_ids": conn.get("team_id"), "restricted": {"$ne": True},
                                  "hubspot.match.portal_id": conn["portal_id"], "hubspot.match.deal_id": {"$in": deal_ids}},
                                 {"date": 1, "title": 1, "slug": 1, "hubspot.match.deal_id": 1}).sort("date", -1).limit(2000)
    async for r in cur:
        d = ((r.get("hubspot") or {}).get("match") or {}).get("deal_id")
        if d and d not in out:
            out[d] = {"date": r.get("date"), "title": r.get("title"), "slug": r.get("slug")}
    return out


async def pipeline(db: AsyncIOMotorDatabase, conn: dict, *, fresh: bool = False, today: date | None = None) -> list[dict]:
    """Open deals (and those closed in the last two weeks), most recently active first, each with its
    stage, amount, close date, owner, last contact, the team's last call and why it's at risk."""
    key = str(conn["_id"])
    hit = _PIPE.get(key)
    if hit and not fresh and hit[0] > _time.monotonic():
        rows = hit[1]
    else:
        since = str(H._ms(now_utc() - timedelta(days=14)))
        body = {"filterGroups": [{"filters": [{"propertyName": "hs_is_closed", "operator": "EQ", "value": "false"}]},
                                 {"filters": [{"propertyName": "closedate", "operator": "GTE", "value": since},
                                              {"propertyName": "hs_is_closed", "operator": "EQ", "value": "true"}]}],
                "properties": PIPE_PROPS, "sorts": [{"propertyName": "hs_lastmodifieddate", "direction": "DESCENDING"}],
                "limit": 100}
        rows, after = [], None
        while len(rows) < PIPELINE_MAX:
            got = await H.call(db, conn, "POST", "crm/v3/objects/deals/search", json={**body, **({"after": after} if after else {})}) or {}
            rows += got.get("results") or []
            after = ((got.get("paging") or {}).get("next") or {}).get("after")
            if not after:
                break
        _PIPE[key] = (_time.monotonic() + PIPELINE_TTL, rows)
    stage_by = {s["id"]: s for s in await H.stages(db, conn)}
    owner_by = {o["id"]: o for o in await H.owners(db, conn)}
    calls = await last_calls(db, conn, [str(d.get("id")) for d in rows])
    today = today or now_utc().date()
    out = []
    for d in rows:
        v = H._deal_view(conn, d, stage_by, owner_by)
        p = d.get("properties") or {}
        v["stage_id"] = str(p.get("dealstage") or "") or None
        v["next_step"] = H._plain(p.get("hs_next_step"))[:200] or None
        lc = H._from_hs_time(p.get("notes_last_contacted"))
        call = calls.get(v["id"])
        v["last_call"] = call
        last = max([x for x in (lc.date() if lc else None, _d(call.get("date")) if call else None) if x], default=None)
        v["last_contact"] = last.isoformat() if last else None
        v["days_quiet"] = (today - last).days if last else None
        risks = []
        if not v["closed"]:
            if last is None or (today - last).days >= RISK_DAYS:
                risks.append("no call yet" if last is None else f"no call in {(today - last).days} days")
            if v["close_date"] and v["close_date"] < today.isoformat():
                risks.append(f"close date {v['close_date']} passed")
        v["risks"] = risks
        out.append(v)
    return out


def _d(s: Any) -> date | None:
    try:
        return date.fromisoformat(str(s)[:10]) if s else None
    except ValueError:
        return None


def deal_line(v: dict) -> str:
    bits = [v["name"], f"stage {v.get('stage') or '?'}" + (f" ({v['pipeline']})" if v.get("pipeline") else ""),
            ("closed" if v.get("closed") else "open")]
    if v.get("amount") is not None:
        bits.append(f"amount {v['amount']:g} {v.get('currency') or ''}".rstrip())
    if v.get("close_date"):
        bits.append(f"close date {v['close_date']}")
    if v.get("owner"):
        bits.append(f"owner {v['owner']}")
    if v.get("last_call"):
        bits.append(f"last call in Markdrop {v['last_call'].get('date')} ({v['last_call'].get('title')})")
    if v.get("last_contact"):
        bits.append(f"last contact {v['last_contact']}")
    else:
        bits.append("no contact recorded")
    if v.get("next_step"):
        bits.append(f"next step: {v['next_step']}")
    if v.get("risks"):
        bits.append("at risk: " + "; ".join(v["risks"]))
    return "- " + " · ".join(bits)


# ── Ask Markdrop ──────────────────────────────────────────────────────────────


_CRM_Q = re.compile(r"\b(deals?|pipeline|hubspot|crm|stages?|proposals?|negotiat\w*|closing|close dates?|forecast|"
                    r"quota|opportunit\w*|prospects?|accounts? at risk|at risk|won|lost|renewals?|customers?)\b", re.I)


def wants_crm(question: str) -> bool:
    return bool(_CRM_Q.search(question or ""))


async def ask_sources(db: AsyncIOMotorDatabase, user_id: str | None, question: str, workspace_ids: list[str]) -> list[dict]:
    """[{workspace_id, title, url, text}]: each connected workspace's pipeline, for a question about deals,
    when the asker may use HubSpot there (the HubSpot team's members and workspace admins)."""
    if not user_id or not wants_crm(question) or not H.configured():
        return []
    out = []
    for ws in workspace_ids[:5]:
        conn = await H.get(db, ws)
        if not (H.is_connected(conn) and conn.get("team_id") and not conn.get("broken")) or not await H.can_use(db, user_id, conn):
            continue
        try:
            rows = await pipeline(db, conn)
        except HubSpotError as exc:
            log.info("hubspot: Ask pipeline for %s: %s", ws, exc)
            continue
        if not rows:
            continue
        today = now_utc().date().isoformat()
        text = (f"HubSpot deals of this workspace (today is {today}; 'last call in Markdrop' is the team's latest "
                f"call matched to the deal):\n" + "\n".join(deal_line(v) for v in rows[:120]))
        out.append({"workspace_id": ws, "title": "HubSpot pipeline", "url": f"https://{conn.get('ui_domain') or 'app.hubspot.com'}"
                    f"/contacts/{conn['portal_id']}/objects/0-3/views/all/list", "text": text})
    return out


# ── The weekly brief's Pipeline section ───────────────────────────────────────


async def brief_lines(db: AsyncIOMotorDatabase, team: dict, week: str, *, today: date | None = None) -> list[dict]:
    """Lines (kind ``pipeline``) for the HubSpot team's weekly brief: deals that moved stage since the last
    snapshot, deals at risk. [] for any other team, or when HubSpot isn't usable."""
    conn = await H.get(db, team["workspace_id"])
    if not (H.is_connected(conn) and conn.get("team_id") == str(team["_id"]) and not conn.get("broken")):
        return []
    try:
        rows = await pipeline(db, conn, fresh=True, today=today)
    except HubSpotError as exc:
        log.info("hubspot: brief pipeline for %s: %s", team["workspace_id"], exc)
        return []
    stage_by = {s["id"]: s for s in await H.stages(db, conn)}
    prev = await db[SNAPSHOTS].find_one({"workspace_id": conn["_id"], "week": {"$lt": week}}, sort=[("week", -1)])
    now_stages = {v["id"]: v.get("stage_id") for v in rows if v.get("stage_id")}
    await db[SNAPSHOTS].update_one({"_id": f"{conn['_id']}:{week}"}, {"$set": {
        "workspace_id": conn["_id"], "week": week, "stages": now_stages, "at": now_utc()}}, upsert=True)
    lines: list[dict] = []
    if prev:
        for v in rows:
            before = (prev.get("stages") or {}).get(v["id"])
            if before and v.get("stage_id") and before != v["stage_id"]:
                was = (stage_by.get(before) or {}).get("label") or before
                lines.append({"kind": "pipeline", "text": f"{v['name']} moved from {was} to {v.get('stage')}",
                              "person_id": None, "sources": []})
    for v in rows:
        if v.get("risks"):
            lines.append({"kind": "pipeline", "text": f"At risk: {v['name']} ({v.get('stage')}) — " + "; ".join(v["risks"]),
                          "person_id": None, "sources": []})
    return lines[:12]


async def may_see_pipeline(db: AsyncIOMotorDatabase, workspace_id: str, user_id: str | None) -> bool:
    conn = await H.get(db, workspace_id)
    return bool(H.is_connected(conn) and await H.can_use(db, user_id, conn))


async def pipeline_for(db: AsyncIOMotorDatabase, user, workspace_id: str, *, fresh: bool = False) -> dict:
    """GET /pipeline, MCP hubspot_pipeline: the HubSpot team's members and workspace admins."""
    await H.role_of(db, user, workspace_id)
    conn = await H.get(db, workspace_id)
    if not H.is_connected(conn):
        raise HTTPException(status_code=404, detail="This workspace isn't connected to HubSpot.")
    if not await H.can_use(db, user.id, conn):
        raise HTTPException(status_code=403, detail="The HubSpot team's members and workspace admins use HubSpot here.")
    try:
        rows = await pipeline(db, conn, fresh=fresh)
    except HubSpotError as exc:
        raise H._http_error(exc)
    keep = ("id", "name", "stage", "pipeline", "closed", "amount", "currency", "close_date", "owner", "url", "next_step",
            "last_call", "last_contact", "days_quiet", "risks")
    deals = [{k: v.get(k) for k in keep} for v in rows]
    return {"deals": deals, "at_risk": sum(1 for d in deals if d["risks"]), "risk_days": RISK_DAYS}
