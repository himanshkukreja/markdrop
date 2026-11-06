"""The Slack messages Markdrop sends (Block Kit), and the small design system they share.

Pure functions: no database, no network. Every message is built from the same pieces, so they read
alike in a channel, in a direct message and on a phone:

``eyebrow``      a one-line context above a direct message: what kind of message it is, and where
                 ("Mention · Senseloaf").
``header``       a channel post's title (plain text, Slack's large bold line).
``meta``         a context line of facts joined by " · " (date, duration, people, a link).
``section``      body text; ``row`` is one item of a list with an optional button beside it
                 (action items, each with its Done button).
``label``        a bold section title with an optional count ("*Action items* · 3 open").
``more``         "+N more in the notes" under a cut list.
``actions``      the message's buttons: one primary at most, link buttons are ``md_open*``.
``footer``       why this message came and how to stop it (always last in a DM).
``divider``      used sparingly: once between a post's reading part and its to-do part.

Rules: no emoji in our own words (the ✓ of a finished item is a text glyph); user-written text
always through :func:`esc` (Slack's three control characters) and cut to Slack's limits (3000
characters a section, 75 a button label, 150 a header, 50 blocks a message); every message has a
``text`` fallback that reads well in a notification on its own.
"""

from __future__ import annotations

import re
from typing import Any, Iterable

from app.services import slack

MAX_SECTION = 2900
MAX_BLOCKS = 50
MINIMAL_TITLE = "Markdrop link — sign in to view"
SEP = "  ·  "
DONE_MARK = "✓"


def esc(text: Any) -> str:
    return str(text or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def cut(text: Any, n: int) -> str:
    t = " ".join(str(text or "").split()) if n < 400 else str(text or "").strip()
    return t if len(t) <= n else t[: max(0, n - 1)].rstrip() + "…"


def link(url: str, label: str) -> str:
    return f"<{url}|{esc(label).replace('|', '¦')}>"


def plural(n: int, one: str, many: str | None = None) -> str:
    return f"{n} {one if n == 1 else (many or one + 's')}"


# ── The pieces ────────────────────────────────────────────────────────────────


def section(text: str, **extra) -> dict:
    return {"type": "section", "text": {"type": "mrkdwn", "text": cut(text, MAX_SECTION) or " "}, **extra}


def context(*texts: str) -> dict:
    return {"type": "context", "elements": [{"type": "mrkdwn", "text": cut(t, 3000 if len(t) > 300 else 300)}
                                            for t in texts if t][:10]}


def header(text: str) -> dict:
    return {"type": "header", "text": {"type": "plain_text", "text": cut(text, 150) or " ", "emoji": False}}


def meta(*parts: str | None) -> dict:
    """Facts in one quiet line: "Fri, Nov 7 · 10:00  ·  32 min  ·  6 people"."""
    return context(SEP.join(p for p in parts if p))


def eyebrow(kind: str, where: str | None = None) -> dict:
    """What a direct message is, above it: "*Mention*  ·  Senseloaf"."""
    return context(f"*{esc(kind)}*" + (f"{SEP}{esc(where)}" if where else ""))


def label(title: str, *counts: str | None) -> str:
    """A section's title line: "*Action items*  ·  3 open  ·  1 done"."""
    rest = SEP.join(c for c in counts if c)
    return f"*{esc(title)}*" + (f"{SEP}{rest}" if rest else "")


def bullets(lines: Iterable[str]) -> str:
    return "\n".join(f"•  {x}" for x in lines)


def more(n: int, url: str | None, what: str = "in the notes") -> dict | None:
    if n <= 0:
        return None
    return context(f"+{n} more {what}" + (f"{SEP}{link(url, 'Open')}" if url else ""))


def divider() -> dict:
    return {"type": "divider"}


def people_line(names: list[str], total: int | None = None, shown: int = 3) -> str | None:
    """"6 people: Maya, Alex, Sam +3" (first names)."""
    names = [n for n in (x.strip() for x in names) if n]
    total = max(total or 0, len(names))
    if not total:
        return None
    first = [esc(n.split()[0]) for n in names[:shown]]
    extra = total - len(first)
    who = ", ".join(first) + (f" +{extra}" if extra > 0 and first else "")
    return f"{plural(total, 'person', 'people')}: {who}" if first else plural(total, "person", "people")


def button(text: str, *, action_id: str, value: str | None = None, url: str | None = None,
           style: str | None = None) -> dict:
    b: dict[str, Any] = {"type": "button", "text": {"type": "plain_text", "text": cut(text, 75), "emoji": False},
                         "action_id": action_id}
    if value is not None:
        b["value"] = value[:2000]
    if url:
        b["url"] = url[:3000]
    if style:
        b["style"] = style
    return b


def open_button(url: str, label: str = "Open in Markdrop", *, primary: bool = False) -> dict:
    return button(label, action_id="md_open", url=url, style="primary" if primary else None)


def actions(*elements: dict, block_id: str | None = None) -> dict:
    out: dict[str, Any] = {"type": "actions", "elements": [e for e in elements if e][:25]}
    if block_id:
        out["block_id"] = block_id
    return out


def row(text: str, *, done_button: dict | None = None) -> dict:
    """One item of a list, its button (Done) beside it."""
    return section(text, accessory=done_button) if done_button else section(text)


def footer(*parts: str | None) -> dict:
    return context(SEP.join(p for p in parts if p))


def message(blocks: list[dict | None], text: str) -> dict:
    """A message: empty pieces dropped, at most 50 blocks (the last one, the footer, always kept)."""
    out = [b for b in blocks if b]
    if len(out) > MAX_BLOCKS:
        out = out[: MAX_BLOCKS - 1] + [out[-1]]
    return {"blocks": out, "text": cut(text, 300) or "Markdrop"}


def md_bold(text: str) -> str:
    """Escaped text with Markdown ``**bold**`` as Slack's ``*bold*`` (Google's notes bold their topics)."""
    return re.sub(r"\*\*([^*\n]{1,120}?)\*\*", r"*\1*", text)


_SENTENCE = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9“\"*(])")


