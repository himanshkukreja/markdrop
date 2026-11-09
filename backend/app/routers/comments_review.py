"""Suggested edits, AI and attachments on comment threads (Track B; CONTRACT §5).

STUB from the contract commit: Track B owns this file. Routes live under
/api/v1/documents/{slug}/comments/{thread_id}/suggestion…, …/ai/…, /api/v1/documents/{slug}/comments/attachments….
"""

from fastapi import APIRouter

router = APIRouter(tags=["comments"])
