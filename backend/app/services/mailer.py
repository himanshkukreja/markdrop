"""Transactional email via Resend."""

import httpx

from app.config import get_settings

settings = get_settings()

_RESEND_URL = "https://api.resend.com/emails"


def is_configured() -> bool:
    return bool(settings.resend_api_key)


def _login_html(otp: str, link_url: str) -> str:
    return f"""\
<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">
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
        "from": f"{settings.email_from_name} <{settings.email_from}>",
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
    greeting = f"Welcome, {name}" if name else "Welcome to Markdrop"

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
        "from": f"{settings.email_from_name} <{settings.email_from}>",
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