def brief(text: str | None, *, sentences: int = 3, chars: int = 300) -> tuple[str, bool]:
    """A long summary as its first few sentences: (text, whether it was cut)."""
    t = " ".join(str(text or "").replace("\r", "").split())
    if not t:
        return "", False
    parts = _SENTENCE.split(t)
    out = ""
    for i, s in enumerate(parts):
        if i >= sentences or (out and len(out) + 1 + len(s) > chars):
            return out, True
        out = f"{out} {s}".strip()
    if len(out) > chars + 80:
        return cut(out, chars), True
    return out, False


# ── Unfurls ───────────────────────────────────────────────────────────────────


def minimal_unfurl(url: str) -> dict:
    """What a channel sees for a link it may not all open: no title, no text."""
    return {"blocks": [
        section(f"*{link(url, MINIMAL_TITLE)}*"),
        context("Only people who can open it in Markdrop see what's behind this link."),
    ]}


def item_unfurl(url: str, title: str, *, kind: str, excerpt: str | None, where: str | None,
                updated: str | None) -> dict:
    blocks = [section(f"*{link(url, cut(title, 150))}*" + (f"\n{esc(cut(excerpt, 300))}" if excerpt else ""))]
    facts = [esc(x) for x in (kind, where, f"Updated {updated}" if updated else None) if x]
    if facts:
        blocks.append(meta(*facts))
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
    who = f"You're linked as *{esc(linked_as)}*." if linked_as else \
        "Your Slack account isn't linked to Markdrop yet: `/markdrop link`."
    return message([
        header("Markdrop in Slack"),
        context("Only you see these replies."),
        section("*Find and ask*\n"
                "`/markdrop search <words>`\nDocuments, pages, files and folders you can open\n"
                "`/markdrop ask <question>`\nAsk your workspace: answers from what you can open, with sources\n"
                "`/markdrop meetings <question>`\nAnswers from your workspace's meetings"),
        section("*Your account*\n"
                "`/markdrop link`  Link your Slack account to your Markdrop account (once)\n"
                "`/markdrop unlink`  Remove that link"),
        section("*Direct messages*\nMentions, sign-off requests, shares and access requests are off until you "
                "turn them on in Markdrop: Settings › Account › Slack notifications. Your action items after "
                "a meeting come on their own; each message has *Stop these*."),
        footer(who, link(slack.frontend_link(SETTINGS_PATH), "Slack settings")),
    ], "Markdrop help")


def link_prompt(url: str, why: str | None = None) -> dict:
    text = (why or "Link your Slack account to your Markdrop account first.") + \
        " Markdrop then answers from what *you* can open, and only you see the answers."
    return {"blocks": [section(text), actions(button("Link my Markdrop account", action_id="md_link", url=url,
                                                     style="primary"))],
            "text": "Link your Markdrop account"}


