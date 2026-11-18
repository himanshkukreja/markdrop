"""MCP tools for running a workspace and auditing access (routers/workspaces.py, routers/access.py).

READ: ``get_workspace`` (settings, counts, domains and every integration's state in one call, like the
settings page), ``get_document_access`` (who can open an item and why: the Share dialog's list).
WRITE: ``update_workspace`` (admins: name and settings, only what is sent, like PUT /workspaces/{id}),
``invite_to_workspace`` (admins: email invitations, 20 an hour like the website),
``update_workspace_member`` (admins: change a role or remove someone, or withdraw a pending invitation;
anyone may leave: person "me").

The rules are the website's: the same services and the same checks (services/workspace.py,
services/invitation.py, services/access.py), so an AI app can never do more than the person could there.
"""

from __future__ import annotations

import asyncio
from typing import Any

from bson import ObjectId
from fastapi import HTTPException

from app.mcp.auth import READ, WRITE
from app.mcp.tools import (
    _DOC_REF,
    _NULLABLE_STR,
    _WORKSPACE_ARG,
    Context,
    Tool,
    ToolError,
    _ann,
    _out,
    actor_of,
    http_message,
    load_for,
    resolve_workspace,
    url_pair,
)
from app.services import access as access_service

MAX_INVITES = 20
_STR = {"type": "string"}
_O = {"type": "object"}
_SETTINGS = ("viewer_chrome", "require_auth_to_view", "members_can_share_folders", "default_access", "ai_enabled",
             "auto_covers", "team_memory", "timezone", "comments_enabled", "allow_resharing")


def _settings_of(ws) -> dict:
    s = ws.settings
    return {k: getattr(s, k, None) for k in _SETTINGS}


async def _integrations(ctx: Context, ws_id: str) -> dict:
    """Each integration's state for this workspace, from the same status services the settings page and the
    *_status tools read (database only). One failing never fails the rest."""
    from app.services import hubspot, jira, meetings_inbox, slack, zoom

    async def one(name: str, coro) -> tuple[str, dict]:
        try:
            return name, await asyncio.wait_for(coro, timeout=5)
        except HTTPException as exc:
            return name, {"error": http_message(exc)}
        except Exception:  # pragma: no cover - an integration's status never fails the call
            return name, {"error": "Not available right now."}

    async def sl():
        st = await slack.status(ctx.db, ctx.user, ws_id)
        inst = st.get("install")
        return {"available": bool(st.get("configured")), "connected": inst is not None,
                "needs_attention": "reconnect" if (inst or {}).get("needs_reconnect") else None,
                "detail": "slack_status"}

    async def ji():
        st = await jira.status(ctx.db, ctx.user, ws_id)
        site = st.get("site")
        return {"available": bool(st.get("configured")), "connected": site is not None,
                "site": (site or {}).get("url"),
                "needs_attention": ("reconnect" if site is not None and not site.get("connector_ok") else None),
                "detail": "jira_status"}

    async def zo():
        st = await zoom.status(ctx.db, ctx.user, ws_id)
        c = st.get("connection") or {}
        return {"connected": bool(st.get("connected")), "team": (st.get("team") or {}).get("name"),
                "needs_attention": c.get("broken") or (("missing scopes: " + ", ".join(m["scope"] for m in c["missing_scopes"]))
                                                       if c.get("missing_scopes") else None),
                "detail": "zoom_status (held meetings: zoom_review)"}

    async def hs():
        st = await hubspot.status(ctx.db, ctx.user, ws_id)
        c = st.get("connection") or {}
        return {"connected": bool(st.get("connected")), "team": (st.get("team") or {}).get("name"),
                "needs_attention": c.get("broken") or (("missing scopes: " + ", ".join(m["scope"] for m in c["missing_scopes"]))
                                                       if c.get("missing_scopes") else None),
                "detail": "hubspot_status"}

    async def gm():
        conns = await meetings_inbox.for_workspace(ctx.db, ws_id)
        return {"connected": bool(conns), "connections": len(conns),
                "needs_attention": next((c.get("last_error") for c in conns if c.get("last_error")), None),
                "detail": "meetings_connection"}

    pairs = await asyncio.gather(one("slack", sl()), one("jira", ji()), one("zoom", zo()), one("hubspot", hs()),
                                 one("google_meet", gm()))
    return dict(pairs)


