"""What Slack sends Markdrop: slash commands, button clicks, events (link unfurls, uninstalls).

The router verifies the request (slack.verify_and_claim) and answers within Slack's 3 seconds;
the handlers here split each request into what goes in that answer and what runs afterwards
(``slack.spawn``), replying through the request's ``response_url`` or the Web API.

Privacy
    /markdrop replies are ephemeral (only the person who typed it sees them) and are built as
    their linked Markdrop account (``access.Actor.of(user)``): search and AI answers see only what
    that account can open. Unfurls are posted for the whole channel, so they show an item only
    when everyone there may see it (slack_notify.channel_may_see); otherwise a minimal card.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime
from typing import Any
from urllib.parse import quote, urlsplit

from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.services import slack, slack_action_items, slack_api, slack_notify
from app.services import slack_blocks as kit

log = logging.getLogger("markdrop.slack")

MAX_UNFURLS = 5


def _link_page(team_id: str) -> str:
    return slack.frontend_link(f"/integrations/slack/link?team={quote(team_id)}")


def _abs(url: str | None) -> str:
    from app.services import urls

    u = url or ""
    return u if u.startswith("http") else urls.markdrop_url(u.lstrip("/"))


# ── Slash commands ────────────────────────────────────────────────────────────

SUBCOMMANDS = ("search", "ask", "meetings", "link", "unlink", "help")


def parse_command(text: str) -> tuple[str, str]:
    t = " ".join((text or "").split())
    if not t:
        return "help", ""
    head, _, rest = t.partition(" ")
    if head.lower() in SUBCOMMANDS:
        return head.lower(), rest.strip()
    from app.services import search_text

    return ("ask" if search_text.looks_like_question(t) else "search"), t


async def command(db: AsyncIOMotorDatabase, form: dict) -> dict:
    """The immediate answer to ``/markdrop …`` (ephemeral); slow work continues in the background."""
    team_id, slack_user = form.get("team_id") or "", form.get("user_id") or ""
    inst = await slack.get_install(db, team_id)
    if inst is None:
        return {"response_type": "ephemeral", "text": "Markdrop isn't connected to this Slack workspace. A Markdrop "
                "workspace admin can connect it in Workspace settings › Integrations › Slack."}
    sub, arg = parse_command(form.get("text") or "")
    user = await slack.linked_user(db, team_id, slack_user)
    if sub == "help":
        return {"response_type": "ephemeral", **kit.help_message((user.name or user.email) if user else None)}
    if sub == "link":
        if user is not None:
            return {"response_type": "ephemeral", **kit.notice(
                f"You're linked as *{kit.esc(user.name or user.email)}*. To link another account, `/markdrop unlink` first.")}
        return {"response_type": "ephemeral", **kit.link_prompt(_link_page(team_id), "Link your Markdrop account.")}
    if sub == "unlink":
        if user is not None:
            await slack.keep_legacy_opt_in(db, user.id)   # their Slack notifications choice outlives the link
        await db[slack.LINKS].delete_one({"_id": f"{team_id}:{slack_user}"})
        return {"response_type": "ephemeral", **kit.notice("Done: your Slack account isn't linked to Markdrop any more.")}
    if user is None:
        return {"response_type": "ephemeral", **kit.link_prompt(_link_page(team_id))}
    if not arg:
        return {"response_type": "ephemeral", **kit.notice(f"Type what to {sub if sub != 'meetings' else 'ask your meetings'} "
                                                             f"after `/markdrop {sub}`.")}
    url = form.get("response_url")
    if sub == "search":
        slack.spawn(_search(db, inst, user, arg, url))
        return {"response_type": "ephemeral", "text": f"Searching for “{kit.cut(arg, 80)}”…"}
    slack.spawn(_ask(db, inst, user, arg, url, meetings=sub == "meetings"))
    return {"response_type": "ephemeral", "text": f"Thinking about “{kit.cut(arg, 80)}”… (only you can see this)"}


async def _scope_for(db: AsyncIOMotorDatabase, inst: dict, user) -> str | None:
    """The team's workspace when the person is a member of it (results there first), else everything."""
    from app.services import workspace as ws_service

    ws = inst.get("workspace_id")
    return ws if ws and await ws_service.role_for(db, ws, user.id) else None


async def _search(db: AsyncIOMotorDatabase, inst: dict, user, q: str, response_url: str | None) -> None:
    from app.services import access, search

    actor, ctx = access.Actor.of(user, cred="session"), access.Ctx(db, surface="slack")
    try:
        res = await search.run(db, actor, ctx, search.Query(q=q, scope=await _scope_for(db, inst, user), limit=8,
                                                           trash=False))
        items = [it for it in res.get("items") or [] if it.get("web_url")]
        msg = kit.search_results(q, items[:8], more_url=slack.frontend_link(f"/search?q={quote(q)}"))
    except Exception:
        log.warning("slack: search failed", exc_info=True)
        msg = kit.notice("Search didn't work just now. Try again in a minute.")
    await slack_api.respond(response_url, {"replace_original": True, **msg})


