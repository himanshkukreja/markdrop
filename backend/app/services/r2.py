"""Cloudflare R2 object storage — the blob store behind artifacts.

Markdown documents keep living in MongoDB (they're ~7 KB of text). Artifacts are
a different shape entirely: a PDF or spreadsheet is megabytes of binary, so the
bytes go to R2 and only metadata stays in Mongo.

Bytes never pass through this server. The browser uploads straight to R2 with a
presigned PUT, and rendered artifacts are served from the Cloudflare edge. Both
matter on a 2 vCPU / 1.9 GB box.

boto3 is synchronous. Presigning is pure local HMAC with no network I/O, so it's
safe to call inline; every function that actually talks to R2 is marked and must
be awaited through ``run_in_threadpool`` by its caller (same pattern the diagram
and OG renderers already use).
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any

from app.config import get_settings

settings = get_settings()


def is_configured() -> bool:
    return settings.artifacts_configured


@lru_cache(maxsize=1)
def _client():
    """Build the S3-compatible client for R2 (cached — it's thread-safe)."""
    import boto3
    from botocore.config import Config

    return boto3.client(
        "s3",
        endpoint_url=settings.r2_endpoint_url,
        aws_access_key_id=settings.r2_access_key_id,
        aws_secret_access_key=settings.r2_secret_access_key,
        # R2 ignores regions but SigV4 requires one; "auto" is Cloudflare's.
        region_name="auto",
        config=Config(signature_version="s3v4", retries={"max_attempts": 3}),
    )


def presign_put(key: str, content_type: str) -> str:
    """Presigned URL for a direct browser upload.

    Binding ``ContentType`` into the signature means the client must send
    exactly that header — it cannot declare ``text/csv`` here and then upload
    ``text/html`` to escape the sandbox routing.

    Note S3/R2 presigned *PUT* cannot enforce a size limit (only POST policies
    can), so the caller must verify the real size with :func:`head` after the
    upload and discard anything oversized.
    """
    return _client().generate_presigned_url(
        "put_object",
        Params={"Bucket": settings.r2_bucket, "Key": key, "ContentType": content_type},
        ExpiresIn=settings.artifact_upload_ttl_seconds,
        HttpMethod="PUT",
    )


# ── Network calls — wrap these in run_in_threadpool ────────────────────────────


def head(key: str) -> dict[str, Any] | None:
    """Real size/type of an uploaded object, or None if it isn't there."""
    try:
        r = _client().head_object(Bucket=settings.r2_bucket, Key=key)
    except Exception:
        return None
    return {
        "size": int(r.get("ContentLength", 0)),
        "content_type": r.get("ContentType") or "application/octet-stream",
        "etag": (r.get("ETag") or "").strip('"'),
    }


def delete(key: str) -> None:
    """Best-effort delete. Missing keys are a no-op, which is what we want for
    orphan cleanup after a failed upload."""
    try:
        _client().delete_object(Bucket=settings.r2_bucket, Key=key)
    except Exception:
        pass


def get_bytes(key: str, max_bytes: int) -> bytes | None:
    """Read an object back, capped. Used for server-side peeks (OG snippets,
    HTML sanity checks) — never to serve the artifact to a viewer."""
    try:
        r = _client().get_object(
            Bucket=settings.r2_bucket, Key=key, Range=f"bytes=0-{max_bytes - 1}"
        )
        return r["Body"].read()
    except Exception:
        return None


def put_bytes(key: str, data: bytes, content_type: str) -> bool:
    """Upload from the server. Only used for the small pasted-HTML path, where a
    presigned round trip would be pointless ceremony — real file uploads always
    go browser→R2 direct so bytes never touch this box."""
    try:
        _client().put_object(
            Bucket=settings.r2_bucket,
            Key=key,
            Body=data,
            ContentType=content_type,
            # Keys are random and never reused, so a blob is immutable.
            CacheControl="public, max-age=31536000, immutable",
        )
        return True
    except Exception:
        return False