async def get_workspace(ctx: Context, args: dict) -> tuple[str, dict]:
    from app.models.workspace import role_allows
    from app.services import domain as domain_service
    from app.services import urls

    ws_id, ws, role = await resolve_workspace(ctx, args["workspace"])
    rows = await ctx.db["domains"].find({"workspace_id": ws_id}).to_list(length=200)
    primary = domain_service.primary_of(rows)
    domains = [{"host": r["host"], "status": urls.domain_status(r), "primary": r["host"] == primary,
                "live": urls.is_live(r)} for r in sorted(rows, key=lambda r: r.get("created_at") or 0)]
    admin = role_allows(role, "admin")
    counts = {"members": await ctx.db["memberships"].count_documents({"workspace_id": ws_id}),
              "pending_invitations": (await ctx.db["invitations"].count_documents(
                  {"workspace_id": ws_id, "status": "pending"})) if admin else None,
              "teams": await ctx.db["teams"].count_documents({"workspace_id": ws_id}),
              "folders": await ctx.db["folders"].count_documents({"workspace_id": ws_id})}
    integrations = await _integrations(ctx, ws_id)
    out = {"workspace_id": ws_id, "name": ws.name, "your_role": role, "is_owner": ws.owner_id == ctx.user.id,
           "settings": _settings_of(ws), "counts": counts, "domains": domains, "integrations": integrations}
    s = out["settings"]
    lines = [f"{ws.name} (id {ws_id}); you are {role}.",
             f"New items start as: {s['default_access']}; sign-in required to view: {'yes' if s['require_auth_to_view'] else 'no'}; "
             f"AI: {'on' if s['ai_enabled'] else 'off'}; comments: {'on' if s['comments_enabled'] else 'off'}; "
             f"team memory: {'on' if s['team_memory'] else 'off'}.",
             f"{counts['members']} members" + (f", {counts['pending_invitations']} pending invitations" if admin else "")
             + f", {counts['teams']} teams, {counts['folders']} folders.",
             "Domains: " + (", ".join(f"{d['host']} ({d['status']})" for d in domains) or "none") + "."]
    for name, st in integrations.items():
        if st.get("error"):
            lines.append(f"{name}: {st['error']}")
        else:
            lines.append(f"{name}: {'connected' if st.get('connected') else 'not connected'}"
                         + (f" — needs attention ({st['needs_attention']})" if st.get("needs_attention") else ""))
    return "\n".join(lines), out


async def update_workspace(ctx: Context, args: dict) -> tuple[str, dict]:
    """PUT /workspaces/{id}: admins; only the settings sent change (C3); team memory on/off and the
    require-sign-in sync run exactly as on the website."""
    from app.schemas.workspace import SettingsPayload
    from app.services import lifecycle, revalidate
    from app.services import workspace as ws_service

    ws_id, _ws, _role = await resolve_workspace(ctx, args["workspace"])
    # timezone "" (or null) clears it, back to UTC.
    sent = {k: args[k] for k in _SETTINGS if k in args and (args[k] is not None or k == "timezone")}
    name = (args.get("name") or "").strip() or None
    if not sent and name is None:
        raise ToolError("Nothing to change: give name or at least one setting.")
    try:
        payload = SettingsPayload(**sent).model_dump(include=set(sent)) if sent else None
    except Exception as exc:
        raise ToolError(f"Invalid setting: {str(exc).splitlines()[-1] if str(exc) else exc}")
    try:
        await ws_service.require_role(ctx.db, ws_id, ctx.user.id, "admin")
        await ws_service.assert_open(ctx.db, ws_id)
        if payload and "team_memory" in payload:
            from app.services import workspace_memory

            await workspace_memory.switched(ctx.db, ws_id, bool(payload["team_memory"]))
        ws = await ws_service.update_workspace(ctx.db, ws_id, name=name, branding=None, settings=payload)
    except HTTPException as exc:
        if exc.status_code == 403:
            raise ToolError("Only the workspace's admins and owner change its settings.")
        raise ToolError(http_message(exc))
    toggled = await lifecycle.sync_require_auth(ctx.db, ws_id, wait=1.0)
    if toggled is not None:
        ws = await ws_service.get_workspace(ctx.db, ws_id) or ws
    rows = await ctx.db["domains"].find({"workspace_id": ws_id}, {"host": 1}).to_list(length=200)
    await revalidate.enqueue(ctx.db, tags=[f"host:{r['host']}" for r in rows] + [f"wsl:{ws_id}"])
    changed = ([f"name → {name}"] if name else []) + [f"{k} → {v}" for k, v in (payload or {}).items()]
    out = {"workspace_id": ws_id, "name": ws.name, "settings": _settings_of(ws), "changed": changed,
           "access_sync": (toggled or {}).get("progress")}
    return f"Updated {ws.name}: " + "; ".join(changed) + ".", out