def notice(text: str) -> dict:
    return {"blocks": [section(text)], "text": cut(text, 150)}


_KIND = {"page": "Page", "doc": "Document", "folder": "Folder", "workspace": "Workspace", "guide": "Guide"}


def search_results(q: str, items: list[dict], *, more_url: str | None) -> dict:
    if not items:
        return notice(f"Nothing you can open matches *{esc(cut(q, 80))}*.")
    blocks: list[dict | None] = [
        section(f"*{plural(len(items[:8]), 'result')}* for “{esc(cut(q, 80))}”"
                + (f"{SEP}{link(more_url, 'See all in Markdrop')}" if more_url else "")),
        divider(),
    ]
    for it in items[:8]:
        title = it.get("title") or it.get("slug") or "Untitled"
        kind = it.get("type_label") if it.get("kind") == "file" else _KIND.get(it.get("kind"), "")
        kind = kind or ("File" if it.get("kind") == "file" else "")
        where = (it.get("workspace") or {}).get("name") if isinstance(it.get("workspace"), dict) else None
        snip = ((it.get("snippet") or {}).get("text") if isinstance(it.get("snippet"), dict) else None) or ""
        blocks.append(section(f"*{link(it['web_url'], cut(title, 120))}*" + (f"\n{esc(cut(snip, 160))}" if snip else "")))
        facts = [esc(x) for x in (kind, where) if x]
        if facts:
            blocks.append(meta(*facts))
    if more_url:
        blocks.append(actions(open_button(more_url, "See all in Markdrop")))
    return message(blocks, f"Results for {cut(q, 80)}")


def answer(q: str, text: str, sources: list[dict], *, note: str | None = None) -> dict:
    """An AI answer: its [n] markers kept, the sources listed under it as links."""
    blocks: list[dict | None] = [context(f"*Asked*{SEP}“{esc(cut(q, 200))}”"), section(esc(text) or "No answer.")]
    if sources:
        src = "\n".join(f"`{s['n']}`  {link(s['url'], cut(s.get('title') or 'Source', 100))}" for s in sources[:8])
        blocks.append(section("*Sources*\n" + src))
    blocks.append(context(note or "Only you can see this answer. Markdrop AI can make mistakes; check the sources."))
    return message(blocks, cut(text, 150) or "Answer")


# ── Meeting posts ─────────────────────────────────────────────────────────────

MAX_DECISIONS = 5
MAX_QUESTIONS = 3
MAX_ITEMS = 8
GROUP_AT = 3        # someone with this many open items gets them under their name


def _item_line(it: dict, *, with_owner: bool = True) -> str:
    owner = it.get("owner") if with_owner else None
    task = it.get("text") or ""
    if it.get("done_by") is not None:
        who = it["done_by"]
        by = f"done by {esc(who)}" if who and who != "Markdrop" else "done"
        return f"{DONE_MARK}  " + (f"{owner} " if owner else "") + f"~{task}~{SEP}_{by}_"
    due = f"{SEP}_due {esc(it['due'])}_" if it.get("due") else ""
    return (f"{owner} " if owner else "") + task + due


def meeting_items(team_id: str, post_id: str, items: list[dict], url: str) -> list[dict]:
    """The action items as rows, open first (page order, someone with three or more under their own
    name), finished ones last; at most MAX_ITEMS, then "+N more in the notes"."""
    open_ = [i for i in items if i.get("done_by") is None]
    done = [i for i in items if i.get("done_by") is not None]
    count: dict[str, int] = {}
    for i in open_:
        if i.get("owner_key"):
            count[i["owner_key"]] = count.get(i["owner_key"], 0) + 1
    ordered: list[tuple[str | None, dict]] = []
    placed: set[str] = set()
    for i in open_:
        k = i.get("owner_key")
        if k and count.get(k, 0) >= GROUP_AT:
            if k in placed:
                continue
            placed.add(k)
            ordered += [(k, j) for j in open_ if j.get("owner_key") == k]
        else:
            ordered.append((None, i))
    ordered += [(None, i) for i in done]
    shown = ordered[:MAX_ITEMS]
    out: list[dict] = []
    group: str | None = None
    for key, it in shown:
        if key and key != group:
            n = count[key]
            out.append(context(f"{it.get('owner') or ''}{SEP}{plural(n, 'item')}"))
        group = key
        btn = None if it.get("done_by") is not None else button(
            "Done", action_id="md_done", value=slack.sign_value(team_id, "done", post_id, it["block"]))
        out.append(row(_item_line(it, with_owner=key is None), done_button=btn))
    left = len(ordered) - len(shown)
    if left > 0:
        out.append(more(left, url))
    return out


