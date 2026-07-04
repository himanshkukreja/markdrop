from pydantic import BaseModel


class GoogleConnectResponse(BaseModel):
    auth_url: str


class GoogleStatusResponse(BaseModel):
    connected: bool       # this account has a stored Google refresh token
    configured: bool      # the server has OAuth + encryption configured at all


class GoogleExportResponse(BaseModel):
    google_doc_id: str
    google_doc_url: str | None
    synced_rev: int | None    # the markdrop rev last pushed to Google
    rev: int                  # the document's current rev (== synced_rev after export)
