"""Transactional email: what each message says, and the one send path.

Every email is built from the design system in ``services/email_kit.py`` (one layout, shared
components, an HTML part and a plain-text part from the same content, light and dark). This module
holds the account and sharing emails (sign-in, welcome, workspace invite, document share, access
requests and decisions, a guide's own domain) and the small helpers other modules still use to put
their own content in the same layout (``_shell``, ``_p``, ``_button`` …: the email-preference pages,
the campaign editor's blocks).

Senders (``_sender``): ``login`` only for sign-in codes and sign-in links; ``welcome`` for the
welcome and the weekly analytics email; ``share`` (notifications@) for everything else. Every send
goes through :func:`_post` → ``services/email_delivery.py`` (routing, daily limits, ``email_log``).

Each ``compose_*`` returns ``{subject, preheader, html, text}``; the message gallery
(``services/message_gallery.py``) renders the same functions from fixtures.
"""

import html

from app.config import get_settings
from app.services import email_kit as K
from app.services.email_kit import Footer, Html

settings = get_settings()

# ── Palette (kept for modules that style their own bits: campaigns, analytics) ─

_GROUND = K.GROUND
_CARD = K.CARD
_LINE = K.LINE
_ACCENT = K.ACCENT
_INK = K.INK
_BODY = K.BODY
_MUTED = K.MUTED
_INSET = K.INSET
_SANS = K.SANS
_MONO = K.MONO


def _base() -> str:
    return settings.frontend_url.rstrip("/")


def _mail(subject: str, preheader: str, e: "K.Email") -> dict:
    return {"subject": subject, "preheader": preheader, "html": e.html, "text": e.text}


def _site() -> Html:
    return K.link(_base(), "markdrop.in", muted=True)


# ── Small helpers in the shared layout (pages and campaign blocks use these) ───
#
# They take markup the caller already escaped, as before.


def _eyebrow(text: str) -> str:
    return K.eyebrow(html.unescape(text)).html


def _heading(text: str, tag: str = "h1") -> str:
    return K.title(Html(text)).html


def _p(inner: str, *, size: int = 15, color: str = _BODY, margin: str = "0 0 16px") -> str:
    return K.p(Html(inner), size=size, muted=color == _MUTED, margin=margin).html


def _strong(text: str) -> str:
    return K.strong(Html(text))


def _link(href: str, label: str) -> str:
    return K.link(html.unescape(href), Html(label))


def _button(href: str, label: str, *, margin: str = "8px 0 24px") -> str:
    return K.button(html.unescape(href), html.unescape(label), margin=margin).html


def _ghost_button(href: str, label: str) -> str:
    return K.button(html.unescape(href), html.unescape(label), secondary=True, margin="0 0 10px").html


def _rule() -> str:
    return K.divider("8px 0 20px").html


def _footer_link(href: str, label: str) -> str:
    return K.link(html.unescape(href), Html(label), muted=True)


def _shell(*, title: str, content: str, footer: str, preheader: str = "", page: bool = False,
           top_label: str = "") -> str:
    """``content`` (markup) in the shared layout. ``title``, ``preheader``, ``top_label`` and
    ``footer`` arrive escaped (callers escape user text), as before."""
    return K.layout(title_=html.unescape(title), body=[K.raw(content)], footer=Footer(why=Html(footer)),
                    preheader=html.unescape(preheader), label_=html.unescape(top_label), base=_base(), page=page).html


def _sender(purpose: str) -> str:
    """`Name <address>` for one kind of message.

    Falls back to the shared address when a purpose-specific one is not
    configured, so adding these is a DNS task that can happen later without
    breaking sending in the meantime.
    """
    address = {
        "login": settings.email_from_login,
        "welcome": settings.email_from_welcome,
        "share": settings.email_from_share,
    }.get(purpose) or settings.email_from
    return f"{settings.email_from_name} <{address}>"


def is_configured() -> bool:
    """Some email provider (Resend or Brevo) is configured."""
    from app.services import email_delivery

    return email_delivery.configured()


async def _post(payload: dict, *, kind: str, ref: str | None = None) -> str:
    """Send one message through the one send path (services/email_delivery.py):
    routed to a provider with room today, logged in ``email_log``. ``kind`` sets
    the priority tier (sign-in codes first, bulk last). Returns ``sent``, or
    ``deferred`` when today's limit queued it for tomorrow; raises when every
    provider failed."""
    from app.services import email_delivery

    r = await email_delivery.send(payload, kind=kind, ref=ref)
    return r.status


