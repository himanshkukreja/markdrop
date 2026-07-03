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
