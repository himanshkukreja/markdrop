from dataclasses import dataclass
from datetime import datetime


@dataclass
class Document:
    slug: str
    content: str
    edit_secret_hash: str
    created_at: datetime
    updated_at: datetime
    title: str | None = None
    expires_at: datetime | None = None
    views: int = 0
    read_password_hash: str | None = None
    owner_id: str | None = None
    export_pdf_count: int = 0
    copy_url_count: int = 0
    rev: int = 1  # bumped on every content change; drives sync concurrency
    # Google Docs export link (optional). synced_rev records the doc `rev` that
    # was last pushed to Google, so the UI can tell when the Doc is stale.
    google_doc_id: str | None = None
    google_doc_url: str | None = None
    google_doc_synced_rev: int | None = None
    google_doc_synced_at: datetime | None = None
    # True once the document has been published or synced from the VS Code
    # extension — drives the "Synced with VS Code" badge on the doc + dashboard.
    vscode_synced: bool = False
    # ── End-to-end encryption ────────────────────────────────────────────────
    # True when `content` (and `title`, when set) hold a client-produced AES-GCM
    # envelope instead of text. The key lives only in the URL fragment, which
    # browsers never transmit, so nothing here or in any log can read it.
    #
    # Immutable after creation, deliberately: the server can neither encrypt an
    # existing plaintext document nor decrypt an encrypted one, so a flag that
    # could be flipped would only ever produce a corrupt record.
    encrypted: bool = False
    # ── Workspaces ───────────────────────────────────────────────────────────
    # None means an ordinary markdrop.in document — which is every document that
    # existed before workspaces did, and remains the default. Only documents that
    # belong to a workspace can be served from that workspace's custom domains.
    workspace_id: str | None = None
    # ── Artifacts ────────────────────────────────────────────────────────────
    # kind="artifact" records store their bytes in R2 (`blob_key`) instead of
    # `content`, and render on the isolated artifact origin. Everything else on
    # this model — slug, edit secret, password, expiry, owner, counters — works
    # identically for both kinds.
    kind: str = "markdown"            # "markdown" | "artifact"
    mime: str | None = None
    blob_key: str | None = None
    size_bytes: int | None = None
    original_filename: str | None = None
    # Set for multi-file bundles: every object lives under this R2 prefix, so
    # deleting the document must clear the whole prefix, not just blob_key.
    bundle_prefix: str | None = None
    id: str | None = None  # str(_id); populated when the query includes _id

