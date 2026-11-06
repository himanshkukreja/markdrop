"""MCP tools for Markdrop for Slack (services/slack.py, services/slack_notify.py).

* ``slack_status``: whether a workspace is connected to Slack, which Slack workspace, the meetings
  channel and whether meetings are posted to it on their own, whether the user's own Slack
  account is linked (and how: found by email, Sign in with Slack), and whether they turned Slack
  notifications on (off by default) with their per-kind choices. The settings card's GET /slack/status, for
  any member; never a token.
* ``post_meeting_to_slack``: post a meeting's summary, decisions and action items (with Done
  buttons) to the workspace's meetings channel, again or for the first time (a past meeting brought
  in by Import past meetings is never posted on its own). POST /slack/meetings/{id}/post: who can
  edit the meeting's page may post it, and a meeting the whole channel may not open is never posted.

Connecting Slack, choosing the channel and linking one's account are done on the website
(Workspace settings › Integrations › Slack): they go through Slack's own consent screens.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from fastapi import HTTPException

from app.mcp.auth import READ, WRITE
from app.mcp.meeting_tools import _MEETING_REF, _actx, _row
from app.mcp.tools import _WORKSPACE_ARG, Context, Tool, ToolError, _ann, _out, actor_of, http_message, resolve_workspace
from app.services import access as access_service
from app.services import md_outline, slack, slack_notify, urls

_SETUP = "Workspace settings › Integrations › Slack"

# The REST route's refusals (routers/slack.py post_meeting), word for word.
_POST_REFUSALS = {
    "not_connected": "Slack isn't connected to this workspace.",
    "no_channel": f"Choose a meetings channel in {_SETUP} first.",
    "private": "Only meetings everyone in the channel may open are posted. This one is restricted.",
    "token": "Slack's connection broke. Reconnect it in Workspace settings.",
    "not_in_channel": "Invite @Markdrop to the meetings channel first (/invite @Markdrop).",
    "channel_not_found": "The meetings channel is gone. Choose another one.",
    "is_archived": "The meetings channel is archived. Choose another one.",
}


def _iso(v: Any) -> str | None:
    return v.isoformat() if hasattr(v, "isoformat") else (v or None)


async def slack_status(ctx: Context, args: dict) -> tuple[str, dict]:
    ws_id, ws_obj, _role = await resolve_workspace(ctx, args["workspace"])
    try:
        st = await slack.status(ctx.db, ctx.user, ws_id)
    except HTTPException as exc:
        raise ToolError(http_message(exc))
    name = getattr(ws_obj, "name", None) or (ws_obj.get("name") if isinstance(ws_obj, dict) else None) or "This workspace"
    inst = st.get("install")
    me = st["me"]
    out: dict[str, Any] = {
        "workspace_id": ws_id,
        "available": bool(st["configured"]),
        "connected": inst is not None,
        "can_manage": bool(st["can_manage"]),
        "slack_workspace": None,
        "meetings_channel": None,
        "post_meetings": None,
        "connected_by": None,
        "connected_at": None,
        "linked_people": None,
        "needs_reconnect": False,
        "me": {"linked": bool(me["linked"]), "slack_name": me.get("slack_name"), "found_by": me.get("match"),
               "notifications_on": bool(me.get("on")), "direct_messages": me["prefs"]},
    }
    if not st["configured"]:
        return ("Markdrop for Slack isn't available on this Markdrop server yet (the Slack app isn't set up), "
                "so no workspace can connect it."), out
    if inst is None:
        how = (f"A workspace admin connects it on the website: {_SETUP} › Add to Slack."
               if not st["can_manage"] else f"You can connect it on the website: {_SETUP} › Add to Slack.")
        return f"{name} isn't connected to Slack. {how}", out
    chan = inst.get("meetings_channel") or None
    out.update({
        "slack_workspace": inst.get("team_name") or None,
        "meetings_channel": {"id": chan.get("id"), "name": chan.get("name")} if chan else None,
        "post_meetings": bool(inst.get("post_meetings")),
        "connected_by": inst.get("installed_by"),
        "connected_at": _iso(inst.get("installed_at")),
        "linked_people": inst.get("linked_people"),
        "needs_reconnect": not inst.get("token_ok", True),
    })
    lines = [f"{name} is connected to the Slack workspace {inst.get('team_name') or '(unnamed)'}"
             + (f" (by {inst['installed_by']})" if inst.get("installed_by") else "") + "."]
    if chan:
        lines.append(f"Meetings channel: #{chan.get('name') or chan.get('id')}; new meetings are "
                     + ("posted there when their summary is ready." if out["post_meetings"] else
                        "not posted on their own (post_meeting_to_slack still posts one by hand)."))
    else:
        lines.append(f"No meetings channel is chosen, so meetings aren't posted ({_SETUP}).")
    if out["needs_reconnect"]:
        lines.append(f"Slack's connection broke: a workspace admin reconnects it in {_SETUP}.")
    lines.append(f"{inst.get('linked_people') or 0} people have linked their Slack account.")
    if not inst.get("can_find_by_email", True):
        lines.append("The Slack app needs an update (new permissions to find people by email): a workspace admin "
                     f"updates it in {_SETUP}.")
    on = [slack.NOTIFY_LABELS[k] for k, v in me["prefs"].items() if v]
    if not me.get("on"):
        lines.append("Your Slack notifications are off (the default): turn them on in Settings › Account › "
                     "Slack notifications, and Markdrop finds you in Slack by your email.")
    elif me["linked"]:
        lines.append("Your Slack notifications are on" + (f", as {me['slack_name']}" if me.get("slack_name") else "")
                     + ("; direct messages for: " + ", ".join(on) if on else "; every kind is turned off") + ".")
    else:
        lines.append("Your Slack notifications are on, but Markdrop hasn't found you in this Slack workspace: link "
                     f"your Slack account in {_SETUP}, or run /markdrop link in Slack.")
    if not me["linked"] and not me.get("on"):
        lines.append(f"Your Slack account isn't linked (link it in {_SETUP}, or run /markdrop link in Slack).")
    return "\n".join(lines), out


async def post_meeting_to_slack(ctx: Context, args: dict) -> tuple[str, dict]:
    if not slack.configured():
        raise ToolError("Markdrop for Slack isn't set up on this Markdrop server yet.")
    row, raw = await _row(ctx, args["meeting"])
    actor = actor_of(ctx)
    if not (await access_service.can(actor, raw, "edit_content", _actx(ctx))).allowed:
        raise ToolError("You can post meetings you can edit.")
    # An assistant asked twice in a row posts once: the same meeting at most once a minute from here.
    claim = f"mcp-post:{row['_id']}"
    if not await slack.remember(ctx.db, claim, timedelta(seconds=60)):
        raise ToolError("This meeting was posted to Slack less than a minute ago. Check the channel before posting it again.")
    out = await slack_notify.post_meeting(ctx.db, str(row["_id"]), again=True)
    if not out.get("posted"):
        await ctx.db[slack.SEEN].delete_one({"_id": claim})
        raise ToolError(_POST_REFUSALS.get(out.get("reason") or "", "Slack didn't take the post. Try again in a minute."))
    inst = await slack.install_for_workspace(ctx.db, row.get("workspace_id")) or {}
    chan = (inst.get("meetings_channel") or {})
    title = md_outline.display_title(raw) or "The meeting"
    data = {"posted": True, "meeting_id": str(row["_id"]), "url": urls.markdrop_url(raw["slug"]),
            "channel": {"id": chan.get("id"), "name": chan.get("name")}}
    return f"Posted {title} to #{chan.get('name') or chan.get('id')} in Slack, with a Done button for each action item.", data


SLACK_TOOLS: list[Tool] = [
    Tool(
        name="slack_status",
        title="Slack connection",
        description=("Whether a workspace is connected to Slack (Markdrop for Slack): which Slack workspace, the "
                     "channel meeting notes are posted to and whether new meetings are posted on their own, whether "
                     "the connection needs reconnecting, how many people linked their Slack account, whether the user's own "
                     "account is linked, and whether they turned Slack notifications on (me.notifications_on: off by "
                     "default; once on, which direct messages they get: mentions, sign-off requests, shares, access "
                     "requests). Any member can ask. Read-only: connecting Slack, choosing the channel and linking an "
                     "account are done on the website (Workspace settings › Integrations › Slack), and Slack "
                     "notifications are turned on in Settings › Account."),
        scope=READ,
        input_schema={"type": "object", "properties": {"workspace": _WORKSPACE_ARG}, "required": ["workspace"]},
        output_schema=_out({
            "workspace_id": {"type": "string"}, "available": {"type": "boolean"}, "connected": {"type": "boolean"},
            "can_manage": {"type": "boolean"}, "slack_workspace": {"type": ["string", "null"]},
            "meetings_channel": {"type": ["object", "null"]}, "post_meetings": {"type": ["boolean", "null"]},
            "connected_by": {"type": ["string", "null"]}, "connected_at": {"type": ["string", "null"]},
            "linked_people": {"type": ["integer", "null"]}, "needs_reconnect": {"type": "boolean"},
            "me": {"type": "object"}}, ["workspace_id", "available", "connected"]),
        annotations=_ann(True, False, True),
        handler=slack_status,
    ),
    Tool(
        name="post_meeting_to_slack",
        title="Post a meeting to Slack",
        description=("Post a meeting's summary, decisions and action items to its workspace's Slack meetings channel, "
                     "each action item with a Done button that ticks it on the Markdrop page. Use it to post a "
                     "meeting again, or one that wasn't posted on its own (meetings brought in by Import past meetings "
                     "never are). Needs edit access to the meeting's page. A meeting restricted to its attendees, or "
                     "one not everyone in the channel may open, is never posted. See slack_status for the channel."),
        scope=WRITE,
        writes=True,
        input_schema={"type": "object", "properties": {"meeting": _MEETING_REF}, "required": ["meeting"]},
        output_schema=_out({"posted": {"type": "boolean"}, "meeting_id": {"type": "string"}, "url": {"type": "string"},
                            "channel": {"type": "object"}}, ["posted"]),
        annotations=_ann(False, False, False),
        handler=post_meeting_to_slack,
    ),
]