def _one_line(text: str, limit: int = 120) -> str:
    """A header-safe single line: a display name or title is chosen by someone
    else and may carry CR/LF or other control characters, which don't belong
    in a Subject (providers reject them, so the email silently never goes)."""
    cleaned = "".join(" " if (ord(ch) < 32 or ord(ch) == 127 or ch in "  ") else ch
                      for ch in text)
    cleaned = " ".join(cleaned.split())
    return cleaned if len(cleaned) <= limit else cleaned[: limit - 1].rstrip() + "…"


async def _send(to: list[str] | str, mail: dict, *, purpose: str, kind: str, ref: str | None = None,
                headers: dict | None = None) -> str:
    payload = {"from": _sender(purpose), "to": [to] if isinstance(to, str) else to, "subject": mail["subject"],
               "reply_to": settings.email_reply_to, "html": mail["html"], "text": mail["text"]}
    if headers:
        payload["headers"] = headers
    return await _post(payload, kind=kind, ref=ref)


# ── Sign-in ────────────────────────────────────────────────────────────────────


def compose_login(otp: str, link_url: str) -> dict:
    minutes = int(settings.login_challenge_ttl_minutes)
    e = K.layout(
        title_="Your Markdrop sign-in code", preheader=f"Your sign-in code is {otp}. It expires in {minutes} minutes.",
        base=_base(), body=[
            K.eyebrow("Sign in"),
            K.title("Your sign-in code"),
            K.p("Enter this code where you asked for it, or sign in with the button."),
            K.code(otp),
            K.small(f"It expires in {minutes} minutes and works once.", margin="0 0 20px"),
            K.button(link_url, "Sign in to Markdrop", margin="0 0 24px"),
        ],
        footer=Footer(why="Didn't ask to sign in? You can ignore this email. Nobody can get in without the code."))
    return _mail(f"Your Markdrop sign-in code: {otp}", f"Your sign-in code is {otp}", e)


def _login_html(otp: str, link_url: str) -> str:
    return compose_login(otp, link_url)["html"]


async def send_login_email(to_email: str, otp: str, link_url: str) -> None:
    """Send the passwordless login email (code + magic link). Raises on failure."""
    await _send(to_email, compose_login(otp, link_url), purpose="login", kind="login")


# ── Welcome / feature-tour email (sent once, on first signup) ───────────────────

_MARKETPLACE_URL = (
    "https://marketplace.visualstudio.com/items?itemName=HimanshuKukreja.markdrop"
)

# Product-demo hero (code-rendered GIF on ImageKit, kept off the app repo since
# it's a binary). Dark artwork, shown as an image-only block with alt text, so a
# blocked image still says what it was.
_HERO_IMAGE = "https://ik.imagekit.io/jrcgzv9vw/markdrop/email/welcome-hero-hd.gif"
_HERO_ALT = "Markdrop: documents and files become links that render in any browser"

# Owner rule (2026-10-13): P2P copy always discloses that a relay may carry the
# bytes. The sentence says "may", so it stays true whether or not the TURN relay
# is configured; it errs toward disclosure rather than a stronger privacy claim.
_P2P_RELAY_LIVE = True
_P2P_RELAY_SENTENCE = " If a network blocks a direct path, an encrypted relay may forward bytes it cannot read."

# (icon filename, title, description, CTA label, CTA href-key). Icons are the
# existing hosted PNG tiles under {frontend_url}/email/. NEVER rename or delete
# those files: emails already in inboxes reference them. New icons get new names
# (and must reach production before any email references them).
_FEATURES = [
    ("publish", "Documents that render",
     "Write or paste markdown and AI write-ups and get a link that opens rendered in any browser, with syntax highlighting and PDF export. Choose who can open it: anyone with the link, only people you name, or your whole team.",
     "Create a document", "new"),
    ("diagram", "Diagrams, charts & math",
     "Add a mermaid block or LaTeX between $$ … $$ and Markdrop renders flowcharts, sequence and Gantt diagrams, charts and typeset math.",
     "Try a diagram", "diagrams"),
    ("artifact", "Files that render: HTML, PDFs, sheets & video",
     "Upload an HTML page, a PDF, a spreadsheet, a Word doc, a video or a zipped site and get a link that opens it rendered, instead of a download. Rendered on an isolated domain, so a published page can never reach your account.",
     "Upload a file", "upload"),
    ("builder", "README builder",
     "Assemble a README from 45+ drag-and-drop section blocks (badges, install steps, API tables, diagrams), then publish it or download the .md.",
     "Open the builder", "builder"),
    ("share", "Send any file, device to device",
     "Encrypted device to device: the files go straight from your browser to theirs and are never stored on our servers. Markdrop keeps file details and connection info.",
     "Send a file", "share"),
    ("sync", "Sync from VS Code",
     "Publish and two-way sync your markdown from your editor: save locally to push, edit on the web to pull back, with safe conflict diffs.",
     "Get the extension", "extension"),
    ("docs", "Analytics",
     "See views, countries and referrers for every link you publish, from your dashboard.",
     "Open the dashboard", "dashboard"),
]


