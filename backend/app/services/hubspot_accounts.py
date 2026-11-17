"""HubSpot Phase 2: an account page per HubSpot company (brief .work/briefs/hubspot-v2.md, item 8).

The first time a HubSpot-team call is matched to a company (hubspot.meeting_ready, after its summary),
Markdrop makes a page for that company: an ordinary Markdrop Page in the workspace's **Accounts** folder,
in the HubSpot team (``team_ids``: a private team's account pages are its members' only), titled with the
company's name. Its **auto-updated section** sits between two marker lines (:data:`START` heading …
:data:`END`): the company's deals with stage, amount and close date; the timeline of the team's calls
with that company (link + one line each); decisions; objections and risks (from the suggested-updates
call, services/hubspot_deals.py); open questions; open tasks (the calls' action items, marked when
they're HubSpot tasks already). Each new call for the company rewrites only that section; whatever
people write above or below it stays. A section someone deleted comes back at the end of the page.

Only the team's calls that the whole team can read go in (never a meeting restricted to its attendees),
and only this workspace's HubSpot account. Written through the website's save path, quietly (nobody is
notified about it), as the person who imported the call (else whoever connected HubSpot).

Collections
    hubspot_accounts   _id "<workspace>:<portal>:<company id>": workspace_id, portal_id, company_id, name,
                       team_id, doc_id, slug, created_at, updated_at, meetings (how many calls it lists)
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.services import hubspot as H
from app.services.hubspot_api import HubSpotError

log = logging.getLogger("markdrop.hubspot")

ACCOUNTS = "hubspot_accounts"
FOLDER_NAME = "Accounts"
START = "## From HubSpot and the team's calls"
END = "*Markdrop keeps the section above up to date from HubSpot and the team's calls. Edits outside it stay.*"
MAX_CALLS = 20
MAX_LINES = 12


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[ACCOUNTS].create_index([("workspace_id", 1), ("company_id", 1)])


def _key(conn: dict, company_id: str) -> str:
    return f"{conn['_id']}:{conn['portal_id']}:{company_id}"


async def company_of(db, conn: dict, m: dict) -> str | None:
    """The call's company: the match's first company, else the deal's."""
    if m.get("company_ids"):
        return str(m["company_ids"][0])
    if m.get("deal_id"):
        got = (await H.assoc(db, conn, "deals", [m["deal_id"]], "companies")).get(str(m["deal_id"]), [])
        return got[0] if got else None
    return None


async def link_for(db: AsyncIOMotorDatabase, conn: dict, m: dict | None) -> dict | None:
    """The panel's link to the account page of the matched company (when it exists)."""
    ids = [str(c) for c in (m or {}).get("company_ids") or []][:3]
    if not ids:
        return None
    row = await db[ACCOUNTS].find_one({"_id": {"$in": [_key(conn, c) for c in ids]}, "doc_id": {"$ne": None}})
    if row is None:
        return None
    raw = await db["documents"].find_one({"_id": row["doc_id"]}, {"slug": 1, "deleted_at": 1})
    if raw is None or raw.get("deleted_at"):
        return None
    return {"name": row.get("name"), "slug": raw["slug"], "href": f"/{raw['slug']}", "updated_at": H.iso(row.get("updated_at"))}


async def refresh_after(db: AsyncIOMotorDatabase, conn: dict, meeting_id: str, m: dict) -> dict | None:
    """hubspot.meeting_ready: the company's account page, made or brought up to date."""
    from app.services import meetings

    if not H.switch(conn, "accounts"):
        return None
    row = await meetings.get_row(db, meeting_id)
    if row is None or row.get("restricted") or m.get("confidence") not in ("high", "medium"):
        return None
    company = await company_of(db, conn, m)
    if not company:
        return None
    if not m.get("company_ids"):
        await db[meetings.COLL].update_one({"_id": row["_id"], "hubspot.match.portal_id": conn["portal_id"]},
                                           {"$set": {"hubspot.match.company_ids": [company]}})
    uid = row.get("imported_by") or row.get("created_by") or conn.get("connected_by")
    return await refresh(db, conn, company, user_id=str(uid) if uid else None)


async def _user(db, user_id: str | None):
    from app.services.user import get_user_by_id

    return await get_user_by_id(db, user_id) if user_id else None


async def _folder(db, conn: dict, user_id: str) -> str:
    """The workspace's Accounts folder (made once, in the HubSpot team)."""
    from app.services import folder as folder_service
    from app.services import teams as T

    ws = conn["_id"]
    f = await db["folders"].find_one({"workspace_id": ws, "hubspot_accounts": True}, sort=[("created_at", 1)])
    if f is None:
        made = await folder_service.create_folder(db, ws, FOLDER_NAME, None)
        await db["folders"].update_one({"_id": ObjectId(made.id)}, {"$set": {"hubspot_accounts": True,
                                                                             **T.team_update([conn["team_id"]], [])["$set"]}})
        f = await db["folders"].find_one({"workspace_id": ws, "hubspot_accounts": True}, sort=[("created_at", 1), ("_id", 1)])
        if f is not None and str(f["_id"]) != made.id:
            await db["folders"].delete_one({"_id": ObjectId(made.id)})
    return str(f["_id"])


