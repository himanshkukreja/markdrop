"""HubSpot deal folders (owner + Prakhar 2026-11-18, brief .work/briefs/hubspot-deal-folders.md): everything
about one HubSpot DEAL in one place, for the HubSpot-linked team only.

    routers/hubspot.py      GET /deals/board, GET /deals/{id}, POST /deals/sync, GET /meetings/{id}/chip
    mcp/hubspot_tools.py    hubspot_list_deals, hubspot_deal_folder, hubspot_sync_deals
    services/background.py  hubspot_deals: :func:`tick` (a pass per workspace every :data:`SYNC_EVERY`)
    scripts/hubspot_deal_folders.py  the one-off backfill (dry run by default)

**Read only.** Every HubSpot request here is a GET, a search or a batch read (services/hubspot.call's
guard lets nothing else through and this module never asks for anything else).

**Which deals.** The connected account's OPEN deals (every pipeline; closed = ``hs_is_closed`` or a stage
whose metadata says ``isClosed``). The first pass pages through the open deals oldest change first; later
passes read only the deals changed since the last one (``hs_lastmodifieddate``), at most :data:`SYNC_CAP` a
pass, so a big account fills in over a few passes. A deal that closes keeps its folder and is marked Closed won /
Closed lost; its facts are read again every :data:`CLOSED_EVERY` (renames, stage; a deal that reopens syncs like
an open one). A CLOSED deal (won or lost) the passes never brought in gets a folder as soon as a team call is
matched to it, and keeps receiving calls (post-signing support calls, say); a closed deal without calls gets none. Service keys get no webhooks: a pass runs
every :data:`SYNC_EVERY` and on "Sync now".

**Where.** One hidden folder "Deals" in the HubSpot team (``hidden``: kept out of the file tree and browse,
reached from the team's Deals section; search still finds what is inside), and a subfolder per deal named
"<Company> — <Deal>" (the deal's primary company; none → the deal's name). Renames follow HubSpot. Both are
the team's (``team_ids``), so what is filed there is the team's like before.

**Inside a deal folder.**
  * the "Deal overview" page: Markdrop keeps the section between :data:`START` and :data:`END` up to date
    (stage, amount, owner, close date, pipeline, company, contacts, HubSpot's history newest first, and the
    team's calls rolled up: decisions, objections and risks, open questions, next steps, last call); what
    people write outside it stays (hubspot_accounts.merge);
  * the deal's calls: a call matched to the deal (HubSpot's booked meeting, a person's pick, or attendees
    whose company has exactly one open deal) is MOVED here (page + transcript, team access unchanged; still
    in Meetings lists and search). A call matched only through a company or contacts with several open deals
    waits for a person ("Pick the deal"): never moved on a guess. Filed once (``hubspot.filed``): a person
    who moves it elsewhere afterwards keeps it there;
  * sales assets: files the team uploads there (ordinary Markdrop files), and HubSpot's attachments on the
    deal's activity listed as links that open in HubSpot (never copied: HubSpot's file links need a broader
    files scope and would leave HubSpot's access rules behind).

**Scopes** (optional reads; everything else works without them): ``sales-email-read`` for what the deal's
emails say (with only the contacts scope HubSpot leaves their subject and text out), and
``files.ui_hidden.read`` (or the legacy ``files``) for the names of the attachments (activity attachments
are hidden files). Missing → the overview says what to add.

Collections
    hubspot_deal_folders  _id "<workspace>:<portal>:<deal id>": workspace_id, portal_id, deal_id, name, company
                          {id, name}, title, folder_id, doc_id, slug, stage_id, pipeline_id, closed, closed_label,
                          amount, currency, owner_id, close_date, contacts [{id, name, title, email}], hs_modified,
                          activity {items, missing, attachments, at}, synced_at, created_at
    hubspot_connections   deals_folder_id; deals_sync {state, at, next_at, cursor, initial_done, lease_until,
                          last_error, deals}
    meetings.hubspot      filed {deal_id, folder_id, at}
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
from datetime import date, datetime, timedelta, timezone
from typing import Any

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo import ReturnDocument

from app.services import hubspot as H
from app.services.hubspot_api import HubSpotError

log = logging.getLogger("markdrop.hubspot")

DEALS = "hubspot_deal_folders"
ROOT_NAME = "Deals"
OVERVIEW_TITLE = "Deal overview"
START = "## From HubSpot and the team's calls"
END = "*Markdrop keeps the section above up to date from HubSpot and the team's calls. Edits outside it stay.*"
SYNC_EVERY = timedelta(minutes=20)
CLOSED_EVERY = timedelta(hours=6)   # closed deals' facts (rename, stage, reopened) are read again at this pace
SYNC_CAP = 40                 # deals a pass (each: a few batch reads; the overview's history on change)
LEASE = timedelta(minutes=10)
ACTIVITY_TTL = timedelta(minutes=15)
QUIET_DAYS = 14
MAX_CONTACTS = 10
MAX_ACTIVITY = 40             # per kind
MAX_HISTORY = 25              # lines on the overview
MAX_ATTACHMENTS = 20
MAX_CALLS = 50
MAX_LINES = 12
PREVIEW = 160
EMAIL_SCOPE = "sales-email-read"
FILES_SCOPE = "files.ui_hidden.read"
DEAL_PROPS = [*H.DEAL_PROPS, "hs_is_closed_won"]
CONTACT_PROPS = ["firstname", "lastname", "email", "jobtitle"]
#: What each kind of HubSpot activity is read with.
KINDS: dict[str, list[str]] = {
    "notes": ["hs_note_body", "hs_timestamp", "hubspot_owner_id", "hs_attachment_ids"],
    "emails": ["hs_email_subject", "hs_email_text", "hs_email_direction", "hs_timestamp", "hubspot_owner_id",
               "hs_attachment_ids"],
    "meetings": ["hs_meeting_title", "hs_meeting_start_time", "hs_meeting_outcome", "hs_timestamp", "hubspot_owner_id",
                 "hs_attachment_ids"],
    "tasks": ["hs_task_subject", "hs_task_status", "hs_timestamp", "hubspot_owner_id", "hs_attachment_ids"],
    "calls": ["hs_call_title", "hs_call_body", "hs_call_direction", "hs_timestamp", "hubspot_owner_id",
              "hs_attachment_ids"],
}
SINGULAR = {"notes": "note", "emails": "email", "meetings": "meeting", "tasks": "task", "calls": "call"}
PRIMARY_COMPANY = 5           # HubSpot-defined deal → company "Primary" association type


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[DEALS].create_index([("workspace_id", 1), ("deal_id", 1)])
    await db[DEALS].create_index("folder_id", sparse=True)


def key_of(conn: dict, deal_id: str) -> str:
    return f"{conn['_id']}:{conn['portal_id']}:{deal_id}"


def deal_href(workspace_id: str, deal_id: str) -> str:
    return f"/deals/{workspace_id}/{deal_id}"


def usable(conn: dict | None) -> bool:
    return bool(H.is_connected(conn) and conn.get("team_id") and conn.get("broken") != "token")


# ── HubSpot reads ─────────────────────────────────────────────────────────────


async def _assoc_typed(db, conn: dict, from_type: str, ids: list[str], to_type: str) -> dict[str, list[tuple[str, set[int]]]]:
    """{from id: [(to id, association type ids)]} (associations v4 batch read, 100 at a time)."""
    out: dict[str, list[tuple[str, set[int]]]] = {}
    ids = [str(i) for i in dict.fromkeys(ids) if i]
    for k in range(0, len(ids), 100):
        got = await H.call(db, conn, "POST", f"crm/v4/associations/{from_type}/{to_type}/batch/read",
                           json={"inputs": [{"id": i} for i in ids[k:k + 100]]}) or {}
        for r in got.get("results") or []:
            fid = str((r.get("from") or {}).get("id"))
            out[fid] = [(str(t.get("toObjectId")), {int(x.get("typeId") or 0) for x in t.get("associationTypes") or []})
                        for t in r.get("to") or [] if t.get("toObjectId")]
    return out


async def _read(db, conn: dict, obj: str, ids: list[str], props: list[str]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    ids = [str(i) for i in dict.fromkeys(ids) if i]
    for k in range(0, len(ids), 100):
        for r in await H.batch_read(db, conn, obj, ids[k:k + 100], props):
            out[str(r.get("id"))] = r
    return out


def _name(p: dict) -> str | None:
    return " ".join(x for x in (p.get("firstname"), p.get("lastname")) if x) or p.get("email") or None


def closed_label(d: dict, stage_by: dict[str, dict]) -> str | None:
    """"Closed won" / "Closed lost" (or the closed stage's own label) for a closed deal; None while open."""
    if H._deal_open(d, stage_by):
        return None
    p = d.get("properties") or {}
    won = str(p.get("hs_is_closed_won") or "").lower()
    if won in ("true", "false"):
        return "Closed won" if won == "true" else "Closed lost"
    st = stage_by.get(str(p.get("dealstage") or "")) or {}
    if st.get("won") is not None:
        return "Closed won" if st["won"] else "Closed lost"   # the stage's win probability (1.0 won, 0.0 lost)
    label = st.get("label") or ""
    if re.search(r"\bwon\b", label, re.I):
        return "Closed won"
    if re.search(r"\blost\b", label, re.I):
        return "Closed lost"
    return label or "Closed"


def title_of(deal_name: str, company: str | None) -> str:
    name = H._plain(deal_name) or "Untitled deal"
    t = f"{H._plain(company)} — {name}" if company and H._plain(company) else name
    t = t.replace("/", "∕")
    return t[:80].rstrip() or "Deal"


async def _companies_contacts(db, conn: dict, deal_ids: list[str]) -> tuple[dict[str, dict | None], dict[str, list[dict]]]:
    """({deal id: {id, name} | None}, {deal id: [contact]}) for a batch of deals."""
    co_links = await _assoc_typed(db, conn, "deals", deal_ids, "companies")
    primary: dict[str, str] = {}
    for d, links in co_links.items():
        if links:
            pick = next((c for c, types in links if PRIMARY_COMPANY in types), links[0][0])
            primary[d] = pick
    cos = await _read(db, conn, "companies", list(primary.values()), ["name", "domain"])
    companies = {}
    for d in deal_ids:
        cid = primary.get(str(d))
        p = (cos.get(cid) or {}).get("properties") or {}
        companies[str(d)] = {"id": cid, "name": H._plain(p.get("name") or p.get("domain")) or None} if cid else None
    try:
        ct_links = await _assoc_typed(db, conn, "deals", deal_ids, "contacts")
        want = {d: [c for c, _t in links][:MAX_CONTACTS] for d, links in ct_links.items()}
        cts = await _read(db, conn, "contacts", [c for v in want.values() for c in v], CONTACT_PROPS)
    except HubSpotError as exc:
        if not exc.scope:
            raise
        want, cts = {}, {}          # the key can't read contacts: the deals come in without them
    contacts: dict[str, list[dict]] = {}
    for d in deal_ids:
        rows = []
        for c in want.get(str(d)) or []:
            p = (cts.get(c) or {}).get("properties") or {}
            if cts.get(c):
                rows.append({"id": c, "name": _name(p), "title": H._plain(p.get("jobtitle")) or None,
                             "email": (p.get("email") or "").lower() or None})
        contacts[str(d)] = rows
    return companies, contacts


def _preview(text: Any, n: int = PREVIEW) -> str:
    t = H._plain(re.sub(r"\s+([,.;:!?])", r"\1", re.sub(r"<[^>]+>", " ", str(text or ""))))
    return (t[: n - 1].rstrip() + "…") if len(t) > n else t


async def activity(db, conn: dict, deal_id: str) -> dict:
    """HubSpot's history of the deal, newest first: ``{items, missing, attachments}``. A kind HubSpot won't
    show with this key (403) is left out and named in ``missing`` (the scope to add)."""
    owner_by = {o["id"]: o for o in await H.owners(db, conn)}
    items: list[dict] = []
    missing: list[dict] = []
    att_ids: list[tuple[str, str]] = []          # (file id, when)
    deal_url = H.record_url(conn, "deal", deal_id)
    for kind, props in KINDS.items():
        try:
            got = await H.call(db, conn, "GET", f"crm/v4/objects/deals/{deal_id}/associations/{kind}", params={"limit": 100}) or {}
            ids = [str(r.get("toObjectId")) for r in got.get("results") or [] if r.get("toObjectId")]
            rows = list((await _read(db, conn, kind, ids[:MAX_ACTIVITY * 2], props)).values())
        except HubSpotError as exc:
            if exc.scope or exc.missing:
                if exc.scope and kind == "emails":
                    await _denied(db, conn, EMAIL_SCOPE)
                if kind == "emails":
                    missing.append({"scope": EMAIL_SCOPE, "what": "emails"})
                else:
                    missing.append({"scope": "crm.objects.contacts.read", "what": kind})
                continue
            raise
        blank_emails = 0
        for r in rows:
            p = r.get("properties") or {}
            at = H._from_hs_time(p.get("hs_timestamp")) or H._from_hs_time(p.get("hs_meeting_start_time")) \
                or H._from_hs_time(r.get("createdAt")) or H._from_hs_time(r.get("updatedAt"))
            it: dict[str, Any] = {"kind": SINGULAR[kind], "id": str(r.get("id")), "at": H.iso(at), "url": deal_url,
                                  "owner": (owner_by.get(str(p.get("hubspot_owner_id") or "")) or {}).get("name")}
            if kind == "notes":
                it.update(title="Note", preview=_preview(p.get("hs_note_body")))
            elif kind == "emails":
                subj, text = H._plain(p.get("hs_email_subject")), _preview(p.get("hs_email_text"))
                if not subj and not text:
                    blank_emails += 1
                d = str(p.get("hs_email_direction") or "").upper()
                it.update(title=subj or "Email", preview=text, direction="in" if d == "INCOMING_EMAIL" else "out")
            elif kind == "meetings":
                it.update(title=H._plain(p.get("hs_meeting_title")) or "Meeting", preview="",
                          status=(p.get("hs_meeting_outcome") or "").replace("_", " ").lower() or None)
            elif kind == "tasks":
                it.update(title=H._plain(p.get("hs_task_subject")) or "Task", preview="",
                          status=(p.get("hs_task_status") or "").replace("_", " ").lower() or None)
            else:
                d = str(p.get("hs_call_direction") or "").upper()
                it.update(title=H._plain(p.get("hs_call_title")) or "Call", preview=_preview(p.get("hs_call_body")),
                          direction="in" if d == "INBOUND" else "out" if d else None)
            items.append(it)
            for f in str(p.get("hs_attachment_ids") or "").replace(";", ",").split(","):
                if f.strip().isdigit():
                    att_ids.append((f.strip(), it["at"] or ""))
        if kind == "emails" and rows and blank_emails == len(rows):
            missing.append({"scope": EMAIL_SCOPE, "what": "emails"})     # listed, but HubSpot hides what they say
            await _denied(db, conn, EMAIL_SCOPE)
    items.sort(key=lambda x: x.get("at") or "", reverse=True)
    attachments, att_missing = await _attachments(db, conn, att_ids, deal_url)
    return {"items": items, "missing": missing, "attachments": {"items": attachments, "missing": att_missing}}


async def _denied(db, conn: dict, scope: str) -> None:
    """HubSpot refused a read this key's scopes don't cover: the Integrations card lists it as missing."""
    if db is not None and not conn.get("_dry") and scope not in (conn.get("denied") or []):
        conn.setdefault("denied", []).append(scope)
        await db[H.CONNS].update_one({"_id": conn["_id"]}, {"$addToSet": {"denied": scope}})


async def _attachments(db, conn: dict, ids: list[tuple[str, str]], deal_url: str | None) -> tuple[list[dict], list[dict]]:
    """The attachments on the deal's activity: names from HubSpot's file details (a read), links to the deal
    in HubSpot (never a file URL: those would leave HubSpot's access rules)."""
    seen: dict[str, str] = {}
    for fid, at in ids:
        if fid not in seen:
            seen[fid] = at
    out, missing = [], []
    for fid, at in list(seen.items())[:MAX_ATTACHMENTS]:
        row = {"id": fid, "name": "Attachment", "ext": None, "size": None, "at": at or None, "url": deal_url}
        if not missing:
            try:
                f = await H.call(db, conn, "GET", f"files/v3/files/{fid}") or {}
                row.update(name=H._plain(f.get("name")) or "Attachment", ext=(f.get("extension") or None),
                           size=f.get("size"))
                if row["ext"] and not row["name"].lower().endswith("." + str(row["ext"]).lower()):
                    row["name"] = f"{row['name']}.{row['ext']}"
            except HubSpotError as exc:
                if exc.scope:
                    missing.append({"scope": FILES_SCOPE, "what": "attachment names"})
                    await _denied(db, conn, FILES_SCOPE)
                elif not exc.missing:
                    raise
        out.append(row)
    return out, missing


# ── Folders and the overview page ─────────────────────────────────────────────


async def _writer(db, conn: dict):
    from app.services.user import get_user_by_id

    return await get_user_by_id(db, conn.get("connected_by")) if conn.get("connected_by") else None


async def root_folder(db, conn: dict) -> str:
    """The team's hidden "Deals" folder (made once)."""
    from app.services import folder as folder_service
    from app.services import teams as T

    ws = conn["_id"]
    if conn.get("deals_folder_id"):
        f = await db["folders"].find_one({"_id": T.oid(conn["deals_folder_id"]), "workspace_id": ws})
        if f is not None:
            return str(f["_id"])
    f = await db["folders"].find_one({"workspace_id": ws, "hubspot_deals_root": True}, sort=[("created_at", 1), ("_id", 1)])
    if f is None:
        made = await folder_service.create_folder(db, ws, ROOT_NAME, None)
        await db["folders"].update_one({"_id": ObjectId(made.id)}, {"$set": {
            "hubspot_deals_root": True, "hidden": True, **T.team_update([conn["team_id"]], [])["$set"]}})
        f = await db["folders"].find_one({"workspace_id": ws, "hubspot_deals_root": True}, sort=[("created_at", 1), ("_id", 1)])
        if f is not None and str(f["_id"]) != made.id:
            await db["folders"].delete_one({"_id": ObjectId(made.id)})
    if not f.get("hidden"):
        await db["folders"].update_one({"_id": f["_id"]}, {"$set": {"hidden": True}})      # connected again
    fid = str(f["_id"])
    conn["deals_folder_id"] = fid
    await db[H.CONNS].update_one({"_id": ws}, {"$set": {"deals_folder_id": fid}})
    return fid


async def _deal_folder(db, conn: dict, row: dict, title: str) -> str | None:
    """The deal's folder: made, or renamed to follow HubSpot. None when the workspace can't take another."""
    from app.services import folder as folder_service
    from app.services import teams as T

    ws = conn["_id"]
    f = await db["folders"].find_one({"_id": T.oid(row.get("folder_id")), "workspace_id": ws}) if row.get("folder_id") else None
    if f is not None:
        if not f.get("hidden"):
            await db["folders"].update_one({"_id": f["_id"]}, {"$set": {"hidden": True}})
        if f.get("name") != title:
            try:
                await folder_service.update_folder(db, ws, str(f["_id"]), name=title)
            except HTTPException as exc:
                log.info("hubspot: couldn't rename the deal folder %s: %s", f["_id"], exc.detail)
        return str(f["_id"])
    root = await root_folder(db, conn)
    try:
        made = await folder_service.create_folder(db, ws, title, root)
    except HTTPException as exc:
        log.warning("hubspot: couldn't make the folder of deal %s: %s", row.get("deal_id"), exc.detail)
        return None
    await db["folders"].update_one({"_id": ObjectId(made.id)}, {"$set": {
        "hubspot_deal": row["_id"], "hidden": True, **T.team_update([conn["team_id"]], [])["$set"]}})
    return made.id


def _money(amount: float | None, currency: str | None) -> str | None:
    if amount is None:
        return None
    return f"{amount:,.0f} {currency or ''}".strip()


def _line_date(at: str | None) -> str:
    from app.services import meetings

    return meetings.fmt_date(at[:10]) if at else ""


async def calls_of(db, conn: dict, deal_id: str, *, team_only: bool = True) -> list[dict]:
    """The team's calls filed in (or matched to and fileable for) the deal, newest first."""
    from app.services import meetings

    q: dict[str, Any] = {"workspace_id": conn["_id"], "team_ids": conn["team_id"], "hubspot.match.portal_id": conn["portal_id"],
                         "$or": [{"hubspot.filed.deal_id": str(deal_id)}, {"hubspot.match.deal_id": str(deal_id)}]}
    if team_only:
        q["restricted"] = {"$ne": True}
    rows = await db[meetings.COLL].find(q, {"segments": 0}).sort([("date", -1), ("created_at", -1)]).limit(MAX_CALLS * 2) \
        .to_list(length=MAX_CALLS * 2)
    return [r for r in rows if _belongs(r, str(deal_id))][:MAX_CALLS]


def fileable(m: dict | None) -> bool:
    """A match good enough to move the call into its deal's folder without asking: a person's pick, the
    meeting HubSpot booked on the deal (one deal), or attendees whose company has exactly one open deal."""
    if not m or not m.get("deal_id"):
        return False
    if m.get("how") == "user":
        return True
    if m.get("how") == "meeting":
        return not m.get("candidates")
    return m.get("how") == "contacts" and m.get("confidence") == "medium"


def _belongs(row: dict, deal_id: str) -> bool:
    hs = row.get("hubspot") or {}
    filed = (hs.get("filed") or {}).get("deal_id")
    m = hs.get("match") or {}
    if m.get("deal_id") == deal_id and fileable(m):
        return True
    return filed == deal_id and (not m.get("deal_id") or m.get("deal_id") == deal_id)


def rollup(calls: list[dict]) -> dict:
    """The team's calls on the deal rolled up: {decisions, risks, questions, next_steps: [{text, date, slug}],
    last_call}."""
    def gather(key: str) -> list[dict]:
        got = []
        for c in calls:
            for it in (c.get("generated") or {}).get(key) or []:
                t = it.get("text") if isinstance(it, dict) else it
                if H._plain(t):
                    got.append({"text": H._plain(t), "date": c.get("date"), "slug": c.get("slug")})
        return got[:MAX_LINES]

    risks = []
    for c in calls:
        acct = (((c.get("hubspot") or {}).get("suggestions") or {}).get("account")) or {}
        for key, tag in (("objections", "Objection"), ("risks", "Risk")):
            for it in acct.get(key) or []:
                if H._plain(it.get("text")):
                    risks.append({"text": f"{tag}: {H._plain(it.get('text'))}", "date": c.get("date"), "slug": c.get("slug")})
    steps = []
    for c in calls:
        done = (c.get("hubspot") or {}).get("tasks") or {}
        for it in H.items_of(c):
            t = done.get(H.task_key(it["text"]))
            extra = " · ".join(x for x in (it.get("owner"), f"due {it['due']}" if it.get("due") else None,
                                           "in HubSpot" if isinstance(t, dict) and t.get("state") == "created" else None) if x)
            steps.append({"text": it["text"] + (f" ({extra})" if extra else ""), "date": c.get("date"), "slug": c.get("slug")})
    last = calls[0] if calls else None
    return {"decisions": gather("decisions"), "risks": risks[:MAX_LINES], "questions": gather("open_questions"),
            "next_steps": steps[:MAX_LINES],
            "last_call": {"date": last.get("date"), "title": last.get("title"), "slug": last.get("slug")} if last else None}


def section_markdown(conn: dict, row: dict, calls: list[dict], act: dict | None, when: datetime) -> str:
    """The overview page's auto-updated section."""
    from app.services import meetings

    e = lambda t: meetings.md_inline(H._plain(t))  # noqa: E731
    out = [START, ""]
    facts = [f"**Stage** {e(row.get('stage') or 'No stage')}" + (f" ({row['closed_label']})" if row.get("closed_label") else "")]
    money = _money(row.get("amount"), row.get("currency"))
    if money:
        facts.append(f"**Amount** {e(money)}")
    if row.get("owner"):
        facts.append(f"**Owner** {e(row['owner'])}")
    if row.get("close_date"):
        facts.append(f"**Close date** {meetings.fmt_date(row['close_date'])}")
    if row.get("pipeline"):
        facts.append(f"**Pipeline** {e(row['pipeline'])}")
    if (row.get("company") or {}).get("name"):
        facts.append(f"**Company** {e(row['company']['name'])}")
    url = H.record_url(conn, "deal", row["deal_id"])
    out.append(" · ".join(facts) + (f" · [Open in HubSpot]({url})" if url else ""))
    if row.get("closed"):
        out += ["", f"This deal is {(row.get('closed_label') or 'closed').lower()}. Its calls still come here; HubSpot's details are read again a few times a day."]
    out += ["", "### Contacts"]
    if row.get("contacts"):
        for c in row["contacts"]:
            out.append("- " + " · ".join(e(x) for x in (c.get("name"), c.get("title"), c.get("email")) if x))
    else:
        out.append("- No contacts on the deal in HubSpot.")
    r = rollup(calls)
    out += ["", "### From the team's calls"]
    if r["last_call"]:
        lc = r["last_call"]
        out.append(f"Last call: {meetings.fmt_date(lc.get('date'))} · "
                   + (f"[{e(lc.get('title') or 'Meeting')}](/{lc['slug']})" if lc.get("slug") else e(lc.get("title") or "Meeting")))
        for c in calls[:MAX_LINES]:
            if c is calls[0]:
                continue
            out.append(f"- {meetings.fmt_date(c.get('date'))} · " + (f"[{e(c.get('title') or 'Meeting')}](/{c['slug']})"
                                                                    if c.get("slug") else e(c.get("title") or "Meeting")))
    else:
        out.append("No calls filed here yet.")

    def bullets(head: str, rows: list[dict]) -> None:
        if rows:
            out.extend(["", f"#### {head}", *(f"- {e(x['text'])}" + (f" ([{meetings.fmt_date(x['date'])}](/{x['slug']}))"
                                                                    if x.get("slug") and x.get("date") else "") for x in rows)])

    bullets("Decisions", r["decisions"])
    bullets("Objections and risks", r["risks"])
    bullets("Open questions", r["questions"])
    bullets("Next steps", r["next_steps"])
    out += ["", "### HubSpot history"]
    items = (act or {}).get("items") or []
    for it in items[:MAX_HISTORY]:
        kind = it["kind"].capitalize()
        if it["kind"] == "email":
            kind = "Email received" if it.get("direction") == "in" else "Email sent"
        bits = [_line_date(it.get("at")), kind, e(it.get("title") or "")]
        line = " · ".join(b for b in bits if b)
        if it.get("preview"):
            line += f" — {e(it['preview'])}"
        if it.get("status"):
            line += f" ({e(it['status'])})"
        out.append(f"- {line}")
    if not items:
        out.append("- Nothing logged on the deal in HubSpot yet.")
    for mi in (act or {}).get("missing") or []:
        out.append(f"\n*Add {mi['scope']} to the HubSpot key (Integrations › HubSpot) to show {mi['what']}.*")
    atts = ((act or {}).get("attachments") or {}).get("items") or []
    if atts:
        out += ["", "### Attachments in HubSpot"]
        out += [f"- [{e(a['name'])}]({a['url']})" if a.get("url") else f"- {e(a['name'])}" for a in atts]
    out += ["", f"Updated {meetings.fmt_date(when.date().isoformat())}.", "", END]
    return "\n".join(out)


async def refresh_overview(db, conn: dict, key: str, *, act: dict | None = None) -> dict | None:
    """Make or rewrite the deal's overview page (only the section; people's notes stay)."""
    from app.services import access, hubspot_accounts, meetings, pages
    from app.services import teams as T

    row = await db[DEALS].find_one({"_id": key})
    if row is None or not row.get("folder_id"):
        return None
    user = await _writer(db, conn)
    if user is None:
        return None
    if act is None:
        act = row.get("activity")
    calls = await calls_of(db, conn, row["deal_id"])
    section = section_markdown(conn, row, calls, act, now_utc())
    actor, ctx = access.Actor.of(user), access.Ctx(db)
    raw = await db["documents"].find_one({"_id": row["doc_id"]}) if row.get("doc_id") else None
    if raw is not None and raw.get("deleted_at"):
        raw = None
    if raw is None:
        try:
            raw, _secret, _err = await pages.create_page(db, user, actor, ctx, title=OVERVIEW_TITLE, workspace=conn["_id"],
                                                         folder=row["folder_id"], content="\n")
        except HTTPException as exc:
            log.info("hubspot: couldn't make the overview of deal %s: %s", row["deal_id"], exc.detail)
            return None
        raw = await db["documents"].find_one({"_id": raw["_id"]}) or raw
        if (raw.get("access_level") or "link") != "workspace":
            raw = await access.set_level(db, raw, "workspace", actor, ctx)
        await T.apply_to_doc(db, raw, [conn["team_id"]], [])
        await db["documents"].update_one({"_id": raw["_id"]}, {"$set": {"hubspot_deal": key}})
        raw = await db["documents"].find_one({"_id": raw["_id"]})
        content = ("The team's page for this deal. Write your own notes above or below the section Markdrop keeps "
                   "up to date.\n\n" + section + "\n")
    else:
        content = hubspot_accounts.merge(raw.get("content") or "", section, start=START, end=END)
    # Only the date line changed: leave the page alone.
    if _sans_date(content) != _sans_date(raw.get("content") or ""):
        try:
            await pages.check_page_lock(raw, actor, ctx, content)
            await meetings._save(db, raw, content, actor, ctx)
        except HTTPException as exc:
            log.info("hubspot: couldn't update the overview %s (%s)", raw.get("slug"), exc.detail)
    await db[DEALS].update_one({"_id": key}, {"$set": {"doc_id": raw["_id"], "slug": raw.get("slug"), "overview_at": now_utc(),
                                                       "calls": len(calls)}})
    return raw


_UPDATED = re.compile(r"^Updated .*\.$", re.M)


def _sans_date(text: str) -> str:
    return _UPDATED.sub("", text or "")


# ── Filing calls ──────────────────────────────────────────────────────────────


async def _move(db, conn: dict, row: dict, folder_id: str | None) -> bool:
    """Move the meeting's page (its transcript comes along) into ``folder_id`` (None: back where meetings go)."""
    from app.services import folder as folder_service
    from app.services import meeting_place, meetings

    raw = await meetings.page_of(db, row)
    if raw is None or raw.get("parent_id") is not None or raw.get("workspace_id") != conn["_id"]:
        return False
    if folder_id is None:
        await db[meetings.COLL].update_one({"_id": row["_id"]}, {"$unset": {"hubspot.filed": ""}})
        row = await db[meetings.COLL].find_one({"_id": row["_id"]}) or row
        if raw.get("folder_id") and await db[DEALS].find_one({"folder_id": raw["folder_id"]}, {"_id": 1}):
            await folder_service.file_document(db, raw, conn["_id"], row.get("folder_id") or None)
            await meeting_place.place_meeting(db, conn["_id"], row)
        return True
    if (raw.get("folder_id") or None) != folder_id:
        try:
            await folder_service.file_document(db, raw, conn["_id"], folder_id)
        except HTTPException as exc:
            log.info("hubspot: couldn't file meeting %s in its deal's folder: %s", row["_id"], exc.detail)
            return False
    return True


async def file_call(db, conn: dict, row: dict, *, sync_overview: bool = True) -> str | None:
    """File one call by its match: into its deal's folder (the deal's folder is made when the deal is open and
    has none yet), or out of a deal's folder it no longer belongs to. Filed once: a call already filed in
    this deal isn't moved again (a person may have put it elsewhere). Returns the deal id it's filed in."""
    from app.services import meetings

    if not H.in_scope(row, conn):
        return None
    hs = row.get("hubspot") or {}
    m = hs.get("match") if (hs.get("match") or {}).get("portal_id") == conn["portal_id"] else None
    filed = hs.get("filed") or {}
    want = str(m["deal_id"]) if fileable(m) else None
    if want and filed.get("deal_id") == want:
        return want
    if not want:
        if filed.get("deal_id") and m and m.get("how") == "user":
            # A person said "no deal" or picked one we can't file: back to the meetings folders.
            await _move(db, conn, row, None)
            if sync_overview:
                await _overview_of(db, conn, filed["deal_id"])
        return filed.get("deal_id") if (filed.get("deal_id") and not (m and m.get("how") == "user")) else None
    key = key_of(conn, want)
    deal = await db[DEALS].find_one({"_id": key})
    if deal is None or not deal.get("folder_id"):
        deal = await ensure_deal(db, conn, want)
    if deal is None or not deal.get("folder_id"):
        return None
    if await _move(db, conn, row, deal["folder_id"]):
        await db[meetings.COLL].update_one({"_id": row["_id"]}, {"$set": {"hubspot.filed": {
            "deal_id": want, "folder_id": deal["folder_id"], "at": now_utc()}}})
        if sync_overview:
            await refresh_overview(db, conn, key)
            if filed.get("deal_id") and filed["deal_id"] != want:
                await _overview_of(db, conn, filed["deal_id"])
        return want
    return None


async def _overview_of(db, conn: dict, deal_id: str) -> None:
    try:
        await refresh_overview(db, conn, key_of(conn, deal_id))
    except Exception:
        log.warning("hubspot: overview of %s failed", deal_id, exc_info=True)


async def file_after(db: AsyncIOMotorDatabase, conn: dict, meeting_id: str, m: dict) -> str | None:
    """hubspot.meeting_ready (a newly imported call, its summary written): file it into its deal's folder."""
    from app.services import meetings

    row = await meetings.get_row(db, meeting_id)
    if row is None or not usable(conn):
        return None
    before = ((row.get("hubspot") or {}).get("filed") or {}).get("deal_id")
    got = await file_call(db, conn, row)
    if got and got == before:
        await _overview_of(db, conn, got)       # already filed: its summary is new, so the roll-up is
    return got


def file_soon(db: AsyncIOMotorDatabase, conn: dict, meeting_id: str) -> None:
    """After a person's Change match / Match again: file (or unfile) the call in the background."""
    async def go() -> None:
        from app.services import meetings

        row = await meetings.get_row(db, meeting_id)
        if row is not None:
            await file_call(db, conn, row)

    H.spawn(go())


# ── Sync ──────────────────────────────────────────────────────────────────────


async def ensure_deal(db, conn: dict, deal_id: str) -> dict | None:
    """One deal brought in now (a call matched to a deal the sync hasn't reached yet)."""
    ds = await H.batch_read(db, conn, "deals", [deal_id], DEAL_PROPS)
    if not ds:
        return None
    stage_by = {s["id"]: s for s in await H.stages(db, conn)}
    await _apply(db, conn, ds, stage_by)
    return await db[DEALS].find_one({"_id": key_of(conn, deal_id)})


def _hash(*parts: Any) -> str:
    return hashlib.sha1(repr(parts).encode("utf-8")).hexdigest()[:16]


def wanted(d: dict, stage_by: dict[str, dict], old: dict | None, with_calls: set[str], closed_too: bool = False) -> bool:
    """Whether a HubSpot deal gets (or keeps updating) a deal folder. The dry run and the real run both ask this."""
    if H._deal_open(d, stage_by):
        return True
    if old is not None and old.get("folder_id"):
        return not old.get("closed") or closed_too       # just closed: marked now; already closed: the slow refresh
    return str(d.get("id")) in with_calls                 # closed (won or lost) with a team call matched to it


async def deals_with_calls(db, conn: dict, deal_ids: list[str]) -> set[str]:
    """Those of ``deal_ids`` that a call of the team is matched to, surely enough to be filed there."""
    from app.services import meetings

    if not deal_ids:
        return set()
    out: set[str] = set()
    async for r in db[meetings.COLL].find({"workspace_id": conn["_id"], "team_ids": conn["team_id"],
                                           "hubspot.match.portal_id": conn["portal_id"],
                                           "$or": [{"hubspot.match.deal_id": {"$in": deal_ids}}, {"hubspot.filed.deal_id": {"$in": deal_ids}}]},
                                          {"hubspot.match": 1, "hubspot.filed": 1}):
        hs = r.get("hubspot") or {}
        m = hs.get("match") or {}
        if fileable(m):
            out.add(str(m["deal_id"]))
        if (hs.get("filed") or {}).get("deal_id"):
            out.add(str(hs["filed"]["deal_id"]))
    return out & set(deal_ids)


async def _apply(db, conn: dict, deals: list[dict], stage_by: dict[str, dict], *, refresh: bool = True,
                 dry: list | None = None, closed_too: bool = False) -> int:
    """Bring a batch of HubSpot deals into Markdrop: rows, folders, renames, overview pages, and the calls
    matched to them. Which deals (:func:`wanted`): open ones; a closed deal only when a team call is matched to it
    (won or lost, it gets a folder and keeps receiving calls) or it just closed. ``closed_too``: also the
    deals already closed here (the slower closed-deal refresh). Returns how many changed."""
    if not deals:
        return 0
    ids = [str(d.get("id")) for d in deals]
    existing = {r["deal_id"]: r for r in await db[DEALS].find({"_id": {"$in": [key_of(conn, i) for i in ids]}}).to_list(length=len(ids))}
    owner_by = {o["id"]: o for o in await H.owners(db, conn)}
    with_calls = await deals_with_calls(db, conn, [i for d, i in zip(deals, ids) if not H._deal_open(d, stage_by)])
    todo = [d for d in deals if wanted(d, stage_by, existing.get(str(d.get("id"))), with_calls, closed_too)]
    if not todo:
        return 0
    companies, contacts = await _companies_contacts(db, conn, [str(d.get("id")) for d in todo])
    n = 0
    for d in todo:
        did = str(d.get("id"))
        v = H._deal_view(conn, d, stage_by, owner_by)
        st = stage_by.get(str((d.get("properties") or {}).get("dealstage") or "")) or {}
        company = companies.get(did)
        title = title_of(v["name"], (company or {}).get("name"))
        key = key_of(conn, did)
        sets = {"workspace_id": conn["_id"], "portal_id": conn["portal_id"], "deal_id": did, "name": v["name"],
                "company": company, "title": title, "stage_id": str((d.get("properties") or {}).get("dealstage") or "") or None,
                "stage": v["stage"], "pipeline": v["pipeline"], "pipeline_id": st.get("pipeline_id") or str((d.get("properties") or {}).get("pipeline") or "") or None,
                "closed": v["closed"], "closed_label": closed_label(d, stage_by), "amount": v["amount"], "currency": v["currency"],
                "owner_id": v["owner_id"], "owner": v["owner"], "close_date": v["close_date"], "contacts": contacts.get(did) or [],
                "hs_modified": H._from_hs_time((d.get("properties") or {}).get("hs_lastmodifieddate")), "synced_at": now_utc()}
        sets["data_hash"] = _hash(*(sets[k] for k in ("name", "company", "stage", "closed_label", "amount", "currency", "owner",
                                                      "close_date", "pipeline", "contacts")), sets["hs_modified"])
        old = existing.get(did)
        if dry is not None:
            dry.append({"deal_id": did, "title": title, "new": old is None, "rename": bool(old and old.get("title") != title),
                        "closed": v["closed"], "closed_label": sets["closed_label"]})
            n += 1
            continue
        await db[DEALS].update_one({"_id": key}, {"$set": sets, "$setOnInsert": {"created_at": now_utc()}}, upsert=True)
        row = await db[DEALS].find_one({"_id": key})
        fid = await _deal_folder(db, conn, row, title)
        if fid and fid != row.get("folder_id"):
            await db[DEALS].update_one({"_id": key}, {"$set": {"folder_id": fid}})
        if not fid:
            continue
        n += 1
        await _file_matched(db, conn, did)
        if refresh and (old is None or old.get("data_hash") != sets["data_hash"] or not old.get("doc_id")):
            act = None
            try:
                act = await activity(db, conn, did)
                await db[DEALS].update_one({"_id": key}, {"$set": {"activity": {**act, "at": now_utc()}}})
            except HubSpotError as exc:
                if exc.auth or exc.limited:
                    raise
                log.info("hubspot: history of deal %s: %s", did, exc)
            await refresh_overview(db, conn, key, act=act)
    return n


async def _file_matched(db, conn: dict, deal_id: str) -> int:
    """Move the calls matched to the deal (fileable matches, not filed yet) into its folder."""
    from app.services import meetings

    n = 0
    cur = db[meetings.COLL].find({"workspace_id": conn["_id"], "team_ids": conn["team_id"],
                                  "hubspot.match.portal_id": conn["portal_id"], "hubspot.match.deal_id": str(deal_id),
                                  "hubspot.filed.deal_id": {"$ne": str(deal_id)}}, {"segments": 0}).limit(500)
    async for row in cur:
        if fileable((row.get("hubspot") or {}).get("match")) and await file_call(db, conn, row, sync_overview=False):
            n += 1
    return n


async def _file_pending(db, conn: dict, limit: int = 50) -> int:
    """Calls matched since their deal last changed (a match made from the meeting panel, past meetings imported
    in bulk): filed on the next pass when their deal has a folder."""
    from app.services import meetings

    n = 0
    missing: dict[str, list[dict]] = {}
    cur = db[meetings.COLL].find({"workspace_id": conn["_id"], "team_ids": conn["team_id"], "hubspot.match.portal_id": conn["portal_id"],
                                  "hubspot.match.deal_id": {"$ne": None}, "hubspot.filed": {"$exists": False}},
                                 {"segments": 0}).limit(limit * 4)
    async for row in cur:
        m = (row.get("hubspot") or {}).get("match")
        if n >= limit or not fileable(m):
            continue
        if not await db[DEALS].find_one({"_id": key_of(conn, m["deal_id"]), "folder_id": {"$ne": None}}, {"_id": 1}):
            missing.setdefault(str(m["deal_id"]), []).append(row)
            continue
        try:
            if await file_call(db, conn, row):
                n += 1
        except HTTPException as exc:
            log.info("hubspot: filing %s: %s", row["_id"], exc.detail)
    if missing and n < limit:
        # Their deal has no folder yet (a closed deal the open-deal passes never bring in): one batch read, then
        # filed like any other (a deal gone from HubSpot just stays without one).
        stage_by = {s["id"]: s for s in await H.stages(db, conn)}
        await _apply(db, conn, await H.batch_read(db, conn, "deals", list(missing)[:100], DEAL_PROPS), stage_by)
        for rows in missing.values():
            for row in rows:
                if n >= limit:
                    break
                if await db[DEALS].find_one({"_id": key_of(conn, row["hubspot"]["match"]["deal_id"]), "folder_id": {"$ne": None}}, {"_id": 1}):
                    try:
                        if await file_call(db, conn, row):
                            n += 1
                    except HTTPException as exc:
                        log.info("hubspot: filing %s: %s", row["_id"], exc.detail)
    return n


async def _refresh_closed(db, conn: dict) -> int:
    """The closed deals that have a folder, read again (batch reads) every :data:`CLOSED_EVERY`: renames and
    stage changes follow, a reopened deal syncs like an open one again."""
    ids = [r["deal_id"] for r in await db[DEALS].find({"workspace_id": conn["_id"], "portal_id": conn["portal_id"], "closed": True,
                                                         "folder_id": {"$ne": None}}, {"deal_id": 1}).sort("synced_at", 1).to_list(length=500)]
    if not ids:
        return 0
    stage_by = {s["id"]: s for s in await H.stages(db, conn)}
    n = 0
    for k in range(0, len(ids), 100):
        n += await _apply(db, conn, await H.batch_read(db, conn, "deals", ids[k:k + 100], DEAL_PROPS), stage_by, closed_too=True)
    return n


async def _claim(db, conn: dict, force: bool) -> dict | None:
    now = now_utc()
    q: dict[str, Any] = {"_id": conn["_id"], "$or": [{"deals_sync.lease_until": {"$exists": False}},
                                                     {"deals_sync.lease_until": None},
                                                     {"deals_sync.lease_until": {"$lt": now}}]}
    if not force:
        q["$and"] = [{"$or": [{"deals_sync.next_at": {"$exists": False}}, {"deals_sync.next_at": None},
                              {"deals_sync.next_at": {"$lte": now}}]}]
    return await db[H.CONNS].find_one_and_update(q, {"$set": {"deals_sync.lease_until": now + LEASE, "deals_sync.state": "running"}},
                                                 return_document=ReturnDocument.AFTER)


async def sync(db: AsyncIOMotorDatabase, conn: dict, *, force: bool = False, cap: int = SYNC_CAP,
               dry: bool = False) -> dict:
    """One pass (see the module doc). ``dry``: read HubSpot and say what would change, write nothing.
    Returns ``{deals, changed, more, state}``."""
    if not usable(conn):
        return {"deals": 0, "changed": 0, "more": False, "state": "off"}
    if dry:
        conn = {**conn, "_dry": True}
    else:
        claimed = await _claim(db, conn, force)
        if claimed is None:
            return {"deals": 0, "changed": 0, "more": False, "state": "busy"}
        conn = claimed
    st = conn.get("deals_sync") or {}
    cursor = st.get("cursor")
    initial = not st.get("initial_done")
    changed, seen, more = 0, 0, False
    report: list | None = [] if dry else None
    try:
        stage_by = {s["id"]: s for s in await H.stages(db, conn)}
        if not dry:
            await root_folder(db, conn)
            if initial and not st.get("started_ms"):
                st["started_ms"] = H._ms(now_utc())
                await db[H.CONNS].update_one({"_id": conn["_id"]}, {"$set": {"deals_sync.started_ms": st["started_ms"]}})
        filters: list[dict] = []
        if initial:
            filters.append({"propertyName": "hs_is_closed", "operator": "EQ", "value": "false"})
        if cursor:
            filters.append({"propertyName": "hs_lastmodifieddate", "operator": "GTE", "value": str(int(cursor))})
        body: dict[str, Any] = {"properties": DEAL_PROPS, "limit": 100,
                                "sorts": [{"propertyName": "hs_lastmodifieddate", "direction": "ASCENDING"}]}
        if filters:
            body["filterGroups"] = [{"filters": filters}]
        after = None
        last_ms = cursor
        while seen < cap:
            got = await H.call(db, conn, "POST", "crm/v3/objects/deals/search",
                               json={**body, "limit": min(100, cap - seen), **({"after": after} if after else {})}) or {}
            rows = got.get("results") or []
            seen += len(rows)
            changed += await _apply(db, conn, rows, stage_by, dry=report)
            for r in rows:
                t = H._from_hs_time((r.get("properties") or {}).get("hs_lastmodifieddate"))
                if t:
                    last_ms = max(int(last_ms or 0), H._ms(t))
            after = ((got.get("paging") or {}).get("next") or {}).get("after")
            if not after:
                break
        more = bool(after)
        if more and last_ms == cursor:
            last_ms = int(last_ms or 0) + 1        # a page of deals all changed in the same millisecond
        done_initial = initial and not more
        out = {"deals": seen, "changed": changed, "more": more, "state": "idle"}
        if dry:
            out["report"] = report
            return out
        await _file_pending(db, conn)
        closed_at = H._aware(st.get("closed_at"))
        refreshed_closed = closed_at is None or now_utc() - closed_at >= CLOSED_EVERY
        if refreshed_closed:
            await _refresh_closed(db, conn)
        total = await db[DEALS].count_documents({"workspace_id": conn["_id"], "portal_id": conn["portal_id"]})
        sets = {"deals_sync.state": "idle", "deals_sync.at": now_utc(), "deals_sync.lease_until": None,
                "deals_sync.last_error": None, "deals_sync.deals": total,
                "deals_sync.next_at": now_utc() + (timedelta(minutes=1) if more else SYNC_EVERY)}
        if refreshed_closed:
            sets["deals_sync.closed_at"] = now_utc()
        if done_initial:
            # The open deals are all in: from now on, every deal changed since the first pass began (one that
            # closed meanwhile included; reading a deal twice changes nothing).
            sets["deals_sync.initial_done"] = True
            sets["deals_sync.cursor"] = st.get("started_ms")
        elif last_ms:
            sets["deals_sync.cursor"] = last_ms
        await db[H.CONNS].update_one({"_id": conn["_id"]}, {"$set": sets})
        return out
    except HubSpotError as exc:
        if not dry:
            await db[H.CONNS].update_one({"_id": conn["_id"]}, {"$set": {
                "deals_sync.state": "error", "deals_sync.lease_until": None, "deals_sync.last_error": H._http_error(exc).detail,
                "deals_sync.next_at": now_utc() + SYNC_EVERY}})
        raise
    except BaseException:
        if not dry:
            await db[H.CONNS].update_one({"_id": conn["_id"]}, {"$set": {"deals_sync.state": "error", "deals_sync.lease_until": None,
                                                                         "deals_sync.next_at": now_utc() + SYNC_EVERY}})
        raise


async def tick(db: AsyncIOMotorDatabase) -> int:
    """The background loop: a pass for each connected workspace whose next pass is due."""
    if not H.configured():
        return 0
    n = 0
    async for conn in db[H.CONNS].find({"token_enc": {"$exists": True}, "team_id": {"$ne": None}}):
        if not usable(conn):
            continue
        try:
            got = await sync(db, conn)
            n += got.get("changed") or 0
        except HubSpotError as exc:
            log.info("hubspot: deal sync for %s: %s", conn["_id"], exc)
        except Exception:
            log.warning("hubspot: deal sync for %s failed", conn["_id"], exc_info=True)
    return n


# ── Views ─────────────────────────────────────────────────────────────────────


async def _conn_for(db, user, workspace_id: str) -> dict:
    await H.role_of(db, user, workspace_id)
    conn = await H.get(db, workspace_id)
    if not usable(conn):
        raise HTTPException(status_code=404, detail="This workspace's HubSpot team has no deals here.")
    if not await H.can_use(db, user.id, conn):
        raise HTTPException(status_code=403, detail="Deals are for the HubSpot team's members.")
    return conn


def _sync_view(conn: dict) -> dict:
    st = conn.get("deals_sync") or {}
    lease = H._aware(st.get("lease_until"))
    state = st.get("state") or "idle"
    if state == "running" and (lease is None or lease < now_utc()):
        state = "idle"
    return {"at": H.iso(st.get("at")), "state": state, "last_error": st.get("last_error"), "deals": int(st.get("deals") or 0),
            "next_at": H.iso(st.get("next_at"))}


def _missing_optional(conn: dict) -> list[dict]:
    out = []
    for s in H.SCOPES:
        if not s["required"] and s["scope"] in (EMAIL_SCOPE, FILES_SCOPE):
            have = set(conn.get("scopes") or []) - set(conn.get("denied") or [])
            alt = FILES_SCOPE == s["scope"] and "files" in have
            if s["scope"] not in have and not alt:
                out.append({"scope": s["scope"], "why": s["why"]})
    return out


def _quiet(last: dict | None, today: date) -> tuple[int | None, bool]:
    try:
        d = date.fromisoformat(str((last or {}).get("date"))[:10]) if last else None
    except ValueError:
        d = None
    if d is None:
        return None, True
    days = (today - d).days
    return days, days >= QUIET_DAYS


async def _pick_counts(db, conn: dict) -> dict[str, int]:
    """{deal id: calls waiting for "Pick the deal" that could be it}."""
    from app.services import meetings

    out: dict[str, int] = {}
    async for r in db[meetings.COLL].find({"workspace_id": conn["_id"], "team_ids": conn["team_id"],
                                           "hubspot.match.portal_id": conn["portal_id"], "hubspot.filed": {"$exists": False},
                                           "hubspot.match.deal_id": {"$ne": None}},
                                          {"hubspot.match": 1}).limit(2000):
        m = (r.get("hubspot") or {}).get("match") or {}
        if fileable(m) or m.get("how") == "user":
            continue
        for d in dict.fromkeys([m.get("deal_id"), *[c.get("id") for c in m.get("candidates") or []]]):
            if d:
                out[str(d)] = out.get(str(d), 0) + 1
    return out


def card(conn: dict, row: dict, calls: dict[str, dict], counts: dict[str, int], picks: dict[str, int], today: date) -> dict:
    last = calls.get(row["deal_id"])
    days, quiet = _quiet(last, today)
    return {"id": row["deal_id"], "name": row.get("name"), "company": row.get("company"), "title": row.get("title"),
            "stage_id": row.get("stage_id"), "stage": row.get("stage"), "pipeline": row.get("pipeline"),
            "pipeline_id": row.get("pipeline_id"), "closed": bool(row.get("closed")), "closed_label": row.get("closed_label"),
            "amount": row.get("amount"), "currency": row.get("currency"), "owner": row.get("owner"), "owner_id": row.get("owner_id"),
            "close_date": row.get("close_date"), "url": H.record_url(conn, "deal", row["deal_id"]),
            "folder_id": row.get("folder_id"), "href": deal_href(conn["_id"], row["deal_id"]),
            "calls": counts.get(row["deal_id"], 0), "last_call": last, "days_quiet": days, "quiet": quiet and not row.get("closed"),
            "pick": picks.get(row["deal_id"], 0), "updated_at": H.iso(row.get("hs_modified"))}


async def _call_index(db, conn: dict) -> tuple[dict[str, dict], dict[str, int]]:
    """({deal id: last call {date, title, slug}}, {deal id: calls}) over the team's calls filed in deals."""
    from app.services import meetings

    last: dict[str, dict] = {}
    count: dict[str, int] = {}
    async for r in db[meetings.COLL].find({"workspace_id": conn["_id"], "team_ids": conn["team_id"],
                                           "hubspot.filed.deal_id": {"$exists": True}},
                                          {"date": 1, "title": 1, "slug": 1, "hubspot.filed": 1, "hubspot.match": 1}).sort("date", -1).limit(5000):
        d = ((r.get("hubspot") or {}).get("filed") or {}).get("deal_id")
        if not d or not _belongs(r, d):
            continue
        count[d] = count.get(d, 0) + 1
        last.setdefault(d, {"date": r.get("date"), "title": r.get("title"), "slug": r.get("slug")})
    return last, count


async def board(db: AsyncIOMotorDatabase, user, workspace_id: str) -> dict:
    """GET /deals/board: every deal folder of the team (open, and closed ones marked)."""
    from app.models.workspace import role_allows
    from app.services import workspace as ws_service

    conn = await _conn_for(db, user, workspace_id)
    team = await H._team(db, workspace_id, conn["team_id"])
    rows = await db[DEALS].find({"workspace_id": workspace_id, "portal_id": conn["portal_id"], "folder_id": {"$ne": None}}) \
        .to_list(length=5000)
    last, count = await _call_index(db, conn)
    picks = await _pick_counts(db, conn)
    today = now_utc().date()
    deals = [card(conn, r, last, count, picks, today) for r in rows]
    deals.sort(key=lambda c: (c["closed"], -(H._from_hs_time(c["updated_at"]) or datetime.min.replace(tzinfo=timezone.utc)).timestamp()))
    try:
        stages = await H.stages(db, conn)
    except HubSpotError:
        stages = conn.get("stages") or []
    pipelines = list({s.get("pipeline_id"): {"id": s.get("pipeline_id"), "label": s.get("pipeline")} for s in stages}.values())
    admin = role_allows(await ws_service.role_for(db, workspace_id, user.id), "admin")
    return {"team": {"id": str(team["_id"]), "name": team.get("name"), "slug": team.get("slug")} if team else None,
            "can_sync": admin, "sync": _sync_view(conn), "stages": stages, "pipelines": pipelines, "deals": deals,
            "missing_scopes": _missing_optional(conn) if admin else []}


async def _readable_calls(db, user, conn: dict, rows: list[dict]) -> list[dict]:
    """The calls the person can open (a call restricted to its attendees only for them)."""
    from app.services import access

    actor, ctx = access.Actor.of(user), access.Ctx(db)
    out = []
    for r in rows:
        if r.get("restricted"):
            raw = await db["documents"].find_one({"_id": r.get("doc_id")}) if r.get("doc_id") else None
            if raw is None or not (await access.can(actor, raw, "read", ctx)).allowed:
                continue
        out.append(r)
    return out


def _call_row(conn: dict, r: dict) -> dict:
    hs = r.get("hubspot") or {}
    m = hs.get("match") or {}
    lg = hs.get("logged") if (hs.get("logged") or {}).get("portal_id") == conn["portal_id"] else None
    sug = (hs.get("suggestions") or {}).get("items") or []
    tasks = hs.get("tasks") or {}
    return {"meeting_id": str(r["_id"]), "title": r.get("title"), "date": r.get("date"), "slug": r.get("slug"),
            "href": f"/{r['slug']}" if r.get("slug") else None, "how": m.get("how"), "confidence": m.get("confidence"),
            "logged": {"at": H.iso(lg.get("at"))} if lg else None, "actions": len(H.items_of(r)),
            "tasks_created": sum(1 for t in tasks.values() if isinstance(t, dict) and t.get("state") == "created"),
            "suggestions_open": sum(1 for s in sug if s.get("state") in ("open", "failed"))}


async def detail(db: AsyncIOMotorDatabase, user, workspace_id: str, deal_id: str, *, fresh: bool = False) -> dict:
    """GET /deals/{id}: the Deal page (Overview, Calls, Assets, HubSpot activity)."""
    from app.models.workspace import role_allows
    from app.services import meetings
    from app.services import workspace as ws_service

    if not H._ID.match(str(deal_id or "")):
        raise HTTPException(status_code=404, detail="Deal not found")
    conn = await _conn_for(db, user, workspace_id)
    key = key_of(conn, deal_id)
    row = await db[DEALS].find_one({"_id": key})
    if row is None or not row.get("folder_id"):
        raise HTTPException(status_code=404, detail="Deal not found")
    act = row.get("activity")
    at = H._aware((act or {}).get("at"))
    if fresh or act is None or at is None or now_utc() - at > ACTIVITY_TTL:
        if not row.get("closed") or act is None or fresh:
            try:
                act = {**await activity(db, conn, deal_id), "at": now_utc()}
                await db[DEALS].update_one({"_id": key}, {"$set": {"activity": act}})
            except HubSpotError as exc:
                log.info("hubspot: history of deal %s: %s", deal_id, exc)
                act = act or {"items": [], "missing": [], "attachments": {"items": [], "missing": []}, "at": None}
    calls_all = await calls_of(db, conn, deal_id, team_only=False)
    calls = await _readable_calls(db, user, conn, calls_all)
    team_calls = [c for c in calls_all if not c.get("restricted")]
    last, count = {}, {deal_id: len(calls)}
    if calls:
        last[deal_id] = {"date": calls[0].get("date"), "title": calls[0].get("title"), "slug": calls[0].get("slug")}
    picks_rows = []
    async for r in db[meetings.COLL].find({"workspace_id": workspace_id, "team_ids": conn["team_id"],
                                           "hubspot.match.portal_id": conn["portal_id"], "hubspot.filed": {"$exists": False},
                                           "$or": [{"hubspot.match.deal_id": str(deal_id)},
                                                   {"hubspot.match.candidates.id": str(deal_id)}]},
                                          {"segments": 0}).sort("date", -1).limit(50):
        m = (r.get("hubspot") or {}).get("match") or {}
        if not fileable(m) and m.get("how") != "user":
            picks_rows.append(r)
    picks_rows = await _readable_calls(db, user, conn, picks_rows)
    suggestions = []
    for r in calls:
        s = (r.get("hubspot") or {}).get("suggestions") or {}
        items = [i for i in s.get("items") or [] if i.get("state") in ("open", "failed")]
        if items:
            from app.services import hubspot_deals

            view = hubspot_deals.suggestions_view(r, conn, (r.get("hubspot") or {}).get("match"), H.switch(conn, "suggest"))
            open_ = [i for i in (view or {}).get("items") or [] if i.get("state") in ("open", "failed")]
            if open_:
                suggestions.append({"meeting_id": str(r["_id"]), "title": r.get("title"), "date": r.get("date"),
                                    "slug": r.get("slug"), "items": open_})
    raw = await db["documents"].find_one({"_id": row["doc_id"]}, {"slug": 1, "deleted_at": 1, "updated_at": 1}) if row.get("doc_id") else None
    folder = await db["folders"].find_one({"_id": ObjectId(row["folder_id"])}, {"name": 1}) if ObjectId.is_valid(str(row["folder_id"])) else None
    admin = role_allows(await ws_service.role_for(db, workspace_id, user.id), "admin")
    c = card(conn, row, last, count, {deal_id: len(picks_rows)}, now_utc().date())
    return {"deal": {**c, "contacts": [{**ct, "url": H.record_url(conn, "contact", ct["id"])} for ct in row.get("contacts") or []]},
            "overview": ({"slug": raw["slug"], "href": f"/{raw['slug']}", "updated_at": H.iso(raw.get("updated_at"))}
                         if raw is not None and not raw.get("deleted_at") else None),
            "folder": ({"id": row["folder_id"], "name": folder.get("name"), "href": f"/w/{workspace_id}/f/{row['folder_id']}"}
                       if folder else None),
            "rollup": rollup(team_calls),
            "calls": [_call_row(conn, r) for r in calls], "pick": [_call_row(conn, r) for r in picks_rows],
            "suggestions": suggestions,
            "activity": {"items": (act or {}).get("items") or [], "missing": (act or {}).get("missing") or [],
                         "at": H.iso((act or {}).get("at"))},
            "attachments": (act or {}).get("attachments") or {"items": [], "missing": []},
            "can_sync": admin,
            "deals_write": ("missing" if "crm.objects.deals.write" in (conn.get("denied") or [])
                            else "unchecked" if "crm.objects.deals.write" in (conn.get("unchecked") or [])
                            else "granted" if "crm.objects.deals.write" in (conn.get("scopes") or []) else "missing")}


async def chip(db: AsyncIOMotorDatabase, user, actor, ctx, meeting_id: str) -> dict:
    """GET /meetings/{id}/chip: the meeting page's one-line link to its deal (from Markdrop's own records,
    no HubSpot call). Nothing for anyone who can't use HubSpot on the meeting."""
    from app.services import meetings

    none = {"deal": None, "pick": False}
    row, _raw = await meetings.for_read(db, meeting_id, actor, ctx)
    conn = await H.get(db, row["workspace_id"])
    if not (usable(conn) and H.in_scope(row, conn) and await H.can_use(db, user.id if user else None, conn)):
        return none
    hs = row.get("hubspot") or {}
    m = hs.get("match") if (hs.get("match") or {}).get("portal_id") == conn["portal_id"] else None
    did = ((hs.get("filed") or {}).get("deal_id")) or (m.get("deal_id") if fileable(m) else None)
    if did:
        d = await db[DEALS].find_one({"_id": key_of(conn, did)})
        if d is not None and d.get("folder_id"):
            return {"deal": {"id": did, "name": d.get("name"), "company": (d.get("company") or {}).get("name"),
                             "stage": d.get("stage"), "closed_label": d.get("closed_label"),
                             "href": deal_href(conn["_id"], did)}, "pick": False, "workspace_id": conn["_id"]}
    # No deal it's filed in: "Pick the deal" (a person's "none of these" stays none).
    return {**none, "pick": not (m and m.get("how") == "user" and not m.get("deal_id")), "workspace_id": conn["_id"]}


async def card_deals(db: AsyncIOMotorDatabase, user_id: str | None, workspace_id: str, rows: list[dict]) -> dict[str, dict]:
    """The Meetings list's deal chips: {meeting id: {deal: {id, name, company, href} | None, pick}} for the rows
    in the HubSpot team (what :func:`chip` says, for a page of cards: one connection read, one deals query).
    Empty for anyone who can't use HubSpot here."""
    conn = await H.get(db, workspace_id) if rows else None
    if not usable(conn):
        return {}
    mine = [r for r in rows if H.in_scope(r, conn)]
    if not mine or not await H.can_use(db, user_id, conn):
        return {}
    want: dict[str, str] = {}
    picks: dict[str, bool] = {}
    for r in mine:
        hs = r.get("hubspot") or {}
        m = hs.get("match") if (hs.get("match") or {}).get("portal_id") == conn["portal_id"] else None
        did = ((hs.get("filed") or {}).get("deal_id")) or (m.get("deal_id") if fileable(m) else None)
        if did:
            want[str(r["_id"])] = str(did)
        elif m:
            # Matched to contacts or several deals, nobody picked yet: "Pick the deal".
            picks[str(r["_id"])] = not (m.get("how") == "user" and not m.get("deal_id")) and bool(
                m.get("deal_id") or m.get("candidates") or m.get("contact_ids"))
    found = {d["deal_id"]: d async for d in db[DEALS].find(
        {"_id": {"$in": [key_of(conn, d) for d in set(want.values())]}, "folder_id": {"$nin": [None, ""]}},
        {"deal_id": 1, "name": 1, "company": 1})} if want else {}
    out: dict[str, dict] = {}
    for mid, did in want.items():
        d = found.get(did)
        if d is not None:
            out[mid] = {"deal": {"id": did, "name": d.get("name"), "company": (d.get("company") or {}).get("name"),
                                 "href": deal_href(conn["_id"], did)}, "pick": False}
    for mid, pick in picks.items():
        if pick and mid not in out:
            out[mid] = {"deal": None, "pick": True}
    return out


async def request_sync(db: AsyncIOMotorDatabase, user, workspace_id: str) -> dict:
    """POST /deals/sync ("Sync now", workspace admins): a pass in the background; the board's sync state."""
    await H.require_admin(db, user, workspace_id)
    conn = await H.get(db, workspace_id)
    if not usable(conn):
        raise HTTPException(status_code=404, detail="This workspace isn't connected to HubSpot.")

    async def go() -> None:
        try:
            await sync(db, conn, force=True)
        except HubSpotError as exc:
            log.info("hubspot: Sync now for %s: %s", workspace_id, exc)

    H.spawn(go())
    await asyncio.sleep(0)
    fresh = await H.get(db, workspace_id) or conn
    v = _sync_view(fresh)
    v["state"] = "running"
    return v


async def forget(db: AsyncIOMotorDatabase, workspace_id: str) -> None:
    """Disconnect: HubSpot's activity kept with the deals goes; the folders, pages and filed calls stay (they're
    the team's) and show in the file tree again, since the Deals section is gone with the connection."""
    await db[DEALS].update_many({"workspace_id": str(workspace_id)}, {"$unset": {"activity": ""}})
    await db["folders"].update_many({"workspace_id": str(workspace_id), "hidden": True,
                                     "$or": [{"hubspot_deals_root": True}, {"hubspot_deal": {"$exists": True}}]},
                                    {"$unset": {"hidden": ""}})


# ── Account pages → archive (the backfill) ────────────────────────────────────


ARCHIVE_NAME = "Accounts (archived)"


async def archive_accounts(db: AsyncIOMotorDatabase, conn: dict, *, apply: bool) -> list[dict]:
    """Move the company account pages (Phase 2, replaced by Deals) into an "Accounts (archived)" folder of the
    team: still readable, out of the way. Returns what moved (or would)."""
    from app.services import folder as folder_service
    from app.services import hubspot_accounts
    from app.services import teams as T

    out = []
    rows = await db[hubspot_accounts.ACCOUNTS].find({"workspace_id": conn["_id"], "doc_id": {"$ne": None}}).to_list(length=5000)
    if not rows:
        return out
    target = None
    if apply:
        f = await db["folders"].find_one({"workspace_id": conn["_id"], "hubspot_accounts_archive": True})
        if f is None:
            made = await folder_service.create_folder(db, conn["_id"], ARCHIVE_NAME, None)
            await db["folders"].update_one({"_id": ObjectId(made.id)}, {"$set": {
                "hubspot_accounts_archive": True, **T.team_update([conn["team_id"]], [])["$set"]}})
            target = made.id
        else:
            target = str(f["_id"])
    for a in rows:
        raw = await db["documents"].find_one({"_id": a["doc_id"]})
        if raw is None or raw.get("deleted_at") or raw.get("parent_id") is not None:
            continue
        if apply and raw.get("folder_id") != target:
            await folder_service.file_document(db, raw, conn["_id"], target)
        out.append({"company": a.get("name"), "slug": raw.get("slug")})
    if apply:
        old = await db["folders"].find_one({"workspace_id": conn["_id"], "hubspot_accounts": True})
        if old is not None and not await db["documents"].find_one({"folder_id": str(old["_id"]), "deleted_at": None}, {"_id": 1}) \
                and not await db["folders"].find_one({"parent_id": str(old["_id"])}, {"_id": 1}):
            await db["folders"].delete_one({"_id": old["_id"]})
    return out


def fileable_any(c: dict) -> bool:
    return bool(c.get("sure"))


async def backfill(db: AsyncIOMotorDatabase, workspace_id: str, *, apply: bool, cap: int = 100000, on_line=None) -> dict:
    """The one-off for existing data: folders for every open deal, the already-matched calls moved, the account
    pages archived. ``apply=False``: what would happen, nothing written (Markdrop or HubSpot)."""
    from app.services import meetings

    conn = await H.get(db, workspace_id)
    if not usable(conn):
        raise RuntimeError("This workspace isn't connected to HubSpot (with a team).")
    say = on_line or (lambda s: None)
    if not apply:
        got = await sync(db, conn, dry=True, cap=cap)
        rows = got.get("report") or []
        for r in rows:
            say(f"  {'new   ' if r['new'] else 'rename' if r['rename'] else 'keep  '} {r['title']}")
        calls = []
        async for r in db[meetings.COLL].find({"workspace_id": workspace_id, "team_ids": conn["team_id"],
                                               "hubspot.match.portal_id": conn["portal_id"], "hubspot.match.deal_id": {"$ne": None}},
                                              {"title": 1, "date": 1, "hubspot": 1}):
            m = r["hubspot"]["match"]
            calls.append({"title": r.get("title"), "date": r.get("date"), "deal_id": str(m.get("deal_id")),
                          "move": fileable(m), "sure": fileable(m), "filed": bool((r["hubspot"].get("filed") or {}).get("deal_id"))})
        # Where each call would go, decided the way --apply decides it: a deal with a folder (or getting one in
        # this run), else its deal read now — a closed deal with a call gets a folder too (:func:`wanted`).
        dest = {r["deal_id"]: r for r in rows}
        async for d in db[DEALS].find({"workspace_id": workspace_id, "portal_id": conn["portal_id"], "folder_id": {"$ne": None}}):
            dest.setdefault(d["deal_id"], {"deal_id": d["deal_id"], "title": d.get("title"), "new": False, "closed": d.get("closed"),
                                           "closed_label": d.get("closed_label")})
        need = list(dict.fromkeys(c["deal_id"] for c in calls if c["move"] and not c["filed"] and c["deal_id"] not in dest))
        extra: list[dict] = []
        if need:
            stage_by = {s["id"]: s for s in await H.stages(db, {**conn, "_dry": True})}
            for k in range(0, len(need), 100):
                await _apply(db, {**conn, "_dry": True}, await H.batch_read(db, {**conn, "_dry": True}, "deals", need[k:k + 100], DEAL_PROPS),
                             stage_by, dry=extra)
        for r in extra:
            dest[r["deal_id"]] = r
            say(f"  new    {r['title']} ({r.get('closed_label') or 'open'}: it has calls)")
        rows = rows + extra
        for c in calls:
            to = dest.get(c["deal_id"])
            c["move"] = c["move"] and to is not None
            label = f" ({to['closed_label']})" if to and to.get("closed_label") else ""
            say(f"  call {c['date']} {c['title']!r}: " + ("already filed" if c["filed"] else
                                                         f"move to {to['title']}{label}" if c["move"] else
                                                         "stays: its deal isn't in HubSpot any more" if to is None and fileable_any(c)
                                                         else "Pick the deal (several open deals)"))
        acc = await archive_accounts(db, conn, apply=False)
        for a in acc:
            say(f"  archive account page {a['company']!r} (/{a['slug']})")
        return {"apply": False, "deals": len(rows), "new_folders": sum(1 for r in rows if r["new"]),
                "closed_deal_folders": sum(1 for r in extra if r["new"]),
                "calls_to_move": sum(1 for c in calls if c["move"] and not c["filed"]),
                "calls_to_pick": sum(1 for c in calls if not c["move"]), "account_pages": len(acc), "more": got.get("more")}
    pending = {r["_id"]: r for r in await db[meetings.COLL].find(
        {"workspace_id": workspace_id, "team_ids": conn["team_id"], "hubspot.match.portal_id": conn["portal_id"],
         "hubspot.match.deal_id": {"$ne": None}, "hubspot.filed": {"$exists": False}}, {"title": 1, "date": 1, "hubspot.match": 1})
        .to_list(length=5000) if fileable(r["hubspot"]["match"])}
    passes, changed = 0, 0
    while True:
        got = await sync(db, conn, force=True, cap=SYNC_CAP)
        passes += 1
        changed += got.get("changed") or 0
        say(f"  pass {passes}: {got.get('deals')} deals read, {got.get('changed')} brought in")
        conn = await H.get(db, workspace_id)
        if not got.get("more") or got.get("state") != "idle" or passes * SYNC_CAP >= cap:
            break
    await _refresh_closed(db, conn)
    async for r in db[meetings.COLL].find({"_id": {"$in": list(pending)}, "hubspot.filed": {"$exists": False}}, {"segments": 0}):
        await file_call(db, conn, r)
    moved = 0
    async for r in db[meetings.COLL].find({"_id": {"$in": list(pending)}, "hubspot.filed": {"$exists": True}}, {"title": 1, "date": 1}):
        moved += 1                         # filed by the passes above or here (the dry run's "move to")
        say(f"  moved {r.get('date')} {r.get('title')!r}")
    acc = await archive_accounts(db, conn, apply=True)
    total = await db[DEALS].count_documents({"workspace_id": workspace_id, "folder_id": {"$ne": None}})
    return {"apply": True, "passes": passes, "deal_folders": total, "calls_moved": moved, "account_pages_archived": len(acc)}
