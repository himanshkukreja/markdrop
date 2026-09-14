"""Transactional email via Resend."""

import html
import httpx

from app.config import get_settings

settings = get_settings()

_RESEND_URL = "https://api.resend.com/emails"

# Hosted on the CDN rather than inlined: Gmail strips inline SVG and blocks
# data: URIs, so a real raster image at an absolute URL is the only thing that
# reliably renders in an inbox.
_LOGO = "https://ik.imagekit.io/jrcgzv9vw/markdrop/email/markdrop-logo.png"


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


def _masthead(tagline: str = "") -> str:
    """The wordmark, as a link back to the site. Shared by every email so they
    are recognisably from the same product."""
    base = settings.frontend_url.rstrip("/")
    sub = (f'<div style="font-size:12px;color:#6b7699;margin-top:6px">{tagline}</div>'
           if tagline else "")
    return f"""\
        <tr><td style="padding:0 0 18px">
          <a href="{base}" style="text-decoration:none">
            <img src="{_LOGO}" width="132" alt="Markdrop"
                 style="display:block;width:132px;height:auto;border:0;outline:none">
          </a>{sub}
        </td></tr>"""


def is_configured() -> bool:
    return bool(settings.resend_api_key)


def _login_html(otp: str, link_url: str) -> str:
    return f"""\
<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">
  <a href="{settings.frontend_url.rstrip("/")}" style="text-decoration:none">
    <img src="{_LOGO}" width="124" alt="Markdrop" style="display:block;width:124px;height:auto;border:0;margin-bottom:18px">
  </a>
  <h2 style="margin:0 0 8px">Sign in to Markdrop</h2>
  <p style="color:#555;margin:0 0 20px">Use the code below, or click the button. This expires in {settings.login_challenge_ttl_minutes} minutes.</p>
  <div style="font-size:32px;font-weight:700;letter-spacing:8px;background:#f4f4f5;border-radius:10px;padding:16px;text-align:center;margin-bottom:20px">{otp}</div>
  <p style="text-align:center;margin:0 0 24px">
    <a href="{link_url}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600">Sign in to Markdrop</a>
  </p>
  <p style="color:#999;font-size:12px;margin:0">If you didn't request this, you can safely ignore this email.</p>
</div>"""


async def send_login_email(to_email: str, otp: str, link_url: str) -> None:
    """Send the passwordless login email (code + magic link). Raises on failure."""
    payload = {
        "from": _sender("login"),
        "to": [to_email],
        "subject": f"Your Markdrop sign-in code: {otp}",
        "reply_to": settings.email_reply_to,
        "html": _login_html(otp, link_url),
    }
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            _RESEND_URL,
            headers={"Authorization": f"Bearer {settings.resend_api_key}"},
            json=payload,
        )
        resp.raise_for_status()


# ── Welcome / feature-tour email (sent once, on first signup) ───────────────────

_MARKETPLACE_URL = (
    "https://marketplace.visualstudio.com/items?itemName=HimanshuKukreja.markdrop"
)

# Animated product-demo hero (code-rendered GIF, hosted on ImageKit CDN — kept off
# the app repo/bundle since it's a binary). Falls through to the static PNG hero
# ({frontend_url}/email/hero.png) only if this is ever cleared.
_HERO_IMAGE = "https://ik.imagekit.io/jrcgzv9vw/markdrop/email/welcome-hero-hd.gif"

# (icon filename, title, description, CTA label, CTA href-key). Icons are hosted
# PNGs under {frontend_url}/email/ — Gmail strips inline SVG and blocks data: URIs,
# so real raster images at absolute URLs are the only reliable option.
_FEATURES = [
    ("publish", "Instant Markdown publishing",
     "Paste or write Markdown and get a clean, shareable link in one click — with live preview, syntax highlighting and PDF export.",
     "Create a document", "new"),
    ("diagram", "Diagrams, charts &amp; math",
     "Add a mermaid block or LaTeX between $$ … $$ and Markdrop renders flowcharts, sequence &amp; Gantt diagrams, charts and typeset math, live.",
     "Try a diagram", "diagrams"),
    ("artifact", "Artifacts &mdash; PDFs, sheets &amp; web pages",
     "Upload a PDF, spreadsheet, Word doc or a zipped site &mdash; or paste raw HTML &mdash; and get a link that renders it, instead of downloading it. Rendered on an isolated domain, so a published page can never reach your account.",
     "Publish an artifact", "upload"),
    ("builder", "README builder",
     "Assemble a README from 45+ drag-and-drop section blocks — badges, install steps, API tables, diagrams — then publish or download the .md.",
     "Open the builder", "builder"),
    ("share", "Peer-to-peer file sharing",
     "Send any file directly browser-to-browser over WebRTC. Transfers are end-to-end encrypted and never touch a server.",
     "Share a file", "share"),
    ("sync", "Sync from VS Code",
     "Publish and two-way sync your Markdown from your editor — save locally to push, edit on the web to pull back, with safe conflict diffs.",
     "Get the extension", "extension"),
    ("docs", "Google Docs &amp; analytics",
     "Export any document to a fully-formatted Google Doc, and track views and geography from your dashboard. Everything works without an account, too.",
     "Open the dashboard", "dashboard"),
]