def meeting_post(team_id: str, post_id: str, *, title: str, url: str, when: str | None, summary: str | None,
                 decisions: list[str], items: list[dict], day: str | None = None, duration: str | None = None,
                 series: str | None = None, people: list[str] | None = None, people_total: int | None = None,
                 open_questions: list[str] | None = None) -> dict:
    """A meeting's notes in its workspace's meetings channel.

    ``items``: [{block, text (mrkdwn, already escaped), owner (mrkdwn: ``<@U…>`` or ``*Name*``) | None,
    owner_key | None, due (plain) | None, done_by (name; "" when it was done before posting) | None}].
    Posts saved before the redesign have only {block, text, done_by}: they render too."""
    title = cut(title, 150) or "Meeting"
    facts = [esc(when) if when else None, esc(duration) if duration else None,
             f"Series: {esc(cut(series, 60))}" if series and series.casefold() != title.casefold() else None,
             people_line(people or [], people_total), link(url, "Open notes")]
    blocks: list[dict | None] = [header(title), meta(*facts)]
    short, was_cut = brief(summary)
    if short:
        body = md_bold(esc(short)) + (f"  {link(url, 'Read the full notes →')}" if was_cut else "")
        blocks.append(section("*Summary*\n" + body))
    decisions = [d for d in decisions if d and str(d).strip()]
    if decisions:
        lines = [esc(cut(d, 280)) for d in decisions[:MAX_DECISIONS]]
        extra = len(decisions) - MAX_DECISIONS
        blocks.append(section(label("Decisions") + "\n" + bullets(lines)
                              + (f"\n_+{extra} more in the notes_" if extra > 0 else "")))
    questions = [q for q in (open_questions or []) if q and str(q).strip()]
    if questions:
        extra = len(questions) - MAX_QUESTIONS
        blocks.append(section(label("Open questions") + "\n" + bullets(esc(cut(q, 240)) for q in questions[:MAX_QUESTIONS])
                              + (f"\n_+{extra} more in the notes_" if extra > 0 else "")))
    n_open = sum(1 for i in items if i.get("done_by") is None)
    n_done = len(items) - n_open
    if items:
        blocks.append(divider())
        blocks.append(section(label("Action items", f"{n_open} open" if n_open else "all done",
                                    f"{n_done} done" if n_done and n_open else None)))
        blocks += meeting_items(team_id, post_id, items, url)
    blocks.append(actions(open_button(url, "Open notes", primary=True)))
    blocks.append(footer("Posted by Markdrop", "Meetings restricted to their attendees are never posted"))
    counts = [plural(len(decisions), "decision") if decisions else None,
              plural(len(items), "action item") if items else None]
    fallback = f"{title}" + (f" · {day}" if day else "") + ": " + (", ".join(c for c in counts if c) or "meeting notes")
    return message(blocks, fallback)


# ── Direct messages ───────────────────────────────────────────────────────────

SETTINGS_PATH = "/settings/account#slack"


def dm_footer() -> dict:
    """Every direct message says why it came and how to stop them (they're opt-in)."""
    return context(f"You turned these on in Markdrop · {link(slack.frontend_link(SETTINGS_PATH), 'Turn off')}")


def _quote(text: str | None, n: int = 300) -> str:
    return f"\n>{esc(cut(text, n))}" if text else ""


def dm_mention(actor: str, title: str, url: str, excerpt: str | None, *, where: str | None = None) -> dict:
    return message([
        eyebrow("Mention", where),
        section(f"*{esc(actor)}* mentioned you in *{link(url, cut(title, 120))}*" + _quote(excerpt, 200)),
        actions(open_button(url, "Open the mention", primary=True)),
        dm_footer(),
    ], f"{actor} mentioned you in {cut(title, 80)}")


def dm_shared(actor: str, title: str, url: str, role: str | None, message_: str | None = None, *,
              where: str | None = None) -> dict:
    can = {"editor": "edit", "viewer": "view"}.get(role or "", "open")
    return message([
        eyebrow("Shared with you", where),
        section(f"*{esc(actor)}* shared *{link(url, cut(title, 120))}* with you" + _quote(message_)),
        meta(f"You can {can} it"),
        actions(open_button(url, "Open it", primary=True)),
        dm_footer(),
    ], f"{actor} shared {cut(title, 80)} with you")