def compose_welcome(name: str | None) -> dict:
    base = _base()
    img = f"{base}/email"
    urls = {
        "new": f"{base}/new", "diagrams": f"{base}/new?sample=diagrams", "upload": f"{base}/upload",
        "builder": f"{base}/builder", "share": f"{base}/share", "record": f"{base}/share#what-we-record",
        "dashboard": f"{base}/dashboard", "extension": _MARKETPLACE_URL, "workspaces": f"{base}/settings/workspaces",
    }
    clean = (name or "").strip()
    greeting = f"Welcome, {clean}" if clean else "Welcome to Markdrop"

    rows = []
    for i, (icon, title, desc, cta, key) in enumerate(_FEATURES):
        body = [desc]
        if key == "share":
            body = [desc + (_P2P_RELAY_SENTENCE if _P2P_RELAY_LIVE else ""), " ", K.link(urls["record"], "What we record")]
        last = i == len(_FEATURES) - 1
        border = "" if last else f"border-bottom:1px solid {K.LINE};"
        part = K.item(K.strong(title), body=body, href=urls[key], action=cta, last=last)
        # The feature's icon tile instead of an avatar (decorative: alt="").
        icon_cell = (f'<td width="52" valign="top" class="md-line" style="padding:14px 0;{border}">'
                     f'<img src="{img}/{icon}.png" width="40" height="40" alt="" style="display:block;width:40px;'
                     f'height:40px;border:0;outline:none;text-decoration:none;border-radius:10px"></td>')
        rows.append(K.Part(part.html.replace("<tr>", "<tr>" + icon_cell, 1), part.text))

    team = K.card(
        K.eyebrow("Working with a team"),
        K.p([K.strong("Your own domain, your own brand. "), "Point ", K.mono("docs.yourcompany.com"),
             " at Markdrop and we issue the certificate. Your name, logo and colour on every page and link "
             "preview, with the option to drop Markdrop branding entirely."], size=14, margin="0 0 10px"),
        K.p([K.strong("A shared library. "), "Documents and files your team can all reach, in folders, with roles. "
             "Your private documents stay private: putting something in a workspace is always your choice."],
            size=14, margin="0 0 10px"),
        K.p([K.strong("Share with exactly who you mean. "), "Anyone with the link, only the people you name, or "
             "everyone in the workspace. You can name someone outside your company by email."], size=14, margin="0 0 12px"),
        K.p(K.link(urls["workspaces"], "Create a workspace →"), size=14, margin="0"),
        inset=True, pad="18px 20px")
    hero = K.Part(f'<a href="{K.esc(base)}" style="text-decoration:none;display:block;margin:0 0 24px">'
                  f'<img src="{_HERO_IMAGE}" width="536" alt="{K.esc(_HERO_ALT)}" style="display:block;width:100%;'
                  f'max-width:536px;height:auto;border:0;border-radius:10px;font-family:{K.SANS};font-size:14px;'
                  f'color:{K.BODY}"></a>', "")
    preheader = ("Drop it. It renders. Markdown, AI write-ups, HTML pages, PDFs, spreadsheets, Word docs, video and "
                 "zipped sites become links that open in any browser.")
    e = K.layout(
        title_="Welcome to Markdrop", preheader=preheader, base=base, body=[
            hero,
            K.eyebrow("Your account is ready"),
            K.title(greeting),
            K.lead("Drop it. It renders. Write or paste markdown and AI write-ups, or upload HTML pages, PDFs, "
                   "spreadsheets, Word docs, video and zipped sites. Each one becomes a link that opens in any "
                   "browser, with no download and no app. For one person, or a whole team on its own domain."),
            K.button(urls["new"], "Start writing", margin="0 0 28px"),
            K.heading("What you can do", top=0),
            K.rows(rows, margin="0 0 20px"),
            team,
        ],
        footer=Footer(why=Html(
            f"You're getting this because you signed up at {_site()}. It's the only welcome email we send. "
            f"Markdrop is open source: {K.link('https://github.com/himanshkukreja/markdrop', 'star it on GitHub', muted=True)}.")))
    return _mail("Welcome to Markdrop: everything you can do", preheader, e)


def _welcome_html(name: str | None) -> str:
    return compose_welcome(name)["html"]