def _welcome_html(name: str | None) -> str:
    base = settings.frontend_url.rstrip("/")
    img = f"{base}/email"
    hero = _HERO_IMAGE or f"{img}/hero.png"
    urls = {
        "new": f"{base}/new",
        "diagrams": f"{base}/new?sample=diagrams",
        "upload": f"{base}/upload",
        "builder": f"{base}/builder",
        "share": f"{base}/share",
        "dashboard": f"{base}/dashboard",
        "extension": _MARKETPLACE_URL,
    }
    greeting = f"Welcome, {html.escape(name)}" if name else "Welcome to Markdrop"

    # Feature rows — hosted PNG icon + text, on the dark card.
    rows = "".join(
        f"""
        <tr>
          <td width="64" valign="top" style="padding:16px 0 16px 2px">
            <img src="{img}/{icon}.png" width="48" height="48" alt=""
                 style="display:block;width:48px;height:48px;border:0;outline:none;text-decoration:none">
          </td>
          <td valign="top" style="padding:16px 2px 16px 14px;border-bottom:1px solid #1a2540">
            <div style="font-size:16px;font-weight:600;color:#eaf1ff;margin:0 0 4px">{title}</div>
            <div style="font-size:14px;line-height:1.55;color:#93a3c6;margin:0 0 9px">{desc}</div>
            <a href="{urls[key]}" style="font-size:13px;font-weight:600;color:#6ba4ff;text-decoration:none">{cta} &rarr;</a>
          </td>
        </tr>"""
        for (icon, title, desc, cta, key) in _FEATURES
    )

    return f"""\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<meta name="supported-color-schemes" content="dark light">
<title>Welcome to Markdrop</title>
</head>
<body style="margin:0;padding:0;background:#080d1a;-webkit-font-smoothing:antialiased">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">Publish Markdown, render diagrams and math, build READMEs, sync from VS Code, and send files peer-to-peer — no login required.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#080d1a" style="background:#080d1a">
  <tr>
    <td align="center" style="padding:26px 14px">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
             style="width:600px;max-width:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">

        <!-- Hero graphic (animated product demo) -->
        <tr><td style="padding:0;line-height:0">
          <a href="{base}" style="text-decoration:none">
            <img src="{hero}" width="600" alt="Markdrop — publish Markdown, render diagrams, sync, share"
                 style="display:block;width:100%;max-width:600px;height:auto;border:0;border-radius:16px 16px 0 0">
          </a>
        </td></tr>

        <!-- Card -->
        <tr><td bgcolor="#0d1428" style="background:#0d1428;border:1px solid #1a2540;border-top:0;border-radius:0 0 16px 16px;padding:30px 26px">
          <div style="font-size:22px;line-height:1.3;font-weight:700;color:#ffffff;margin:0 0 10px">{greeting}</div>
          <div style="font-size:15px;line-height:1.65;color:#a6b4d4;margin:0 0 22px">
            Your account is ready. Markdrop began as a Markdown pastebin and grew into a full
            publishing and sharing suite — here's what you can do with it.
          </div>

          <!-- Primary CTA -->
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px">
            <tr><td bgcolor="#2563eb" style="border-radius:10px">
              <a href="{urls['new']}" style="display:inline-block;padding:13px 26px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none">Create your first document</a>
            </td></tr>
          </table>

          <div style="font-size:12px;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;color:#5f6f92;margin:0 0 2px">What you can do</div>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">{rows}</table>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:22px 8px 8px">
          <div style="font-size:12px;line-height:1.65;color:#6b7699">
            You're receiving this because you signed up at
            <a href="{base}" style="color:#6ba4ff;text-decoration:none">markdrop.in</a>.
            Markdrop is open source —
            <a href="https://github.com/himanshkukreja/markdrop" style="color:#6ba4ff;text-decoration:none">star it on GitHub</a>.
          </div>
        </td></tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>"""