def _e(text: Any) -> str:
    from app.services import meetings

    return meetings.md_inline(H._plain(text))


def _first(text: Any, n: int = 200) -> str:
    t = H._plain(text)
    cut = t.split(". ")[0]
    cut = cut if cut.endswith(".") else cut + ("." if len(cut) < len(t) else "")
    return cut[:n]


def section_markdown(company: str, deals: list[dict], calls: list[dict], when: datetime) -> str:
    """The auto-updated section (deals, calls, decisions, objections and risks, open questions, open tasks)."""
    from app.services import meetings

    out = [START, ""]
    out.append("### Deals")
    if deals:
        for d in deals:
            bits = [d.get("stage") or "No stage"]
            if d.get("amount") is not None:
                bits.append(f"{d['amount']:,.0f} {d.get('currency') or ''}".strip())
            if d.get("close_date"):
                bits.append(f"closes {meetings.fmt_date(d['close_date'])}")
            if d.get("owner"):
                bits.append(f"owner {_e(d['owner'])}")
            name = _e(d["name"])
            label = f"[{name}]({d['url']})" if d.get("url") else name
            out.append(f"- {label} · " + " · ".join(bits) + (" · closed" if d.get("closed") else ""))
    else:
        out.append(f"- No deal for {_e(company)} in HubSpot yet.")
    out += ["", "### Calls"]
    for c in calls:
        line = f"- {meetings.fmt_date(c.get('date'))} · " + (f"[{_e(c.get('title') or 'Meeting')}](/{c['slug']})" if c.get("slug")
                                                             else _e(c.get("title") or "Meeting"))
        gist = _first(((c.get("generated") or {}).get("summary")) or ((c.get("notes") or {}).get("summary")) or "")
        out.append(line + (f" — {_e(gist)}" if gist else ""))
    if not calls:
        out.append("- No calls yet.")

    def gather(key: str) -> list[tuple[str, str]]:
        got = []
        for c in calls:
            for it in (c.get("generated") or {}).get(key) or []:
                t = it.get("text") if isinstance(it, dict) else it
                if H._plain(t):
                    got.append((H._plain(t), c.get("date") or ""))
        return got[:MAX_LINES]

    def bullets(head: str, rows: list[tuple[str, str]]) -> None:
        if rows:
            out.extend(["", f"### {head}", *(f"- {_e(t)}" + (f" ({meetings.fmt_date(d)})" if d else "") for t, d in rows)])

    bullets("Decisions", gather("decisions"))
    risks: list[tuple[str, str]] = []
    for c in calls:
        acct = (((c.get("hubspot") or {}).get("suggestions") or {}).get("account")) or {}
        for key, tag in (("objections", "Objection"), ("risks", "Risk")):
            for it in acct.get(key) or []:
                if H._plain(it.get("text")):
                    risks.append((f"{tag}: {H._plain(it.get('text'))}", c.get("date") or ""))
    bullets("Objections and risks", risks[:MAX_LINES])
    bullets("Open questions", gather("open_questions"))
    tasks: list[tuple[str, str]] = []
    for c in calls:
        done = (c.get("hubspot") or {}).get("tasks") or {}
        for it in H.items_of(c):
            t = done.get(H.task_key(it["text"]))
            extra = " · ".join(x for x in (it.get("owner"), f"due {it['due']}" if it.get("due") else None,
                                           "in HubSpot" if isinstance(t, dict) and t.get("state") == "created" else None) if x)
            tasks.append((it["text"] + (f" ({extra})" if extra else ""), c.get("date") or ""))
    bullets("Open tasks", tasks[:MAX_LINES])
    out += ["", f"Updated {meetings.fmt_date(when.date().isoformat())}.", "", END]
    return "\n".join(out)


def merge(content: str, section: str) -> str:
    """The page with its auto-updated section replaced (or added at the end); the rest untouched."""
    cur = content or ""
    lines = cur.split("\n")
    try:
        i = next(k for k, ln in enumerate(lines) if ln.strip() == START)
    except StopIteration:
        return cur.rstrip("\n") + ("\n\n" if cur.strip() else "") + section + "\n"
    j = next((k for k in range(i + 1, len(lines)) if lines[k].strip() == END), None)
    if j is None:
        # The end marker was deleted: up to the next heading of the same or a higher level.
        j = next((k - 1 for k in range(i + 1, len(lines)) if lines[k].startswith("## ") or lines[k].startswith("# ")), len(lines) - 1)
    return "\n".join([*lines[:i], *section.split("\n"), *lines[j + 1:]])