def dm_signoff(team_id: str, actor: str | None, title: str, url: str, label_: str | None, doc_id: str, block: str,
               options: list[str], done: str | None = None, *, where: str | None = None) -> dict:
    what = f" on *{esc(cut(label_, 120))}*" if label_ else ""
    if actor:
        text = f"*{esc(actor)}* asked for your sign-off{what} in *{link(url, cut(title, 120))}*"
    else:
        text = f"Your sign-off{what} in *{link(url, cut(title, 120))}*"
    blocks: list[dict | None] = [eyebrow("Sign-off requested" if not done else "Sign-off", where), section(text)]
    if done:
        blocks.append(context(f"{DONE_MARK}  {done}"))
        blocks.append(actions(open_button(url, "Open the page")))
    else:
        btns = [button(o, action_id=f"md_so_{i}", value=slack.sign_value(team_id, "so", doc_id, block, str(i)),
                       style="primary" if i == 0 else None) for i, o in enumerate(options[:4])]
        blocks.append(actions(*btns, open_button(url, "Open the page")))
    blocks.append(dm_footer())
    return message(blocks, f"{actor or 'Someone'} asked for your sign-off in {cut(title, 80)}")


def dm_access_request(team_id: str, requester: str, email: str | None, title: str, url: str, request_id: str,
                      edit: bool, message_: str | None, as_admin: bool, done: str | None = None) -> dict:
    verb = "edit" if edit else "open"
    blocks: list[dict | None] = [
        eyebrow("Edit access request" if edit else "Access request", "as a workspace admin" if as_admin else None),
        section(f"*{esc(requester)}* asked to {verb} *{link(url, cut(title, 120))}*" + _quote(message_)),
        meta(esc(email) if email and email != requester else None,
             "Its owner can't approve it, so it came to the workspace's admins" if as_admin else None),
    ]
    if done:
        blocks.append(context(f"{DONE_MARK}  {done}"))
        blocks.append(actions(open_button(url, "Open in Markdrop")))
    else:
        approve = "edit" if edit else "view"
        blocks.append(actions(
            button("Approve", action_id="md_ar_ok", value=slack.sign_value(team_id, "ar", request_id, approve), style="primary"),
            button("Decline", action_id="md_ar_no", value=slack.sign_value(team_id, "ar", request_id, "decline"), style="danger"),
            open_button(url, "Review in Markdrop")))
    blocks.append(dm_footer())
    return message(blocks, f"{requester} asked to {verb} {cut(title, 80)}")


# ── Action items after a meeting (services/slack_action_items.py) ─────────────


def dm_action_items(team_id: str, row_id: str, meetings: list[dict], *, stop_value: str) -> dict:
    """One person's action items from one meeting (or a few that ended close together).

    ``meetings``: [{title, when, url | None, organizer | None, can_edit, items: [{block, text (mrkdwn,
    already escaped), due | None, done}]}]. ``url`` only for someone whose Markdrop account may open
    the notes; without it the message holds the item text and who to ask, nothing else of the
    meeting. A Done button per open item only where ``can_edit``."""
    one = len(meetings) == 1
    n_items = sum(len(m["items"]) for m in meetings)
    if one:
        m = meetings[0]
        head = f"Your action items from *{esc(cut(m['title'], 120))}*"
    else:
        head = f"Your action items from {len(meetings)} meetings"
    blocks: list[dict | None] = [eyebrow("Your action items", esc(meetings[0].get("when")) if one and meetings[0].get("when") else None),
                                 section(head)]
    for m in meetings:
        if not one:
            blocks.append(divider())
            blocks.append(section(f"*{esc(cut(m['title'], 120))}*" + (f"{SEP}{esc(m['when'])}" if m.get("when") else "")))
        for it in m["items"][:15]:
            due = f"\n_due {esc(cut(it['due'], 60))}_" if it.get("due") else ""
            if it.get("done"):
                blocks.append(row(f"{DONE_MARK}  ~{it['text']}~{SEP}_done_"))
            elif m.get("can_edit"):
                blocks.append(row(f"{it['text']}{due}", done_button=button(
                    "Done", action_id="md_ai_done", value=slack.sign_value(team_id, "aid", row_id, it["block"]))))
            else:
                blocks.append(row(f"{it['text']}{due}"))
        if m.get("url"):
            blocks.append(actions(open_button(m["url"], "Open the notes", primary=one)))
        else:
            who = f"ask {esc(cut(m['organizer'], 80))} for access" if m.get("organizer") else "ask the organizer for access"
            blocks.append(context(f"Notes are in Markdrop ({who})"))
    blocks = [b for b in blocks if b][:46]
    blocks.append(divider())
    blocks.append(section("_Sent after each meeting where you have an action item_", accessory=button(
        "Stop these", action_id="md_ai_stop", value=stop_value)))
    text = (f"Your action items from {cut(meetings[0]['title'], 100)}" if one else
            f"Your action items from {len(meetings)} meetings") + f" ({n_items})"
    return {"blocks": blocks, "text": text}


