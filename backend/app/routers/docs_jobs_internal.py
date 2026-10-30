"""The API a docs job runner outside the server calls (GitHub Actions: docs-platform/runner/run-job.mjs).

    GET  /api/v1/internal/docs-jobs/{id}?runner=<id>   claim the job → its spec (content bundle or import source)
    POST /api/v1/internal/docs-jobs/{id}/progress       {runner, step, done, total, message} (also renews the lock)
    POST /api/v1/internal/docs-jobs/{id}/result         {runner, ok, manifest_hash?, stats?, timings?, error?, runner_ms?}
    POST /api/v1/internal/docs-jobs/{id}/import-result  {runner, ok: true, import: {...}, runner_ms?}

Every call carries ``Authorization: Bearer <job token>``: an HMAC of the job id
and an expiry (services/docs_jobs.job_token, MARKDROP_DOCS_JOB_SECRET), handed
to the run in its workflow_dispatch inputs. A token opens this one job and
nothing else; the runner never sees Mongo or any other credential of the API.
Not in the public schema.

Answers: 401 bad token, 404 no such job, 409 the job isn't this runner's (taken,
or another build of the site is running), 410 finished, 413 body too big.
"""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from app.database import get_database
from app.limiter import limiter
from app.services import docs_build, docs_dispatch, docs_import_job, docs_jobs

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/internal/docs-jobs", tags=["internal"])

MAX_BODY = 32 * 1024 * 1024  # an import of 1,000 pages is a few MB of Markdown


def _auth(request: Request, job_id: str) -> None:
    if not docs_jobs.get_jobs_settings().docs_job_secret:
        raise HTTPException(503, "docs jobs are not enabled on this server")
    h = request.headers.get("authorization") or ""
    token = h[7:].strip() if h.lower().startswith("bearer ") else ""
    if not docs_jobs.verify_job_token(job_id, token):
        raise HTTPException(401, "bad or expired job token")


async def _body(request: Request) -> dict:
    n = int(request.headers.get("content-length") or 0)
    if n > MAX_BODY:
        raise HTTPException(413, "body too large")
    raw = b""
    async for chunk in request.stream():
        raw += chunk
        if len(raw) > MAX_BODY:
            raise HTTPException(413, "body too large")
    try:
        body = json.loads(raw or b"{}")
    except ValueError:
        raise HTTPException(400, "body must be JSON")
    if not isinstance(body, dict):
        raise HTTPException(400, "body must be a JSON object")
    return body


async def _held(db, job_id: str, runner: str) -> dict:
    job = await db[docs_jobs.JOBS].find_one({"_id": docs_jobs.oid(job_id)})
    if job is None:
        raise HTTPException(404, "no such job")
    if job["status"] in ("done", "failed"):
        raise HTTPException(410, f"the job is {job['status']}")
    if job["status"] != "running" or job.get("locked_by") != runner:
        raise HTTPException(409, "the job isn't held by this runner")
    return job


def _runner(value: object) -> str:
    r = str(value or "").strip()[:80]
    if not r:
        raise HTTPException(400, "runner is required")
    return r


@router.get("/{job_id}")
@limiter.limit("60/minute")
async def get_job(request: Request, job_id: str, runner: str = ""):
    _auth(request, job_id)
    runner = _runner(runner)
    db = get_database()
    job, why = await docs_jobs.claim_job(db, job_id, runner)
    if job is None:
        status = {"missing": 404, "finished": 410}.get(why, 409)
        return JSONResponse({"detail": why}, status_code=status)
    try:
        if job["kind"] == "build":
            build = await docs_build.start_build(db, job)
            spec = await docs_build.build_spec(db, job, build)
        elif job["kind"] == "import":
            spec = docs_import_job.import_spec(job)
        else:
            await docs_jobs.release(db, job["_id"], runner)
            return JSONResponse({"detail": f"{job['kind']} jobs run on the server"}, status_code=409)
    except (LookupError, PermissionError) as e:
        if job["kind"] == "build":
            await docs_build.fail_build_job(db, job, runner, str(e))
        else:
            await docs_jobs.fail(db, job["_id"], runner, str(e))
        return JSONResponse({"detail": str(e)}, status_code=410)
    log.info("docs job %s (%s) claimed by %s", job_id, job["kind"], runner)
    return spec


@router.post("/{job_id}/progress")
@limiter.limit("120/minute")
async def post_progress(request: Request, job_id: str):
    _auth(request, job_id)
    body = await _body(request)
    runner = _runner(body.get("runner"))
    db = get_database()
    if not await docs_jobs.set_progress(db, job_id, runner, body):
        await _held(db, job_id, runner)  # raises the right status
    return {"ok": True}


@router.post("/{job_id}/result")
@limiter.limit("30/minute")
async def post_result(request: Request, job_id: str):
    _auth(request, job_id)
    body = await _body(request)
    runner = _runner(body.get("runner"))
    db = get_database()
    job = await _held(db, job_id, runner)
    if job["kind"] == "build":
        out = await docs_build.finish_build(db, job, runner, body)
    else:
        err = str(body.get("error") or ("the import reported no data" if body.get("ok") else "the job failed"))
        await docs_jobs.fail(db, job["_id"], runner, err)
        out = {"ok": False, "error": err}
    await _minutes(db, job, body)
    await docs_dispatch.kick(db, site_id=job["site_id"])
    return {"ok": True, "result": out}


@router.post("/{job_id}/import-result")
@limiter.limit("30/minute")
async def post_import_result(request: Request, job_id: str):
    _auth(request, job_id)
    body = await _body(request)
    runner = _runner(body.get("runner"))
    db = get_database()
    job = await _held(db, job_id, runner)
    if job["kind"] != "import":
        raise HTTPException(409, "not an import job")
    data = body.get("import")
    if not body.get("ok") or not isinstance(data, dict):
        await docs_jobs.fail(db, job["_id"], runner, str(body.get("error") or "the import reported no data"))
        return {"ok": True, "result": {"ok": False}}
    out = await docs_import_job.apply_import(db, job, runner, data)
    await _minutes(db, job, body)
    return {"ok": True, "result": {k: out.get(k) for k in ("ok", "pages", "nav_groups")}}


async def _minutes(db, job: dict, body: dict) -> None:
    ms = body.get("runner_ms")
    if job.get("target") == "actions" and isinstance(ms, (int, float)) and ms > 0:
        await db[docs_jobs.JOBS].update_one({"_id": job["_id"]}, {"$set": {"actions_minutes": int(-(-int(ms) // 60000))}})
