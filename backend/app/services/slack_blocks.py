"""The Slack messages Markdrop sends (Block Kit). Pure functions: no database, no network.

Everything user-written goes through :func:`esc` (Slack's three control characters) and is cut to
Slack's limits (3000 characters a section, 75 a button label, 50 blocks a message).
"""

from __future__ import annotations

from typing import Any

from app.services import slack

MAX_SECTION = 2900
MINIMAL_TITLE = "Markdrop link — sign in to view"


def esc(text: Any) -> str:
    return str(text or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def cut(text: Any, n: int) -> str:
    t = " ".join(str(text or "").split()) if n < 400 else str(text or "").strip()
    return t if len(t) <= n else t[: max(0, n - 1)].rstrip() + "…"


def link(url: str, label: str) -> str:
    return f"<{url}|{esc(label).replace('|', '¦')}>"


def section(text: str, **extra) -> dict:
    return {"type": "section", "text": {"type": "mrkdwn", "text": cut(text, MAX_SECTION) or " "}, **extra}


def context(*texts: str) -> dict:
    return {"type": "context", "elements": [{"type": "mrkdwn", "text": cut(t, 300)} for t in texts if t][:10]}


def button(text: str, *, action_id: str, value: str | None = None, url: str | None = None,
           style: str | None = None) -> dict:
    b: dict[str, Any] = {"type": "button", "text": {"type": "plain_text", "text": cut(text, 75), "emoji": True},
                         "action_id": action_id}
    if value is not None:
        b["value"] = value[:2000]
    if url:
        b["url"] = url[:3000]
    if style:
        b["style"] = style
    return b


def open_button(url: str, label: str = "Open in Markdrop") -> dict:
    return button(label, action_id="md_open", url=url)


def actions(*elements: dict, block_id: str | None = None) -> dict:
    out: dict[str, Any] = {"type": "actions", "elements": list(elements)[:25]}
    if block_id:
        out["block_id"] = block_id
    return out


# ── Unfurls ───────────────────────────────────────────────────────────────────


def minimal_unfurl(url: str) -> dict:
    """What a channel sees for a link it may not all open: no title, no text."""
    return {"blocks": [
        section(f"*{link(url, MINIMAL_TITLE)}*"),
        context("Only people who can open it in Markdrop see what's behind this link."),
    ]}


def item_unfurl(url: str, title: str, *, kind: str, excerpt: str | None, where: str | None,
                updated: str | None) -> dict:
    meta = " · ".join(x for x in (kind, where, f"updated {updated}" if updated else None) if x)
    blocks = [section(f"*{link(url, cut(title, 150))}*" + (f"\n{esc(cut(excerpt, 300))}" if excerpt else ""))]
    if meta:
        blocks.append(context(esc(meta)))
    return {"blocks": blocks}


# ── /markdrop replies (ephemeral) ─────────────────────────────────────────────

HELP = (
    "*Markdrop in Slack* (only you see these replies)\n"
    "• `/markdrop search <words>` finds documents, pages, files and folders you can open\n"
    "• `/markdrop ask <question>` asks your workspace (Ask <Workspace>): answers from what you can open, with sources\n"
    "• `/markdrop meetings <question>` answers from your workspace's meetings\n"
    "• `/markdrop link` links your Slack account to your Markdrop account (once)\n"
    "• `/markdrop unlink` removes that link\n"
    "Direct messages for mentions, sign-off requests, shares and access requests are off until you turn "
    "them on in Markdrop: Settings › Account › Slack notifications."
)


def help_message(linked_as: str | None) -> dict:
    who = f"You're linked as *{esc(linked_as)}*." if linked_as else "Your Slack account isn't linked to Markdrop yet: `/markdrop link`."
    return {"blocks": [section(HELP), context(who)], "text": "Markdrop help"}


def link_prompt(url: str, why: str | None = None) -> dict:
    text = (why or "Link your Slack account to your Markdrop account first.") + \
        " Markdrop then answers from what *you* can open, and only you see the answers."
    return {"blocks": [section(text), actions(button("Link my Markdrop account", action_id="md_link", url=url,
                                                     style="primary"))],
            "text": "Link your Markdrop account"}


def notice(text: str) -> dict:
    return {"blocks": [section(text)], "text": cut(text, 150)}


def search_results(q: str, items: list[dict], *, more_url: str | None) -> dict:
    if not items:
        return notice(f"Nothing you can open matches *{esc(cut(q, 80))}*.")
    lines = []
    for it in items:
        title = it.get("title") or it.get("slug") or "Untitled"
        kind = {"page": "Page", "doc": "Document", "file": it.get("type_label") or "File", "folder": "Folder",
                "workspace": "Workspace", "guide": "Guide"}.get(it.get("kind"), "")
        where = (it.get("workspace") or {}).get("name") if isinstance(it.get("workspace"), dict) else None
        meta = " · ".join(x for x in (kind, where) if x)
        snip = ((it.get("snippet") or {}).get("text") if isinstance(it.get("snippet"), dict) else None) or ""
        line = f"*{link(it['web_url'], cut(title, 120))}*" + (f"  _{esc(meta)}_" if meta else "")
        if snip:
            line += f"\n{esc(cut(snip, 160))}"
        lines.append(line)
    blocks = [section(f"Results for *{esc(cut(q, 80))}*")]
    blocks += [section(x) for x in lines[:10]]
    if more_url:
        blocks.append(actions(open_button(more_url, "See all in Markdrop")))
    return {"blocks": blocks, "text": f"Results for {cut(q, 80)}"}


def answer(q: str, text: str, sources: list[dict], *, note: str | None = None) -> dict:
    """An AI answer: its [n] markers kept, the sources listed under it as links."""
    blocks = [context(f"_{esc(cut(q, 200))}_"), section(esc(text) or "No answer.")]
    if sources:
        src = "\n".join(f"[{s['n']}] {link(s['url'], cut(s.get('title') or 'Source', 100))}" for s in sources[:8])
        blocks.append(section("*Sources*\n" + src))
    blocks.append(context(note or "Only you can see this answer. Markdrop AI can make mistakes; check the sources."))
    return {"blocks": blocks, "text": cut(text, 150) or "Answer"}


# ── Meeting posts ─────────────────────────────────────────────────────────────


def meeting_post(team_id: str, post_id: str, *, title: str, url: str, when: str | None, summary: str | None,
                 decisions: list[str], items: list[dict]) -> dict:
    """``items``: [{block, text (mrkdwn, already escaped), done_by (name) | None}]."""
    head = f"*{link(url, cut(title, 150))}*" + (f"\n{esc(when)}" if when else "")
    blocks: list[dict] = [section(":spiral_note_pad: " + head)]
    if summary:
        blocks.append(section("*Summary*\n" + esc(cut(summary, 1200))))
    if decisions:
        blocks.append(section("*Decisions*\n" + "\n".join(f"• {esc(cut(d, 280))}" for d in decisions[:8])))
    if items:
        blocks.append(section("*Action items*"))
        for it in items[:20]:
            if it.get("done_by"):
                blocks.append(section(f":white_check_mark: ~{it['text']}~\n_Done by {esc(it['done_by'])}_"))
            else:
                blocks.append(section(f":white_large_square: {it['text']}", accessory=button(
                    "Done", action_id="md_done", value=slack.sign_value(team_id, "done", post_id, it["block"]))))
    blocks.append(actions(open_button(url, "Open the meeting")))
    return {"blocks": blocks[:50], "text": f"Meeting notes: {cut(title, 120)}"}


# ── Direct messages ───────────────────────────────────────────────────────────

SETTINGS_PATH = "/settings/account#slack"


def dm_footer() -> dict:
    """Every direct message says why it came and how to stop them (they're opt-in)."""
    return context(f"You turned these on in Markdrop · {link(slack.frontend_link(SETTINGS_PATH), 'Turn off')}")


def dm_mention(actor: str, title: str, url: str, excerpt: str | None) -> dict:
    text = f"*{esc(actor)}* mentioned you in *{link(url, cut(title, 120))}*"
    if excerpt:
        text += f"\n>{esc(cut(excerpt, 200))}"
    return {"blocks": [section(text), actions(open_button(url)), dm_footer()],
            "text": f"{actor} mentioned you in {cut(title, 80)}"}


def dm_shared(actor: str, title: str, url: str, role: str | None, message: str | None) -> dict:
    can = {"editor": "edit", "viewer": "view"}.get(role or "", "open")
    text = f"*{esc(actor)}* shared *{link(url, cut(title, 120))}* with you (you can {can} it)"
    if message:
        text += f"\n>{esc(cut(message, 300))}"
    return {"blocks": [section(text), actions(open_button(url)), dm_footer()],
            "text": f"{actor} shared {cut(title, 80)} with you"}


def dm_signoff(team_id: str, actor: str | None, title: str, url: str, label: str | None, doc_id: str, block: str,
               options: list[str], done: str | None = None) -> dict:
    what = f" on *{esc(cut(label, 120))}*" if label else ""
    if actor:
        text = f"*{esc(actor)}* asked for your sign-off{what} in *{link(url, cut(title, 120))}*"
    else:
        text = f"Your sign-off{what} in *{link(url, cut(title, 120))}*"
    blocks = [section(text)]
    if done:
        blocks.append(context(done))
        blocks.append(actions(open_button(url)))
    else:
        btns = [button(o, action_id=f"md_so_{i}", value=slack.sign_value(team_id, "so", doc_id, block, str(i)),
                       style="primary" if i == 0 else None) for i, o in enumerate(options[:4])]
        blocks.append(actions(*btns, open_button(url)))
    blocks.append(dm_footer())
    return {"blocks": blocks, "text": f"{actor or 'Someone'} asked for your sign-off in {cut(title, 80)}"}


def dm_access_request(team_id: str, requester: str, email: str | None, title: str, url: str, request_id: str,
                      edit: bool, message: str | None, as_admin: bool, done: str | None = None) -> dict:
    who = esc(requester) + (f" ({esc(email)})" if email and email != requester else "")
    verb = "edit" if edit else "open"
    text = f"*{who}* asked to {verb} *{link(url, cut(title, 120))}*"
    if as_admin:
        text += "\n_You're getting this as a workspace admin: its owner can't approve it._"
    if message:
        text += f"\n>{esc(cut(message, 300))}"
    blocks = [section(text)]
    if done:
        blocks.append(context(done))
        blocks.append(actions(open_button(url, "Open in Markdrop")))
    else:
        approve = "edit" if edit else "view"
        blocks.append(actions(
            button("Approve", action_id="md_ar_ok", value=slack.sign_value(team_id, "ar", request_id, approve), style="primary"),
            button("Decline", action_id="md_ar_no", value=slack.sign_value(team_id, "ar", request_id, "decline"), style="danger"),
            open_button(url, "Review in Markdrop")))
    blocks.append(dm_footer())
    return {"blocks": blocks, "text": f"{requester} asked to {verb} {cut(title, 80)}"}


# ── Action items after a meeting (services/slack_action_items.py) ─────────────


def dm_action_items(team_id: str, row_id: str, meetings: list[dict], *, stop_value: str) -> dict:
    """One person's action items from one meeting (or a few that ended close together).

    ``meetings``: [{title, when, url | None, organizer | None, can_edit, items: [{block, text (mrkdwn,
    already escaped), due | None, done}]}]. ``url`` only for someone whose Markdrop account may open
    the notes; without it the message holds the item text and who to ask, nothing else of the
    meeting. A Done button per open item only where ``can_edit``."""
    one = len(meetings) == 1
    if one:
        m = meetings[0]
        head = f"Your action items from *{esc(cut(m['title'], 120))}*" + (f" · {esc(m['when'])}" if m.get("when") else "")
    else:
        head = f"Your action items from {len(meetings)} meetings"
    blocks: list[dict] = [section(":clipboard: " + head)]
    for m in meetings:
        if not one:
            blocks.append(section(f"*{esc(cut(m['title'], 120))}*" + (f" · {esc(m['when'])}" if m.get("when") else "")))
        for it in m["items"][:15]:
            due = f"  _due {esc(cut(it['due'], 60))}_" if it.get("due") else ""
            if it.get("done"):
                blocks.append(section(f":white_check_mark: ~{it['text']}~"))
            elif m.get("can_edit"):
                blocks.append(section(f":white_large_square: {it['text']}{due}", accessory=button(
                    "Done", action_id="md_ai_done", value=slack.sign_value(team_id, "aid", row_id, it["block"]))))
            else:
                blocks.append(section(f":white_large_square: {it['text']}{due}"))
        if m.get("url"):
            blocks.append(actions(open_button(m["url"], "Open the notes")))
        else:
            who = f"ask {esc(cut(m['organizer'], 80))} for access" if m.get("organizer") else "ask the organizer for access"
            blocks.append(context(f"Notes are in Markdrop ({who})"))
    blocks = blocks[:47]
    blocks.append({"type": "divider"})
    blocks.append(section("_Sent after each meeting_", accessory=button(
        "Stop these", action_id="md_ai_stop", value=stop_value)))
    text = ("Your action items from " + cut(meetings[0]["title"], 100)) if one else \
        f"Your action items from {len(meetings)} meetings"
    return {"blocks": blocks, "text": text}


def action_items_stopped(start_value: str) -> dict:
    return {"blocks": [section("Done: Markdrop won't send you your action items after meetings any more.",
                               accessory=button("Turn back on", action_id="md_ai_start", value=start_value))],
            "text": "Action items after meetings: off"}