async def _ask(db: AsyncIOMotorDatabase, inst: dict, user, q: str, response_url: str | None, *, meetings: bool) -> None:
    from app.services import access, meetings_ai, pages_ai, search_ai

    actor, ctx = access.Actor.of(user, cred="session"), access.Ctx(db, surface="slack")
    try:
        if meetings:
            ws = await _scope_for(db, inst, user)
            if ws is None:
                await slack_api.respond(response_url, {"replace_original": True, **kit.notice(
                    "Ask your meetings needs you to be a member of the Markdrop workspace this Slack is connected to.")})
                return
            done = await meetings_ai.collect(meetings_ai.ask_meetings(db, actor, ctx, ws, q, via="slack"))
            sources = []
            for i, c in enumerate(done.get("citations") or [], 1):
                href = c.get("href") or ""
                base, _, frag = href.partition("#")
                sources.append({"n": c.get("label") or i, "title": c.get("text") or c.get("label") or "Source",
                                "url": _abs(base) + (f"#{frag}" if frag else "")})
        else:
            done = await search_ai.collect(search_ai.ask(db, actor, ctx, q, scope=await _scope_for(db, inst, user),
                                                         via="slack"))
            sources = [{"n": c["n"], "title": c.get("title"), "url": _abs(c.get("url") or c.get("slug"))}
                       for c in done.get("citations") or [] if c.get("url") or c.get("slug")]
        msg = kit.answer(q, done.get("answer") or "", sources)
    except pages_ai.AIError as exc:
        msg = kit.notice(str(exc.detail))
    except Exception:
        log.warning("slack: ask failed", exc_info=True)
        msg = kit.notice("Markdrop AI didn't answer just now. Try again in a minute.")
    await slack_api.respond(response_url, {"replace_original": True, **msg})


# ── Button clicks ─────────────────────────────────────────────────────────────


async def interaction(db: AsyncIOMotorDatabase, payload: dict) -> None:
    """A block_actions payload (already verified as Slack's). Runs after the 200. A comment Reply modal's
    view_submission goes to services/comments/slack.py (the empty 200 closes the modal)."""
    if payload.get("type") == "view_submission":
        from app.services.comments import slack as comment_slack

        await comment_slack.submit(db, payload)
        return
    if payload.get("type") != "block_actions":
        return
    team_id = ((payload.get("team") or {}).get("id")) or ""
    slack_user = ((payload.get("user") or {}).get("id")) or ""
    acts = payload.get("actions") or []
    if not acts:
        return
    act = acts[0]
    action_id = str(act.get("action_id") or "")
    if action_id in ("md_open", "md_link"):
        return  # link buttons: Slack opens the URL; nothing to do here
    response_url = payload.get("response_url")
    inst = await slack.get_install(db, team_id)
    if inst is None:
        return
    parts = slack.read_value(team_id, act.get("value"))
    if parts is None:
        log.info("slack: refused a click with a forged or foreign value (team %s, action %s)", team_id, action_id)
        await slack_api.respond(response_url, kit.notice("That button isn't valid any more."))
        return
    # A person's own action-items message (services/slack_action_items.py): bound to who it was sent
    # to, so these work without a linked Slack account (people who aren't in Markdrop get them too).
    if parts[0] == "aid" and len(parts) == 3 and action_id == "md_ai_done":
        why = await slack_action_items.click_done(db, inst, slack_user, parts[1], parts[2], payload)
        if why:
            await slack_api.respond(response_url, kit.notice(why))
        return
    if parts[0] in ("stop", "start") and action_id in ("md_ai_stop", "md_ai_start"):
        reply = await slack_action_items.click_stop(db, inst, slack_user, parts, on=parts[0] == "start")
        if reply:
            await slack_api.respond(response_url, reply)
        return
    user = await slack.linked_user(db, team_id, slack_user)
    if user is None:
        await slack_api.respond(response_url, kit.link_prompt(_link_page(team_id)))
        return
    kind = parts[0]
    if kind == "done" and len(parts) == 3 and action_id == "md_done":
        why = await slack_notify.mark_done(db, inst, user, parts[1], parts[2])
        if why:
            await slack_api.respond(response_url, kit.notice(why))
    elif kind == "ar" and len(parts) == 3 and action_id in ("md_ar_ok", "md_ar_no"):
        await _decide(db, inst, user, parts[1], parts[2], payload)
    elif kind == "so" and len(parts) == 4 and action_id.startswith("md_so_"):
        await _sign(db, inst, user, parts[1], parts[2], parts[3], payload)
    elif kind == "cm" and len(parts) == 4 and action_id in ("md_cm_reply", "md_cm_resolve"):
        from app.services.comments import slack as comment_slack

        await comment_slack.click(db, inst, user, parts, action_id, payload)


