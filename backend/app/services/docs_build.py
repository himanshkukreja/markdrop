"""Markdrop Docs builds: start, finish, restore, unpublish.

A publish (services/docs_site_publish.py) snapshots the drafts, numbers a
``docs_builds`` row and queues a ``build`` job (docs_site_jobs.enqueue_job,
which coalesces a burst of publishes into one waiting job). The build runs
elsewhere (GitHub Actions or the Python worker, both through
docs-platform/runner/run-job.mjs), which publishes to the docs R2 bucket and
reports the manifest hash back. Only then is the build live: the site points at
it, the build it replaced becomes ``superseded``, and every page in the snapshot
gets its ``published`` copy. A publish that moved the site to a new slug also
takes the old address's host mapping down.

Restore re-points the site at an earlier build's manifest (the store keeps every
manifest and object): one small R2 write, no rebuild; drafts don't change.
Unpublish removes the site's host mappings and its pointer, so its addresses
answer 404; a later publish puts them back.

The R2 writes here (pointer, host mappings) are tiny; they run in the API
process or the local worker, whichever holds the docs bucket keys
(config.py docs_r2_*). A folder store (MARKDROP_DOCS_STORE_DIR) stands in for
the bucket in tests and self-hosting.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from typing import Any

from motor.motor_asyncio import AsyncIOMotorDatabase

from app.config import get_settings
from app.services import docs_jobs
from app.services.docs_jobs import BUILDS, JOBS, PAGES, SITES, SNAPSHOTS, now, oid

log = logging.getLogger(__name__)

RESTORABLE = ("live", "superseded")


class RestoreError(Exception):
    pass


# ── the pointer store (R2 or a folder) ──────────────────────────────────────


class FsPointerStore:
    """get_text / put_text / delete over a folder store (MARKDROP_DOCS_STORE_DIR: tests, self-host)."""

    def __init__(self, root: str):
        self.root = os.path.abspath(root)

    def _f(self, key: str) -> str:
        f = os.path.abspath(os.path.join(self.root, key))
        if not f.startswith(self.root + os.sep):
            raise RestoreError("bad key")
        return f

    def get_text(self, key: str) -> str | None:
        try:
            with open(self._f(key), encoding="utf-8") as fh:
                return fh.read()
        except FileNotFoundError:
            return None

    def put_text(self, key: str, text: str) -> None:
        f = self._f(key)
        os.makedirs(os.path.dirname(f), exist_ok=True)
        tmp = f"{f}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, f)

    def delete(self, key: str) -> None:
        try:
            os.remove(self._f(key))
        except FileNotFoundError:
            pass


class R2PointerStore:
    """get_text / put_text / delete over the docs bucket (boto3)."""

    def __init__(self, client=None, bucket: str | None = None):
        s = get_settings()
        if client is None:
            import boto3
            from botocore.config import Config

            client = boto3.client(
                "s3", endpoint_url=f"https://{s.docs_r2_account_id}.r2.cloudflarestorage.com",
                aws_access_key_id=s.docs_r2_access_key_id, aws_secret_access_key=s.docs_r2_secret_access_key,
                region_name="auto",
                config=Config(signature_version="s3v4", retries={"max_attempts": 3}, connect_timeout=5, read_timeout=20),
            )
        self.client = client
        self.bucket = bucket or s.docs_r2_bucket

    def get_text(self, key: str) -> str | None:
        try:
            return self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read().decode()
        except Exception as e:  # botocore ClientError NoSuchKey
            code = getattr(e, "response", {}).get("Error", {}).get("Code")
            if code in ("NoSuchKey", "404", "NotFound"):
                return None
            raise

    def put_text(self, key: str, text: str) -> None:
        self.client.put_object(Bucket=self.bucket, Key=key, Body=text.encode(), ContentType="application/json")

    def delete(self, key: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=key)


def store_available() -> bool:
    return bool(os.environ.get("MARKDROP_DOCS_STORE_DIR")) or get_settings().docs_r2_configured


def default_store():
    if os.environ.get("MARKDROP_DOCS_STORE_DIR"):
        return FsPointerStore(os.environ["MARKDROP_DOCS_STORE_DIR"])
    if not get_settings().docs_r2_configured:
        raise RestoreError("the docs bucket isn't configured on this server")
    return R2PointerStore()


def point_site(store: Any, site: str, manifest: str, *, force: bool = False) -> dict:
    """Python twin of docs-platform/builder/store.mjs pointSite (the same pointer JSON)."""
    if len(manifest) != 64 or any(c not in "0123456789abcdef" for c in manifest):
        raise RestoreError("bad manifest hash")
    raw = store.get_text(f"manifests/{manifest}.json")
    if raw is None:
        raise RestoreError(f"manifest {manifest[:12]} is not in the store")
    m = json.loads(raw)
    # A manifest that names no site is refused too: it can't be shown to be this one's.
    if not force and (m.get("site") or {}).get("id") != site:
        raise RestoreError(f"manifest {manifest[:12]} belongs to another site")
    cur_raw = store.get_text(f"sites/{site}/current.json")
    cur = json.loads(cur_raw) if cur_raw else None
    if cur and cur.get("manifest") == manifest:
        return {"site": site, "manifest": manifest, "unchanged": True, "previous": cur.get("previous")}
    ptr = {"manifest": manifest, "engine": m.get("engine"),
           "publishedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
           "previous": (cur or {}).get("manifest"), "restored": True}
    store.put_text(f"sites/{site}/current.json", json.dumps(ptr, separators=(",", ":")))
    return {"site": site, "manifest": manifest, "unchanged": False, "previous": ptr["previous"]}


def drop_hosts(store: Any, site: str, hosts: list[str]) -> list[str]:
    """Remove host mappings that point at ``site`` (never another site's)."""
    gone = []
    for h in hosts:
        key = f"hosts/{h.lower()}.json"
        raw = store.get_text(key)
        if raw is None:
            continue
        try:
            owner = json.loads(raw).get("site")
        except ValueError:
            owner = None
        if owner == site:
            store.delete(key)
            gone.append(h)
    return gone


def ensure_hosts(store: Any, site: str, hosts: list[str]) -> list[str]:
    """Map hosts that have no mapping to ``site`` (a host mapped to another site is left alone)."""
    added = []
    for h in hosts:
        key = f"hosts/{h.lower()}.json"
        if store.get_text(key) is None:
            store.put_text(key, json.dumps({"site": site}))
            added.append(h)
    return added


def host_owner(store: Any, host: str) -> str | None:
    raw = store.get_text(f"hosts/{host.lower()}.json")
    if raw is None:
        return None
    try:
        return json.loads(raw).get("site")
    except (ValueError, AttributeError):
        return None


def manifest_site(store: Any, manifest: str) -> str | None:
    """The site id a manifest in the store names (None: missing, unreadable or nameless)."""
    raw = store.get_text(f"manifests/{manifest}.json")
    if raw is None:
        return None
    try:
        return (json.loads(raw).get("site") or {}).get("id")
    except (ValueError, AttributeError):
        return None


def owned_hosts(site: dict | None) -> list[str]:
    """The addresses a site holds right now in the database: its free address (current slug) and
    its verified domains. Nothing for a deleted site or one without a slug."""
    from app.services import docs_snapshot

    if not site or site.get("deleted_at") or not site.get("slug"):
        return []
    return [h.lower() for h in docs_snapshot.site_hosts(site)]


async def free_stale_hosts(db: AsyncIOMotorDatabase, site_id: Any, hosts: list[str]) -> list[str]:
    """Host mappings of ``hosts`` that still point at another site which no longer holds that
    address in the database (it moved to a new slug, or was deleted, before its old address was
    taken down): removed, so this site's publish can claim them. A mapping of a site that still
    holds the address is never touched. Best effort."""
    if not hosts or not store_available():
        return []
    sid = str(site_id)
    try:
        store = default_store()
        owners = await asyncio.to_thread(lambda: {h: host_owner(store, h) for h in hosts})
        freed = []
        for h, owner in owners.items():
            if not owner or owner == sid:
                continue
            other = await db[SITES].find_one({"_id": oid(owner)}, {"slug": 1, "domains": 1, "deleted_at": 1})
            if h.lower() in owned_hosts(other):
                continue
            freed += await asyncio.to_thread(drop_hosts, store, owner, [h])
        return freed
    except Exception:
        log.warning("docs site %s: couldn't check its addresses for stale mappings", sid, exc_info=True)
        return []


# ── builds ──────────────────────────────────────────────────────────────────


async def job_build(db: AsyncIOMotorDatabase, job: dict) -> dict | None:
    bid = (job.get("payload") or {}).get("build_id")
    return await db[BUILDS].find_one({"_id": oid(bid)}) if bid else None


async def start_build(db: AsyncIOMotorDatabase, job: dict) -> dict:
    """A runner claimed the job: the build is building. LookupError when the build is gone or
    already settled. The daily cap is the API's, at publish time."""
    build = await job_build(db, job)
    if build is None:
        raise LookupError("the job's build is missing")
    if build.get("status") in ("failed", "superseded", "live"):
        raise LookupError(f"build {build.get('number')} is already {build['status']}")
    await db[BUILDS].update_one(
        {"_id": build["_id"], "status": {"$in": ["queued", "building", "publishing"]}},
        {"$set": {"status": "building", "started_at": now(), "error": None}},
    )
    build["status"] = "building"
    return build


async def build_spec(db: AsyncIOMotorDatabase, job: dict, build: dict | None = None) -> dict:
    """What a runner needs for a build job (GET /internal/docs-jobs/{id}, or the worker's spec file)."""
    from app.services import docs_snapshot

    build = build or await job_build(db, job)
    if build is None:
        raise LookupError("the job's build is missing")
    b = await docs_snapshot.bundle(db, build)
    hosts = b["publish"]["hosts"]
    # The runner writes a mapping only where none is: a stale one (another site's old address)
    # goes first. The hosts are kept on the build, so a take-down drops exactly what it wrote.
    await free_stale_hosts(db, build["site_id"], hosts)
    await db[BUILDS].update_one({"_id": build["_id"]}, {"$set": {"publish_hosts": hosts}})
    return {
        "job": {"id": str(job["_id"]), "kind": "build", "site_id": str(job["site_id"]), "attempt": int(job.get("attempts") or 1)},
        "build": {"id": str(build["_id"]), "number": build.get("number")},
        **b,
    }


def _clean_stats(stats: Any) -> dict | None:
    if not isinstance(stats, dict):
        return None
    out = {}
    for k in ("pages", "routes", "objects", "uploaded", "bytes", "total_bytes", "assets", "ms"):
        v = stats.get(k)
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            out[k] = int(v)
    return out


def _clean_timings(t: Any) -> dict | None:
    if not isinstance(t, dict):
        return None
    return {str(k)[:40]: int(v) for k, v in list(t.items())[:30] if isinstance(v, (int, float)) and not isinstance(v, bool)}


async def _snapshot_slug(db: AsyncIOMotorDatabase, build: dict | None) -> str | None:
    if not build or not build.get("snapshot_id"):
        return None
    snap = await db[SNAPSHOTS].find_one({"_id": build["snapshot_id"]}, {"site.slug": 1})
    return ((snap or {}).get("site") or {}).get("slug")


CANCELLED = ("failed", "superseded")
TAKEN_DOWN = "Not published: the guide was taken down while this version was building."


def _taken_down_since(site: dict, build: dict) -> bool:
    """The site was unpublished after this build was requested (a publish made after an
    unpublish is wanted: it puts the site back)."""
    if site.get("status") != "unpublished":
        return False
    at, asked = docs_jobs.aware(site.get("taken_down_at")), docs_jobs.aware(build.get("created_at"))
    return at is None or asked is None or asked <= at


async def wanted(db: AsyncIOMotorDatabase, build: dict | None) -> tuple[bool, str]:
    """Whether this build may still go live: (yes/no, why). No when the site was deleted or taken
    down after it was requested, or the build was cancelled (failed or superseded meanwhile)."""
    if build is None:
        return False, "the build is missing"
    if build.get("status") in CANCELLED:
        return False, "the build was cancelled"
    site = await db[SITES].find_one({"_id": build["site_id"]}, {"status": 1, "deleted_at": 1, "taken_down_at": 1})
    if site is None or site.get("deleted_at"):
        return False, "the site was deleted"
    if _taken_down_since(site, build):
        return False, "the site was unpublished"
    return True, "ok"


async def still_wanted(db: AsyncIOMotorDatabase, job: dict, worker: str | None) -> tuple[bool, str]:
    """The runner's question right before it flips the pointer (GET /internal/docs-jobs/{id}/wanted,
    or the local worker's "@@wanted?"): the job must still be this runner's and its build wanted."""
    cur = await db[JOBS].find_one({"_id": job["_id"]}, {"status": 1, "locked_by": 1})
    if cur is None or cur.get("status") != "running" or (worker is not None and cur.get("locked_by") != worker):
        return False, "the job isn't this runner's any more"
    return await wanted(db, await job_build(db, job))


async def _undo_flip(db: AsyncIOMotorDatabase, build: dict, reason: str) -> dict | None:
    """The runner flipped the pointer (and wrote host mappings) for a build that must not be live:
    put back the site's live build if it has one, else take its addresses down. Queued as a server
    job, so it runs where the bucket keys are; both jobs are idempotent."""
    from app.services.docs_site_jobs import enqueue_job

    site = await db[SITES].find_one({"_id": build["site_id"]}) or {}
    live_id = site.get("live_build_id")
    live = await db[BUILDS].find_one({"_id": live_id}) if live_id and live_id != build["_id"] else None
    if live is not None and live.get("manifest_hash") and not site.get("deleted_at") \
            and site.get("status") != "unpublished":
        return await enqueue_job(db, "restore", build["site_id"], {
            "build_id": str(live["_id"]), "number": live.get("number"), "manifest_hash": live["manifest_hash"],
            "reason": reason})
    return await enqueue_job(db, "unpublish", build["site_id"], {
        "reason": reason, "slug": site.get("slug") or site.get("deleted_slug"),
        "hosts": list(build.get("publish_hosts") or [])})


async def _manifest_problem(manifest: str, site_id: Any) -> str | None:
    """The manifest the runner reported must be in the store and name the job's site."""
    if not store_available():
        return None  # nowhere to look (an API without the bucket keys): the runner is trusted
    try:
        named = await asyncio.to_thread(manifest_site, default_store(), manifest)
    except Exception:
        log.warning("docs build: couldn't read manifest %s", manifest[:12], exc_info=True)
        return None
    if named != str(site_id):
        return "the runner reported a manifest of another site" if named else "the runner reported a manifest the store doesn't have"
    return None


async def finish_build(db: AsyncIOMotorDatabase, job: dict, worker: str | None, result: dict) -> dict:
    """The runner's result → the build (live or failed), the site's live fields, the pages'
    published copies, the job. Returns the job's stored result."""
    build = await job_build(db, job)
    t = now()
    if build is None:
        await docs_jobs.fail(db, job["_id"], worker, "the job's build is missing")
        return {"ok": False}
    if not result.get("ok") and result.get("aborted"):
        # The runner asked before flipping the pointer and was told no: nothing went live.
        await db[BUILDS].update_one({"_id": build["_id"], "status": {"$nin": ["live"]}},
                                    {"$set": {"status": "superseded", "error": TAKEN_DOWN, "finished_at": t}})
        await docs_jobs.complete(db, job["_id"], worker, {"ok": True, "build_id": str(build["_id"]), "taken_down": True})
        return {"ok": True, "taken_down": True}
    if not result.get("ok"):
        err = str(result.get("error") or "the build failed")[:2000]
        await db[BUILDS].update_one({"_id": build["_id"]}, {"$set": {"status": "failed", "error": err, "finished_at": t}})
        await docs_jobs.fail(db, job["_id"], worker, err, result={"build_id": str(build["_id"])})
        await docs_jobs.log_event(db, "docs_build_failed", build["site_id"], build.get("requested_by"),
                                  build_id=str(build["_id"]), number=build.get("number"))
        return {"ok": False, "error": err}
    manifest = str(result.get("manifest_hash") or "")
    if len(manifest) != 64 or any(c not in "0123456789abcdef" for c in manifest):
        return await finish_build(db, job, worker, {"ok": False, "error": "the runner reported no manifest"})
    problem = await _manifest_problem(manifest, build["site_id"])
    if problem:
        log.warning("docs build %s: %s (%s)", build["_id"], problem, manifest[:12])
        await _undo_flip(db, build, "bad_manifest")
        return await finish_build(db, job, worker, {"ok": False, "error": problem})
    stats = _clean_stats(result.get("stats")) or {}
    ok, why = await wanted(db, build)
    if not ok:
        # Taken down (or cancelled) while it built, after the runner's last check: it flipped the
        # pointer and wrote the host mappings already. Don't record it live, and undo that.
        sets: dict = {"manifest_hash": manifest, "stats": stats, "finished_at": t}
        if build.get("status") not in CANCELLED:  # a cancelled build keeps its status and reason
            sets.update(status="superseded", error=TAKEN_DOWN)
        await db[BUILDS].update_one({"_id": build["_id"]}, {"$set": sets})
        undo = await _undo_flip(db, build, "build_after_take_down")
        await docs_jobs.complete(db, job["_id"], worker, {"ok": True, "build_id": str(build["_id"]), "taken_down": True,
                                                          "reason": why, "undo_job_id": str(undo["_id"]) if undo else None})
        return {"ok": True, "taken_down": True}
    site = await db[SITES].find_one({"_id": build["site_id"]}, {"live_build_id": 1, "status": 1, "deleted_at": 1,
                                                                 "domains": 1, "slug": 1})
    prev_id = site.get("live_build_id")
    prev = await db[BUILDS].find_one({"_id": prev_id}) if prev_id else None
    await db[BUILDS].update_one({"_id": build["_id"]}, {"$set": {
        "status": "live", "manifest_hash": manifest, "stats": stats, "engine": result.get("engine"),
        "timings": _clean_timings(result.get("timings")), "error": None, "finished_at": t,
    }})
    await db[BUILDS].update_many({"site_id": build["site_id"], "status": "live", "_id": {"$ne": build["_id"]}},
                                 {"$set": {"status": "superseded", "superseded_at": t}})
    await db[SITES].update_one({"_id": build["site_id"]}, {"$set": {
        "live_build_id": build["_id"], "last_published_at": t, "last_published_by": build.get("requested_by"),
        "status": "live", "updated_at": t,
    }})
    await _mark_published(db, build)
    moved = await _drop_old_address(db, site, build, prev)
    out = {"ok": True, "build_id": str(build["_id"]), "number": build.get("number"), "manifest_hash": manifest,
           "unchanged": bool(result.get("unchanged")), "stats": stats}
    if moved:
        out["old_hosts_removed"] = moved
    await _reconcile_access(db, build["site_id"], result.get("access"))
    await docs_jobs.complete(db, job["_id"], worker, out)
    await docs_jobs.log_event(db, "docs_build_live", build["site_id"], build.get("requested_by"),
                              build_id=str(build["_id"]), number=build.get("number"), pages=stats.get("pages"),
                              ms=stats.get("ms"), target=job.get("target"))
    return out


async def _reconcile_access(db: AsyncIOMotorDatabase, site_id: Any, written: Any) -> None:
    """The runner writes the access policy the spec carried before it flips the pointer. When the
    site's policy changed since (or an older runner wrote none), queue the access job, which writes
    the current one."""
    from app.services import docs_site_access

    site = await db[SITES].find_one({"_id": site_id}, {"settings.access.level": 1, "access_version": 1})
    if site is None or not docs_site_access.needs_policy(site):
        return
    want = docs_site_access.policy(site)
    if isinstance(written, dict) and written.get("level") == want["level"] \
            and written.get("policy_version") == want["policy_version"]:
        await docs_site_access.mark_synced(db, site_id, want["policy_version"])
        return
    await docs_site_access.queue_sync(db, site_id, "build")


async def _drop_old_address(db: AsyncIOMotorDatabase, site: dict, build: dict, prev: dict | None) -> list[str]:
    """The site's free address moved (a new slug): the address the last live build was published
    at stops serving it. The new one is the site's slug now (what build_spec published to)."""
    from app.services import docs_snapshot

    old, new = await _snapshot_slug(db, prev), site.get("slug") or await _snapshot_slug(db, build)
    if not old or not new or old == new:
        return []
    from app.services import docs_cf_hosts

    # Its Cloudflare custom domain too (the job keeps it while the site still wants it).
    await docs_cf_hosts.queue(db, site["_id"], "moved", [docs_cf_hosts.free_host(old)])
    if not store_available():
        return []
    try:
        return await asyncio.to_thread(drop_hosts, default_store(), str(site["_id"]), [docs_snapshot.host_for(old, site["_id"])])
    except Exception:
        log.warning("docs site %s: couldn't remove the old address %s", site["_id"], old, exc_info=True)
        return []


async def _mark_published(db: AsyncIOMotorDatabase, build: dict) -> None:
    """Each page in the build's snapshot: published = what went live (by page id, else path)."""
    snap = await db[SNAPSHOTS].find_one({"_id": build["snapshot_id"]}, {"pages": 1})
    for p in (snap or {}).get("pages") or []:
        q: dict = {"site_id": build["site_id"]}
        pid = p.get("page_id") or p.get("id")
        if pid and oid(pid):
            q["_id"] = oid(pid)
        elif p.get("path"):
            q["path"] = p["path"]
        else:
            continue
        await db[PAGES].update_one(q, {"$set": {"published": {
            "markdown": p.get("markdown") or "", "rev": p.get("rev"), "published_build_id": build["_id"],
        }}})


async def fail_build_job(db: AsyncIOMotorDatabase, job: dict, worker: str | None, error: str) -> None:
    build = await job_build(db, job)
    if build is not None:
        await db[BUILDS].update_one({"_id": build["_id"], "status": {"$nin": ["live", "superseded"]}},
                                    {"$set": {"status": "failed", "error": error[:2000], "finished_at": now()}})
    await docs_jobs.fail(db, job["_id"], worker, error)


# ── restore / unpublish ─────────────────────────────────────────────────────


async def restore_build(db: AsyncIOMotorDatabase, site_id: Any, build_id: Any, by: Any, *, store: Any = None) -> dict:
    """Make an earlier build live again: flip the site's pointer to its manifest, then record it.
    Only what is live changes; drafts don't. Raises RestoreError with a reason a person can read."""
    build = await db[BUILDS].find_one({"_id": oid(build_id), "site_id": oid(site_id)})
    if build is None:
        raise RestoreError("that build doesn't belong to this site")
    if build.get("status") not in RESTORABLE or not build.get("manifest_hash"):
        raise RestoreError("only a build that was live can be restored")
    site = await db[SITES].find_one({"_id": oid(site_id)}, {"live_build_id": 1, "deleted_at": 1})
    if site is None or site.get("deleted_at"):
        raise RestoreError("site not found")
    from app.services import docs_snapshot

    store = store or default_store()
    full = await db[SITES].find_one({"_id": oid(site_id)}, {"slug": 1, "domains": 1})

    def work():
        r = point_site(store, str(build["site_id"]), build["manifest_hash"])
        # After an unpublish the addresses were taken down: a restore puts them back.
        ensure_hosts(store, str(build["site_id"]), docs_snapshot.site_hosts(full) if full and full.get("slug") else [])
        return r

    res = await asyncio.to_thread(work)
    t = now()
    await db[BUILDS].update_many({"site_id": build["site_id"], "status": "live", "_id": {"$ne": build["_id"]}},
                                 {"$set": {"status": "superseded", "superseded_at": t}})
    await db[BUILDS].update_one({"_id": build["_id"]}, {"$set": {"status": "live", "restored_at": t, "restored_by": str(by) if by else None}})
    await db[SITES].update_one({"_id": build["site_id"]}, {"$set": {"live_build_id": build["_id"], "status": "live", "updated_at": t}})
    await docs_jobs.log_event(db, "docs_restored", build["site_id"], by, build_id=str(build["_id"]), number=build.get("number"))
    return {"build_id": str(build["_id"]), "number": build.get("number"), "manifest_hash": build["manifest_hash"], "unchanged": res["unchanged"]}


async def unpublish(db: AsyncIOMotorDatabase, site_id: Any, slug: str | None, *, store: Any = None,
                    extra_hosts: list[str] | None = None) -> dict:
    """Take the site off its addresses: remove its host mappings (the free address for ``slug``,
    its slug now, its own domains, and ``extra_hosts``: what a build published to) and its pointer.
    The API already marked it unpublished. Idempotent: a mapping already gone (or another site's)
    and a missing pointer are fine, so it can run again, or after a build that went live late."""
    from app.services import docs_snapshot

    site = await db[SITES].find_one({"_id": oid(site_id)})
    sid = str(oid(site_id))
    if site is not None and site.get("status") == "live" and not site.get("deleted_at"):
        # Published (or restored) again since this was queued: nothing to take down.
        return {"hosts_removed": [], "skipped": "the site is live again"}
    base = site or {"_id": sid, "domains": []}
    hosts = docs_snapshot.site_hosts(base, slug or (site or {}).get("deleted_slug"))
    if (site or {}).get("slug"):
        hosts += docs_snapshot.site_hosts(base)
    hosts += [h for h in (extra_hosts or []) if isinstance(h, str) and h]
    hosts = list(dict.fromkeys(h.lower() for h in hosts))
    store = store or default_store()

    def work():
        gone = drop_hosts(store, sid, hosts)
        store.delete(f"sites/{sid}/current.json")
        return gone

    gone = await asyncio.to_thread(work)
    return {"hosts_removed": gone}


async def run_server_job(db: AsyncIOMotorDatabase, job: dict, worker: str) -> dict:
    """A claimed restore, unpublish or access job, start to finish (the API inline, or the local worker)."""
    p = job.get("payload") or {}
    try:
        if job["kind"] == "restore":
            res = await restore_build(db, job["site_id"], p.get("build_id"), p.get("requested_by") or p.get("by"))
        elif job["kind"] == "unpublish":
            res = await unpublish(db, job["site_id"], p.get("slug"), extra_hosts=p.get("hosts"))
            await docs_jobs.log_event(db, "docs_unpublished", job["site_id"], None, reason=p.get("reason"), **res)
        elif job["kind"] == "access":
            from app.services import docs_site_access

            res = await docs_site_access.sync_policy(db, job["site_id"])
        elif job["kind"] == "cf_host":
            from app.services import docs_cf_hosts

            res = await docs_cf_hosts.reconcile(db, job["site_id"], p.get("hosts") or [])
        else:
            raise RestoreError(f"{job['kind']} jobs don't run on the server")
        if job["kind"] == "restore":
            from app.services import docs_cf_hosts

            await docs_cf_hosts.queue(db, job["site_id"], "restore")  # live again: its address too
    except RestoreError as e:
        await docs_jobs.fail(db, job["_id"], worker, str(e))
        return {"ok": False, "error": str(e)}
    except Exception as e:  # the bucket (or Cloudflare) hiccuped: try again (until out of attempts)
        log.warning("docs %s job %s failed: %s", job["kind"], job["_id"], type(e).__name__,
                    exc_info=job["kind"] != "cf_host")
        if job["kind"] == "cf_host":
            err = str(e)[:1500] or type(e).__name__  # CfHostError: what Cloudflare said (never the token)
        else:
            err = f"{type(e).__name__} while writing to the docs bucket"
        await docs_jobs.retry_later(db, job, worker, err)
        return {"ok": False, "error": err}
    await docs_jobs.complete(db, job["_id"], worker, {"ok": True, **res})
    return {"ok": True, **res}