def action_items_stopped(start_value: str) -> dict:
    return {"blocks": [section("Done: Markdrop won't send you your action items after meetings any more.",
                               accessory=button("Turn back on", action_id="md_ai_start", value=start_value))],
            "text": "Action items after meetings: off"}


# ── Team's weekly summary (services/team_extras.py) ───────────────────────────


def team_weekly(*, workspace: str, team_url: str, span: str | None, highlights: list[dict], decisions: list[dict],
                blockers: list[dict], due: list[dict], overdue: list[dict], meetings: list[dict]) -> dict:
    """"This week in <Workspace>" in the meetings channel (Monday, or Send now).

    Each list holds dicts already reduced to plain values: highlights {who, text, src: (title, url) | None},
    decisions {text, src}, blockers {who, text, waiting_on}, due / overdue {who, text, when, late},
    meetings {title, url, when}."""
    def src(s) -> str:
        return f"{SEP}{link(s[1], cut(s[0], 60))}" if s else ""

    counts = [plural(len(highlights), "highlight") if highlights else None,
              plural(len(decisions), "decision") if decisions else None,
              f"{len(due)} due" if due else None, f"{len(overdue)} overdue" if overdue else None,
              plural(len(blockers), "blocker") if blockers else None,
              plural(len(meetings), "meeting") if meetings else None]
    blocks: list[dict | None] = [header(f"This week in {workspace}"), meta(esc(span) if span else None, *counts)]
    if highlights:
        first = {}
        for i, h in enumerate(highlights):
            first.setdefault(h.get("who") or "", i)
        highlights = sorted(highlights, key=lambda h: first[h.get("who") or ""])   # one person's lines together
        blocks.append(section(label("Highlights") + "\n" + bullets(
            f"*{esc(h['who'])}*  {esc(h['text'])}{src(h.get('src'))}" if h.get("who") else f"{esc(h['text'])}{src(h.get('src'))}"
            for h in highlights[:8])))
    if decisions:
        blocks.append(section(label("Decisions") + "\n" + bullets(f"{esc(d['text'])}{src(d.get('src'))}" for d in decisions[:5])))
    if due or overdue or blockers:
        blocks.append(divider())
    if overdue:
        blocks.append(section(label("Overdue", str(len(overdue))) + "\n" + bullets(
            f"*{esc(x['who'])}*  {esc(x['text'])}{SEP}_{esc(x['when'])}, {esc(x['late'])}_" for x in overdue[:10])))
    if due:
        blocks.append(section(label("Due this week", str(len(due))) + "\n" + bullets(
            f"*{esc(x['who'])}*  {esc(x['text'])}{SEP}_{esc(x['when'])}_" for x in due[:12])))
    if blockers:
        blocks.append(section(label("Blocked") + "\n" + bullets(
            f"*{esc(b['who'])}*  {esc(b['text'])}" + (f"{SEP}_waiting on {esc(b['waiting_on'])}_" if b.get("waiting_on") else "")
            for b in blockers[:8])))
    if meetings:
        blocks.append(section(label("Meetings this week") + "\n" + bullets(
            f"{link(m['url'], cut(m['title'], 80))}{SEP}_{esc(m['when'])}_" if m.get("url") else
            f"{esc(m['title'])}{SEP}_{esc(m['when'])}_" for m in meetings[:8])))
    blocks.append(actions(open_button(team_url, "Open Team", primary=True)))
    blocks.append(footer("Only from meetings and pages everyone in the workspace can open", "Sent every Monday"))
    return message(blocks, f"This week in {workspace}: " + (", ".join(c for c in counts if c) or "a quiet week"))
