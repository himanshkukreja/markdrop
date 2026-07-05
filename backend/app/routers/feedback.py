"""Public endpoint for submitting bug reports & feature requests.

Open to everyone — anonymous visitors and signed-in users alike. When the caller
is authenticated we attach their user id (and fall back to their account email if
they didn't type one), so triage in the admin dashboard has context. Admin
read/manage endpoints live in ``routers/admin.py``.
"""

from fastapi import APIRouter, Depends, Request
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import optional_user
from app.schemas.feedback import FeedbackCreate
from app.services import feedback as feedback_service

router = APIRouter(prefix="/api/v1/feedback", tags=["feedback"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


@router.post("", status_code=201)
@limiter.limit("5/minute")
async def submit_feedback(
    request: Request,
    data: FeedbackCreate,
    db: AsyncIOMotorDatabase = Depends(get_db),
    user: User | None = Depends(optional_user),
):
    """Record a bug report or feature request. Always returns {status: received}."""
    email = data.email or (user.email if user else None)
    await feedback_service.create_feedback(
        db,
        type=data.type,
        message=data.message,
        email=email,
        user_id=user.id if user else None,
        page_url=data.page_url,
        user_agent=request.headers.get("user-agent", ""),
    )
    return {"status": "received"}
