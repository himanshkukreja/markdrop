"""Meeting memory while writing (services/meeting_memory.py): what the team decided in meetings,
next to the page being written.

    POST  /api/v1/meeting-memory/related   {page?, workspace?, title?, heading?, selection?, section?, q?,
                                            kinds?, limit?} → {facts, hints, meetings, workspace_id, prefs}
    POST  /api/v1/meeting-memory/check     {page, heading?, section, facts: [id]} → {results, cached, reason?}
    GET   /api/v1/meeting-memory/prefs     → {panel, hints}
    PATCH /api/v1/meeting-memory/prefs     {panel?, hints?} → {panel, hints}

Signed-in workspace members. ``related`` is search (no model): facts only from meetings whose page the
caller can open now. ``check`` asks Claude Haiku whether the section contradicts or leaves out the
given decisions (``meetings_ai`` limits; answers cached per section text for 30 days); it needs edit
access to the page.
"""

# No `from __future__ import annotations`: slowapi wraps these routes (see routers/docs_ai.py).
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.encoders import jsonable_encoder
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from app.database import get_database
from app.limiter import limiter
from app.models.user import User
from app.routers.auth import require_user
from app.services import access, meeting_memory, meetings
from app.utils.net import get_client_ip

router = APIRouter(prefix="/api/v1/meeting-memory", tags=["meeting-memory"])


def get_db() -> AsyncIOMotorDatabase:
    return get_database()


def _ac(request: Request, db, user: User):
    return (access.actor_from_request(request, user),
            access.Ctx(db, surface="rest", ip=get_client_ip(request)))


Kind = Literal["decision", "action_item", "open_question", "topic"]


class RelatedBody(BaseModel):
    page: Optional[str] = Field(None, max_length=200, description="The page being written (its slug): its workspace, and its own meeting left out.")
    workspace: Optional[str] = Field(None, max_length=40, description="A workspace id, when there is no page.")
    title: Optional[str] = Field(None, max_length=300)
    heading: Optional[str] = Field(None, max_length=300, description="The heading of the section under the caret.")
    selection: Optional[str] = Field(None, max_length=2000)
    section: Optional[str] = Field(None, max_length=meeting_memory.MAX_TEXT + 2000, description="The section's text (Markdown).")
    q: Optional[str] = Field(None, max_length=200, description="A typed search.")
    kinds: Optional[list[Kind]] = Field(None, max_length=4)
    limit: int = Field(meeting_memory.LIMIT_DEFAULT, ge=1, le=meeting_memory.LIMIT_MAX)


class CheckBody(BaseModel):
    page: str = Field(..., max_length=200)
    heading: Optional[str] = Field(None, max_length=300)
    section: str = Field(..., max_length=meeting_memory.CHECK_SECTION_CHARS + 2000)
    facts: list[str] = Field(..., min_length=1, max_length=meeting_memory.CHECK_MAX_FACTS)


class PrefsBody(BaseModel):
    panel: Optional[bool] = None
    hints: Optional[bool] = None


async def _page(db, slug: str, actor: access.Actor, ctx: access.Ctx, action: str = "read") -> dict:
    raw = await db["documents"].find_one({"slug": slug.strip().rsplit("/", 1)[-1]}, {"content": 0})
    await access.require(actor, raw, action, ctx)
    return raw


@router.post("/related")
@limiter.limit("120/minute")
async def related(request: Request, body: RelatedBody, db: AsyncIOMotorDatabase = Depends(get_db),
                  user: User = Depends(require_user)):
    """Decisions, action items, open questions and topics from the workspace's meetings related to what
    is being written, best first, each with its date, meeting, series, a link to the moment and the
    cited line to insert; ``hints``: a related decision the section seems to leave out (clear matches
    only)."""
    actor, ctx = _ac(request, db, user)
    exclude = None
    if body.page:
        raw = await _page(db, body.page, actor, ctx)
        ws = raw.get("workspace_id")
        exclude = raw.get("meeting_id")
    else:
        if not body.workspace:
            raise HTTPException(status_code=422, detail="Pass the page or the workspace.")
        ws = body.workspace.strip()
    prefs = await meeting_memory.get_prefs(db, user.id)
    if not ws:
        return {"facts": [], "hints": [], "meetings": 0, "workspace_id": None, "prefs": prefs}
    await meetings.require_member(db, ws, user.id, write=False)
    out = await meeting_memory.related(db, actor, ctx, ws, title=body.title, heading=body.heading,
                                       selection=body.selection, section=body.section, q=body.q,
                                       kinds=list(body.kinds or []) or None, limit=body.limit, exclude_meeting=exclude)
    if not prefs["hints"]:
        out["hints"] = []
    return jsonable_encoder({**out, "workspace_id": ws, "prefs": prefs})


@router.post("/check")
@limiter.limit("30/minute")
async def check(request: Request, body: CheckBody, db: AsyncIOMotorDatabase = Depends(get_db),
                user: User = Depends(require_user)):
    """AI's verdict on the section against these decisions: ``contradicts`` / ``omits`` /
    ``consistent`` with a one-line note. Never edits the page."""
    actor, ctx = _ac(request, db, user)
    raw = await _page(db, body.page, actor, ctx, "edit_content")
    if raw.get("workspace_id"):
        await meetings.require_member(db, raw["workspace_id"], user.id, write=False)
    return jsonable_encoder(await meeting_memory.check(db, actor, ctx, raw, heading=body.heading, section=body.section,
                                                       fact_ids=body.facts))


@router.get("/prefs")
@limiter.limit("120/minute")
async def get_prefs(request: Request, db: AsyncIOMotorDatabase = Depends(get_db), user: User = Depends(require_user)):
    """Your switches: ``panel`` (the "From meetings" panel shows by itself) and ``hints`` (suggestions
    when a section seems to leave out a decision). Both on by default."""
    return await meeting_memory.get_prefs(db, user.id)


@router.patch("/prefs")
@limiter.limit("60/minute")
async def set_prefs(request: Request, body: PrefsBody, db: AsyncIOMotorDatabase = Depends(get_db),
                    user: User = Depends(require_user)):
    return await meeting_memory.set_prefs(db, user.id, body.model_dump(exclude_none=True))