async def send_welcome_email(to_email: str, name: str | None = None) -> None:
    """Send the one-time welcome / feature-tour email. Raises on failure."""
    payload = {
        "from": _sender("welcome"),
        "to": [to_email],
        "subject": "Welcome to Markdrop — everything you can do",
        "reply_to": settings.email_reply_to,
        "html": _welcome_html(name),
    }
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            _RESEND_URL,
            headers={"Authorization": f"Bearer {settings.resend_api_key}"},
            json=payload,
        )
        resp.raise_for_status()


# ── Workspace invitations ──────────────────────────────────────────────────────

_ROLE_BLURB = {
    "admin": "manage members, domains and branding",
    "member": "create and publish documents",
    "viewer": "read what the workspace publishes",
}


def _invite_html(workspace_name: str, inviter_name: str, role: str, link_url: str) -> str:
    base = settings.frontend_url.rstrip("/")
    blurb = _ROLE_BLURB.get(role, "collaborate")
    # Both of these are free text chosen by a user, and they are about to be
    # interpolated into markup that lands in someone else's inbox. A workspace
    # named `</div><a href="http://evil">` would otherwise let any workspace
    # owner compose arbitrary HTML inside an email sent from our domain, which
    # is a phishing kit, not a display bug.
    workspace_name = html.escape(workspace_name)
    inviter_name = html.escape(inviter_name)
    return f"""\
<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light"><title>Join {workspace_name} on Markdrop</title></head>
<body style="margin:0;padding:0;background:#080d1a;-webkit-font-smoothing:antialiased">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">{inviter_name} invited you to the {workspace_name} workspace on Markdrop.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#080d1a" style="background:#080d1a">
  <tr><td align="center" style="padding:32px 14px">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"
           style="width:560px;max-width:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
      <tr><td bgcolor="#0d1428" style="background:#0d1428;border:1px solid #1a2540;border-radius:16px;padding:34px 30px">

        <img src="{_LOGO}" width="124" alt="Markdrop" style="display:block;width:124px;height:auto;border:0;margin:0 0 20px">
        <div style="font-size:12px;font-weight:700;letter-spacing:.9px;text-transform:uppercase;color:#5f6f92;margin:0 0 14px">Workspace invitation</div>
        <div style="font-size:23px;line-height:1.3;font-weight:700;color:#ffffff;margin:0 0 14px">
          {inviter_name} invited you to {workspace_name}
        </div>
        <div style="font-size:15px;line-height:1.65;color:#a6b4d4;margin:0 0 26px">
          You've been invited as a <strong style="color:#eaf1ff">{role}</strong>, which lets you {blurb}.
          Nothing happens until you accept &mdash; and you can decline just as easily.
        </div>

        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 26px">
          <tr><td bgcolor="#2563eb" style="border-radius:10px">
            <a href="{link_url}" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none">View invitation</a>
          </td></tr>
        </table>

        <div style="font-size:13px;line-height:1.6;color:#6b7699;border-top:1px solid #1a2540;padding-top:18px">
          This invitation expires in 7 days. To accept it you'll need to be signed in
          to Markdrop with this email address &mdash; if you don't have an account yet,
          you can create one on the way through.
        </div>
      </td></tr>
      <tr><td style="padding:20px 8px 8px">
        <div style="font-size:12px;line-height:1.65;color:#6b7699">
          Didn't expect this? You can safely ignore it &mdash; you will not be added to
          anything unless you accept. Sent by
          <a href="{base}" style="color:#6ba4ff;text-decoration:none">markdrop.in</a>.
        </div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>"""


async def send_invite_email(
    *, to_email: str, workspace_name: str, inviter_name: str, role: str, token: str
) -> None:
    """Send a workspace invitation. Raises on failure, which the caller treats as
    grounds to withdraw the invitation -- an invite nobody can receive is worse
    than none, because it shows as pending in the admin list forever."""
    link_url = f"{settings.frontend_url.rstrip('/')}/invite/{token}"
    payload = {
        "from": _sender("share"),
        "to": [to_email],
        "subject": f"{inviter_name} invited you to {workspace_name} on Markdrop",
        "reply_to": settings.email_reply_to,
        "html": _invite_html(workspace_name, inviter_name, role, link_url),
    }
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            _RESEND_URL,
            headers={"Authorization": f"Bearer {settings.resend_api_key}"},
            json=payload,
        )
        resp.raise_for_status()


# ── Document sharing ───────────────────────────────────────────────────────────

_SHARE_ROLE = {
    "viewer": "read it",
    "editor": "read and edit it",
}


