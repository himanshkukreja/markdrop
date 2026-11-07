from pydantic import AliasChoices, Field, model_validator
from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    app_name: str = "Markdrop"
    debug: bool = False

    mongodb_uri: str = "mongodb://localhost:27017"
    mongodb_db: str = "markdrop"

    redis_url: str = "redis://localhost:6379"

    slug_length: int = 7
    slug_max_retries: int = 5
    max_content_chars: int = 500_000

    rate_limit_create: str = "10/minute"
    rate_limit_read: str = "60/minute"
    # Saving a document's text (PUT /documents/{slug}) and holding a page's edit
    # lock: the block editor autosaves 2 s after typing stops and heartbeats
    # every 30 s, which the create limit above would refuse within a minute.
    rate_limit_edit: str = "60/minute"
    # A page's edit lock (services/pages.py): held only while someone is actually editing. It lapses
    # page_lock_ttl_s after the editor's last heartbeat, page_lock_idle_s after their last change, and
    # page_lock_hidden_s after their tab was hidden. Tests and the e2e stack shorten them.
    page_lock_ttl_s: float = 120.0
    page_lock_idle_s: float = 120.0
    page_lock_hidden_s: float = 60.0
    # The holder's last live socket on the page closed (tab closed or killed, no close beacon): the
    # lock goes this long after, unless one of their tabs is back (services/viewers._editor_left).
    page_lock_gone_s: float = 8.0

    cors_origins: list[str] = ["http://localhost:3000"]

    # Public URL of the frontend — used for OAuth/email redirect links.
    frontend_url: str = "http://localhost:3000"
    # Where Markdrop Guides' studio lives (studio_url / studio_link below): its own host,
    # https://guides.markdrop.in/<path> (the frontend's middleware serves it from the app's /guides
    # routes). Blank: https://guides.markdrop.in, except when frontend_url is a local address
    # (http://localhost:3000), where the studio stays under <frontend_url>/guides. Its origin is
    # always allowed by CORS (cors_origins gets it added).
    guides_studio_url: str = ""
    # Public URL of this backend API — used to build the email magic-link.
    api_base_url: str = "http://localhost:8080"

    # Admin console (/admin, routers/admin.require_admin). Who may open it: the OWNERS, the signed-in
    # Markdrop accounts whose email is listed here (comma-separated, case-insensitive, exact match),
    # plus the admins an owner adds in Admin › Admins (the `admins` collection, services/admin_roles).
    # Only owners add or remove admins; owners themselves change only here. There is no admin
    # username or password: the person's own Markdrop session is the credential (2026-11-06).
    admin_emails: str = "kukreja.him@gmail.com"
    # An admin request needs a session signed in within this many days (the app's sessions last
    # 30); an older one is asked to sign in again. 0 turns the check off.
    admin_session_max_age_days: int = 7
    # Adding or removing an admin needs a session signed in within this many hours (else sign in
    # again first). 0 turns the check off.
    admin_role_change_max_age_hours: int = 24
    # Retired with the admin password form (2026-11-06). Kept only so an existing .env that still
    # sets MARKDROP_ADMIN_USERNAME / _PASSWORD / _SECRET keeps loading; nothing reads them.
    admin_username: str = ""
    admin_password: str = ""
    admin_secret: str = ""

    # ── User authentication (optional login) ──────────────────────────────────
    # JWT signing key for USER sessions (separate from admin_secret). Override!
    auth_secret: str = "change-this-user-jwt-secret-in-production"
    access_token_ttl_hours: int = 24 * 30  # 30-day session tokens

    # Google OAuth 2.0 (Phase 1) — create a client at console.cloud.google.com
    google_client_id: str = ""
    google_client_secret: str = ""
    google_redirect_uri: str = "http://localhost:8080/api/v1/auth/google/callback"

    # Google Docs integration — a SEPARATE, opt-in OAuth flow (incremental auth)
    # that additionally requests the `drive.file` scope + offline access so we can
    # create/update Google Docs on the user's behalf. Register this redirect URI
    # in the same OAuth client. The encryption key protects refresh tokens at rest
    # (generate with: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())").
    google_docs_redirect_uri: str = "http://localhost:8080/api/v1/google/callback"
    token_encryption_key: str = ""  # Fernet key; REQUIRED for Google Docs in prod
    # Google Picker (Meetings import: pick a Meet transcript / Gemini notes Doc, granted per file
    # under drive.file). The browser key of the Cloud project (restricted to the Picker API and
    # markdrop.in) and the project number. Empty: the Google Docs tab of Import is hidden.
    google_picker_api_key: str = ""
    google_cloud_app_id: str = ""

    # Passwordless email login via Resend (Phase 2)
    resend_api_key: str = ""
    email_from: str = "login@markdrop.in"
    # Per-purpose senders. Keeping sign-in on its own address matters: if a
    # welcome or share email ever gets someone's domain to filter "markdrop",
    # the login code must not go with it. Each falls back to `email_from`, so an
    # unverified address in Resend degrades to a working send rather than a
    # bounce — set them only once the domain is verified.
    email_from_login: str = ""
    email_from_welcome: str = ""
    email_from_share: str = ""
    email_from_name: str = "Markdrop"
    # Where replies actually land. The From addresses are send-only mailboxes
    # with no inbox, so without this a reply — "I can't sign in", "unsubscribe
    # me" — is silently dropped. Override per environment via
    # MARKDROP_EMAIL_REPLY_TO.
    #
    # On the product's own domain, deliberately. Every share notification an
    # enterprise customer receives carries this address, and inviting them to
    # reply to a personal mailbox is a different thing to be than the one the
    # rest of these emails are dressed as.
    email_reply_to: str = "himanshu@markdrop.in"
    # The sender's postal address in every email's footer (blank: "Markdrop · markdrop.in").
    email_postal_address: str = ""
    # ── Email campaigns (admin → Email; services/email_campaigns) ──────────
    # The env default campaign sender. Blank keeps the previous behaviour: the
    # `updates@` mailbox on email_from's domain, so a complaint about an
    # announcement can't drag the sign-in sender down with it.
    email_campaign_from: str = ""
    # "console" renders every campaign and test message to the log (and the
    # email_outbox collection) instead of sending it, even with a Resend key.
    # Blank means: Resend when resend_api_key is set, console otherwise.
    email_transport: str = ""
    # Svix signing secret of the Resend webhook (whsec_…). Blank turns the
    # webhook endpoint off (503) rather than accepting unsigned events.
    resend_webhook_secret: str = ""
    # Hosts (or host/path-prefix) whose links are wrapped for click tracking and
    # that the click redirect will send people to. The site's own frontend and
    # API hosts are always allowed.
    email_click_hosts: list[str] = [
        "markdrop.in", "www.markdrop.in", "github.com/himanshkukreja",
        "marketplace.visualstudio.com", "x.com", "twitter.com",
        "linkedin.com", "www.linkedin.com",
    ]
    # Pace: messages per Resend batch call (≤100) and the gap between calls.
    # Resend allows a few requests a second per team; one batch a second leaves
    # room for the sign-in mail sharing the key.
    email_batch_size: int = 100
    email_round_gap_ms: int = 1000
    # The background sender started with the app. Off, campaigns only move when
    # the admin page drives them with the tick endpoint.
    email_worker_enabled: bool = True
    # ── Email providers and daily limits (services/email_delivery.py) ──────
    # Every email goes through one send path that routes to the first provider
    # in MARKDROP_EMAIL_PROVIDER_ORDER with room left today (UTC), falls back
    # to the next on a provider error, and logs each send (admin → Emails).
    # Brevo is off while its key is unset. Limits are the providers' free-plan
    # daily caps (Brevo: Markdrop's share); bulk mail stops at 80% of the combined room, transactional
    # at 95%, sign-in codes may use all of it.
    brevo_api_key: str = ""
    resend_daily_limit: int = 100
    # Markdrop's share of Brevo's 300/day free plan (the portfolio site sends from the same account).
    brevo_daily_limit: int = 250
    email_provider_order: str = "resend,brevo"

    login_challenge_ttl_minutes: int = 15
    otp_length: int = 6
    login_max_attempts: int = 5

    # ── Artifacts (HTML / PDF / spreadsheet hosting on Cloudflare R2) ─────────
    # Rendered artifacts are served from a SEPARATE ORIGIN, never markdrop.in.
    # User-authored HTML on our own origin could read the session token out of
    # localStorage and the edit secrets / read passwords out of sessionStorage,
    # so isolation here is a hard security requirement, not a nicety.
    r2_account_id: str = ""
    r2_access_key_id: str = ""
    r2_secret_access_key: str = ""
    r2_bucket: str = ""
    # Defaults to https://<account_id>.r2.cloudflarestorage.com when blank.
    r2_endpoint: str = ""
    # Public origin serving rendered artifacts (Cloudflare Worker + R2 binding),
    # e.g. https://markdropusercontent.com. MUST NOT be markdrop.in or a
    # subdomain of it — see `artifact_origin_is_isolated` below.
    artifact_origin: str = ""
    # HMAC key for the short-lived access tokens the Worker validates on
    # private (password-protected / unlisted) artifacts.
    artifact_signing_key: str = ""
    artifact_url_ttl_seconds: int = 900
    # Signed links for video/audio renderers last longer so playback survives
    # past the 15-minute default (T4). Safe only because every signed link
    # carries the document's access epoch, which the Worker checks: a narrowing
    # (password added, made private, require sign-in) revokes them at once.
    artifact_media_url_ttl_seconds: int = 4 * 3600
    # Escape hatch: serve artifacts from a SUBDOMAIN of the app (e.g.
    # artifacts.markdrop.in). A subdomain is still a distinct origin, so it does
    # block the localStorage/sessionStorage theft — but it shares cookie scope
    # and, more importantly, shares domain reputation: phishing hosted there can
    # get markdrop.in itself flagged by Safe Browsing. Prefer a separate
    # registrable domain; *.workers.dev is on the Public Suffix List and counts
    # as one, for free. Must be set deliberately — the default stays safe.
    artifact_allow_subdomain_origin: bool = False
    # Quotas — R2's free tier is 10 GB, so cap both per-file and per-account.
    artifact_max_bytes: int = 25 * 1024 * 1024
    # Video gets its own ceiling: a 25 MB cap is right for a PDF and useless for
    # a screen recording. Still bounded — R2's free tier is 10 GB in total, and
    # one upload should not be able to consume a meaningful slice of it.
    # Media (video, and audio) can be up to 2 GB: 4K screen recordings are
    # routinely hundreds of megabytes. Anything this large arrives through the
    # multipart upload API (routers/files.py), straight to R2.
    artifact_max_video_bytes: int = 2 * 1024 * 1024 * 1024
    # Per account, and old file versions count towards it (services/file_versions.py).
    artifact_user_quota_bytes: int = 20 * 1024 * 1024 * 1024
    # Presigned PUT validity. Short: the client uploads immediately.
    artifact_upload_ttl_seconds: int = 600

    # ── File uploads and versions (routers/files.py) ──────────────────────────
    # Versions kept per file, the current one included. Older ones are pruned,
    # and dropped early when an upload would otherwise go over the quota.
    file_versions_keep: int = 5
    # Multipart part size. R2 needs every part but the last to be the same size
    # and at least 5 MiB; 32 MiB keeps a 2 GB file at 64 parts.
    file_part_size: int = 32 * 1024 * 1024
    # Presigned part-URL validity. Clients ask for fresh ones when they lapse.
    file_upload_url_ttl: int = 3600
    # An upload session stays usable this long; its row is purged (TTL) a day later.
    file_upload_session_hours: int = 24
    # A page image sent straight to storage (create_page_image_upload) that isn't
    # completed within this many hours is aborted (its parts are dropped).
    page_image_upload_hours: int = 6
    # How long `complete` waits for the sha256 check before answering 202.
    file_complete_wait_seconds: float = 45.0
    # Server-side media probing (duration, size, codecs) and video posters.
    # Blank finds the binaries on PATH; missing binaries just mean no metadata.
    ffprobe_path: str = ""
    ffmpeg_path: str = ""
    # After a file is swapped, purge the frontend's cached page
    # (POST {frontend_url}/api/revalidate). Off in tests.
    page_revalidate_enabled: bool = True
    # Background loops (services/background.py): the revalidation outbox worker,
    # the expiry sweeper and the access reconciler. Each takes a Mongo lease so
    # only one API worker runs it. Off in tests (they call the loops' bodies).
    background_workers_enabled: bool = True
    # Page images nothing references (services/page_history.py): the daily pass only counts
    # (logs the counts) when on; off, it marks and, 30 days later, deletes them.
    page_image_cleanup_dry_run: bool = False

    # ── Custom domains ───────────────────────────────────────────────────────
    # Attaching a verified host to the hosting project so TLS is issued. Left
    # blank the whole integration stays inert: domains can still be added and
    # DNS-verified, they just aren't attached automatically and an operator
    # completes that step by hand. Nothing here is ever invented at runtime.
    vercel_api_token: str = ""
    vercel_project_id: str = ""
    vercel_team_id: str = ""
    # What customers point their DNS at.
    #
    # Set this to a host of your own (edge.markdrop.in) rather than the hosting
    # provider's, and point that at the provider once. Two reasons, and the
    # second is the important one:
    #
    #   * A customer's DNS panel then shows only your domain, instead of naming
    #     your hosting provider in the setup instructions you hand them.
    #   * Changing provider becomes one record on your side. Pointing customers
    #     straight at the provider means every one of them has to edit DNS to
    #     follow you — which for an enterprise is a change ticket, not a click.
    #
    # The default stays the provider's target so a fresh self-hosted install
    # works before anyone has set up an alias.
    custom_domain_cname_target: str = "cname.vercel-dns.com"
    # Apexes cannot be CNAMEs, so they need a literal address and there is no
    # hiding whose it is. Some DNS providers offer ALIAS/ANAME records that
    # behave like a CNAME at the apex; those can use the target above instead.
    custom_domain_apex_ip: str = "76.76.21.21"
    # Scheduled re-verification (services/domain_monitor.py). Every verified
    # domain's TXT *and* routing record are re-read once per interval; a domain
    # whose checks keep failing for `domain_lapse_after_hours` is lapsed:
    # detached from hosting, no longer resolved, no tokens, no CORS. One worker
    # runs each pass (a Mongo lease); the others only wake to see whether one is
    # due, every `domain_recheck_poll_seconds`.
    domain_recheck_enabled: bool = True
    domain_recheck_interval_seconds: int = 24 * 3600
    domain_recheck_poll_seconds: int = 15 * 60
    domain_lapse_after_hours: int = 72
    # An unverified claim holds nothing and expires: without this a typed-in
    # hostname squatted it for every other workspace forever.
    domain_pending_ttl_days: int = 7

    # Weekly analytics digest (services/analytics_digest.py): on Mondays from
    # 03:30 UTC, one email per owner whose links were viewed last week. Off
    # until the owner flips MARKDROP_ANALYTICS_DIGEST_ENABLED after a deploy;
    # also needs background workers on. One worker sends (a Mongo lease); the
    # others only wake every `analytics_digest_poll_seconds` to see if it's due.
    analytics_digest_enabled: bool = False
    analytics_digest_poll_seconds: int = 15 * 60

    # Shared secret between the frontend's server and this API
    # (MARKDROP_INTERNAL_SECRET; the frontend reads MARKDROP_INTERNAL_SECRET or
    # INTERNAL_API_SECRET). A server-side tenant render signs
    # `X-Markdrop-Internal` with it and is exempt from per-IP rate limits, which
    # otherwise count every reader of every custom domain as one Vercel egress
    # address. Blank: nothing is exempt.
    internal_secret: str = ""

    # ── PostHog (product analytics and session replay) ───────────────────────
    # The browser sends events with the public project key (frontend
    # lib/analyticsConfig.ts). The backend only READS, for the admin Journeys
    # tab, with a personal API key holding the query, session_recording and
    # person read scopes. Blank leaves that tab inert; nothing else depends on it.
    posthog_host: str = "https://us.posthog.com"
    posthog_project_id: str = ""
    posthog_personal_api_key: str = ""
    # Local development: show localhost traffic in the Journeys tab (hidden by default).
    posthog_include_local: bool = False
    # Development only: lets an admin inject canned PostHog failures (429, 503, timeouts) through
    # POST /api/v1/admin/journeys/_debug/fault to exercise the stale and cooldown paths.
    posthog_fault_injection: bool = False
    # Keys the opaque document reference analytics receives instead of the slug
    # (services/doc_ref.py). Blank derives one from auth_secret.
    doc_ref_secret: str = ""

    # ── MCP server + OAuth 2.1 authorization server (routers/mcp.py, oauth.py) ─
    # The MCP endpoint's canonical resource URI (RFC 8707/9728) and the OAuth
    # issuer. Blank derives both from api_base_url, so production
    # (https://api.markdrop.in) gets https://api.markdrop.in/mcp and
    # https://api.markdrop.in, and a local sandbox on http://127.0.0.1:<port>
    # gets its own loopback URLs. Plain http is only ever kept for loopback
    # hosts: anything else is advertised as https.
    mcp_resource_url: str = ""
    oauth_issuer: str = ""
    # Per-user limits on MCP tool calls, so a runaway agent loop can't spam
    # publishes. Writes cover every tool that creates, changes or deletes.
    mcp_write_rate_limit: str = "60/minute"
    mcp_read_rate_limit: str = "300/minute"
    # Per-IP limits on the public OAuth endpoints. Generous because AI clients
    # call them server to server, from a handful of shared egress addresses.
    oauth_token_rate_limit: str = "300/minute"
    oauth_register_rate_limit: str = "30/minute"
    # Development only: accept http://127.0.0.1 / http://localhost Client ID
    # Metadata Document URLs (and fetch them from loopback). Off, CIMD URLs
    # must be https and resolve to public addresses.
    oauth_cimd_allow_http_loopback: bool = False

    @property
    def oauth_issuer_url(self) -> str:
        return _public_base(self.oauth_issuer or self.api_base_url)

    @property
    def mcp_resource(self) -> str:
        if self.mcp_resource_url:
            return _public_base(self.mcp_resource_url)
        return f"{self.oauth_issuer_url}/mcp"

    @property
    def studio_url(self) -> str:
        """Markdrop Guides' studio base URL, no trailing slash (see guides_studio_url)."""
        if self.guides_studio_url.strip():
            return self.guides_studio_url.strip().rstrip("/")
        from urllib.parse import urlsplit

        front = self.frontend_url.rstrip("/")
        if (urlsplit(front).hostname or "").lower() in _LOOPBACK_HOSTS:
            return f"{front}/guides"
        return "https://guides.markdrop.in"

    def studio_link(self, path: str = "/") -> str:
        """A studio screen's address, from its studio path ("/", "/new", "/<site>/settings/people").

        On the studio host the path is the address; a studio under <app>/guides (local development)
        has its home at /guides/home, since /guides itself is the landing page.
        """
        p = path if path.startswith("/") else f"/{path}"
        base = self.studio_url
        if base.endswith("/guides") and (p == "/" or p.startswith("/?") or p.startswith("/#")):
            p = "/home" + p[1:]
        return f"{base}{p}"

    @property
    def studio_origin(self) -> str:
        """The studio's origin (scheme://host[:port]), for CORS."""
        from urllib.parse import urlsplit

        u = urlsplit(self.studio_url)
        return f"{u.scheme}://{u.netloc}" if u.scheme and u.netloc else ""

    @model_validator(mode="after")
    def _studio_origin_is_allowed(self) -> "Settings":
        # The studio host calls the API with the user's session, like markdrop.in does: it is one
        # of the app's own origins, whatever MARKDROP_CORS_ORIGINS lists.
        origin = self.studio_origin
        if origin and origin not in self.cors_origins:
            self.cors_origins = [*self.cors_origins, origin]
        return self

    @property
    def admin_email_set(self) -> frozenset[str]:
        """MARKDROP_ADMIN_EMAILS (the owners) as lowercase addresses (blank entries dropped)."""
        return frozenset(e.strip().lower() for e in self.admin_emails.split(",") if e.strip())

    @property
    def posthog_configured(self) -> bool:
        return bool(self.posthog_project_id and self.posthog_personal_api_key)

    @property
    def vercel_domains_configured(self) -> bool:
        return bool(self.vercel_api_token and self.vercel_project_id)

    @property
    def r2_endpoint_url(self) -> str:
        if self.r2_endpoint:
            return self.r2_endpoint.rstrip("/")
        return f"https://{self.r2_account_id}.r2.cloudflarestorage.com"

    @property
    def artifact_origin_is_separate_site(self) -> bool:
        """True when the artifact origin is a different *registrable* site.

        This is the strong form: different site means isolated cookies AND
        independent domain reputation, so a takedown lands on the artifact
        origin instead of the product. Note ``*.workers.dev`` / ``*.pages.dev``
        satisfy this for free — they're Public Suffix List entries, so each
        subdomain is its own site.
        """
        if not self.artifact_origin:
            return False
        from urllib.parse import urlparse

        art = (urlparse(self.artifact_origin).hostname or "").lower()
        app = (urlparse(self.frontend_url).hostname or "").lower()
        if not art or not app:
            return False
        base = ".".join(app.split(".")[-2:])  # markdrop.in
        return art != app and not art.endswith("." + base) and art != base

    @property
    def artifact_origin_is_isolated(self) -> bool:
        """Whether we'll serve artifacts from the configured origin at all.

        Always true for a separate site. For a subdomain of the app we require
        the operator to opt in explicitly, and we still refuse the app's own
        origin outright — serving user HTML there would expose the session
        token in localStorage, which no flag should be able to enable.
        """
        if not self.artifact_origin:
            return False
        if self.artifact_origin_is_separate_site:
            return True
        if not self.artifact_allow_subdomain_origin:
            return False
        from urllib.parse import urlparse

        art = (urlparse(self.artifact_origin).hostname or "").lower()
        app = (urlparse(self.frontend_url).hostname or "").lower()
        # A subdomain is permitted under the flag; the exact same host never is.
        return bool(art) and art != app

    @property
    def artifacts_configured(self) -> bool:
        return bool(
            self.r2_account_id
            and self.r2_access_key_id
            and self.r2_secret_access_key
            and self.r2_bucket
            and self.artifact_origin
            and self.artifact_signing_key
        )

    # ── P2P file share: TURN relay (Cloudflare Realtime) ─────────────────────
    # A direct WebRTC path fails on networks that isolate clients from each
    # other, lack NAT hairpinning, or only let 80/443 out. TURN is the fallback
    # that always works: both peers dial *out* to the relay, over TLS on 443 if
    # that is all the network allows. ICE still prefers a direct path, so the
    # relay only carries the transfers that would otherwise fail.
    #
    # Create a key in the Cloudflare dashboard (Realtime → TURN Server). Left
    # blank, peers get STUN only — today's behaviour, nothing breaks.
    cf_turn_key_id: str = ""
    cf_turn_api_token: str = ""
    # Lifetime of the credentials handed to browsers. Long enough to outlast a
    # big transfer (an allocation can't refresh on an expired credential); short
    # enough that a harvested one stops being a free relay soon.
    cf_turn_credential_ttl_seconds: int = 6 * 3600

    @property
    def turn_configured(self) -> bool:
        return bool(self.cf_turn_key_id and self.cf_turn_api_token)

    # ── Docs Ask AI (routers/docs_ai.py, services/docs_agent.py) ─────────────
    # Blank key: the endpoint answers with a `limit` event ("not configured")
    # and the docs site offers its Open-in-Claude links instead. Never logged.
    anthropic_api_key: str = ""
    # Kill switch. Off: same as no key, whatever the budget says.
    docs_ai_enabled: bool = True
    docs_ai_model: str = "claude-haiku-5-5"
    # low | medium | high | xhigh | max (output_config.effort).
    docs_ai_effort: str = "medium"
    # Spend caps in USD, computed from the real usage of every call (cache
    # reads/writes and the >100k-token price tier included). Days and months
    # are UTC. Reaching either answers `limit` until it rolls over.
    docs_ai_daily_usd: float = 5.0
    docs_ai_monthly_usd: float = 50.0
    # Questions per visitor (account, or hashed IP when signed out) per hour.
    docs_ai_per_visitor_hour: int = 20
    # Answers being written at once by this API process.
    docs_ai_max_concurrent: int = 8
    # Per model call. Thinking counts towards it, so leave room.
    docs_ai_max_tokens: int = 4000
    # Tool-calling rounds per question before the model must answer.
    docs_ai_max_tool_rounds: int = 6
    # The docs content (Markdown + site.json + changelog.json). Blank: the
    # repo's frontend/content/docs next to this backend.
    docs_content_dir: str = ""
    docs_site_url: str = "https://docs.markdrop.in"
    # Origins allowed to call /api/v1/docs/* from a browser (no credentials:
    # the Authorization header is the only credential these routes read).
    # http://docs.localhost:<any port> is always allowed for local development:
    # that origin can only exist on the reader's own machine.
    docs_cors_origins: list[str] = ["https://docs.markdrop.in"]
    # The docs sites Ask AI serves (services/docs_sites.py): a JSON object
    # {"id": "content dir"} or "id=dir,id=dir". Each folder holds the site's
    # Markdown, site.json and an optional ai.json. "markdrop" is always there
    # (docs_content_dir, or the repo's frontend/content/docs) unless listed
    # here with another folder. A request names its site with `site` or the
    # X-Docs-Site header; none means "markdrop". Each site.json `url` origin is
    # allowed to call /api/v1/docs/* as well as docs_cors_origins.
    docs_sites: str = ""
    # Site indexes kept in memory at once (least recently used goes first).
    docs_sites_cache_size: int = 8

    # ── Docs sites (routers/docs_sites.py, services/docs_site_*.py) ──────────
    # Hosted docs sites live at <slug>.<docs_sites_domain>.
    docs_sites_domain: str = "guides.markdrop.in"
    # The docs hosting Cloudflare account is separate from the artifacts one,
    # so its R2 credentials are too. Each also reads the plain names the build
    # worker and docs-platform/.env use (CF_ACCOUNT_ID, R2_ACCESS_KEY_ID, …).
    docs_r2_bucket: str = Field("", validation_alias=AliasChoices("MARKDROP_DOCS_R2_BUCKET"))
    docs_r2_account_id: str = Field(
        "", validation_alias=AliasChoices("MARKDROP_DOCS_R2_ACCOUNT_ID", "CF_ACCOUNT_ID"))
    docs_r2_access_key_id: str = Field(
        "", validation_alias=AliasChoices("MARKDROP_DOCS_R2_ACCESS_KEY_ID", "R2_ACCESS_KEY_ID"))
    docs_r2_secret_access_key: str = Field(
        "", validation_alias=AliasChoices("MARKDROP_DOCS_R2_SECRET_ACCESS_KEY", "R2_SECRET_ACCESS_KEY"))
    # Free plan (there is no paid plan yet). Per workspace, or per person for
    # personal sites.
    docs_sites_per_workspace: int = 3
    docs_pages_per_site: int = 1000
    docs_builds_per_day: int = 30          # server builds per site per UTC day
    # Daily caps on the work that costs (builds, imports) and on making sites, per person and per
    # workspace, per UTC day. Deleted sites count: deleting and recreating doesn't reset them.
    docs_site_creations_per_user_per_day: int = 10
    docs_site_creations_per_workspace_per_day: int = 20
    docs_imports_per_user_per_day: int = 5
    docs_imports_per_workspace_per_day: int = 10
    docs_builds_per_user_per_day: int = 50  # publishes across all of a person's sites
    docs_builds_per_workspace_per_day: int = 100
    # Password and members-only docs sites. The edge enforces them (docs-platform/edge/access.mjs,
    # services/docs_site_access.py); turn this on only once the docs Worker runs that code with its
    # DOCS_ACCESS_SECRET set to docs_access_secret below. Off: the API refuses non-public access,
    # and refuses to publish or restore a non-public site.
    docs_private_sites_enabled: bool = False
    # The secret the API shares with the docs edge Worker (its DOCS_ACCESS_SECRET): the API signs
    # short sign-in grants for password and members-only sites with it, the edge checks them and
    # signs its session cookie (services/docs_site_access.py). 32+ characters; blank = nobody can
    # sign in to a non-public site (the edge still keeps it closed).
    docs_access_secret: str = ""
    docs_access_grant_ttl_seconds: int = 120
    docs_asset_max_bytes: int = 25 * 1024 * 1024
    docs_site_storage_bytes: int = 2 * 1024 * 1024 * 1024
    # Ask AI answers per site per UTC month: shown on the dashboard and enforced by Ask AI
    # (services/docs_agent.py; a reader past it gets the `limit` answer with Open-in links).
    # Inside the global docs_ai_daily_usd / docs_ai_monthly_usd spend caps. The editor's AI help
    # (below) counts against it too: one guide, one monthly AI allowance.
    docs_ai_answers_per_month: int = 1000
    # AI help in the Guides page editor (services/docs_editor_ai.py): rewrite a selected passage
    # (improve, shorten, fix, translate). Editors and up. Uses Ask AI's key and model, and is off
    # whenever Ask AI is (docs_ai_enabled, no key) or this switch is.
    docs_editor_ai_enabled: bool = True
    # Characters per selection.
    docs_editor_ai_max_chars: int = 6000
    # Per model call (thinking counts towards it). A cut-off answer is refused, not half-applied.
    docs_editor_ai_max_tokens: int = 4000
    # Requests per person (across guides) per UTC day. Refused ones don't count. A guide's own limit
    # is its AI budget, shared with its readers' Ask AI: docs_ai_answers_per_month.
    docs_editor_ai_per_user_day: int = 50
    # The feature's own spend caps in USD (separate from Ask AI's), UTC day and month.
    docs_editor_ai_daily_usd: float = 2.0
    docs_editor_ai_monthly_usd: float = 20.0
    # Rewrites running at once in this API process.
    docs_editor_ai_max_concurrent: int = 6
    # One page's Markdown. A publish snapshot is one MongoDB document (16 MB).
    docs_page_max_chars: int = 300_000

    # ── Every AI feature (services/ai_usage.py) ──────────────────────────────
    # Defaults only: the admin panel (Admin → AI → Budgets, collection `ai_settings`) overrides
    # each of these and takes effect within ~10 s, no deploy. Days and months are UTC.
    # Spend caps across all AI features together ("*"). None: no global cap (each feature's
    # own caps still apply).
    ai_daily_usd: float | None = None
    ai_monthly_usd: float | None = None
    # Anti-abuse burst limit per signed-in person, across all AI features (refused requests
    # don't count). Not an allowance.
    ai_burst_per_minute: int = 30
    ai_burst_per_day: int = 300
    # A per-person daily spend cap in USD across all AI features. None: no per-person cap.
    ai_user_daily_usd: float | None = None
    # The readable AI request log (services/ai_log.py, Admin → AI → Requests). Our own servers'
    # addresses (comma-separated): a request from one of them (a script run on the box) is test
    # traffic, like one from localhost. The admin panel can add more and turn content capture off.
    ai_log_internal_ips: str = ""
    # AI in pages (Page AI, ledger feature "pages_ai"): kill switch and spend caps.
    pages_ai_enabled: bool = True
    pages_ai_daily_usd: float = 5.0
    pages_ai_monthly_usd: float = 50.0
    # AI search (services/search_ai.py, ledger feature "search_ai"): kill switch and spend caps
    # (owner decision 2026-11-04: $2 a day, $20 a month; the admin AI tab overrides them).
    search_ai_enabled: bool = True
    search_ai_daily_usd: float = 2.0
    search_ai_monthly_usd: float = 20.0
    # Analytics AI (ledger feature "analytics_ai": the analytics home's story, Ask and content gaps,
    # services/analytics_ai_home.py, and the per-document AI): kill switch and spend caps
    # (owner decision 2026-11-05: $2 a day, $20 a month; the admin AI tab overrides them).
    analytics_ai_enabled: bool = True
    analytics_ai_daily_usd: float = 2.0
    analytics_ai_monthly_usd: float = 20.0
    # Meetings AI (services/meetings_ai.py, ledger feature "meetings_ai"): summaries of imported
    # meetings and Ask this meeting / Ask across meetings (owner decision 2026-11-05: $5 a day,
    # $50 a month; the admin AI tab overrides them).
    meetings_ai_enabled: bool = True
    meetings_ai_daily_usd: float = 5.0
    meetings_ai_monthly_usd: float = 50.0
    # Ask's live suggestions (services/ask_suggestions.py, ledger feature "ask_suggestions"): one Haiku
    # call per workspace rebuild (owner decision 2026-11-06: $0.50 a day, $5 a month; the admin AI tab
    # overrides them).
    ask_suggestions_enabled: bool = True
    ask_suggestions_daily_usd: float = 0.5
    ask_suggestions_monthly_usd: float = 5.0
    # Team memory (services/workspace_memory.py, ledger feature "workspace_memory"): the background
    # reading of meetings and pages into who-is-doing-what facts, in workspaces that turned it on
    # (owner decision 2026-11-06: $3 a day, $30 a month; the admin AI tab overrides them).
    workspace_memory_enabled: bool = True
    workspace_memory_daily_usd: float = 3.0
    workspace_memory_monthly_usd: float = 30.0

    # ── Markdrop for Slack (services/slack*.py, routers/slack.py) ────────────
    # The one Slack app Markdrop owns (docs-platform/slack/manifest.yaml + SETUP.md). All three come
    # from the app's Basic Information page; until they are all set (and token_encryption_key, which
    # protects the teams' bot tokens at rest) the Slack card says "Not set up yet".
    slack_client_id: str = ""
    slack_client_secret: str = ""
    slack_signing_secret: str = ""
    # Slack's Web API and web addresses (tests point them elsewhere; the defaults are slack.com).
    slack_api_base: str = "https://slack.com/api"
    slack_web_base: str = "https://slack.com"

    # ── Jira Cloud (services/jira*.py, routers/jira.py) ──────────────────────
    # Markdrop's Atlassian OAuth 2.0 (3LO) app (developer.atlassian.com/console/myapps; docs:
    # integrations/jira.md). Both come from the app's Settings page; until both are set (and
    # token_encryption_key, which protects people's Atlassian tokens at rest) the Jira cards say
    # "Not set up yet". Its callback URL is <frontend_url>/integrations/jira/callback.
    atlassian_client_id: str = ""
    atlassian_client_secret: str = ""
    # Atlassian's sign-in and API hosts (tests point them elsewhere).
    atlassian_auth_base: str = "https://auth.atlassian.com"
    atlassian_api_base: str = "https://api.atlassian.com"
    # Jira AI (services/jira_ai.py, ledger feature "jira_ai"): drafting issues from meetings, Team and
    # pages (owner decision 2026-11-06: $1 a day, $10 a month; the admin AI tab overrides them).
    jira_ai_enabled: bool = True
    jira_ai_daily_usd: float = 1.0
    jira_ai_monthly_usd: float = 10.0

    # ── Push notifications (Web Push: services/webpush.py, services/push.py) ──
    # The server's VAPID key pair (RFC 8292). Generate one with
    #   python -m app.services.webpush keys
    # (prints all three lines); check a .env with  python -m app.services.webpush check.
    # Private: 32 raw bytes, base64url (or a PEM). Public: 65 bytes uncompressed, base64url; derived
    # from the private key when blank. Subject: a mailto: or https: contact for the push services.
    # Until the private key is set, the Push card says "Not set up yet" and nothing is sent.
    vapid_public_key: str = ""
    vapid_private_key: str = ""
    vapid_subject: str = "https://markdrop.in"
    # Extra push-service hosts (comma separated, host or host:port; plain http allowed): the tests'
    # and the e2e stack's fake push service. Never set in production.
    push_endpoint_hosts_extra: str = ""

    @property
    def slack_configured(self) -> bool:
        return bool(self.slack_client_id and self.slack_client_secret and self.slack_signing_secret
                    and self.token_encryption_key)

    @property
    def jira_configured(self) -> bool:
        return bool(self.atlassian_client_id and self.atlassian_client_secret and self.token_encryption_key)

    @property
    def docs_r2_configured(self) -> bool:
        return bool(self.docs_r2_bucket and self.docs_r2_account_id
                    and self.docs_r2_access_key_id and self.docs_r2_secret_access_key)

    # Analytics geo-IP (Phase 4) — MaxMind GeoLite2 City DB
    geoip_db_path: str = ""  # e.g. /opt/markdrop/geoip/GeoLite2-City.mmdb
    ip_hash_salt: str = "change-this-ip-hash-salt-in-production"

    # Docs Studio job pipeline (services/docs_jobs.DocsJobsSettings reads these). Declared here too
    # because this model forbids unknown MARKDROP_ keys in .env (tests/test_config_docs_jobs.py
    # keeps the two lists in step).
    docs_job_secret: str = ''
    docs_job_token_ttl_seconds: int = 10800
    docs_job_api_base: str = ''
    docs_job_lock_seconds: int = 120
    docs_job_max_attempts: int = 3
    docs_job_running_timeout_minutes: int = 25
    docs_job_queued_timeout_minutes: int = 180
    docs_site_host_template: str = ''
    docs_ai_api: str = ''
    docs_build_targets: str = 'actions,local'
    docs_builder_repo: str = ''
    docs_builder_token: str = ''
    docs_builder_workflow: str = 'docs-job.yml'
    docs_builder_ref: str = 'main'
    docs_actions_monthly_minutes: int = 1800
    docs_dispatch_retry_minutes: int = 10
    docs_local_import_max_pages: int = 40  # no longer read: imports run on Actions only (docs_dispatch)
    docs_local_build_max_mb: int = 768
    docs_local_min_free_mb: int = 1200
    docs_local_build_timeout_seconds: int = 900
    docs_cf_api_token: str = ''
    docs_cf_account_id: str = ''
    docs_cf_zone_name: str = 'markdrop.in'
    docs_cf_worker: str = 'markdrop-docs-edge'
    docs_cf_zone_id: str = ''
    docs_custom_domain_target: str = 'cname.guides.markdrop.in'
    docs_domain_connect_key: str = ''
    docs_domain_connect_key_host: str = '_dcpubkeyv1'
    # ── Markdrop Guides: Import from GitHub + keep in sync (services/docs_github_app.py) ──
    # The "Markdrop Guides" GitHub App (docs-platform/setup-github-app.md). The app counts as set up
    # only when all six are set; until then public repositories still import (no sync), and private
    # repositories and sync say "Not set up yet". The private key is the app's PEM (a one-line value
    # with literal "\n" escapes is accepted).
    docs_github_app_id: str = ''
    docs_github_app_slug: str = ''
    docs_github_app_private_key: str = ''
    docs_github_webhook_secret: str = ''
    docs_github_client_id: str = ''
    docs_github_client_secret: str = ''
    # GitHub's API and web addresses (tests and GitHub Enterprise; the defaults are github.com).
    docs_github_api: str = 'https://api.github.com'
    docs_github_web: str = 'https://github.com'
    # Pushes a guide may sync per day (each is an import job on Actions).
    docs_github_syncs_per_site_per_day: int = 50

    model_config = {"env_file": ".env", "env_prefix": "MARKDROP_"}


_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


def _public_base(url: str) -> str:
    """`url` without a trailing slash, upgraded to https unless it is loopback.

    OAuth metadata, token audiences and redirect `iss` values are compared as
    strings by clients, so the advertised form has to be stable. A plain-http
    address is only meaningful for a local sandbox; anywhere else it would mean
    tokens and codes crossing the network in the clear.
    """
    from urllib.parse import urlsplit, urlunsplit

    parts = urlsplit(url.strip().rstrip("/"))
    host = (parts.hostname or "").lower()
    scheme = parts.scheme.lower() or "https"
    if scheme == "http" and host not in _LOOPBACK_HOSTS:
        scheme = "https"
    return urlunsplit((scheme, parts.netloc.lower(), parts.path, "", ""))


@lru_cache
def get_settings() -> Settings:
    return Settings()
