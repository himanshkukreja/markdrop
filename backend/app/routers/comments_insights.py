"""Comment analytics, exports and digest (Track C; CONTRACT §5).

STUB from the contract commit: Track C owns this file. Routes live under
/api/v1/documents/{slug}/comments/insights…, /api/v1/documents/{slug}/comments/export…, /api/v1/comments/digest….
"""

from fastapi import APIRouter

router = APIRouter(tags=["comments"])
