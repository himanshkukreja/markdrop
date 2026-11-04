"""MCP tools for access requests (services/access_requests.py): the page ⋯ menu's
"Request edit access", and the owner's Access requests list with its Approve /
Decline.

* ``request_edit_access``: ``access_requests.create(role="editor")`` — the same
  checks, duplicate and decline cool-down, rate limit and emails as the web
  route (the owner, or the workspace's admins when the page has no reachable
  owner, get the Approve / Decline email).
* ``list_access_requests``: incoming (``list_for_owner``: exactly the requests
  the user may decide on, as the web list shows them) or outgoing
  (``list_for_requester``: the user's own, the title only while they can open
  the document).
* ``decide_access_request``: ``access_requests.decide`` — only the owner (or,
  for an edit request routed to them, a workspace admin) may; the grant and the
  requester's email happen as when they click Approve / Decline.
"""

from __future__ import annotations

from fastapi import HTTPException

from app.mcp.auth import READ, WRITE
from app.mcp.tools import (
    _DOC_REF,
    _NULLABLE_STR,
    NOT_FOUND,
    Context,
    Tool,
    ToolError,
    _ann,
    _out,
    actor_of,
    audit_result,
    audit_target,
    http_message,
    iso,
    load_for,
    resolve_doc,
    url_pair,
)
from app.services import access as access_service
from app.services import access_requests as svc

STATUSES = ["pending", "approved", "declined", "all"]
DIRECTIONS = ["incoming", "outgoing"]
MAX_LIST = 50
_REQUEST_ID = {"type": "string", "minLength": 1, "maxLength": 64,
               "description": "The request's id (from list_access_requests, or the Approve / Decline email's link)."}

_REQUEST = {
    "type": "object",
    "properties": {
        "id": {"type": "string"},
        "status": {"type": "string", "enum": ["pending", "approved", "declined"]},
        "role_requested": {"type": "string", "enum": ["viewer", "editor"],
                           "description": "viewer: asked to open it; editor: asked to edit it."},
        "role_granted": {**_NULLABLE_STR, "description": "What an approval gave: viewer or editor."},
        "as_admin": {"type": "boolean",
                     "description": "An edit request that went to the workspace's admins (no reachable owner)."},
        "message": _NULLABLE_STR,
        "created_at": {"type": "string"},
        "decided_at": _NULLABLE_STR,
        "requester": {"type": "object", "properties": {"email": _NULLABLE_STR, "name": _NULLABLE_STR}},
        "document": {"type": "object", "properties": {
            "slug": {"type": "string"},
            "title": {**_NULLABLE_STR, "description": "None for an end-to-end encrypted one, or one the user can't open."},
            "url": _NULLABLE_STR,
            "available": {"type": "boolean",
                          "description": "Outgoing: false while the user can't open it (no title or url)."},
        }, "required": ["slug", "title", "url", "available"]},
    },
    "required": ["id", "status", "role_requested", "role_granted", "message", "created_at", "decided_at",
                 "requester", "document"],
}


def _svc_ctx(ctx: Context, scope: str | None = None) -> access_service.Ctx:
    return access_service.Ctx(ctx.db, surface="mcp", workspace_scope=scope)


def _error(exc: HTTPException) -> ToolError:
    if exc.status_code == 404 and exc.detail == "Document not found":
        return ToolError(NOT_FOUND)
    if exc.status_code == 404:
        return ToolError("I couldn't find that access request, or it isn't one you can decide on.")
    return ToolError(http_message(exc))


def _row(r: dict) -> dict:
    doc = r["document"]
    return {"id": r["id"], "status": r["status"], "role_requested": r["role_requested"],
            "role_granted": r.get("role_granted"), "as_admin": bool(r.get("as_admin")),
            "message": r.get("message"), "created_at": iso(r.get("created_at")),
            "decided_at": iso(r.get("decided_at")),
            "requester": {"email": r["requester"].get("email"), "name": r["requester"].get("name")},
            "document": {"slug": doc["slug"], "title": doc.get("title"), "url": doc.get("url"),
                         "available": doc.get("available", True)}}


def _asks(r: dict) -> str:
    return "to edit" if r["role_requested"] == "editor" else "to open"


