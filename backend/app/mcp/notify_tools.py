"""MCP tools for notifications (services/notifications.py) and for sharing a
document with named people, telling them.

* ``list_notifications`` / ``mark_notifications_read``: the user's own
  mentions, sign-off requests and shares, exactly as the bell in the app shows
  them (a page they can no longer open shows without its title or link).
* ``share_with_people``: the share dialog's "Add people" — a grant per address
  (``access.add_grant``: the same rules and errors as the website), and with
  ``notify`` the share email plus a notification for people with an account.

Page writes made over MCP notify newly mentioned people like the editor does
(author = the MCP user): that happens in the page tools' save path.
"""

from __future__ import annotations

from fastapi import HTTPException

from app.mcp.auth import READ, WRITE
from app.mcp.tools import (
    _DOC_REF,
    _NULLABLE_STR,
    Context,
    Tool,
    ToolError,
    _ann,
    _out,
    actor_of,
    http_message,
    load_for,
    url_pair,
)
from app.services import access as access_service
from app.services import notifications as svc

MAX_PEOPLE = 20

_NOTE = {
    "type": "object",
    "properties": {
        "id": {"type": "string"},
        "kind": {"type": "string", "enum": list(svc.KINDS)},
        "text": {"type": "string", "description": "The notification as a sentence."},
        "read": {"type": "boolean"},
        "created_at": {"type": "string"},
        "actor": {"type": "string", "description": "Who did it."},
        "available": {"type": "boolean",
                      "description": "False when the user can't open the page now: no title, url or excerpt."},
        "page": {"type": ["object", "null"], "properties": {"slug": {"type": "string"}, "title": {"type": "string"}}},
        "block": _NULLABLE_STR,
        "url": {**_NULLABLE_STR, "description": "The page's link, with #<block> when the mention is in an anchored block."},
        "excerpt": _NULLABLE_STR,
        "label": {**_NULLABLE_STR, "description": "signoff_requested: the sign-off's label."},
        "message": {**_NULLABLE_STR, "description": "shared: the note the sharer added."},
    },
    "required": ["id", "kind", "text", "read", "created_at", "actor", "available", "page", "block", "url"],
}


def _row(n: dict) -> dict:
    return {"id": n["id"], "kind": n["kind"], "text": n["text"], "read": n["read"], "created_at": n["created_at"],
            "actor": n["actor"]["name"], "available": n["available"], "page": n["page"], "block": n["block"],
            "url": n["url"], "excerpt": n["excerpt"], "label": n["label"], "message": n["message"]}


async def list_notifications(ctx: Context, args: dict) -> tuple[str, dict]:
    limit = int(args.get("limit") or 20)
    data = await svc.listing(ctx.db, ctx.user.id, unread_only=bool(args.get("unread_only")), limit=limit,
                             before=args.get("cursor") or None)
    items = [_row(n) for n in data["items"]]
    out = {"notifications": items, "unread_count": data["unread_count"], "next_cursor": data["next_before"]}
    if not items:
        return ("No unread notifications." if args.get("unread_only") else "No notifications."), out
    lines = [f"- [{'unread' if not n['read'] else 'read'}] {n['text']} ({n['created_at'][:16].replace('T', ' ')} UTC)"
             + (f": {n['excerpt']}" if n.get("excerpt") else "") + (f" {n['url']}" if n["url"] else "")
             + f" (id {n['id']})" for n in items]
    more = f"\nOlder ones: call again with cursor {out['next_cursor']}." if out["next_cursor"] else ""
    return (f"{data['unread_count']} unread. Newest first:\n" + "\n".join(lines) + more), out


async def mark_notifications_read(ctx: Context, args: dict) -> tuple[str, dict]:
    ids = args.get("ids") or None
    all_ = bool(args.get("all"))
    if bool(ids) == all_:
        raise ToolError("Give either ids (from list_notifications) or all: true.")
    marked = await svc.mark_read(ctx.db, ctx.user.id, ids, all_)
    left = await svc.unread_count(ctx.db, ctx.user.id)
    out = {"marked": marked, "unread_count": left}
    return f"Marked {marked} notification{'s' if marked != 1 else ''} read; {left} unread.", out