async def send_welcome_email(to_email: str, name: str | None = None) -> None:
    """Send the one-time welcome / feature-tour email. Raises on failure."""
    await _send(to_email, compose_welcome(name), purpose="welcome", kind="welcome")


# ── Workspace invitations ──────────────────────────────────────────────────────

_ROLE_BLURB = {
    "admin": "manage members, domains and branding",
    "member": "create and publish documents",
    "viewer": "read what the workspace publishes",
}


def _invite_ttl_days() -> int:
    try:  # the source of truth; imported lazily so a rename there can't break mail
        from app.services.invitation import INVITE_TTL_DAYS
        return int(INVITE_TTL_DAYS)
    except Exception:
        return 7


def compose_invite(workspace_name: str, inviter_name: str, role: str, link_url: str) -> dict:
    # All free text chosen by a user, about to land in someone else's inbox: the kit escapes it.
    blurb = _ROLE_BLURB.get(role, "collaborate")
    days = _invite_ttl_days()
    head = f"{inviter_name} invited you to {workspace_name}"
    ws_row = K.rows([K.item(K.strong(workspace_name), who=workspace_name,
                            meta=f"You'd join as {role.capitalize()}: {blurb}.", last=True, pad=4)], margin="0")
    e = K.layout(
        title_=f"Join {workspace_name} on Markdrop", preheader=f"{inviter_name} invited you to the {workspace_name} workspace on Markdrop.",
        base=_base(), label_=workspace_name, body=[
            K.eyebrow("Workspace invitation"),
            K.title(head),
            K.p("Nothing happens until you accept, and you can decline just as easily."),
            K.card(ws_row, inset=True, pad="12px 16px"),
            K.button(link_url, "View invitation", margin="4px 0 24px"),
            K.small("To accept, sign in to Markdrop with this email address. If you don't have an account yet, you "
                    "can create one on the way."),
        ],
        footer=Footer(why=f"This invitation expires in {days} days. Didn't expect it? You can ignore this email: you "
                          "won't be added to anything unless you accept."))
    return _mail(f"{inviter_name} invited you to {workspace_name} on Markdrop",
                 f"{inviter_name} invited you to the {workspace_name} workspace on Markdrop.", e)


def _invite_html(workspace_name: str, inviter_name: str, role: str, link_url: str) -> str:
    return compose_invite(workspace_name, inviter_name, role, link_url)["html"]


async def send_invite_email(
    *, to_email: str, workspace_name: str, inviter_name: str, role: str, token: str
) -> None:
    """Send a workspace invitation. Raises on failure, which the caller treats as
    grounds to withdraw the invitation -- an invite nobody can receive is worse
    than none, because it shows as pending in the admin list forever."""
    link_url = f"{_base()}/invite/{token}"
    await _send(to_email, compose_invite(workspace_name, inviter_name, role, link_url), purpose="share", kind="invite")


# ── Document sharing ───────────────────────────────────────────────────────────

_SHARE_ROLE = {
    "viewer": "read it",
    "editor": "read and edit it",
}


def compose_share(*, document_title: str, url: str, sharer_name: str, role: str, encrypted: bool,
                  message: str | None, noun: str = "document") -> dict:
    can = _SHARE_ROLE.get(role, "read it")
    body = [
        K.eyebrow("Shared with you"),
        K.title(f"{sharer_name} shared a {noun} with you"),
        K.quote(message, who=sharer_name) if message else None,
        K.doc_card(document_title, url, meta=f"You can {can}"),
        # An encrypted document can't be unlocked by a permission: the key is in the link's
        # fragment and never reached us.
        K.callout(["Open it with the full link, including everything after the ", K.mono("#"),
                   ". Access alone can't decrypt it."], tone="warn", title_="This document is end-to-end encrypted.")
        if encrypted else None,
        K.button(url, f"Open the {noun}", margin="4px 0 24px"),
        K.small(["Sign in to Markdrop with ", K.strong("this email address"), " to open it. You can create an account "
                 "with it if you don't have one. Access is tied to the address, not to a link anyone could forward."]),
    ]
    e = K.layout(title_=document_title or "Shared with you", preheader=f"{sharer_name} shared “{document_title}” with you on Markdrop.",
                 base=_base(), body=body,
                 footer=Footer(why="Didn't expect this? You can ignore it: nothing opens until you sign in with this address."))
    return _mail(f"{sharer_name} shared “{document_title}” with you",
                 f"{sharer_name} shared “{document_title}” with you on Markdrop.", e)


def _share_html(**kw) -> str:
    return compose_share(**kw)["html"]