async def request_edit_access(ctx: Context, args: dict) -> tuple[str, dict]:
    # Reading it is the precondition: the tools' own refusals (not found, password) first.
    raw = await load_for(ctx, args["document"], "read", "read")
    ref = await resolve_doc(ctx, args["document"])
    try:
        row = await svc.create(ctx.db, actor_of(ctx), _svc_ctx(ctx, ref.scope), raw["slug"],
                               args.get("message"), role="editor")
    except HTTPException as exc:
        raise _error(exc)
    audit_result(request_id=str(row["_id"]))
    urls = await url_pair(ctx, raw)
    to = "the workspace's admins" if row.get("admin_workspace_id") else "the owner"
    out = {**urls, "slug": raw["slug"], "title": svc.display_title(raw), "request_id": str(row["_id"]),
           "status": row["status"], "sent_to": "admins" if row.get("admin_workspace_id") else "owner"}
    return (f"Asked {to} for edit access to {urls['url']}. They get an email to approve or decline; the user "
            "gets one when they decide (list_access_requests with direction outgoing shows where it stands)."), out


async def list_access_requests(ctx: Context, args: dict) -> tuple[str, dict]:
    direction = args.get("direction") or "incoming"
    status = args.get("status") or "pending"
    limit = int(args.get("limit") or MAX_LIST)
    actor = actor_of(ctx)
    if direction == "outgoing":
        data = await svc.list_for_requester(ctx.db, actor, _svc_ctx(ctx), status, limit)
        pending = None
    else:
        data = await svc.list_for_owner(ctx.db, actor, _svc_ctx(ctx), status, limit)
        pending = data["pending_count"]
    items = [_row(r) for r in data["requests"]]
    out = {"direction": direction, "status": status, "requests": items, "pending_count": pending}
    which = "" if status == "all" else f"{status} "
    if not items:
        where = "to decide on" if direction == "incoming" else "made by the user"
        return f"No {which}access requests {where}.", out
    lines = []
    for r in items:
        doc = r["document"]
        name = doc["title"] or f"/{doc['slug']}"
        link = f" {doc['url']}" if doc["url"] else ""
        when = (r["created_at"] or "")[:16].replace("T", " ")
        note = f': "{r["message"]}"' if r["message"] else ""
        if direction == "incoming":
            who = r["requester"]["name"] or r["requester"]["email"]
            head = f"{who} ({r['requester']['email']}) asked {_asks(r)} {name}{link}"
        else:
            head = f"Asked {_asks(r)} {name}{link}"
        lines.append(f"- [{r['status']}] {head} ({when} UTC){note} (id {r['id']})")
    head = (f"{pending} pending to decide on. " if pending is not None else "") + "Newest first:"
    return head + "\n" + "\n".join(lines), out


async def decide_access_request(ctx: Context, args: dict) -> tuple[str, dict]:
    actor, sctx = actor_of(ctx), _svc_ctx(ctx)
    try:
        row, raw = await svc.for_decider(ctx.db, actor, sctx, args["request"])
    except HTTPException as exc:
        raise _error(exc)
    audit_target(raw)
    editing = svc.requested_role(row) == "editor"
    if args["decision"] == "decline":
        if args.get("role"):
            raise ToolError("role only goes with decision approve.")
        decision = "decline"
    else:
        role = args.get("role") or ("editor" if editing else "viewer")
        decision = "edit" if role == "editor" else "view"
    try:
        ans = await svc.decide(ctx.db, actor, sctx, str(row["_id"]), decision)
    except HTTPException as exc:
        raise _error(exc)
    audit_result(request_id=ans["id"], status=ans["status"], role_granted=ans["role_granted"])
    urls = await url_pair(ctx, raw)
    who = row.get("requester_name") or row.get("requester_email")
    out = {**urls, "slug": raw["slug"], "title": svc.display_title(raw), "id": ans["id"],
           "status": ans["status"], "role_granted": ans["role_granted"], "decided_at": iso(ans["decided_at"]),
           "requester": {"email": row.get("requester_email"), "name": row.get("requester_name")}}
    if ans["status"] == "declined":
        text = f"Declined {who}'s request {'to edit' if editing else 'to open'} {urls['url']}. They get an email saying so."
    else:
        can = "edit" if ans["role_granted"] == "editor" else "view"
        text = (f"Approved: {who} ({row.get('requester_email')}) can now {can} {urls['url']}"
                + (" (that page only, not its sub-pages)" if editing else "") + ". They get an email saying so.")
    return text, out


