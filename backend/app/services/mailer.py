"""Transactional email via Resend, and the one light shell every email shares.

Every message Markdrop sends (sign-in, welcome, workspace invite, document
share, and the campaign templates in ``app/emails/``) is built on the same
light shell (REVAMP_PLAN §7.20): a ``#f9fafb`` ground, a white 560px card with a
1px ``#e5e7eb`` border, radius 12, and a 4px ``#155dfc`` bar across the top.

Why light, and only light:

* Gmail's mobile apps force-invert email colours and offer no supported opt-out.
  Inversion turns near-white text dark while leaving saturated colours alone, so
  a dark design comes out muddy and half-inverted. Dark text on white reads
  correctly whether or not a client inverts it.
* Apple Mail, Outlook and Samsung Mail honour ``color-scheme: light`` and skip
  their dark transform entirely, so the meta tags below are still worth having.
* Every colour that carries no text (the top bar, the button fill) is a
  saturated block, which inversion leaves alone.

The same shell renders the unsubscribe confirmation page (``page_html``), so the
page someone lands on from an email looks like the email they came from.
"""

import html

import httpx

from app.config import get_settings

settings = get_settings()

_RESEND_URL = "https://api.resend.com/emails"


# ── Shell palette (email-safe hexes from the light palette, REVAMP §7.20) ──────

_GROUND = "#f9fafb"
_CARD = "#ffffff"
_LINE = "#e5e7eb"
_ACCENT = "#155dfc"
_INK = "#101828"     # headings, strong text
_BODY = "#364153"    # body copy
_MUTED = "#6a7282"   # eyebrows and footers (never #999 / #94a3b8: they fail AA)
_INSET = "#f3f4f6"   # OTP ground

# Single quotes inside: these go into style="..." attributes.
_SANS = "'Manrope',-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
_MONO = "'JetBrains Mono',ui-monospace,Menlo,monospace"

# Hidden filler after a preheader. Without it a client keeps scraping visible
# text after the preheader to fill the preview line.
_PREHEADER_PAD = "&#847;&zwnj;&nbsp;" * 40


def _wordmark(size: int = 20) -> str:
    """The Markdrop wordmark, as text rather than an image.

    It used to be a PNG on a third-party CDN, and that URL 404'd, so every
    system email showed a broken image. Most clients block remote images by
    default and Outlook desktop blocks them outright, so the first thing a
    recipient saw of us was reliably a placeholder. Text always renders, cannot
    rot, cannot be blocked and costs no request.
    """
    return (
        f'<span style="font-family:{_SANS};font-size:{size}px;line-height:1;'
        f'font-weight:800;letter-spacing:-0.02em;color:{_INK}">mark'
        f'<span style="color:{_ACCENT}">drop</span></span>'
    )


def _base() -> str:
    return settings.frontend_url.rstrip("/")


# ── Building blocks ────────────────────────────────────────────────────────────


def _eyebrow(text: str) -> str:
    return (
        f'<div style="font-family:{_SANS};font-size:11px;line-height:16px;font-weight:700;'
        f'letter-spacing:0.08em;text-transform:uppercase;color:{_MUTED};margin:0 0 10px">'
        f"{text}</div>"
    )


def _heading(text: str, tag: str = "h1") -> str:
    return (
        f'<{tag} style="font-family:{_SANS};font-size:24px;line-height:1.3;font-weight:700;'
        f'color:{_INK};margin:0 0 12px;padding:0">{text}</{tag}>'
    )


def _p(inner: str, *, size: int = 15, color: str = _BODY, margin: str = "0 0 16px") -> str:
    return (
        f'<p style="font-family:{_SANS};font-size:{size}px;line-height:1.6;color:{color};'
        f'margin:{margin}">{inner}</p>'
    )


def _strong(text: str) -> str:
    return f'<strong style="color:{_INK};font-weight:700">{text}</strong>'


def _link(href: str, label: str) -> str:
    return (
        f'<a href="{href}" style="color:{_ACCENT};font-weight:600;'
        f'text-decoration:underline">{label}</a>'
    )


def _button(href: str, label: str, *, margin: str = "8px 0 24px") -> str:
    """Bulletproof button: the fill is on the table cell, so it survives clients
    that ignore padding or background on links."""
    return f"""\
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:{margin}">
  <tr><td bgcolor="{_ACCENT}" style="background-color:{_ACCENT};border-radius:8px">
    <a href="{href}" style="display:inline-block;padding:12px 24px;font-family:{_SANS};font-size:14px;line-height:20px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px">{label}</a>
  </td></tr>
</table>"""