async def send_document_share_email(
    *, to_email: str, document_title: str, slug: str,
    sharer_name: str, role: str, encrypted: bool, message: str | None = None,
    noun: str = "document",
) -> None:
    """Tell someone a document was shared with them. Raises on failure.

    The caller treats a failure as non-fatal: the grant is real whether or not
    the email arrived, and revoking someone's access because a mail server was
    slow would be the worse outcome.
    """
    # `/<slug>`, never `/<folder>/<slug>`: markdrop.in serves every document at `/<slug>`, and a
    # custom host has no `/login`, which everyone a share email reaches may need.
    url = f"{_base()}/{slug}"
    mail = compose_share(document_title=document_title, url=url, sharer_name=sharer_name, role=role,
                         encrypted=encrypted, message=message, noun=noun)
    mail["subject"] = f"{_one_line(sharer_name, 60)} shared “{_one_line(document_title)}” with you"
    await _send(to_email, mail, purpose="share", kind="share", ref=slug)


# ── Access requests ────────────────────────────────────────────────────────────


def compose_access_request(*, requester_name: str, requester_email: str, document_title: str, message: str | None,
                           request_id: str, workspace_name: str | None) -> dict:
    base = f"{_base()}/requests/{request_id}"
    who = K.rows([K.item(K.strong(requester_name), who=requester_name,
                         meta=[K.mono(requester_email)] + ([f"  ·  not in {workspace_name}"] if workspace_name else []),
                         last=True, pad=4)], margin="0 0 16px")
    e = K.layout(
        title_=f"{requester_name} asked to open {document_title}",
        preheader=f"{requester_name} ({requester_email}) asked for access to “{document_title}”.", base=_base(), body=[
            K.eyebrow("Access request"),
            K.title(f"{requester_name} asked to open “{document_title}”"),
            who,
            K.quote(message) if message else None,
            K.buttons((f"{base}?action=view", "Let them view"), (f"{base}?action=edit", "Let them edit"),
                      (f"{base}?action=decline", "Decline"), margin="4px 0 20px"),
            K.small("This shares only this item with them. "
                    + ("It doesn't add them to your workspace. " if workspace_name else "")
                    + "You'll be asked to sign in before anything changes."),
        ],
        footer=Footer(why="You're getting this because you own the document. Ignore it and nothing changes."))
    return _mail(f"{_one_line(requester_name, 60)} asked to open “{_one_line(document_title)}”",
                 f"{requester_name} ({requester_email}) asked for access to “{document_title}”.", e)


def _access_request_html(**kw) -> str:
    return compose_access_request(**kw)["html"]


async def send_access_request_email(
    *, to_email: str, requester_name: str, requester_email: str, document_title: str,
    message: str | None, request_id: str, workspace_name: str | None = None,
) -> None:
    """Tell a document's owner someone asked to open it. Raises on failure (the
    request is recorded in-app either way)."""
    mail = compose_access_request(requester_name=requester_name, requester_email=requester_email,
                                  document_title=document_title, message=message, request_id=request_id,
                                  workspace_name=workspace_name)
    await _send(to_email, mail, purpose="share", kind="access_request", ref=request_id)


def compose_edit_request(*, requester_name: str, requester_email: str, document_title: str, message: str | None,
                         request_id: str, as_admin: bool, workspace_name: str | None) -> dict:
    base = f"{_base()}/requests/{request_id}"
    why = (f"Its owner can't be reached, so this came to the admins of {workspace_name or 'the workspace'}. "
           if as_admin else "")
    who = K.rows([K.item(K.strong(requester_name), who=requester_name,
                         meta=[K.mono(requester_email), "  ·  can read it now"], last=True, pad=4)], margin="0 0 16px")
    e = K.layout(
        title_=f"{requester_name} asked to edit {document_title}",
        preheader=f"{requester_name} ({requester_email}) asked to edit “{document_title}”.", base=_base(), body=[
            K.eyebrow("Edit access request"),
            K.title(f"{requester_name} asked to edit “{document_title}”"),
            who,
            K.quote(message) if message else None,
            K.buttons((f"{base}?action=edit", "Approve: let them edit"), (f"{base}?action=decline", "Decline"),
                      margin="4px 0 20px"),
            K.small(why + "Approving lets them edit this page only, not the pages inside it. You'll be asked to sign "
                    "in before anything changes."),
        ],
        footer=Footer(why=("You're getting this as an admin of the page's workspace. " if as_admin
                           else "You're getting this because you own the page. ") + "Ignore it and nothing changes."))
    return _mail(f"{_one_line(requester_name, 60)} asked to edit “{_one_line(document_title)}”",
                 f"{requester_name} ({requester_email}) asked to edit “{document_title}”.", e)


def _edit_request_html(**kw) -> str:
    return compose_edit_request(**kw)["html"]