async def share_with_people(ctx: Context, args: dict) -> tuple[str, dict]:
    raw = await load_for(ctx, args["document"], "share", "share")
    emails = [e.strip() for e in args.get("emails") or [] if isinstance(e, str) and e.strip()]
    if not emails:
        raise ToolError("Give at least one email address.")
    if len(emails) > MAX_PEOPLE:
        raise ToolError(f"Share with at most {MAX_PEOPLE} people at a time.")
    role = args.get("role") or "viewer"
    notify_them = args.get("notify", True) is not False
    message = (args.get("message") or "").strip() or None
    if message and not notify_them:
        raise ToolError("A message goes with the notification: leave notify on (or drop the message).")
    actor = actor_of(ctx)
    people = []
    for email in dict.fromkeys(emails):
        actx = access_service.Ctx(ctx.db, surface="mcp")
        fresh = await ctx.db["documents"].find_one({"_id": raw["_id"]}) or raw
        try:
            g = await svc.share_with(ctx.db, fresh, email, role, actor, actx, notify_them=notify_them,
                                     message=message)
        except HTTPException as exc:
            people.append({"email": email, "role": None, "added": False, "notified": False,
                           "error": http_message(exc)})
            continue
        people.append({"email": g.email, "role": g.role, "added": not g.unchanged,
                       "notified": bool(g.notified), "error": None})
    urls = await url_pair(ctx, raw)
    out = {**urls, "slug": raw["slug"], "people": people}
    parts = []
    for p in people:
        if p["error"]:
            parts.append(f"{p['email']}: not shared ({p['error']})")
        elif not p["added"]:
            parts.append(f"{p['email']}: already had access (nothing sent)")
        else:
            told = (" and emailed" if p["notified"] else " (the email didn't send)") if notify_them else ""
            parts.append(f"{p['email']}: can {'edit' if p['role'] == 'editor' else 'view'}{told}")
    return f"Sharing {urls['url']}:\n" + "\n".join(f"- {x}" for x in parts), out


NOTIFY_TOOLS: list[Tool] = [
    Tool(
        name="list_notifications",
        title="List the user's notifications",
        description=("The user's notifications, newest first, as the bell in the Markdrop app shows them: someone "
                     "mentioned them on a page (kind mention), asked for their sign-off (signoff_requested) or "
                     "shared a page with them (shared). Each has a sentence, who did it, the page and a url to the "
                     "block when there is one, and whether it's read. A page the user can no longer open shows "
                     "without its title, url or excerpt (available: false). Kept 90 days. Mark them read with "
                     "mark_notifications_read."),
        scope=READ,
        input_schema={"type": "object", "properties": {
            "unread_only": {"type": "boolean", "description": "Only unread ones. Default false."},
            "limit": {"type": "integer", "minimum": 1, "maximum": svc.LIST_MAX, "description": "Default 20."},
            "cursor": {"type": "string", "maxLength": 64,
                       "description": "next_cursor from a previous call, for older ones."},
        }},
        output_schema=_out({"notifications": {"type": "array", "items": _NOTE},
                            "unread_count": {"type": "integer"}, "next_cursor": _NULLABLE_STR}),
        annotations=_ann(True, False, True),
        handler=list_notifications,
    ),
    Tool(
        name="mark_notifications_read",
        title="Mark notifications read",
        description=("Mark the user's notifications read: the ids from list_notifications, or all: true for every "
                     "one. Only the user's own; unknown ids are ignored. Returns how many changed and how many are "
                     "still unread."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "ids": {"type": "array", "items": {"type": "string", "maxLength": 64}, "minItems": 1,
                    "maxItems": svc.LIST_MAX},
            "all": {"type": "boolean", "description": "Mark every notification read (instead of ids)."},
        }},
        output_schema=_out({"marked": {"type": "integer"}, "unread_count": {"type": "integer"}}),
        annotations=_ann(False, False, True),
        handler=mark_notifications_read,
    ),
    Tool(
        name="share_with_people",
        title="Share a document with people",
        description=("Give named people access to a page, document or file by email address, like Share → Add "
                     "people in the app: role viewer (can view, the default) or editor (can edit). They sign in "
                     "with that address to open it. With notify (default true) each one gets an email with the "
                     "link (and the optional message) and, if they have a Markdrop account, a notification under "
                     "the bell; nobody is told twice, and someone who already had that access gets nothing. The "
                     "rules are the website's: the user must be allowed to share it, can't give more access than "
                     "they have, and only the owner changes someone's existing role. At most 20 addresses per "
                     "call. Each person's result is listed (added, notified, or why not)."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "document": _DOC_REF,
            "emails": {"type": "array", "items": {"type": "string", "format": "email", "maxLength": 254},
                       "minItems": 1, "maxItems": MAX_PEOPLE},
            "role": {"type": "string", "enum": ["viewer", "editor"], "description": "Default viewer."},
            "notify": {"type": "boolean", "description": "Email them (and notify them in Markdrop). Default true."},
            "message": {"type": "string", "maxLength": 500,
                        "description": "Optional note included in the email and the notification."},
        }, "required": ["document", "emails"]},
        output_schema=_out({
            "url": {"type": "string"}, "markdrop_url": {"type": ["string", "null"]},
            "workspace_url": {"type": ["string", "null"]}, "slug": {"type": "string"},
            "people": {"type": "array", "items": {"type": "object", "properties": {
                "email": {"type": "string"}, "role": _NULLABLE_STR, "added": {"type": "boolean"},
                "notified": {"type": "boolean"}, "error": _NULLABLE_STR,
            }, "required": ["email", "role", "added", "notified", "error"]}},
        }, ["url", "markdrop_url", "slug", "people"]),
        annotations=_ann(False, False, True),
        handler=share_with_people,
    ),
]