async def _update_message(inst: dict, payload: dict, msg: dict) -> None:
    cont = payload.get("container") or {}
    chan = cont.get("channel_id") or (payload.get("channel") or {}).get("id")
    ts = cont.get("message_ts") or (payload.get("message") or {}).get("ts")
    token = slack.bot_token(inst)
    if not (token and chan and ts):
        return
    try:
        await slack_api.call("chat.update", token, channel=chan, ts=ts, blocks=msg["blocks"], text=msg["text"])
    except slack_api.SlackError as exc:
        log.info("slack: chat.update %s", exc.error)


async def _decide(db: AsyncIOMotorDatabase, inst: dict, user, request_id: str, decision: str, payload: dict) -> None:
    from app.services import access, access_requests, md_outline

    actor, ctx = access.Actor.of(user, cred="session"), access.Ctx(db, surface="slack")
    response_url = payload.get("response_url")
    try:
        out = await access_requests.decide(db, actor, ctx, request_id, decision)
    except HTTPException as exc:
        if exc.status_code == 409:
            await slack_api.respond(response_url, kit.notice("Someone already answered that request."))
        else:
            await slack_api.respond(response_url, kit.notice(str(exc.detail) if isinstance(exc.detail, str) else
                                                             "Markdrop couldn't do that."))
        return
    req = await db[access_requests.COLL].find_one({"_id": slack_notify._oid(request_id)})
    raw = await db["documents"].find_one({"_id": slack_notify._oid((req or {}).get("doc_id"))}) if req else None
    status = out.get("status")
    label = {"view": "can view it now", "edit": "can edit it now"}.get(decision, "")
    done = f"Approved by you: they {label}." if status == "approved" else "Declined by you."
    msg = kit.dm_access_request(inst["_id"], (req or {}).get("requester_name") or (req or {}).get("requester_email") or "Someone",
                                (req or {}).get("requester_email"), md_outline.display_title(raw) if raw else "the page",
                                slack.frontend_link(f"/requests/{request_id}"), request_id,
                                access_requests.requested_role(req or {}) == "editor", (req or {}).get("message"),
                                bool((req or {}).get("admin_workspace_id")), done=done)
    await _update_message(inst, payload, msg)


async def _sign(db: AsyncIOMotorDatabase, inst: dict, user, doc_id: str, block: str, idx: str, payload: dict) -> None:
    from app.services import access, md_outline, signoffs, urls

    response_url = payload.get("response_url")
    raw = await db["documents"].find_one({"_id": slack_notify._oid(doc_id)})
    b = signoffs.find((raw or {}).get("content"), block) if raw else None
    if raw is None or b is None or not idx.isdigit() or int(idx) >= len(b.options):
        await slack_api.respond(response_url, kit.notice("That sign-off changed or was removed. Open the page to see it."))
        return
    option = b.options[int(idx)]
    actor, ctx = access.Actor.of(user, cred="session"), access.Ctx(db, surface="slack")
    try:
        await signoffs.sign(db, raw, block, option, actor, ctx, via="slack")
    except HTTPException as exc:
        await slack_api.respond(response_url, kit.notice(str(exc.detail) if isinstance(exc.detail, str) else
                                                         "Markdrop couldn't do that."))
        return
    msg = kit.dm_signoff(inst["_id"], None, md_outline.display_title(raw), urls.markdrop_url(raw["slug"]) + f"#{block}",
                         b.label, doc_id, block, b.options, done=f"You chose *{kit.esc(option)}*.")
    await _update_message(inst, payload, msg)


# ── Events ────────────────────────────────────────────────────────────────────


async def event(db: AsyncIOMotorDatabase, payload: dict) -> None:
    """An event_callback (already verified, and not a retry we've handled). Runs after the 200."""
    team_id = payload.get("team_id") or ""
    ev = payload.get("event") or {}
    kind = ev.get("type")
    if kind == "app_uninstalled":
        await slack.forget_team(db, team_id)
        log.info("slack: team %s uninstalled the app", team_id)
        return
    if kind == "tokens_revoked":
        if (ev.get("tokens") or {}).get("bot"):
            await slack.forget_team(db, team_id)
        return
    if kind == "link_shared":
        inst = await slack.get_install(db, team_id)
        if inst is not None:
            await unfurl(db, inst, ev)