async def send_edit_request_email(
    *, to_email: str, requester_name: str, requester_email: str, document_title: str,
    message: str | None, request_id: str, as_admin: bool = False, workspace_name: str | None = None,
) -> None:
    """Tell a page's owner (or, with no reachable owner, its workspace's admins) that a reader
    asked to edit it. Raises on failure (the request is recorded in-app either way)."""
    mail = compose_edit_request(requester_name=requester_name, requester_email=requester_email,
                                document_title=document_title, message=message, request_id=request_id,
                                as_admin=as_admin, workspace_name=workspace_name)
    await _send(to_email, mail, purpose="share", kind="edit_request", ref=request_id)


def compose_access_decision(*, owner_name: str, document_title: str, url: str, approved: bool, role: str | None,
                            edit_request: bool = False) -> dict:
    title = _one_line(document_title)
    verb = "edit" if edit_request else "open"
    if approved:
        can = "edit this page (not the pages inside it)" if edit_request else _SHARE_ROLE.get(role or "viewer", "read it")
        head = f"You can {verb} “{document_title}”"
        body = [
            K.eyebrow("Edit access request" if edit_request else "Access request"),
            K.title(head),
            K.callout([K.strong(owner_name), f" said yes. You can {can} now."], tone="ok"),
            K.doc_card(document_title, url),
            K.button(url, "Open it", margin="0 0 24px"),
            None if edit_request else K.small(["Sign in to Markdrop with ", K.strong("this email address"), " to open it."]),
        ]
        subject = f"You can {verb} “{title}”"
    else:
        head = f"Your request to {verb} “{document_title}”"
        body = [
            K.eyebrow("Edit access request" if edit_request else "Access request"),
            K.title(head),
            K.p(f"{owner_name} isn't giving you edit access right now. You can still read it." if edit_request else
                f"{owner_name} isn't sharing it with you right now. Nothing else changes, and you're welcome to ask "
                "them directly if you think this is a mistake."),
        ]
        subject = f"About your request to {verb} “{title}”"
    e = K.layout(title_=subject, preheader=subject, base=_base(), body=body,
                 footer=Footer(why=f"You're getting this because you asked for {'edit ' if edit_request else ''}access."))
    return _mail(subject, subject, e)


def _access_decision_html(**kw) -> str:
    return compose_access_decision(**kw)["html"]


async def send_access_decision_email(
    *, to_email: str, owner_name: str, document_title: str, slug: str,
    approved: bool, role: str | None = None, edit_request: bool = False,
) -> None:
    """Tell a requester what the owner decided. Raises on failure."""
    mail = compose_access_decision(owner_name=owner_name, document_title=document_title, url=f"{_base()}/{slug}",
                                   approved=approved, role=role, edit_request=edit_request)
    await _send(to_email, mail, purpose="share", kind="access_decision", ref=slug)


# ── A guide's own domain: live, or given up on ────────────────────────────────


def compose_guide_domain(*, host: str, guide_name: str, live: bool, settings_url: str, message: str | None) -> dict:
    if live:
        subject = f"{_one_line(host, 120)} is live"
        body = [
            K.eyebrow("Markdrop Guides"),
            K.title(f"{host} is live"),
            K.callout(["Readers get ", K.strong(guide_name), " at ", K.strong(host), " now, with HTTPS."], tone="ok"),
            K.p("Links, the sitemap and search results switch to it as the guide is published again, which Markdrop "
                "has started for you."),
            K.button(f"https://{host}", f"Open {host}", margin="0 0 24px"),
            K.small("Keep the CNAME record in place: the domain stops working without it. The free address keeps "
                    "working too."),
        ]
    else:
        subject = f"{_one_line(host, 120)} isn't live yet"
        body = [
            K.eyebrow("Markdrop Guides"),
            K.title(f"{host} isn't live yet"),
            K.callout([f"Markdrop checked {host} for ", K.strong(guide_name), " for three days and stopped."]
                      + ([" ", _one_line(message, 300)] if message else []), tone="warn"),
            K.p("Usually the DNS record is missing, has a typo, or the domain was added twice (help.acme.com.acme.com). "
                "Fix it, then choose Check now on the setup page to start again."),
            K.button(settings_url, "Open the setup page", margin="0 0 24px"),
        ]
    e = K.layout(title_=subject, preheader=subject, base=_base(), body=body,
                 footer=Footer(why="You're getting this because you added this domain to a guide."))
    return _mail(subject, subject, e)


def _guide_domain_html(**kw) -> str:
    return compose_guide_domain(**kw)["html"]