def _rule() -> str:
    return (
        f'<div style="border-top:1px solid {_LINE};height:0;line-height:0;'
        f'font-size:0;margin:8px 0 20px">&nbsp;</div>'
    )


def _shell(
    *,
    title: str,
    content: str,
    footer: str,
    preheader: str = "",
    page: bool = False,
    top_label: str = "",
) -> str:
    """Wrap ``content`` in the light shell.

    ``title``, ``preheader`` and ``top_label`` are interpolated as-is: callers
    escape any user text in them. ``page=True`` renders it as a web page (no
    preheader, a vertical offset, noindex) for the unsubscribe confirmation.
    ``top_label`` is a small uppercase label opposite the wordmark (campaigns:
    "Product update", "Newsletter").
    """
    brand = f'<a href="{_base()}" style="text-decoration:none">{_wordmark(20)}</a>'
    if top_label:
        brand = (
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
            f'<td valign="middle">{brand}</td>'
            f'<td align="right" valign="middle" style="font-family:{_SANS};font-size:11px;line-height:16px;'
            f'font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:{_MUTED}">{top_label}</td>'
            "</tr></table>"
        )
    pre = (
        f'<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">'
        f"{preheader}{_PREHEADER_PAD}</div>"
        if preheader and not page else ""
    )
    robots = '<meta name="robots" content="noindex">\n' if page else ""
    outer_pad = "64px 12px 48px" if page else "32px 12px"
    return f"""\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no,address=no,email=no,date=no">
<!-- Light only. Apple Mail, Outlook and Samsung honour this; Gmail mobile
     inverts regardless, which the design survives (see mailer.py). -->
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
{robots}<title>{title}</title>
<style>
  :root {{ color-scheme: light only; supported-color-schemes: light; }}
  body {{ margin: 0; padding: 0; }}
  a {{ color: {_ACCENT}; }}
  @media (max-width: 600px) {{
    .md-pad {{ padding-left: 22px !important; padding-right: 22px !important; }}
    .md-h1 h1, .md-h1 h2 {{ font-size: 22px !important; }}
  }}
</style>
</head>
<body bgcolor="{_GROUND}" style="margin:0;padding:0;background-color:{_GROUND};-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%">
{pre}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="{_GROUND}" style="background-color:{_GROUND}">
  <tr><td align="center" style="padding:{outer_pad}">
    <!--[if mso]><table role="presentation" width="560" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
    <div style="max-width:560px;margin:0 auto">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%">
      <tr><td bgcolor="{_CARD}" style="background-color:{_CARD};border:1px solid {_LINE};border-radius:12px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td bgcolor="{_ACCENT}" height="4" style="background-color:{_ACCENT};height:4px;line-height:4px;font-size:0;border-radius:11px 11px 0 0">&nbsp;</td></tr>
          <tr><td class="md-pad" style="padding:26px 32px 22px">
            {brand}
          </td></tr>
          <tr><td class="md-pad md-h1" style="padding:0 32px 12px;font-family:{_SANS};color:{_BODY};word-break:break-word;overflow-wrap:anywhere">
{content}
          </td></tr>
        </table>
      </td></tr>
      <tr><td class="md-pad" style="padding:20px 32px 0">
        <div style="font-family:{_SANS};font-size:12px;line-height:1.6;color:{_MUTED}">{footer}</div>
      </td></tr>
    </table>
    </div>
    <!--[if mso]></td></tr></table><![endif]-->
  </td></tr>
</table>
</body>
</html>"""


def _footer_link(href: str, label: str) -> str:
    return f'<a href="{href}" style="color:{_MUTED};text-decoration:underline">{label}</a>'


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
    return bool(settings.resend_api_key)


async def _post(payload: dict) -> None:
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            _RESEND_URL,
            headers={"Authorization": f"Bearer {settings.resend_api_key}"},
            json=payload,
        )
        resp.raise_for_status()


# ── Sign-in ────────────────────────────────────────────────────────────────────