def _invite_limited(user_id: str) -> bool:
    """20 an hour per person, like POST /workspaces/{id}/invitations (fails open, like the MCP limiter)."""
    try:
        from limits import parse

        from app.limiter import limiter

        return not limiter.limiter.hit(parse("20/hour"), "mcp", "ws_invite", user_id)
    except Exception:  # pragma: no cover - depends on the limiter backend
        return False


async def invite_to_workspace(ctx: Context, args: dict) -> tuple[str, dict]:
    from app.services import invitation as invite_service
    from app.services import mailer
    from app.services import workspace as ws_service

    ws_id, ws, _role = await resolve_workspace(ctx, args["workspace"])
    emails = list(dict.fromkeys(e.strip().lower() for e in args.get("emails") or [] if isinstance(e, str) and e.strip()))
    if not emails:
        raise ToolError("Give at least one email address.")
    if len(emails) > MAX_INVITES:
        raise ToolError(f"Invite at most {MAX_INVITES} people at a time.")
    role = args.get("role") or "member"
    try:
        await ws_service.require_role(ctx.db, ws_id, ctx.user.id, "admin")
    except HTTPException:
        raise ToolError("Only the workspace's admins and owner invite people.")
    if role == "admin" and ws.owner_id != ctx.user.id:
        raise ToolError("Only the workspace owner can invite admins.")
    if not mailer.is_configured():
        raise ToolError("Email isn't configured, so invitations can't be sent.")
    people = []
    for email in emails:
        if _invite_limited(ctx.user.id):
            people.append({"email": email, "invited": False, "invitation_id": None,
                           "error": "Too many invitations this hour: try again later."})
            continue
        try:
            invite, token = await invite_service.create_invitation(ctx.db, ws_id, email, role, ctx.user,
                                                                   by_owner=ws.owner_id == ctx.user.id)
        except HTTPException as exc:
            people.append({"email": email, "invited": False, "invitation_id": None, "error": http_message(exc)})
            continue
        try:
            await mailer.send_invite_email(to_email=invite.email, workspace_name=ws.name,
                                           inviter_name=ctx.user.name or ctx.user.email, role=invite.role, token=token)
        except Exception:
            await invite_service.revoke_invitation(ctx.db, ws_id, invite.id)
            people.append({"email": email, "invited": False, "invitation_id": None,
                           "error": "The invitation email couldn't be sent. Check the address."})
            continue
        people.append({"email": invite.email, "invited": True, "invitation_id": invite.id, "error": None})
    lines = [f"- {p['email']}: " + ("invited (an email with a link to join went out)" if p["invited"] else f"not invited ({p['error']})")
             for p in people]
    return f"Invitations to {ws.name} as {role}:\n" + "\n".join(lines), {"workspace_id": ws_id, "role": role, "people": people}


async def _member_rows(ctx: Context, ws_id: str) -> list[dict]:
    from app.services import workspace as ws_service

    rows = await ws_service.list_members(ctx.db, ws_id)
    oids = [ObjectId(m.user_id) for m in rows if ObjectId.is_valid(m.user_id)]
    users = {str(u["_id"]): u for u in await ctx.db["users"].find(
        {"_id": {"$in": oids}}, {"name": 1, "email": 1}).to_list(length=len(oids) or 1)}
    return [{"id": m.user_id, "role": m.role, "name": (users.get(m.user_id) or {}).get("name") or "",
             "email": ((users.get(m.user_id) or {}).get("email") or m.email or "").lower()} for m in rows]


