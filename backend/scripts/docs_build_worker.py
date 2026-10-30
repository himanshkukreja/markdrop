"""Markdrop Docs local worker: runs the docs jobs routed to "local" (builds, imports, restores, unpublishes, access policies).

GitHub Actions runs most builds (services/docs_dispatch.py). This worker runs
what the dispatcher sends to the server (restores, small imports, builds when
Actions is unavailable) and is the whole pipeline in local development or on a
dedicated build box. A build or import is done by the same Node runner Actions
uses (docs-platform/runner/run-job.mjs), fed a spec file instead of the API.

    cd backend
    .venv/bin/python -m scripts.docs_build_worker            # poll until SIGTERM
    .venv/bin/python -m scripts.docs_build_worker --once     # run what is queued, then exit

Config is the environment only (MARKDROP_ prefix, plus backend/.env on the
server like the API): MONGODB_URI / MONGODB_DB, DOCS_R2_* (the docs Cloudflare
account's bucket keys, config.py), DOCS_BUILD_TARGETS, DOCS_LOCAL_BUILD_MAX_MB,
DOCS_LOCAL_MIN_FREE_MB, DOCS_LOCAL_BUILD_TIMEOUT_SECONDS (services/docs_jobs.py),
and for this process:

    MARKDROP_DOCS_WORKER_CONCURRENCY   jobs at once (default 1; builds are 1 at a time regardless)
    MARKDROP_DOCS_WORKER_KINDS         build,import,restore,unpublish,access
    MARKDROP_DOCS_WORKER_POLL_SECONDS  5
    MARKDROP_DOCS_WORKER_GRACE_SECONDS 120 (on SIGTERM: let running jobs finish this long, then hand them back)
    MARKDROP_DOCS_WORKER_DISPATCH      1 = also run the dispatcher pass (routing + sweeper; a lease, so
                                       it never doubles the API's); 0 = only claim
    MARKDROP_DOCS_PLATFORM_DIR         <repo>/docs-platform
    MARKDROP_DOCS_ENGINE_DIR           <repo>/frontend (with node_modules)
    MARKDROP_DOCS_WORK_DIR             stage + Next cache + asset cache, kept between jobs
    MARKDROP_DOCS_NODE                 node binary (default: node on PATH)
    MARKDROP_DOCS_BUILD_PORT_BASE      3591 (slot n crawls on base + n)
    MARKDROP_DOCS_NICE                 1 = run builds under nice -n 15 (+ ionice -c3 when present)
    MARKDROP_DOCS_LOCAL_CONVERT_GIFS   1 = let local imports convert GIFs with ffmpeg (a build box)
    MARKDROP_DOCS_STORE_DIR            publish to a folder instead of R2 (tests, self-host)
    MARKDROP_DOCS_BUILD_CPUS           Next render workers per build (default 1: the memory peak)

Logs are JSON lines on stdout (event, job, site, timings); page content is never logged.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import secrets
import shutil
import signal
import socket
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

from motor.motor_asyncio import AsyncIOMotorClient

ROOT = Path(__file__).resolve().parents[2]

from app.config import get_settings  # noqa: E402
from app.services import docs_build, docs_dispatch, docs_import_job, docs_jobs  # noqa: E402
from app.services.docs_jobs import JOBS, get_jobs_settings, now  # noqa: E402


def log(event: str, level: str = "info", **kw) -> None:
    row = {"ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds"), "level": level, "event": event}
    row.update({k: (str(v) if k in ("job", "site") else v) for k, v in kw.items() if v is not None})
    print(json.dumps(row, default=str), flush=True)


class Config:
    def __init__(self, env=os.environ):
        self.concurrency = max(1, int(env.get("MARKDROP_DOCS_WORKER_CONCURRENCY", "1")))
        self.kinds = tuple(k for k in env.get("MARKDROP_DOCS_WORKER_KINDS", "build,import,restore,unpublish,access").split(",") if k in docs_jobs.KINDS)
        self.poll = float(env.get("MARKDROP_DOCS_WORKER_POLL_SECONDS", "5"))
        self.grace = float(env.get("MARKDROP_DOCS_WORKER_GRACE_SECONDS", "120"))
        self.dispatch = env.get("MARKDROP_DOCS_WORKER_DISPATCH", "1") == "1"
        self.platform = Path(env.get("MARKDROP_DOCS_PLATFORM_DIR") or ROOT / "docs-platform")
        self.engine = Path(env.get("MARKDROP_DOCS_ENGINE_DIR") or ROOT / "frontend")
        self.work = Path(env.get("MARKDROP_DOCS_WORK_DIR") or Path(tempfile.gettempdir()) / "markdrop-docs-worker")
        self.node = env.get("MARKDROP_DOCS_NODE") or shutil.which("node") or "node"
        self.port_base = int(env.get("MARKDROP_DOCS_BUILD_PORT_BASE", "3591"))
        self.nice = env.get("MARKDROP_DOCS_NICE", "1") == "1"
        self.convert_gifs = env.get("MARKDROP_DOCS_LOCAL_CONVERT_GIFS", "0") == "1"
        self.passthrough = {k: env[k] for k in ("MARKDROP_DOCS_STORE_DIR", "MARKDROP_DOCS_IMPORT_CACHE_DIR",
                                                  "MARKDROP_DOCS_ENGINE_ASSETS_DIR", "MARKDROP_DOCS_ASSET_CACHE") if env.get(k)}


def mem_available_mb() -> int | None:
    """MemAvailable from /proc/meminfo (Linux); None elsewhere."""
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) // 1024
    except OSError:
        return None
    return None


def tree_rss_mb(pgid: int) -> int:
    """Resident memory of every process in a process group (ps works on Linux and macOS)."""
    try:
        import subprocess

        out = subprocess.run(["ps", "-A", "-o", "pgid=,rss="], capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return 0
    kb = 0
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0] == str(pgid):
            kb += int(parts[1])
    return kb // 1024


class Running:
    def __init__(self, job: dict, slot: int):
        self.job = job
        self.slot = slot
        self.proc: asyncio.subprocess.Process | None = None
        self.abandon = False
        self.peak_rss_mb = 0


class Worker:
    def __init__(self, db, cfg: Config, *, once: bool = False):
        self.db = db
        self.cfg = cfg
        self.once = once
        self.id = f"{socket.gethostname()}:{os.getpid()}:{secrets.token_hex(3)}"
        self.stop = asyncio.Event()
        self.running: dict[int, Running] = {}
        self.tasks: set[asyncio.Task] = set()

    # ── claiming ────────────────────────────────────────────────────────────

    async def local_build_running(self) -> bool:
        return await self.db[JOBS].count_documents({"kind": "build", "target": "local", "status": "running",
                                                    "locked_until": {"$gt": now()}}) > 0

    async def kinds_now(self) -> tuple[str, ...]:
        kinds = set(self.cfg.kinds)
        if "build" in kinds:
            if any(r.job["kind"] == "build" for r in self.running.values()) or await self.local_build_running():
                kinds.discard("build")
            else:
                free = mem_available_mb()
                need = get_jobs_settings().docs_local_min_free_mb
                if free is not None and free < need:
                    kinds.discard("build")
                    log("guard_memory", level="warning", free_mb=free, need_mb=need)
        return tuple(k for k in docs_jobs.KINDS if k in kinds)

    async def claim(self) -> dict | None:
        kinds = await self.kinds_now()
        if not kinds:
            return None
        job = await docs_jobs.claim_next(self.db, self.id, kinds=kinds, target="local")
        if job and job["kind"] == "build":
            # Max one local build: two workers that claimed at once settle it by claim time.
            mine = docs_jobs.aware(job.get("claimed_at"))
            async for o in self.db[JOBS].find({"_id": {"$ne": job["_id"]}, "kind": "build", "target": "local",
                                               "status": "running", "locked_until": {"$gt": now()}}):
                theirs = docs_jobs.aware(o.get("claimed_at"))
                if theirs and mine and (theirs < mine or (theirs == mine and o["_id"] < job["_id"])):
                    await docs_jobs.release(self.db, job["_id"], self.id)
                    return None
        return job

    # ── running ─────────────────────────────────────────────────────────────

    def runner_env(self, slot: int, heavy: bool) -> dict:
        s = get_jobs_settings()
        app_s = get_settings()
        env = {k: os.environ[k] for k in ("PATH", "HOME", "LANG", "TMPDIR", "SYSTEMROOT") if k in os.environ}
        env.update({
            "MARKDROP_DOCS_WORK_DIR": str(self.cfg.work / f"slot-{slot}"),
            "MARKDROP_DOCS_ASSET_CACHE": str(self.cfg.work / "asset-cache"),
            "MARKDROP_DOCS_ENGINE_DIR": str(self.cfg.engine),
            "MARKDROP_DOCS_BUILD_PORT": str(self.cfg.port_base + slot),
            "NEXT_TELEMETRY_DISABLED": "1",
        })
        env.update(self.cfg.passthrough)
        if "MARKDROP_DOCS_STORE_DIR" not in env:
            env.update({"MARKDROP_DOCS_R2_BUCKET": app_s.docs_r2_bucket, "CF_ACCOUNT_ID": app_s.docs_r2_account_id,
                        "R2_ACCESS_KEY_ID": app_s.docs_r2_access_key_id, "R2_SECRET_ACCESS_KEY": app_s.docs_r2_secret_access_key})
        if heavy and s.docs_local_build_max_mb:
            env["NODE_OPTIONS"] = f"--max-old-space-size={int(s.docs_local_build_max_mb)}"
        # One Next render worker: every worker is a Node process of its own (11 on an 11-core
        # laptop: 2.5 GB peak instead of 1.1 GB). A build box with memory to spare can raise it.
        env["MARKDROP_DOCS_BUILD_CPUS"] = os.environ.get("MARKDROP_DOCS_BUILD_CPUS", "1")
        return env

    async def run_runner(self, run: Running, spec: dict, *, heavy: bool) -> dict:
        s = get_jobs_settings()
        job = run.job
        tmp = Path(tempfile.mkdtemp(prefix="docs-job-"))
        spec_f, result_f = tmp / "spec.json", tmp / "result.json"
        spec_f.write_text(json.dumps(spec))
        cmd = [self.cfg.node, str(self.cfg.platform / "runner" / "run-job.mjs"), "--spec", str(spec_f), "--result", str(result_f)]
        if heavy and self.cfg.nice and shutil.which("nice"):
            cmd = (["ionice", "-c3"] if shutil.which("ionice") else []) + ["nice", "-n", "15"] + cmd
        t0 = time.monotonic()
        tail: list[str] = []
        try:
            run.proc = proc = await asyncio.create_subprocess_exec(
                *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                env=self.runner_env(run.slot, heavy), cwd=str(self.cfg.platform), start_new_session=True,
            )
            last = {"at": 0.0, "step": None}

            async def read_out():
                async for raw in proc.stdout:
                    line = raw.decode(errors="replace").rstrip()
                    if line.startswith("@@progress "):
                        try:
                            p = json.loads(line[11:])
                        except ValueError:
                            continue
                        t = time.monotonic()
                        if p.get("step") != last["step"] or t - last["at"] > 1.0:
                            last.update(at=t, step=p.get("step"))
                            if not await docs_jobs.set_progress(self.db, job["_id"], self.id, p):
                                log("job_lost", level="warning", job=job["_id"])
                                run.abandon = True
                                self.kill(run)

            async def read_err():
                async for raw in proc.stderr:
                    line = raw.decode(errors="replace").rstrip()
                    tail.append(line)
                    del tail[:-40]
                    if line.startswith(("[run-job]", "[markdrop-docs]")):
                        log("runner", job=job["_id"], line=line[:300])

            async def heartbeat():
                while True:
                    await asyncio.sleep(max(5.0, s.docs_job_lock_seconds / 3))
                    if not await docs_jobs.renew(self.db, job["_id"], self.id):
                        log("job_lost", level="warning", job=job["_id"])
                        run.abandon = True
                        self.kill(run)
                        return

            async def sample():
                while True:
                    run.peak_rss_mb = max(run.peak_rss_mb, await asyncio.to_thread(tree_rss_mb, proc.pid))
                    await asyncio.sleep(1.0)

            helpers = [asyncio.create_task(c) for c in (heartbeat(), sample())]
            readers = asyncio.gather(read_out(), read_err())
            try:
                await asyncio.wait_for(proc.wait(), timeout=s.docs_local_build_timeout_seconds)
            except asyncio.TimeoutError:
                self.kill(run)
                await proc.wait()
                return {"ok": False, "error": f"the build took longer than {s.docs_local_build_timeout_seconds} s and was stopped"}
            finally:
                for h in helpers:
                    h.cancel()
                await asyncio.gather(readers, return_exceptions=True)
            if result_f.exists():
                out = json.loads(result_f.read_text())
            else:
                out = {"ok": False, "error": f"the runner exited with {proc.returncode}: " + " | ".join(tail[-3:])[:600]}
            out.setdefault("timings", {})
            if isinstance(out.get("timings"), dict):
                out["timings"]["peak_rss_mb"] = run.peak_rss_mb
                out["timings"]["wall_ms"] = int((time.monotonic() - t0) * 1000)
            return out
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def kill(self, run: Running) -> None:
        p = run.proc
        if p and p.returncode is None:
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    async def run_job(self, run: Running) -> None:
        job = run.job
        db = self.db
        t0 = time.monotonic()
        log("job_start", job=job["_id"], site=job["site_id"], kind=job["kind"], attempt=job.get("attempts"), slot=run.slot)
        ok = False
        try:
            if job["kind"] in ("restore", "unpublish", "access"):
                res = await docs_build.run_server_job(db, job, self.id)
                ok = bool(res.get("ok"))
            elif job["kind"] == "build":
                try:
                    build = await docs_build.start_build(db, job)
                    spec = await docs_build.build_spec(db, job, build)
                except (LookupError, PermissionError) as e:
                    await docs_build.fail_build_job(db, job, self.id, str(e))
                    return
                result = await self.run_runner(run, spec, heavy=True)
                if run.abandon:
                    return
                out = await docs_build.finish_build(db, job, self.id, result)
                ok = bool(out.get("ok"))
                log("build_result", job=job["_id"], site=job["site_id"], ok=ok, error=result.get("error"),
                    stats=result.get("stats"), timings=result.get("timings"))
                await docs_dispatch.kick(db, site_id=job["site_id"])
            elif job["kind"] == "import":
                spec = docs_import_job.import_spec(job, keep_gifs=not self.cfg.convert_gifs)
                result = await self.run_runner(run, spec, heavy=False)
                if run.abandon:
                    return
                if result.get("ok") and isinstance(result.get("import"), dict):
                    out = await docs_import_job.apply_import(db, job, self.id, result["import"])
                    ok = bool(out.get("ok"))
                    log("import_result", job=job["_id"], site=job["site_id"], pages=out.get("pages"),
                        counts=(out.get("report") or {}).get("counts"), timings={**(result.get("import", {}).get("timings") or {}),
                                                                                  **(result.get("timings") or {})})
                else:
                    await docs_jobs.fail(db, job["_id"], self.id, str(result.get("error") or "the import failed"))
        except Exception as e:  # never leave a claimed job hanging
            log("job_error", level="error", job=job["_id"], error=f"{type(e).__name__}: {e}"[:500])
            if job["kind"] == "build":
                await docs_build.fail_build_job(db, job, self.id, f"worker error: {type(e).__name__}")
            else:
                await docs_jobs.fail(db, job["_id"], self.id, f"worker error: {type(e).__name__}")
        finally:
            if run.abandon:
                released = await docs_jobs.release(db, job["_id"], self.id)
                log("job_released", job=job["_id"], released=released)
            log("job_end", job=job["_id"], kind=job["kind"], ok=ok, ms=int((time.monotonic() - t0) * 1000),
                peak_rss_mb=run.peak_rss_mb or None)

    # ── loop ────────────────────────────────────────────────────────────────

    async def dispatch_pass(self) -> None:
        from datetime import timedelta

        from app.services import background

        try:
            if await background.acquire(self.db, "docs_dispatch", timedelta(seconds=30), holder=self.id):
                await docs_dispatch.run_once(self.db)
        except Exception as e:
            log("dispatch_error", level="warning", error=f"{type(e).__name__}: {e}"[:300])

    def free_slots(self) -> list[int]:
        return [i for i in range(self.cfg.concurrency) if i not in self.running]

    async def serve(self) -> None:
        self.cfg.work.mkdir(parents=True, exist_ok=True)
        log("worker_start", worker=self.id, kinds=list(self.cfg.kinds), concurrency=self.cfg.concurrency,
            targets=get_jobs_settings().targets, work=str(self.cfg.work))
        while not self.stop.is_set():
            if self.cfg.dispatch:
                await self.dispatch_pass()
            claimed = 0
            for slot in self.free_slots():
                job = await self.claim()
                if job is None:
                    break
                run = Running(job, slot)
                self.running[slot] = run
                task = asyncio.create_task(self.run_job(run))
                self.tasks.add(task)
                task.add_done_callback(lambda t, s=slot: (self.tasks.discard(t), self.running.pop(s, None)))
                claimed += 1
            if self.once and not claimed and not self.running:
                break
            try:
                await asyncio.wait_for(self.stop.wait(), timeout=self.cfg.poll if not claimed else 0.5)
            except asyncio.TimeoutError:
                pass
        await self.shutdown()

    async def shutdown(self) -> None:
        if self.tasks:
            log("worker_draining", jobs=len(self.tasks), grace_s=self.cfg.grace)
            done, pending = await asyncio.wait(self.tasks, timeout=self.cfg.grace)
            if pending:
                for run in list(self.running.values()):
                    run.abandon = True
                    self.kill(run)
                await asyncio.wait(pending, timeout=30)
        log("worker_stop", worker=self.id)


async def amain(args) -> int:
    settings = get_settings()
    cfg = Config()
    if args.concurrency:
        cfg.concurrency = args.concurrency
    client = AsyncIOMotorClient(settings.mongodb_uri)
    db = client[settings.mongodb_db]
    await docs_jobs.ensure_indexes(db)
    w = Worker(db, cfg, once=args.once)
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, w.stop.set)
        except NotImplementedError:  # pragma: no cover
            pass
    await w.serve()
    client.close()
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Markdrop Docs local job worker")
    ap.add_argument("--once", action="store_true", help="run what is queued for local, then exit")
    ap.add_argument("--concurrency", type=int, default=0)
    return asyncio.run(amain(ap.parse_args()))


if __name__ == "__main__":
    sys.exit(main())
