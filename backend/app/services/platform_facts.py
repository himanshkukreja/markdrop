"""Markdrop's limits, read from the code that enforces them.

The docs assistant's `get_limits` tool and the platform brief in its system
prompt both read this, so a number the assistant quotes is the number the API
applies today: settings (app/config.py) and the module constants the services
check against. Nothing here is typed in twice.
"""

from __future__ import annotations

from app.config import get_settings


def _size(n: int) -> str:
    gb, mb, kb = 1024 ** 3, 1024 ** 2, 1024
    if n >= gb and n % gb == 0:
        return f"{n // gb} GB"
    if n >= mb and n % mb == 0:
        return f"{n // mb} MB"
    if n >= kb and n % kb == 0:
        return f"{n // kb} KB"
    return f"{n:,} bytes"


def _rate(spec: str) -> str:
    n, _, per = spec.partition("/")
    return f"{n} a {per}" if per else spec


def limits() -> dict:
    """Grouped limits: each value has the number and a readable form."""
    from app.services import access, bundle, domain, folder, invitation, workspace
    from app.services import branding, file_uploads
    from app.services.artifact import MAX_PASTE_BYTES
    from app.routers import share
    from app.services.oauth_server import ACCESS_TTL, REFRESH_TTL
    from app.utils.auth import TENANT_TOKEN_TTL_HOURS

    s = get_settings()
    return {
        "note": "Sizes use binary units (1 MB = 1,024 KB). Values come from the running code.",
        "documents": {
            "max_document_characters": s.max_content_chars,
            "max_title_characters": 200,
            "custom_address_characters": "3 to 50; letters, numbers, - and _",
            "max_read_password_characters": 100,
            "expiry_options": ["never", "1 day", "7 days", "30 days", "a date you choose"],
        },
        "files": {
            "max_file": _size(s.artifact_max_bytes),
            "max_video_or_audio_file": _size(s.artifact_max_video_bytes),
            "max_pasted_html": _size(MAX_PASTE_BYTES),
            "storage_per_account": _size(s.artifact_user_quota_bytes) + " (old versions count towards it)",
            "versions_kept_per_file": f"{s.file_versions_keep} (the current one included)",
            "zipped_website": (f"{bundle.MAX_ENTRIES} files, {_size(bundle.MAX_TOTAL_UNCOMPRESSED)} unpacked, "
                               f"{_size(bundle.MAX_ENTRY_BYTES)} for any one file"),
            "uploads_in_progress_at_once": file_uploads.MAX_OPEN_SESSIONS,
            "upload_session_valid_hours": s.file_upload_session_hours,
        },
        "sharing": {
            "people_added_to_one_document": access.MAX_GRANTS_PER_DOCUMENT,
            "peer_to_peer_recipients_at_once": share.MAX_GUESTS,
        },
        "workspaces": {
            "workspaces_you_can_own": workspace.MAX_WORKSPACES_PER_USER,
            "members_per_workspace": invitation.MAX_MEMBERS,
            "pending_invitations_per_workspace": invitation.MAX_PENDING_INVITES,
            "invitation_expires_after_days": invitation.INVITE_TTL_DAYS,
            "folders_per_workspace": folder.MAX_FOLDERS_PER_WORKSPACE,
            "folder_nesting_depth": folder.MAX_DEPTH,
            "folder_name_characters": folder.MAX_NAME,
            "custom_domains_per_workspace": domain.MAX_DOMAINS_PER_WORKSPACE,
            "unverified_domain_dropped_after_days": s.domain_pending_ttl_days,
            "verified_domain_lapses_after_failing_dns_hours": s.domain_lapse_after_hours,
            "logo_or_favicon_upload": _size(branding.MAX_UPLOAD_BYTES),
        },
        "sign_in_and_tokens": {
            "session_on_markdrop_in_days": s.access_token_ttl_hours // 24,
            "email_code": (f"{s.otp_length} digits, expires after {s.login_challenge_ttl_minutes} minutes, "
                           f"{s.login_max_attempts} tries"),
            "session_on_a_workspace_domain_hours": TENANT_TOKEN_TTL_HOURS,
            "api_tokens": "no expiry; revoke them in Settings",
            "connected_ai_apps": (f"access renews every {int(ACCESS_TTL.total_seconds() // 3600)} hour(s); "
                                  f"an app unused for {REFRESH_TTL.days} days must connect again"),
        },
        "request_rates_per_ip_unless_noted": {
            "publishing_and_changing_documents": _rate(s.rate_limit_create),
            "reading_documents_through_the_api": _rate(s.rate_limit_read),
            "creating_api_tokens": _rate("20/hour"),
            "sending_workspace_invitations": _rate("20/hour"),
            "mcp_changes_per_account": _rate(s.mcp_write_rate_limit),
            "mcp_reads_per_account": _rate(s.mcp_read_rate_limit),
            "status_when_exceeded": "HTTP 429",
        },
    }


def brief_lines() -> list[str]:
    """The handful of limits worth having in the system prompt."""
    s = get_settings()
    from app.services import access, domain, workspace

    return [
        f"Document: up to {s.max_content_chars:,} characters.",
        f"One file: {_size(s.artifact_max_bytes)}; video or audio: {_size(s.artifact_max_video_bytes)}; "
        f"storage per account: {_size(s.artifact_user_quota_bytes)} (old versions count).",
        f"Versions kept per file: {s.file_versions_keep}.",
        f"People added to one document: {access.MAX_GRANTS_PER_DOCUMENT}; workspaces you can own: "
        f"{workspace.MAX_WORKSPACES_PER_USER}; custom domains per workspace: {domain.MAX_DOMAINS_PER_WORKSPACE}.",
        "For any other number call get_limits.",
    ]