async def update_workspace_member(ctx: Context, args: dict) -> tuple[str, dict]:
    from app.services import invitation as invite_service
    from app.services import workspace as ws_service

    ws_id, ws, _role = await resolve_workspace(ctx, args["workspace"])
    person = (args.get("person") or "").strip()
    remove = args.get("remove") is True
    role = args.get("role")
    if remove == bool(role):
        raise ToolError("Give either role (to change it) or remove: true.")
    members = await _member_rows(ctx, ws_id)
    if person.lower() in ("me", "myself", "i"):
        hit = [m for m in members if m["id"] == ctx.user.id]
    else:
        hit = [m for m in members if m["id"] == person or m["email"] == person.lower()] or \
              [m for m in members if " ".join(m["name"].casefold().split()) == " ".join(person.casefold().split())]
    if len(hit) > 1:
        raise ToolError("More than one member is called that: " + ", ".join(f"{m['name']} (id {m['id']})" for m in hit)
                        + ". Pass the id or email.")
    if not hit:
        if remove and "@" in person:
            # A pending invitation: withdraw it (admins; an admin invitation only by the owner).
            inv = await ctx.db["invitations"].find_one({"workspace_id": ws_id, "email": person.lower(), "status": "pending"},
                                                       {"_id": 1})
            if inv is not None:
                try:
                    await ws_service.require_role(ctx.db, ws_id, ctx.user.id, "admin")
                    await invite_service.revoke_invitation(ctx.db, ws_id, str(inv["_id"]),
                                                           by_owner=ws.owner_id == ctx.user.id)
                except HTTPException as exc:
                    if exc.status_code == 404:
                        raise ToolError("Only the workspace's admins and owner withdraw invitations.")
                    raise ToolError(http_message(exc))
                return (f"Withdrew the invitation to {person.lower()}.",
                        {"workspace_id": ws_id, "person": {"email": person.lower()}, "removed": True, "role": None,
                         "invitation_withdrawn": True})
        raise ToolError(f"No member of {ws.name} matches “{person}”. list_workspace_members shows who is in it.")
    m = hit[0]
    self_ = m["id"] == ctx.user.id
    try:
        if remove:
            await ws_service.require_role(ctx.db, ws_id, ctx.user.id, "viewer" if self_ else "admin")
            await ws_service.remove_member(ctx.db, ws_id, m["id"], actor_id=ctx.user.id)
        else:
            await ws_service.require_role(ctx.db, ws_id, ctx.user.id, "admin")
            await ws_service.set_member_role(ctx.db, ws_id, m["id"], role, actor_id=ctx.user.id)
    except HTTPException as exc:
        if exc.status_code == 403 and "owner" not in (http_message(exc) or "").lower():
            raise ToolError("Only the workspace's admins and owner change members.")
        if exc.status_code == 404 and not self_:
            raise ToolError("Only the workspace's admins and owner change members.")
        raise ToolError(http_message(exc))
    who = m["name"] or m["email"] or m["id"]
    out = {"workspace_id": ws_id, "person": {"id": m["id"], "name": m["name"]}, "removed": remove,
           "role": None if remove else role, "invitation_withdrawn": False}
    if remove:
        return (("You left " if self_ else f"Removed {who} from ") + f"{ws.name}. Their own documents stay theirs; "
                "access they had through the workspace ends."), out
    return f"{who} is now {role} in {ws.name}.", out