async def refresh(db: AsyncIOMotorDatabase, conn: dict, company_id: str, *, user_id: str | None) -> dict | None:
    """Make or rewrite the company's account page. Returns its row (None: nobody to write it as)."""
    from app.services import access, meetings, pages
    from app.services import teams as T

    user = await _user(db, user_id) or await _user(db, conn.get("connected_by"))
    if user is None or not conn.get("team_id"):
        return None
    cos = await H.batch_read(db, conn, "companies", [company_id], ["name", "domain"])
    p = (cos[0].get("properties") or {}) if cos else {}
    name = H._plain(p.get("name") or p.get("domain")) or f"Company {company_id}"
    deal_ids = (await H.assoc(db, conn, "companies", [company_id], "deals")).get(str(company_id), [])
    stage_by = {s["id"]: s for s in await H.stages(db, conn)}
    owner_by = {o["id"]: o for o in await H.owners(db, conn)}
    deals = [H._deal_view(conn, d, stage_by, owner_by) for d in await H.batch_read(db, conn, "deals", deal_ids[:20], H.DEAL_PROPS)]
    deals.sort(key=lambda d: (d["closed"], d.get("close_date") or "9999"))
    calls = await db[meetings.COLL].find(
        {"workspace_id": conn["_id"], "team_ids": conn["team_id"], "restricted": {"$ne": True},
         "hubspot.match.portal_id": conn["portal_id"], "hubspot.match.company_ids": str(company_id)},
        {"segments": 0}).sort([("date", -1), ("created_at", -1)]).limit(MAX_CALLS).to_list(length=MAX_CALLS)
    now = now_utc()
    section = section_markdown(name, deals, calls, now)
    key = _key(conn, company_id)
    acc = await db[ACCOUNTS].find_one({"_id": key})
    actor, ctx = access.Actor.of(user), access.Ctx(db)
    raw = await db["documents"].find_one({"_id": acc["doc_id"]}) if acc and acc.get("doc_id") else None
    if raw is not None and raw.get("deleted_at"):
        raw = None
    if raw is None:
        folder = await _folder(db, conn, user.id)
        try:
            raw, _secret, _err = await pages.create_page(db, user, actor, ctx, title=name[:150], workspace=conn["_id"],
                                                         folder=folder, content="\n")
        except HTTPException as exc:
            log.info("hubspot: couldn't make the account page of %s: %s", company_id, exc.detail)
            return None
        raw = await db["documents"].find_one({"_id": raw["_id"]}) or raw
        if (raw.get("access_level") or "link") != "workspace":
            raw = await access.set_level(db, raw, "workspace", actor, ctx)
        await T.apply_to_doc(db, raw, [conn["team_id"]], [])
        await db["documents"].update_one({"_id": raw["_id"]}, {"$set": {"hubspot_company": key}})
        raw = await db["documents"].find_one({"_id": raw["_id"]})
        intro = (f"The account page of **{_e(name)}**. Write your own notes above or below the section Markdrop keeps "
                 "up to date.\n\n")
        content = intro + section + "\n"
    else:
        content = merge(raw.get("content") or "", section)
    if content != (raw.get("content") or ""):
        try:
            await pages.check_page_lock(raw, actor, ctx, content)
            await meetings._save(db, raw, content, actor, ctx)
        except HTTPException as exc:
            log.info("hubspot: couldn't update the account page %s (%s)", raw.get("slug"), exc.detail)
    await db[ACCOUNTS].update_one({"_id": key}, {"$set": {
        "workspace_id": conn["_id"], "portal_id": conn["portal_id"], "company_id": str(company_id), "name": name,
        "team_id": conn["team_id"], "doc_id": raw["_id"], "slug": raw.get("slug"), "updated_at": now, "meetings": len(calls)},
        "$setOnInsert": {"created_at": now}}, upsert=True)
    return await db[ACCOUNTS].find_one({"_id": key})


async def account(db: AsyncIOMotorDatabase, user, actor, ctx, meeting_id: str, *, refresh_now: bool = False) -> dict:
    """The meeting's account page (MCP, the panel's Update button): made or refreshed on request."""
    row, conn = await H._usable(db, user, actor, ctx, meeting_id)
    hs = row.get("hubspot") or {}
    m = hs.get("match") if (hs.get("match") or {}).get("portal_id") == conn["portal_id"] else None
    try:
        if m is None:
            m = await H.match(db, conn, row)
        link = await link_for(db, conn, m)
        if refresh_now or link is None:
            company = await company_of(db, conn, m)
            if not company:
                raise HTTPException(status_code=409, detail="This call isn't matched to a HubSpot company yet. Pick the deal first.")
            if not m.get("company_ids"):
                from app.services import meetings

                await db[meetings.COLL].update_one({"_id": row["_id"]}, {"$set": {"hubspot.match.company_ids": [company]}})
                m = {**m, "company_ids": [company]}
            await refresh(db, conn, company, user_id=user.id)
            link = await link_for(db, conn, m)
    except HubSpotError as exc:
        raise H._http_error(exc)
    if link is None:
        raise HTTPException(status_code=409, detail="Markdrop couldn't make the account page.")
    raw = await db["documents"].find_one({"slug": link["slug"]})
    from app.services import access

    if raw is None or not (await access.can(actor, raw, "read", ctx)).allowed:
        raise HTTPException(status_code=404, detail="Account page not found")
    return {**link, "content": raw.get("content") or ""}