def _share_html(
    *, document_title: str, url: str, sharer_name: str, role: str,
    encrypted: bool, message: str | None,
) -> str:
    base = settings.frontend_url.rstrip("/")
    # Free text chosen by one user, rendered into markup that lands in another
    # user's inbox. Unescaped, a document titled `</div><a href="http://evil">`
    # turns any sharer into a phishing kit sending from our domain.
    document_title = html.escape(document_title)
    sharer_name = html.escape(sharer_name)
    note = (
        f"""<tr><td style="padding:0 0 20px">
          <div style="border-left:3px solid #2563eb;padding:2px 0 2px 14px;
                      font-size:14px;line-height:1.6;color:#a6b4d4">
            &ldquo;{html.escape(message)}&rdquo;
          </div></td></tr>"""
        if message else ""
    )
    # An encrypted document cannot be unlocked by a permission — the key is in
    # the link's fragment and never reached us. Saying so here prevents the
    # entirely reasonable assumption that being granted access means being able
    # to read it.
    crypto = (
        """<tr><td style="padding:0 0 18px">
          <div style="background:#2a1f05;border:1px solid #5c4813;border-radius:10px;
                      padding:12px 14px;font-size:13px;line-height:1.6;color:#f6c453">
            This document is end-to-end encrypted. You'll need the full link,
            including everything after the <span style="font-family:monospace">#</span>,
            for it to open — access alone isn't enough to decrypt it.
          </div></td></tr>"""
        if encrypted else ""
    )

    return f"""\
<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light"><title>{document_title}</title></head>
<body style="margin:0;padding:0;background:#080d1a;-webkit-font-smoothing:antialiased">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">{sharer_name} shared a document with you on Markdrop.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#080d1a" style="background:#080d1a">
  <tr><td align="center" style="padding:32px 14px">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"
           style="width:560px;max-width:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
      <tr><td bgcolor="#0d1428" style="background:#0d1428;border:1px solid #1a2540;border-radius:16px;padding:32px 30px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          {_masthead()}
          <tr><td style="padding:0 0 10px">
            <div style="font-size:22px;line-height:1.3;font-weight:700;color:#ffffff">
              {sharer_name} shared a document with you
            </div></td></tr>
          <tr><td style="padding:0 0 18px">
            <div style="font-size:15px;line-height:1.6;color:#a6b4d4">
              You can <strong style="color:#eaf1ff">{_SHARE_ROLE.get(role, "read it")}</strong>.
            </div></td></tr>
          {note}
          <tr><td style="padding:0 0 20px">
            <div style="background:#0a1020;border:1px solid #1a2540;border-radius:10px;padding:14px 16px">
              <div style="font-size:16px;font-weight:600;color:#eaf1ff">{document_title}</div>
              <div style="font-family:monospace;font-size:12px;color:#6ba4ff;margin-top:5px;word-break:break-all">{url}</div>
            </div></td></tr>
          {crypto}
          <tr><td style="padding:0 0 22px">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr><td bgcolor="#2563eb" style="border-radius:10px">
                <a href="{url}" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none">Open the document</a>
              </td></tr></table></td></tr>
          <tr><td style="border-top:1px solid #1a2540;padding:16px 0 0">
            <div style="font-size:13px;line-height:1.6;color:#6b7699">
              Sign in to Markdrop with <strong style="color:#93a3c6">this email address</strong> to open it.
              You can create an account with it if you don't have one — access is tied to the address,
              not to a link that anyone could forward.
            </div></td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:18px 8px 8px">
        <div style="font-size:12px;line-height:1.65;color:#6b7699">
          Didn't expect this? You can ignore it — nothing was shared with you until you sign in.
          Sent by <a href="{base}" style="color:#6ba4ff;text-decoration:none">markdrop.in</a>.
        </div></td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>"""


async def send_document_share_email(
    *, to_email: str, document_title: str, slug: str, folder_path: list[str],
    sharer_name: str, role: str, encrypted: bool, message: str | None = None,
) -> None:
    """Tell someone a document was shared with them. Raises on failure.

    The caller treats a failure as non-fatal: the grant is real whether or not
    the email arrived, and revoking someone's access because a mail server was
    slow would be the worse outcome.
    """
    base = settings.frontend_url.rstrip("/")
    url = f"{base}/{'/'.join([*folder_path, slug])}"
    payload = {
        "from": _sender("share"),
        "to": [to_email],
        "subject": f"{sharer_name} shared “{document_title}” with you",
        "reply_to": settings.email_reply_to,
        "html": _share_html(
            document_title=document_title, url=url, sharer_name=sharer_name,
            role=role, encrypted=encrypted, message=message,
        ),
    }
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            _RESEND_URL,
            headers={"Authorization": f"Bearer {settings.resend_api_key}"},
            json=payload,
        )
        resp.raise_for_status()