async def get_document_access(ctx: Context, args: dict) -> tuple[str, dict]:
    """GET /documents/{slug}/access for the MCP user: the same holder-only rule (a link reader with no role
    learns nothing), the grantee list only for those who may see it (owner, editors)."""
    from app.services import folder_access

    raw = await load_for(ctx, args["document"], "read", "open")
    actor, actx = actor_of(ctx), access_service.Ctx(ctx.db, surface="mcp")
    f = await access_service.facts(actor, raw, actx)
    if f.role is None:
        raise ToolError("The user can open this by its link but holds no role on it, so who has access isn't "
                        "shown (only to its owner and the people it's shared with).")
    sees = (await access_service.can(actor, raw, "see_grants", actx)).allowed
    grants = await access_service.list_grants(ctx.db, str(raw["_id"])) if sees else []
    owner = None
    if raw.get("owner_id") and ObjectId.is_valid(raw["owner_id"]):
        u = await ctx.db["users"].find_one({"_id": ObjectId(raw["owner_id"])}, {"name": 1, "email": 1})
        if u:
            owner = {"name": u.get("name"), "email": u.get("email") if sees else None}
    teams = []
    tids = [ObjectId(t) for t in raw.get("team_ids") or [] if ObjectId.is_valid(str(t))]
    if tids and f.ws_id:
        view = await actx.team_view(f.ws_id, ctx.user.id)
        for t in await ctx.db["teams"].find({"_id": {"$in": tids}}, {"name": 1, "visibility": 1}).to_list(length=20):
            if str(t["_id"]) in view.readable_teams or t.get("visibility") != "private":
                teams.append({"id": str(t["_id"]), "name": t.get("name"), "visibility": t.get("visibility") or "open"})
    people = [{"email": g.email, "role": g.role, "active": getattr(g, "active", True),
               "effective_role": getattr(g, "effective_role", None) if getattr(g, "active", True) else None,
               "granted_by": g.granted_by_email} for g in grants]
    level = raw.get("access_level") or "link"
    out = {**await url_pair(ctx, raw), "slug": raw["slug"], "level": level,
           "password": bool(raw.get("read_password_hash")),
           "expires_at": raw["expires_at"].isoformat() if raw.get("expires_at") else None,
           "allow_resharing": access_service.resharing_allowed(raw, f.ws if f.ws_id else None),
           "workspace": ({"id": f.ws_id, "name": f.ws.name} if f.ws_id and f.ws is not None else None),
           "owner": owner, "your_role": f.role, "can_share": (await access_service.can(actor, raw, "share", actx)).allowed,
           "can_change_access": f.is_owner, "people": people if sees else None, "teams": teams,
           "folder_access": await folder_access.item_folder_access(actor, raw, actx),
           "why": await folder_access.explain(actor, raw, actx)}
    who = {"link": "anyone with the link", "private": "only its owner and the people below",
           "workspace": "members of its workspace"}.get(level, level)
    lines = [f"{out['url']}: open to {who}" + (" (with a password)" if out["password"] else "") + "."]
    if owner:
        lines.append(f"Owner: {owner['name'] or owner.get('email') or 'someone'}. You: {f.role}.")
    if out["why"] and out["why"].get("text"):
        lines.append(f"Why you can open it: {out['why']['text']}")
    if teams:
        lines.append("Teams: " + ", ".join(t["name"] for t in teams) + ".")
    fa = out["folder_access"]
    if fa and fa.get("summary"):
        lines.append(f"Folder {fa.get('path') or ''}: {fa['summary']}")
    if sees:
        lines.append("People: " + (", ".join(f"{p['email']} ({p['role']}" + ("" if p["active"] else ", inactive") + ")"
                                            for p in people) or "nobody added by email") + ".")
    else:
        lines.append("Only its owner and editors see the list of people.")
    return "\n".join(lines), out


_PERSON = {"type": "string", "minLength": 1, "maxLength": 254,
           "description": "A member's id, email or full name, or \"me\" (to leave). An email of a pending invitation "
                          "with remove: true withdraws the invitation."}