async def send_guide_domain_email(*, to_email: str, host: str, guide_name: str, live: bool,
                                  settings_url: str, message: str | None = None) -> None:
    """Tell whoever added a guide's own domain that it went live (or that checks gave up). Raises
    on failure."""
    mail = compose_guide_domain(host=host, guide_name=guide_name, live=live, settings_url=settings_url, message=message)
    await _send(to_email, mail, purpose="share", kind="guide_domain", ref=host)


# ── A guide's readers: sign-in link, access request, decision ─────────────────


def compose_guide_signin(*, to: str, guide: str, url: str) -> dict:
    e = K.layout(title_=f"Sign in to {guide}", preheader=f"Your sign-in link for {guide}. It works once, for 15 minutes.",
                 base=_base(), label_=guide, body=[
                     K.eyebrow("Sign in"),
                     K.title(f"Open {guide}"),
                     K.p(["Use the button to sign in to ", K.strong(guide), " as ", K.mono(to), "."]),
                     K.button(url, "Sign in and open the page", margin="4px 0 16px"),
                     K.small("It works once, for 15 minutes."),
                 ],
                 footer=Footer(why="Sent by Markdrop Guides because someone entered this address on the guide's sign-in "
                                   "page. Didn't ask? Ignore this email: nothing happens unless the button is used."))
    return _mail(f"Sign in to {_one_line(guide, 80)}", f"Your sign-in link for {guide}.", e)


def compose_guide_access_request(*, guide: str, email: str, rule_name: str, note: str, url: str) -> dict:
    e = K.layout(title_="Access request", preheader=f"{email} asked to open {rule_name} pages in {guide}.", base=_base(),
                 label_=guide, body=[
                     K.eyebrow("Access request"),
                     K.title(f"{email} asked for access"),
                     K.p(["They want to open ", K.strong(rule_name), " pages in ", K.strong(guide), "."]),
                     K.quote(note) if note else None,
                     K.button(url, "Review the request", margin="4px 0 24px"),
                 ],
                 footer=Footer(why="You get these because you're an admin of this guide in Markdrop Guides."))
    return _mail(f"Access request for {_one_line(guide, 80)}", f"{email} asked to open {rule_name} pages in {guide}.", e)


def compose_guide_access_decision(*, guide: str, approved: bool, url: str) -> dict:
    if approved:
        body = [K.eyebrow("Access request"), K.title(f"You can open {guide}"),
                K.callout("Your request was approved.", tone="ok"),
                K.p("Open the guide and sign in with this email address."),
                K.button(url, "Open the guide", margin="4px 0 24px")]
    else:
        body = [K.eyebrow("Access request"), K.title("Your request wasn't approved"),
                K.p(f"The team behind {guide} didn't approve access for this address.")]
    e = K.layout(title_="Access request", preheader=f"Your access request for {guide}: "
                 + ("approved." if approved else "not approved."), base=_base(), label_=guide, body=body,
                 footer=Footer(why="Sent by Markdrop Guides because you asked for access."))
    return _mail(f"Your access request for {_one_line(guide, 80)}", "", e)


# ── Admin console: who is an admin (services/admin_roles.py) ───────────────────


def compose_admin_change(*, actor: str, actor_email: str, target: str, added: bool, note: str | None) -> dict:
    """To every owner when an admin is added or removed: who, whom, and where to check."""
    who = actor if not actor_email or actor == actor_email else f"{actor} ({actor_email})"
    if added:
        subject = f"{_one_line(target, 120)} is now a Markdrop admin"
        lines = [K.p([K.strong(who), " made ", K.strong(target), " an admin. They can see every user, document, "
                      "analytics, email and AI log in the admin console, but can't change who is an admin."])]
    else:
        subject = f"{_one_line(target, 120)} is no longer a Markdrop admin"
        lines = [K.p([K.strong(who), " removed ", K.strong(target), " from the admins. Their next admin request is refused."])]
    body = [K.eyebrow("Admin console"), K.title(subject), *lines,
            K.quote(note) if note else None,
            K.button(f"{_base()}/admin?tab=admins", "Review admins", margin="4px 0 24px"),
            K.small("Didn't expect this? Remove the admin in the console, and check backend/scripts/admin_access.py log "
                    "on the server.")]
    e = K.layout(title_=subject, preheader=subject, base=_base(), label_="Admin console", body=body,
                 footer=Footer(why="You're getting this because you're an owner of this Markdrop's admin console. "
                                   "Every change to its admins is sent to every owner."))
    return _mail(subject, subject, e)


async def send_admin_change_email(*, to_email: str, actor: str, actor_email: str, target: str, added: bool,
                                  note: str | None = None) -> None:
    mail = compose_admin_change(actor=actor, actor_email=actor_email, target=target, added=added, note=note)
    await _send(to_email, mail, purpose="share", kind="admin_change", ref=target)