def _login_html(otp: str, link_url: str) -> str:
    otp = html.escape(otp)
    link_url = html.escape(link_url, quote=True)
    minutes = int(settings.login_challenge_ttl_minutes)
    content = (
        _eyebrow("Sign in")
        + _heading("Your sign-in code")
        + _p("Enter this code where you asked for it, or use the button below.")
        + f"""\
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 12px">
  <tr><td align="center" bgcolor="{_INSET}" style="background-color:{_INSET};border-radius:8px;padding:16px 8px 16px 14px">
    <span style="font-family:{_MONO};font-size:32px;line-height:40px;font-weight:700;letter-spacing:6px;color:{_INK}">{otp}</span>
  </td></tr>
</table>"""
        + _p(f"This code expires in {minutes} minutes.", size=13, color=_MUTED, margin="0 0 20px")
        + _button(link_url, "Sign in to Markdrop", margin="0 0 24px")
    )
    footer = (
        "If you didn't ask to sign in, you can ignore this email. "
        "Nobody can get in without the code."
    )
    return _shell(
        title="Your Markdrop sign-in code",
        preheader=f"Your sign-in code is {otp}",
        content=content,
        footer=footer,
    )


async def send_login_email(to_email: str, otp: str, link_url: str) -> None:
    """Send the passwordless login email (code + magic link). Raises on failure."""
    await _post({
        "from": _sender("login"),
        "to": [to_email],
        "subject": f"Your Markdrop sign-in code: {otp}",
        "reply_to": settings.email_reply_to,
        "html": _login_html(otp, link_url),
    })


# ── Welcome / feature-tour email (sent once, on first signup) ───────────────────

_MARKETPLACE_URL = (
    "https://marketplace.visualstudio.com/items?itemName=HimanshuKukreja.markdrop"
)

