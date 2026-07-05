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

# (emoji, accent bg, title, description, CTA label, CTA href-key)
# href-key is resolved against the URL map built in _welcome_html.
_FEATURES = [
    ("📝", "#eff6ff", "#2563eb", "Instant Markdown publishing",
     "Paste or write Markdown and get a clean, shareable link in one click — live preview, syntax highlighting, and PDF export.",
     "Create a document", "new"),
    ("📊", "#f0fdf4", "#16a34a", "Diagrams, charts &amp; math",
     "Drop in a <b>mermaid</b> block or LaTeX between $$…$$ and Markdrop renders flowcharts, sequence &amp; Gantt diagrams, charts and typeset math — live.",
     "Render a diagram", "diagrams"),
    ("🧱", "#fef3f2", "#e11d48", "README builder",
     "Assemble a polished README from 45+ drag-and-drop section blocks — badges, install, API tables, diagrams — then publish or download the .md.",
     "Open the builder", "builder"),
    ("🔒", "#eef2ff", "#4f46e5", "Peer-to-peer file sharing",
     "Send any file directly browser-to-browser over WebRTC. It's end-to-end encrypted and nothing is ever uploaded to a server.",
     "Share a file", "share"),
    ("🧩", "#ecfeff", "#0891b2", "Sync from VS Code",
     "Publish and two-way sync your Markdown straight from your editor — save locally to push, edit on the web to pull back, with safe conflict diffs.",
     "Get the extension", "extension"),
    ("📄", "#fffbeb", "#d97706", "Export to Google Docs",
     "Turn any document into a fully-formatted Google Doc in one click — headings, tables, lists and code included — and push updates to the same Doc.",
     "Connect Google", "dashboard"),
    ("📈", "#faf5ff", "#9333ea", "Dashboard &amp; analytics",
     "Your account unlocks a dashboard of all your documents, with view counts and geographic analytics. Everything still works without logging in, too.",
     "Open dashboard", "dashboard"),
]


def _welcome_html(name: str | None) -> str:
    base = settings.frontend_url.rstrip("/")
    urls = {
        "new": f"{base}/new",
        "diagrams": f"{base}/new?sample=diagrams",
        "builder": f"{base}/builder",
        "share": f"{base}/share",
        "dashboard": f"{base}/dashboard",
        "extension": _MARKETPLACE_URL,
    }
    greeting = f"Welcome, {name}" if name else "Welcome to Markdrop"

    # Feature cards — each is its own table so it stacks cleanly on mobile.
    cards = "".join(
        f"""
        <tr>
          <td style="padding:0 0 14px 0">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                   style="background:#ffffff;border:1px solid #eceef1;border-radius:14px">
              <tr>
                <td width="60" valign="top" style="padding:18px 0 18px 18px">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                    <tr><td align="center" valign="middle"
                        style="width:44px;height:44px;background:{bg};border-radius:11px;font-size:22px;line-height:44px">{emoji}</td></tr>
                  </table>
                </td>
                <td valign="top" style="padding:18px 18px 18px 14px">
                  <div style="font-size:16px;font-weight:700;color:#0f172a;margin:0 0 4px">{title}</div>
                  <div style="font-size:14px;line-height:1.55;color:#5b6472;margin:0 0 10px">{desc}</div>
                  <a href="{urls[key]}" style="font-size:13px;font-weight:600;color:{accent};text-decoration:none">{cta} &rarr;</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>"""
        for (emoji, bg, accent, title, desc, cta, key) in _FEATURES
    )

    return f"""\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>Welcome to Markdrop</title>
</head>
<body style="margin:0;padding:0;background:#f5f6f8;-webkit-font-smoothing:antialiased">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">Publish Markdown, render diagrams &amp; math, build READMEs, sync from VS Code, send files peer-to-peer — all no-login by default.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f6f8">
  <tr>
    <td align="center" style="padding:28px 14px">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
             style="width:600px;max-width:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">

        <!-- Wordmark -->
        <tr><td style="padding:4px 6px 18px">
          <span style="font-size:22px;font-weight:800;letter-spacing:-0.3px;color:#0f172a">mark<span style="color:#2563eb">drop</span></span>
        </td></tr>

        <!-- Hero -->
        <tr><td style="background:#2563eb;background-image:linear-gradient(135deg,#2563eb 0%,#0ea5e9 100%);border-radius:18px;padding:36px 30px">
          <div style="font-size:26px;line-height:1.25;font-weight:800;color:#ffffff;margin:0 0 10px">{greeting} 🎉</div>
          <div style="font-size:15px;line-height:1.6;color:#e6f0ff;margin:0 0 22px">
            Your account is ready. Markdrop is a whole publishing &amp; sharing suite —
            here's everything you can do with it, all no-login by default.
          </div>
          <a href="{urls['new']}" style="display:inline-block;background:#ffffff;color:#1d4ed8;text-decoration:none;font-size:14px;font-weight:700;padding:13px 26px;border-radius:10px">Create your first document</a>
        </td></tr>

        <tr><td style="padding:26px 6px 10px">
          <div style="font-size:13px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:#94a3b8">What you can do</div>
        </td></tr>

        <!-- Feature cards -->
        <tr><td style="padding:0 0 6px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">{cards}</table>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:18px 6px 8px;border-top:1px solid #e7e9ee">
          <div style="font-size:13px;line-height:1.6;color:#8b93a1">
            You're receiving this because you signed up at
            <a href="{base}" style="color:#2563eb;text-decoration:none">markdrop.in</a>.
            Markdrop is open source —
            <a href="https://github.com/himanshkukreja/markdrop" style="color:#2563eb;text-decoration:none">star it on GitHub</a>.
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
        "subject": "Welcome to Markdrop — here's everything you can do 🚀",
        "html": _welcome_html(name),
    }
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            _RESEND_URL,
            headers={"Authorization": f"Bearer {settings.resend_api_key}"},
            json=payload,
        )
        resp.raise_for_status()
