"""MCP tools for the user's own comment notification settings (the website's Settings › Account).

    get_comment_notifications   email (mentions and assignments; replies and new comments), the daily
                                comments digest, push and Slack per kind
    set_comment_notifications   change any of them

The same services as the website: notifications.email_modes / set_modes, comments/digest.is_on / set_on,
push.prefs_of / set_prefs, slack.dm_on / prefs_of / set_prefs. Turning Slack direct messages on finds the
person in Slack by their email, so that switch stays on the website.
"""

from __future__ import annotations

from bson import ObjectId

from app.mcp.auth import READ, WRITE
from app.mcp.tools import Context, Tool, ToolError, _ann, _out
from app.services import notifications, push, slack
from app.services.comments import digest

_EMAIL_KINDS = ("comment_mention", "comment_activity")
_KINDS = ("comment_mention", "comment_assigned")
_SLACK_SETTINGS = "Settings › Account › Slack notifications"


async def _state(ctx: Context) -> dict:
    row = await ctx.db["users"].find_one({"_id": ObjectId(ctx.user.id)}, {
        "email_notify": 1, "mention_emails": 1, "comment_digest": 1, "push_notify": 1, "slack_notify": 1})
    if row is None:
        raise ToolError("Your account wasn't found.")
    modes = notifications.email_modes(row)
    pushp = push.prefs_of(row)
    slackp = slack.prefs_of(row)
    return {
        "email": {k: modes[k] for k in _EMAIL_KINDS},
        "digest": digest.is_on(row),
        "push": {k: pushp[k] for k in _KINDS},
        "slack": {"on": await slack.dm_on(ctx.db, row), **{k: slackp[k] for k in _KINDS}},
    }


def _onoff(v: bool) -> str:
    return "On" if v else "Off"


def _text(s: dict, head: str) -> str:
    lines = [head, "Email:"]
    for k in _EMAIL_KINDS:
        lines.append(f"- {notifications.KIND_LABELS[k]}: {notifications.MODE_LABELS[s['email'][k]]}")
    lines.append(f"- Daily comments digest: {_onoff(s['digest'])}")
    lines.append("Push notifications (on devices where push is turned on):")
    for k in _KINDS:
        lines.append(f"- {push.LABELS[k]}: {_onoff(s['push'][k])}")
    if s["slack"]["on"]:
        lines.append("Slack direct messages: On")
        for k in _KINDS:
            lines.append(f"- {slack.NOTIFY_LABELS[k]}: {_onoff(s['slack'][k])}")
    else:
        lines.append(f"Slack direct messages: Off (they're turned on on the website, in {_SLACK_SETTINGS}; the "
                     "choices below apply once they are)")
        for k in _KINDS:
            lines.append(f"- {slack.NOTIFY_LABELS[k]}: {_onoff(s['slack'][k])}")
    return "\n".join(lines)


async def get_comment_notifications(ctx: Context, args: dict) -> tuple[str, dict]:
    s = await _state(ctx)
    return _text(s, "Your comment notifications:"), s


async def set_comment_notifications(ctx: Context, args: dict) -> tuple[str, dict]:
    uid = ctx.user.id
    email = {k: args[a] for a, k in (("email_mentions", "comment_mention"), ("email_activity", "comment_activity"))
             if args.get(a) is not None}
    bad = [v for v in email.values() if v not in notifications.MODES]
    if bad:
        raise ToolError("Email settings must be one of: " + ", ".join(notifications.MODES) + ".")
    pushc = {k: args[a] for a, k in (("push_mentions", "comment_mention"), ("push_assigned", "comment_assigned"))
             if isinstance(args.get(a), bool)}
    slackc = {k: args[a] for a, k in (("slack_mentions", "comment_mention"), ("slack_assigned", "comment_assigned"))
              if isinstance(args.get(a), bool)}
    dig = args.get("digest") if isinstance(args.get("digest"), bool) else None
    if not email and not pushc and not slackc and dig is None:
        raise ToolError("Nothing to change: pass email_mentions, email_activity, digest, push_mentions, "
                        "push_assigned, slack_mentions or slack_assigned.")
    if email:
        await notifications.set_modes(ctx.db, uid, email)
    if dig is not None:
        await digest.set_on(ctx.db, uid, dig)
    if pushc:
        await push.set_prefs(ctx.db, uid, pushc)
    if slackc:
        await slack.set_prefs(ctx.db, uid, slackc)
    s = await _state(ctx)
    return _text(s, "Saved. Your comment notifications now:"), s


_MODE = {"type": "string", "enum": list(notifications.MODES)}
_STATE_OUT = _out({
    "email": {"type": "object", "properties": {k: _MODE for k in _EMAIL_KINDS}},
    "digest": {"type": "boolean"},
    "push": {"type": "object", "properties": {k: {"type": "boolean"} for k in _KINDS}},
    "slack": {"type": "object", "properties": {"on": {"type": "boolean"}, **{k: {"type": "boolean"} for k in _KINDS}}},
})

COMMENT_NOTIFY_TOOLS: list[Tool] = [
    Tool(
        name="get_comment_notifications",
        title="My comment notification settings",
        description=("How the user hears about comments: email for mentions and assignments (email.comment_mention) "
                     "and for replies and new comments (email.comment_activity), each instant, hourly, daily or off; "
                     "the daily comments digest email (on or off); push notifications for mentions and assigned "
                     "threads; and Slack direct messages (whether they're on, and for which kinds)."),
        scope=READ,
        input_schema={"type": "object", "properties": {}},
        output_schema=_STATE_OUT,
        annotations=_ann(True, False, True),
        handler=get_comment_notifications,
    ),
    Tool(
        name="set_comment_notifications",
        title="Change my comment notifications",
        description=("Change how the user hears about comments; anything left out stays as it is. email_mentions "
                     "(mentions and assignments) and email_activity (replies and new comments): instant, hourly, "
                     "daily or off. digest: the daily comments digest email on or off. push_mentions, push_assigned: "
                     "push notifications. slack_mentions, slack_assigned: which Slack direct messages come once "
                     f"Slack notifications are on; turning those on is done on the website ({_SLACK_SETTINGS}), "
                     "where Markdrop finds the user in Slack. Returns the settings as get_comment_notifications does."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {
            "email_mentions": {**_MODE, "description": "Email for comment mentions and assignments."},
            "email_activity": {**_MODE, "description": "Email for replies and new comments."},
            "digest": {"type": "boolean", "description": "The daily comments digest email."},
            "push_mentions": {"type": "boolean"},
            "push_assigned": {"type": "boolean"},
            "slack_mentions": {"type": "boolean"},
            "slack_assigned": {"type": "boolean"},
        }},
        output_schema=_STATE_OUT,
        annotations=_ann(False, False, True),
        handler=set_comment_notifications,
    ),
]