ACCESS_REQUEST_TOOLS: list[Tool] = [
    Tool(
        name="request_edit_access",
        title="Request edit access",
        description=("Ask for edit access to a page, document or file the user can open but not edit, like "
                     "\"Request edit access\" in the page's ⋯ menu. It goes to the owner (or, when the page has "
                     "no reachable owner, its workspace's admins) as an email with Approve / Decline, with the "
                     "optional message; the user gets an email when they decide. Approval lets the user edit "
                     "that page only (not its sub-pages). Refused when the user can already edit it, can't open "
                     "it, already has a request pending for it, or was declined in the last 24 hours; at most 10 "
                     "requests an hour. Follow it with list_access_requests (direction outgoing)."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "document": _DOC_REF,
            "message": {"type": "string", "maxLength": svc.MAX_MESSAGE,
                        "description": "Optional note for the owner: what the user wants to change, and why."},
        }, "required": ["document"]},
        output_schema=_out({
            "url": {"type": "string"}, "markdrop_url": {"type": ["string", "null"]},
            "workspace_url": {"type": ["string", "null"]}, "slug": {"type": "string"}, "title": _NULLABLE_STR,
            "request_id": {"type": "string"}, "status": {"type": "string"},
            "sent_to": {"type": "string", "enum": ["owner", "admins"]},
        }, ["url", "markdrop_url", "slug", "title", "request_id", "status", "sent_to"]),
        annotations=_ann(False, False, False),
        handler=request_edit_access,
    ),
    Tool(
        name="list_access_requests",
        title="List access requests",
        description=("Access requests, newest first, as the Access requests list in the Markdrop app shows them. "
                     "direction incoming (the default): people asking to open or to edit the user's documents "
                     "(and edit requests sent to a workspace the user administers because the page has no "
                     "reachable owner) — the ones the user can decide with decide_access_request. direction "
                     "outgoing: the requests the user made; a document they still can't open shows its slug only "
                     "(available: false). status pending (the default), approved, declined or all. Each has the "
                     "id, the document, who asked (name and email), what they asked for (role_requested viewer "
                     "or editor), their message, the status and when."),
        scope=READ,
        input_schema={"type": "object", "properties": {
            "direction": {"type": "string", "enum": DIRECTIONS,
                          "description": "incoming: to the user, to decide (default). outgoing: the user's own."},
            "status": {"type": "string", "enum": STATUSES, "description": "Default pending."},
            "limit": {"type": "integer", "minimum": 1, "maximum": MAX_LIST, "description": "Default 50."},
        }},
        output_schema=_out({"direction": {"type": "string", "enum": DIRECTIONS},
                            "status": {"type": "string", "enum": STATUSES},
                            "requests": {"type": "array", "items": _REQUEST},
                            "pending_count": {"type": ["integer", "null"],
                                              "description": "Incoming: how many are pending in all."}}),
        annotations=_ann(True, False, True),
        handler=list_access_requests,
    ),
    Tool(
        name="decide_access_request",
        title="Approve or decline an access request",
        description=("Approve or decline an access request the user may decide on (see list_access_requests, "
                     "direction incoming): the document's owner, or a workspace admin for an edit request sent to "
                     "the admins. Like Approve / Decline in the app: approving shares the document with the "
                     "requester's email address (a request to edit: they can edit that page only; a request to "
                     "open: they can view it, or edit it with role editor) and they get an email either way. "
                     "Confirm with the user before approving. Deciding again the same way changes nothing; the "
                     "other way is refused."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "request": _REQUEST_ID,
            "decision": {"type": "string", "enum": ["approve", "decline"]},
            "role": {"type": "string", "enum": ["viewer", "editor"],
                     "description": ("Approve only: the access to give. Default: what they asked for. A request "
                                     "to edit can only be approved as editor.")},
        }, "required": ["request", "decision"]},
        output_schema=_out({
            "url": {"type": "string"}, "markdrop_url": {"type": ["string", "null"]},
            "workspace_url": {"type": ["string", "null"]}, "slug": {"type": "string"}, "title": _NULLABLE_STR,
            "id": {"type": "string"}, "status": {"type": "string", "enum": ["approved", "declined"]},
            "role_granted": _NULLABLE_STR, "decided_at": _NULLABLE_STR,
            "requester": {"type": "object", "properties": {"email": _NULLABLE_STR, "name": _NULLABLE_STR}},
        }, ["url", "markdrop_url", "slug", "title", "id", "status", "role_granted", "decided_at", "requester"]),
        annotations=_ann(False, False, True),
        handler=decide_access_request,
    ),
]