# Top-level app routes (frontend/src/app) that aren't documents; utils/slug.RESERVED_SLUGS too.
_APP_ROUTES = frozenset({
    "dashboard", "meetings", "pages", "recent", "requests", "search", "settings", "shared", "trash", "w", "h", "f",
    "guides", "enterprise", "mcp", "privacy", "terms", "builder", "new", "share", "upload", "admin", "login", "auth", "invite",
    "oauth", "extension", "d", "integrations", "docs-site",
})


def _hosts() -> set[str]:
    hosts = {"markdrop.in", "www.markdrop.in"}
    front = urlsplit(slack._s().frontend_url).hostname
    if front:
        hosts.add(front.lower())
    return hosts


async def card_for(db: AsyncIOMotorDatabase, inst: dict, url: str, *, shared: bool) -> dict | None:
    """The unfurl for one link: a preview, the minimal card, or None (not an item: leave it alone)."""
    from app.services import access, artifact, document, folder, md_outline, search_text

    parts = urlsplit(url)
    if (parts.hostname or "").lower() not in _hosts():
        return None
    segs = [s for s in parts.path.split("/") if s]
    if not segs:
        return None
    if segs[0] == "f" and len(segs) >= 2:
        fo = await folder.find_share(db, segs[1])
        share = (fo or {}).get("share") or {}
        if fo is None or len(segs) > 2:
            return kit.minimal_unfurl(url) if fo is not None else None
        ok = share.get("level") == "link" or (
            share.get("level") == "workspace" and not shared and fo.get("workspace_id") == inst.get("workspace_id"))
        if not ok:
            return kit.minimal_unfurl(url)
        return kit.item_unfurl(url, fo.get("name") or "Folder", kind="Folder", excerpt=None, where=None, updated=None)
    from app.utils.slug import is_reserved_slug

    if len(segs) != 1 or segs[0].lower() in _APP_ROUTES or is_reserved_slug(segs[0]) \
            or not re.fullmatch(r"[A-Za-z0-9_-]{3,80}", segs[0]):
        return None
    raw, _moved = await document.find_for_read(db, segs[0])
    if raw is None:
        return kit.minimal_unfurl(url)
    if not await slack_notify.channel_may_see(db, inst, raw, shared=shared):
        return kit.minimal_unfurl(url)
    title = md_outline.display_title(raw)
    if raw.get("kind") == "artifact":
        kind, excerpt = artifact.label_for(raw.get("mime") or "") or "File", raw.get("original_filename")
    elif raw.get("encrypted"):
        kind, excerpt = "End-to-end encrypted", None
    else:
        kind = "Page" if raw.get("editor") == "blocks" else "Document"
        body = search_text.markdown_text((raw.get("content") or "")[:20000])
        if body.startswith(title):
            body = body[len(title):]
        excerpt = " ".join(body.split())[:300] or None
    where = None
    if raw.get("workspace_id"):
        ws = await access.Ctx(db).workspace(raw["workspace_id"])
        where = getattr(ws, "name", None)
    upd = raw.get("updated_at")
    updated = upd.strftime("%b %-d, %Y") if isinstance(upd, datetime) else None
    return kit.item_unfurl(url, title, kind=kind, excerpt=excerpt, where=where, updated=updated)


async def unfurl(db: AsyncIOMotorDatabase, inst: dict, ev: dict) -> None:
    token = slack.bot_token(inst)
    if not token:
        return
    channel = ev.get("channel") or ""
    composer = ev.get("source") == "composer" or channel == "COMPOSER"
    shared = True if composer else await slack_notify.channel_is_shared(token, channel)
    unfurls: dict[str, Any] = {}
    for ln in (ev.get("links") or [])[:MAX_UNFURLS]:
        url = str(ln.get("url") or "")[:2000]
        if not url or url in unfurls:
            continue
        try:
            card = await card_for(db, inst, url, shared=shared)
        except Exception:
            log.warning("slack: unfurl of %s failed", url[:120], exc_info=True)
            card = None
        if card is not None:
            unfurls[url] = card
    if not unfurls:
        return
    args: dict[str, Any] = {"unfurls": unfurls}
    if composer and ev.get("unfurl_id"):
        args.update(unfurl_id=ev["unfurl_id"], source=ev.get("source") or "composer")
    else:
        args.update(channel=channel, ts=ev.get("message_ts"))
    try:
        await slack_api.call("chat.unfurl", token, **args)
    except slack_api.SlackError as exc:
        log.info("slack: chat.unfurl %s", exc.error)