# Product-demo hero (code-rendered GIF on ImageKit, kept off the app repo since
# it's a binary). It is dark artwork, so it sits in the light card as an
# image-only block (D31) until a light re-render exists. Falls back to the
# static {frontend_url}/email/hero.png only if this is ever cleared.
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
    ("diagram", "Diagrams, charts &amp; math",
     "Add a mermaid block or LaTeX between $$ &hellip; $$ and Markdrop renders flowcharts, sequence and Gantt diagrams, charts and typeset math.",
     "Try a diagram", "diagrams"),
    ("artifact", "Files that render: HTML, PDFs, sheets &amp; video",
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


def _welcome_html(name: str | None) -> str:
    base = _base()
    img = f"{base}/email"
    hero = _HERO_IMAGE or f"{img}/hero.png"
    urls = {
        "new": f"{base}/new",
        "diagrams": f"{base}/new?sample=diagrams",
        "upload": f"{base}/upload",
        "builder": f"{base}/builder",
        "share": f"{base}/share",
        "record": f"{base}/share#what-we-record",
        "dashboard": f"{base}/dashboard",
        "extension": _MARKETPLACE_URL,
        "workspaces": f"{base}/settings/workspaces",
    }
    clean = (name or "").strip()
    greeting = f"Welcome, {html.escape(clean)}" if clean else "Welcome to Markdrop"

    def row(icon: str, title: str, desc: str, cta: str, key: str, last: bool) -> str:
        if key == "share":
            if _P2P_RELAY_LIVE:
                desc += _P2P_RELAY_SENTENCE
            desc += " " + _link(urls["record"], "What we record")
        border = "" if last else f"border-bottom:1px solid {_LINE};"
        return f"""
  <tr>
    <td width="52" valign="top" style="padding:16px 0 16px;{border}">
      <img src="{img}/{icon}.png" width="40" height="40" alt=""
           style="display:block;width:40px;height:40px;border:0;outline:none;text-decoration:none;border-radius:10px">
    </td>
    <td valign="top" style="padding:16px 0 16px 14px;{border}">
      <div style="font-family:{_SANS};font-size:15px;line-height:1.4;font-weight:700;color:{_INK};margin:0 0 4px">{title}</div>
      <div style="font-family:{_SANS};font-size:14px;line-height:1.6;color:{_BODY};margin:0 0 8px">{desc}</div>
      <a href="{urls[key]}" style="font-family:{_SANS};font-size:14px;font-weight:600;color:{_ACCENT};text-decoration:none">{cta} &rarr;</a>
    </td>
  </tr>"""

    rows = "".join(
        row(*f, last=(i == len(_FEATURES) - 1)) for i, f in enumerate(_FEATURES)
    )

    def team(title: str, desc: str, margin: str = "0 0 14px") -> str:
        return (
            f'<div style="font-family:{_SANS};font-size:15px;line-height:1.4;font-weight:700;color:{_INK};margin:0 0 4px">{title}</div>'
            f'<div style="font-family:{_SANS};font-size:14px;line-height:1.6;color:{_BODY};margin:{margin}">{desc}</div>'
        )

    domain = f'<span style="font-family:{_MONO};font-size:13px;color:{_INK}">docs.yourcompany.com</span>'
    team_block = (
        _eyebrow("Working with a team")
        + team("Your own domain, your own brand",
               f"Point {domain} at Markdrop and we issue the certificate. Your name, logo "
               "and colour on every page and link preview, with the option to drop "
               "Markdrop branding entirely.")
        + team("A shared library",
               "Documents and files your team can all reach, in folders, with roles. Your "
               "private documents stay private: putting something in a workspace is always "
               "your choice.")
        + team("Share with exactly who you mean",
               "Anyone with the link, only the people you name, or everyone in the "
               "workspace. You can name someone outside your company by email.")
        + f'<a href="{urls["workspaces"]}" style="font-family:{_SANS};font-size:14px;'
          f'font-weight:600;color:{_ACCENT};text-decoration:none">Create a workspace &rarr;</a>'
    )

    content = (
        # Image-only hero block (D31): dark artwork inside the light card, with
        # alt text so a blocked image still says what it was.
        f"""\
<a href="{base}" style="text-decoration:none;display:block;margin:0 0 24px">
  <img src="{hero}" width="494" alt="{html.escape(_HERO_ALT, quote=True)}"
       style="display:block;width:100%;max-width:494px;height:auto;border:0;border-radius:8px;font-family:{_SANS};font-size:14px;color:{_BODY}">
</a>"""
        + _eyebrow("Your account is ready")
        + _heading(greeting)
        + _p(
            "Drop it. It renders. Write or paste markdown and AI write-ups, or upload "
            "HTML pages, PDFs, spreadsheets, Word docs, video and zipped sites. Each "
            "one becomes a link that opens in any browser, with no download and no app. "
            "For one person, or a whole team on its own domain."
        )
        + _button(urls["new"], "Start writing", margin="4px 0 28px")
        + _eyebrow("What you can do")
        + f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px">{rows}\n</table>'
        # The team half of the product: a block rather than another icon row,
        # because it is a different way of using Markdrop, not an eighth feature.
        + f"""\
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px">
  <tr><td bgcolor="{_GROUND}" style="background-color:{_GROUND};border:1px solid {_LINE};border-radius:8px;padding:18px 18px 16px">
    {team_block}
  </td></tr>
</table>"""
    )
    footer = (
        f"You're getting this because you signed up at {_footer_link(base, 'markdrop.in')}. "
        "It's the only welcome email we send. Markdrop is open source: "
        f"{_footer_link('https://github.com/himanshkukreja/markdrop', 'star it on GitHub')}."
    )
    return _shell(
        title="Welcome to Markdrop",
        preheader=(
            "Drop it. It renders. Markdown, AI write-ups, HTML pages, PDFs, spreadsheets, "
            "Word docs, video and zipped sites become links that open in any browser."
        ),
        content=content,
        footer=footer,
    )


async def send_welcome_email(to_email: str, name: str | None = None) -> None:
    """Send the one-time welcome / feature-tour email. Raises on failure."""
    await _post({
        "from": _sender("welcome"),
        "to": [to_email],
        "subject": "Welcome to Markdrop: everything you can do",
        "reply_to": settings.email_reply_to,
        "html": _welcome_html(name),
    })


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


def _invite_html(workspace_name: str, inviter_name: str, role: str, link_url: str) -> str:
    blurb = _ROLE_BLURB.get(role, "collaborate")
    # All free text chosen by a user, about to land in someone else's inbox. A
    # workspace named `</div><a href="http://evil">` would otherwise let any
    # workspace owner compose arbitrary HTML inside an email sent from our
    # domain, which is a phishing kit, not a display bug.
    workspace_name = html.escape(workspace_name)
    inviter_name = html.escape(inviter_name)
    role = html.escape(role)
    link_url = html.escape(link_url, quote=True)
    days = _invite_ttl_days()

    content = (
        _eyebrow("Workspace invitation")
        + _heading(f"{inviter_name} invited you to {workspace_name}")
        + _p(
            f"You're invited as {_strong(role)}, which lets you {blurb}. "
            "Nothing happens until you accept, and you can decline just as easily."
        )
        + _button(link_url, "View invitation")
        + _rule()
        + _p(
            "To accept, sign in to Markdrop with this email address. If you don't "
            "have an account yet, you can create one on the way.",
            size=13, color=_MUTED, margin="0 0 20px",
        )
    )
    footer = (
        f"This invitation expires in {days} days. Didn't expect it? You can ignore "
        "this email: you won't be added to anything unless you accept. Sent by "
        f"{_footer_link(_base(), 'markdrop.in')}."
    )
    return _shell(
        title=f"Join {workspace_name} on Markdrop",
        preheader=f"{inviter_name} invited you to the {workspace_name} workspace on Markdrop.",
        content=content,
        footer=footer,
    )


async def send_invite_email(
    *, to_email: str, workspace_name: str, inviter_name: str, role: str, token: str
) -> None:
    """Send a workspace invitation. Raises on failure, which the caller treats as
    grounds to withdraw the invitation -- an invite nobody can receive is worse
    than none, because it shows as pending in the admin list forever."""
    link_url = f"{_base()}/invite/{token}"
    await _post({
        "from": _sender("share"),
        "to": [to_email],
        "subject": f"{inviter_name} invited you to {workspace_name} on Markdrop",
        "reply_to": settings.email_reply_to,
        "html": _invite_html(workspace_name, inviter_name, role, link_url),
    })


# ── Document sharing ───────────────────────────────────────────────────────────

_SHARE_ROLE = {
    "viewer": "read it",
    "editor": "read and edit it",
}


def _share_html(
    *, document_title: str, url: str, sharer_name: str, role: str,
    encrypted: bool, message: str | None,
) -> str:
    # Free text chosen by one user, rendered into markup that lands in another
    # user's inbox. Unescaped, a document titled `</div><a href="http://evil">`
    # turns any sharer into a phishing kit sending from our domain.
    document_title = html.escape(document_title)
    sharer_name = html.escape(sharer_name)
    url_attr = html.escape(url, quote=True)
    url_text = html.escape(url)

    note = (
        f"""\
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px">
  <tr><td style="border-left:3px solid {_LINE};padding:2px 0 2px 14px">
    <div style="font-family:{_SANS};font-size:15px;line-height:1.6;color:{_BODY}">&ldquo;{html.escape(message)}&rdquo;</div>
  </td></tr>
</table>"""
        if message else ""
    )
    # An encrypted document cannot be unlocked by a permission: the key is in
    # the link's fragment and never reached us. Saying so here prevents the
    # entirely reasonable assumption that being granted access means being able
    # to read it.
    crypto = (
        f"""\
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px">
  <tr><td bgcolor="#fffbeb" style="background-color:#fffbeb;border:1px solid #fee685;border-radius:8px;padding:12px 14px">
    <div style="font-family:{_SANS};font-size:14px;line-height:1.6;color:#bb4d00">
      <strong style="font-weight:700">This document is end-to-end encrypted.</strong>
      Open it with the full link, including everything after the
      <span style="font-family:{_MONO}">#</span>. Access alone can't decrypt it.
    </div>
  </td></tr>
</table>"""
        if encrypted else ""
    )
    doc_box = f"""\
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px">
  <tr><td bgcolor="{_GROUND}" style="background-color:{_GROUND};border:1px solid {_LINE};border-radius:8px;padding:14px 16px">
    <div dir="auto" style="font-family:{_SANS};font-size:16px;line-height:1.4;font-weight:700;color:{_INK};margin:0 0 6px">{document_title}</div>
    <div style="font-family:{_MONO};font-size:13px;line-height:1.5;color:{_BODY};word-break:break-all">{url_text}</div>
  </td></tr>
</table>"""

    content = (
        _eyebrow("Shared with you")
        + _heading(f"{sharer_name} shared a document with you")
        + _p(f"You can {_strong(_SHARE_ROLE.get(role, 'read it'))}.")
        + note
        + doc_box
        + crypto
        + _button(url_attr, "Open the document", margin="0 0 24px")
        + _rule()
        + _p(
            f"Sign in to Markdrop with {_strong('this email address')} to open it. You can "
            "create an account with it if you don't have one. Access is tied to the "
            "address, not to a link anyone could forward.",
            size=13, color=_MUTED, margin="0 0 20px",
        )
    )
    footer = (
        "Didn't expect this? You can ignore it: nothing opens until you sign in with "
        f"this address. Sent by {_footer_link(_base(), 'markdrop.in')}."
    )
    return _shell(
        title=document_title or "A document was shared with you",
        preheader=f"{sharer_name} shared &ldquo;{document_title}&rdquo; with you on Markdrop.",
        content=content,
        footer=footer,
    )


async def send_document_share_email(
    *, to_email: str, document_title: str, slug: str,
    sharer_name: str, role: str, encrypted: bool, message: str | None = None,
) -> None:
    """Tell someone a document was shared with them. Raises on failure.

    The caller treats a failure as non-fatal: the grant is real whether or not
    the email arrived, and revoking someone's access because a mail server was
    slow would be the worse outcome.
    """
    # `/<slug>`, never `/<folder>/<slug>`.
    #
    # Folders are part of a document's address only on a workspace's own
    # domain. markdrop.in serves every document at `/<slug>` and has no folder
    # routes at all, so a link like markdrop.in/data/video-test 404s — which is
    # what the person you just shared with saw.
    #
    # It has to be the primary host rather than the prettier branded one,
    # because a custom host rewrites *every* path to the document route: it has
    # no `/login`. Someone who has to sign in to read this — which is everybody
    # a share email reaches — would arrive somewhere with no way to do it.
    url = f"{_base()}/{slug}"
    await _post({
        "from": _sender("share"),
        "to": [to_email],
        "subject": f"{sharer_name} shared “{document_title}” with you",
        "reply_to": settings.email_reply_to,
        "html": _share_html(
            document_title=document_title, url=url, sharer_name=sharer_name,
            role=role, encrypted=encrypted, message=message,
        ),
    })


# ── Access requests ────────────────────────────────────────────────────────────


def _one_line(text: str, limit: int = 120) -> str:
    """A header-safe single line: a display name or title is chosen by someone
    else and may carry CR/LF or other control characters, which don't belong
    in a Subject (providers reject them, so the email silently never goes)."""
    cleaned = "".join(" " if (ord(ch) < 32 or ord(ch) == 127 or ch in "\u2028\u2029") else ch
                      for ch in text)
    cleaned = " ".join(cleaned.split())
    return cleaned if len(cleaned) <= limit else cleaned[: limit - 1].rstrip() + "…"


def _quote(message: str | None) -> str:
    if not message:
        return ""
    return f"""\
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px">
  <tr><td style="border-left:3px solid {_LINE};padding:2px 0 2px 14px">
    <div style="font-family:{_SANS};font-size:15px;line-height:1.6;color:{_BODY};white-space:pre-wrap">&ldquo;{html.escape(message)}&rdquo;</div>
  </td></tr>
</table>"""


def _ghost_button(href: str, label: str) -> str:
    return f"""\
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 10px">
  <tr><td bgcolor="{_CARD}" style="background-color:{_CARD};border:1px solid {_LINE};border-radius:8px">
    <a href="{href}" style="display:inline-block;padding:11px 22px;font-family:{_SANS};font-size:14px;line-height:20px;font-weight:600;color:{_INK};text-decoration:none;border-radius:8px">{label}</a>
  </td></tr>
</table>"""


def _access_request_html(*, requester_name: str, requester_email: str, document_title: str,
                         message: str | None, request_id: str, workspace_name: str | None) -> str:
    # Every value below is chosen by someone else (the requester's name and
    # note, the title): escaped, or a request is a way to put markup in an
    # owner's inbox from our domain.
    name = html.escape(requester_name)
    address = html.escape(requester_email)
    title = html.escape(document_title)
    base = f"{_base()}/requests/{html.escape(request_id, quote=True)}"
    outsider = (f" &middot; not in {html.escape(workspace_name)}" if workspace_name else "")
    content = (
        _eyebrow("Access request")
        + _heading(f"{name} asked to open &ldquo;{title}&rdquo;")
        + _p(f'<span style="font-family:{_MONO};font-size:13px">{address}</span>{outsider}',
             size=13, color=_MUTED, margin="0 0 16px")
        + _quote(message)
        + _button(f"{base}?action=view", "Let them view", margin="8px 0 10px")
        + _ghost_button(f"{base}?action=edit", "Let them edit")
        + _ghost_button(f"{base}?action=decline", "Decline")
        + _rule()
        + _p(
            "This shares only this item with them. "
            + ("It doesn't add them to your workspace. " if workspace_name else "")
            + "You'll be asked to sign in before anything changes.",
            size=13, color=_MUTED, margin="0 0 20px",
        )
    )
    footer = (
        "You're getting this because you own the document. Ignore it and nothing "
        f"changes. Sent by {_footer_link(_base(), 'markdrop.in')}."
    )
    return _shell(
        title=f"{name} asked to open {title}",
        preheader=f"{name} ({address}) asked for access to &ldquo;{title}&rdquo;.",
        content=content,
        footer=footer,
    )


async def send_access_request_email(
    *, to_email: str, requester_name: str, requester_email: str, document_title: str,
    message: str | None, request_id: str, workspace_name: str | None = None,
) -> None:
    """Tell a document's owner someone asked to open it. Raises on failure (the
    request is recorded in-app either way)."""
    await _post({
        "from": _sender("share"),
        "to": [to_email],
        "subject": f"{_one_line(requester_name, 60)} asked to open “{_one_line(document_title)}”",
        "reply_to": settings.email_reply_to,
        "html": _access_request_html(
            requester_name=requester_name, requester_email=requester_email,
            document_title=document_title, message=message, request_id=request_id,
            workspace_name=workspace_name),
    })


def _access_decision_html(*, owner_name: str, document_title: str, url: str,
                          approved: bool, role: str | None) -> str:
    owner = html.escape(owner_name)
    title = html.escape(document_title)
    if approved:
        can = _SHARE_ROLE.get(role or "viewer", "read it")
        content = (
            _eyebrow("Access request")
            + _heading(f"You can open &ldquo;{title}&rdquo;")
            + _p(f"{owner} said yes. You can {_strong(can)}.")
            + _button(html.escape(url, quote=True), "Open it", margin="0 0 24px")
            + _rule()
            + _p(f"Sign in to Markdrop with {_strong('this email address')} to open it.",
                 size=13, color=_MUTED, margin="0 0 20px")
        )
        subject_line = f"You can open {title}"
    else:
        content = (
            _eyebrow("Access request")
            + _heading(f"Your request to open &ldquo;{title}&rdquo;")
            + _p(f"{owner} isn't sharing it with you right now. Nothing else changes, and "
                 "you're welcome to ask them directly if you think this is a mistake.")
        )
        subject_line = f"About your request to open {title}"
    footer = f"Sent by {_footer_link(_base(), 'markdrop.in')} because you asked for access."
    return _shell(title=subject_line, preheader=subject_line, content=content, footer=footer)


async def send_access_decision_email(
    *, to_email: str, owner_name: str, document_title: str, slug: str,
    approved: bool, role: str | None = None,
) -> None:
    """Tell a requester what the owner decided. Raises on failure."""
    url = f"{_base()}/{slug}"
    title = _one_line(document_title)
    subject = (f"You can open “{title}”" if approved
               else f"About your request to open “{title}”")
    await _post({
        "from": _sender("share"),
        "to": [to_email],
        "subject": subject,
        "reply_to": settings.email_reply_to,
        "html": _access_decision_html(owner_name=owner_name, document_title=document_title,
                                      url=url, approved=approved, role=role),
    })


# ── Web pages in the email shell ───────────────────────────────────────────────


def unsubscribe_page_html(ok: bool) -> str:
    """The page an unsubscribe link lands on, in the same light shell as the
    email it came from. Light only: it is an extension of the email."""
    base = _base()
    if ok:
        content = (
            _eyebrow("Email preferences")
            + _heading("You're unsubscribed")
            + _p(
                "You won't get product emails from Markdrop any more. Sign-in codes "
                "and invitations still arrive, because you asked for them."
            )
            + _p(_link(base, "Go to Markdrop"), margin="0 0 20px")
        )
        title = "You're unsubscribed from Markdrop"
    else:
        content = (
            _eyebrow("Email preferences")
            + _heading("Link not recognised")
            + _p(
                "This unsubscribe link is invalid or incomplete, so nothing has "
                "changed. Open the link again from the email, making sure none of it "
                "was cut off."
            )
            + _p(
                "Still getting emails you don't want? Reply to any of them and we'll "
                "take you off the list by hand.",
            )
            + _p(_link(base, "Go to Markdrop"), margin="0 0 20px")
        )
        title = "Unsubscribe link not recognised"
    footer = f"Markdrop &middot; {_footer_link(base, 'markdrop.in')}"
    return _shell(title=title, content=content, footer=footer, page=True)