# ── Operations: the API's memory watchdog (services/memory_health.py) ──────────


def compose_ops_alert(*, host: str, role: str, pid: int, why: str, rss_mb: float, swap_mb: float, peak_mb: float,
                      uptime_s: int, top: list[tuple[str, int]] | None = None) -> dict:
    """To every owner, at most once an hour: an API process is using too much memory."""
    subject = f"Markdrop API memory: {_one_line(why, 100)}"
    hours = uptime_s / 3600
    body = [K.eyebrow("Operations"), K.title("The API is using too much memory"),
            K.callout(f"{why}.", tone="warn"),
            K.stats([("RSS", f"{rss_mb:.0f} MB"), ("Swap", f"{swap_mb:.0f} MB"), ("Peak", f"{peak_mb:.0f} MB")]),
            K.p([K.strong(f"{role} process"), f" {pid} on {host}, up {hours:.1f} h. Slow pages and, at the "
                 "service's MemoryMax, a restart come next."]),
            K.p("Biggest in-process structures: " + (", ".join(f"{k} {v:,}" for k, v in top) if top else "none") + "."),
            K.button(f"{_base()}/admin?tab=health", "Open Product health", margin="4px 0 24px"),
            K.small("On the server: journalctl -u markdrop -u markdrop-worker | grep memory, and "
                    "GET /api/v1/admin/health/memory for the caches (set MARKDROP_TRACEMALLOC=1 and restart for "
                    "allocation sites).")]
    e = K.layout(title_=subject, preheader=f"{why} ({role}, pid {pid}).", base=_base(), label_="Operations", body=body,
                 footer=Footer(why="You're getting this because you're an owner of Markdrop. At most one an hour."))
    return _mail(subject, f"{why} ({role}, pid {pid}).", e)


async def send_ops_alert_email(*, to_email: str, mail: dict) -> None:
    await _send(to_email, mail, purpose="share", kind="ops_alert", ref="memory")


def compose_admin_granted(*, actor: str, has_account: bool, name: str | None = None) -> dict:
    """To a new admin: what they can do now, and how to get in."""
    subject = "You're now an admin of Markdrop"
    hello = f"Hi {name}," if name else "Hi,"
    body = [K.eyebrow("Admin console"), K.title(subject),
            K.p(hello),
            K.p([K.strong(actor), " gave you access to Markdrop's admin console: users, documents, analytics, "
                 "email and AI logs. Treat what you see there as private."]),
            K.button(f"{_base()}/admin", "Open the admin console", margin="4px 0 24px"),
            K.small(["Sign in to Markdrop with ", K.strong("this email address"), " to open it"
                     + ("." if has_account else "; signing in the first time creates your account.")
                     + " Signed in already? You'll find Admin in your account menu."])]
    e = K.layout(title_=subject, preheader="You can open Markdrop's admin console now.", base=_base(),
                 label_="Admin console", body=body,
                 footer=Footer(why="You're getting this because an owner made you an admin of Markdrop. Didn't "
                                   "expect it? Reply to this email."))
    return _mail(subject, "You can open Markdrop's admin console now.", e)


async def send_admin_granted_email(*, to_email: str, actor: str, has_account: bool, name: str | None = None) -> None:
    await _send(to_email, compose_admin_granted(actor=actor, has_account=has_account, name=name),
                purpose="share", kind="admin_change", ref=to_email)


# ── Web pages in the email layout ──────────────────────────────────────────────


def unsubscribe_page_html(ok: bool) -> str:
    """The page an unsubscribe link lands on, in the same layout as the email it came from."""
    base = _base()
    if ok:
        body = [K.eyebrow("Email preferences"), K.title("You're unsubscribed"),
                K.p("You won't get product emails from Markdrop any more. Sign-in codes and invitations still arrive, "
                    "because you asked for them."),
                K.p(K.link(base, "Go to Markdrop"), margin="0 0 20px")]
        title = "You're unsubscribed from Markdrop"
    else:
        body = [K.eyebrow("Email preferences"), K.title("Link not recognised"),
                K.p("This unsubscribe link is invalid or incomplete, so nothing has changed. Open the link again from "
                    "the email, making sure none of it was cut off."),
                K.p("Still getting emails you don't want? Reply to any of them and we'll take you off the list by hand."),
                K.p(K.link(base, "Go to Markdrop"), margin="0 0 20px")]
        title = "Unsubscribe link not recognised"
    return K.layout(title_=title, body=body, footer=Footer(), base=base, page=True).html