WORKSPACE_ADMIN_TOOLS: list[Tool] = [
    Tool(name="get_workspace", title="A workspace's settings and integrations",
         description=("One workspace at a glance, as its settings page shows it: the user's role, its settings "
                      "(default access for new items, sign-in required, AI, comments, team memory, resharing, "
                      "timezone…), counts (members, pending invitations for admins, teams, folders), its domains "
                      "with their state, and every integration's state in one call — Slack, Jira, Zoom, HubSpot and "
                      "Google Meet auto import: connected or not, and what needs attention (each names the tool "
                      "with the details). Workspace members."),
         scope=READ, input_schema={"type": "object", "properties": {"workspace": _WORKSPACE_ARG}, "required": ["workspace"]},
         output_schema=_out({"workspace_id": _STR, "name": _STR, "your_role": _STR, "is_owner": {"type": "boolean"},
                             "settings": _O, "counts": _O, "domains": {"type": "array", "items": _O},
                             "integrations": _O}),
         annotations=_ann(True, False, True), handler=get_workspace),
    Tool(name="update_workspace", title="Change a workspace's settings", writes=True, scope=WRITE,
         description=("Change a workspace's name or settings (its admins and owner), like Settings › General: only "
                      "what you send changes. default_access (new items start as link, workspace or private), "
                      "require_auth_to_view (every filed item needs sign-in: changes who can open everything, so "
                      "confirm with the user first), viewer_chrome, members_can_share_folders, ai_enabled, "
                      "auto_covers, team_memory (on starts gathering who's doing what; off deletes what it "
                      "gathered: confirm first), timezone (IANA, e.g. Asia/Kolkata), comments_enabled, "
                      "allow_resharing."),
         input_schema={"type": "object", "properties": {
             "workspace": _WORKSPACE_ARG, "name": {"type": "string", "minLength": 1, "maxLength": 80},
             "default_access": {"type": "string", "enum": ["link", "workspace", "private"]},
             "require_auth_to_view": {"type": "boolean"},
             "viewer_chrome": {"type": "string", "enum": ["full", "minimal", "none"]},
             "members_can_share_folders": {"type": "boolean"}, "ai_enabled": {"type": "boolean"},
             "auto_covers": {"type": "boolean"}, "team_memory": {"type": "boolean"},
             "timezone": {"type": "string", "maxLength": 64}, "comments_enabled": {"type": "boolean"},
             "allow_resharing": {"type": "boolean"}}, "required": ["workspace"]},
         output_schema=_out({"workspace_id": _STR, "name": _STR, "settings": _O,
                             "changed": {"type": "array", "items": _STR}, "access_sync": {"type": ["object", "null"]}}),
         annotations=_ann(False, False, True), handler=update_workspace),
    Tool(name="invite_to_workspace", title="Invite people to a workspace", writes=True, scope=WRITE,
         description=("Invite people to a workspace by email (its admins and owner; only the owner invites admins), "
                      "like Settings › Members › Invite: each gets an email with a link to join as role (member, "
                      "the default; viewer; or admin). Someone already in it is reported, not invited again. At most "
                      "20 addresses per call and 20 invitations an hour. Pending ones are listed by "
                      "list_workspace_members with include_invitations; withdraw one with update_workspace_member "
                      "(its email, remove: true)."),
         input_schema={"type": "object", "properties": {
             "workspace": _WORKSPACE_ARG,
             "emails": {"type": "array", "items": {"type": "string", "format": "email", "maxLength": 254},
                        "minItems": 1, "maxItems": MAX_INVITES},
             "role": {"type": "string", "enum": ["member", "viewer", "admin"], "description": "Default member."}},
             "required": ["workspace", "emails"]},
         output_schema=_out({"workspace_id": _STR, "role": _STR, "people": {"type": "array", "items": _out({
             "email": _STR, "invited": {"type": "boolean"}, "invitation_id": _NULLABLE_STR, "error": _NULLABLE_STR})}}),
         annotations=_ann(False, False, False), handler=invite_to_workspace),
    Tool(name="update_workspace_member", title="Change or remove a workspace member", writes=True, scope=WRITE,
         description=("Change a member's role (role: admin, member or viewer) or take them out of the workspace "
                      "(remove: true), like Settings › Members (its admins and owner; only the owner changes or "
                      "removes an admin; the owner can't be changed). person \"me\" with remove: true leaves the "
                      "workspace. The email of a pending invitation with remove: true withdraws it. Removing ends "
                      "the access they had through the workspace and its teams; confirm with the user first."),
         input_schema={"type": "object", "properties": {
             "workspace": _WORKSPACE_ARG, "person": _PERSON,
             "role": {"type": "string", "enum": ["admin", "member", "viewer"]}, "remove": {"type": "boolean"}},
             "required": ["workspace", "person"]},
         output_schema=_out({"workspace_id": _STR, "person": _O, "removed": {"type": "boolean"}, "role": _NULLABLE_STR,
                             "invitation_withdrawn": {"type": "boolean"}}),
         annotations=_ann(False, True, True), handler=update_workspace_member),
    Tool(name="get_document_access", title="Who can open a document, and why", scope=READ,
         description=("Who can open a page, document or file, as its Share dialog shows: the access level (link, "
                      "workspace, private; password; expiry), the owner, the people it's shared with by email and "
                      "their roles (only for its owner and editors), its teams, its folder's access (people, teams, "
                      "restricted), whether the user may share it or change its access, and why the user can open "
                      "it. For someone who only has the link (no role) it says nothing more. Change it with "
                      "set_access, share_with_people (remove: true takes people off) and set_folder_access."),
         input_schema={"type": "object", "properties": {"document": _DOC_REF}, "required": ["document"]},
         output_schema=_out({"url": _STR, "markdrop_url": _NULLABLE_STR, "workspace_url": _NULLABLE_STR, "slug": _STR,
                             "level": _STR, "password": {"type": "boolean"}, "expires_at": _NULLABLE_STR,
                             "allow_resharing": {"type": "boolean"}, "workspace": {"type": ["object", "null"]},
                             "owner": {"type": ["object", "null"]}, "your_role": _STR, "can_share": {"type": "boolean"},
                             "can_change_access": {"type": "boolean"},
                             "people": {"type": ["array", "null"], "items": _O}, "teams": {"type": "array", "items": _O},
                             "folder_access": {"type": ["object", "null"]}, "why": {"type": ["object", "null"]}},
                            ["url", "slug", "level", "your_role", "people", "teams"]),
         annotations=_ann(True, False, True), handler=get_document_access),
]
