"""A guide's API reference: the OpenAPI description it's generated from.

Someone uploads an OpenAPI 3.0 or 3.1 file (JSON or YAML, at most 5 MB) or gives an https URL, which
the API fetches through services/safe_fetch.py. The description is parsed, checked (version, size,
at most 1,000 operations) and stored as JSON in the docs R2 bucket under
``sites/<site>/api/<sha256>.json`` (outside ``assets/``: it isn't a file readers download), with one
``docs_api_specs`` row per version: where it came from, what it holds, what to look at (warnings),
and the sidebar it makes. Nothing is ever deleted, so every version stays restorable.

``settings.api.spec_id`` names the version a publish builds (so a snapshot pins it); the build
spec carries its key and hash (services/docs_snapshot.py) and the runner fetches it into the
content folder as ``openapi.json`` (docs-platform/runner/lib.mjs). The engine generates the pages
(frontend/src/docs/openapi.mjs, ``auto`` mode) under the reserved ``/api-reference`` prefix.

The sidebar preview (:func:`nav_preview`) mirrors the engine's auto mode: groups from tags,
titles from summaries or operation ids, unique page slugs. Test: tests/test_docs_api_spec.py checks
it against the engine's own output for the sample spec.
"""

from __future__ import annotations

import datetime as _dt
import json
import logging
import re
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

from bson import ObjectId
from fastapi import HTTPException
from fastapi.concurrency import run_in_threadpool
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.models.user import User
from app.services import docs_site_assets as assets
from app.services import safe_fetch

log = logging.getLogger("markdrop.docs_api_spec")

SPECS = "docs_api_specs"
MAX_BYTES = 5 * 1024 * 1024
MAX_OPERATIONS = 1000
# The stored JSON can be larger than the YAML it came from.
MAX_JSON_BYTES = 8 * 1024 * 1024
MAX_NODES = 2_000_000
MAX_DEPTH = 200
FETCH_TIMEOUT = 15.0
HISTORY = 20
BASE = "/api-reference"
SAMPLE = Path(__file__).resolve().parent.parent / "assets" / "northwind-openapi.json"

METHODS = ("get", "post", "put", "patch", "delete")
OTHER_METHODS = ("head", "options", "trace")


class SpecError(ValueError):
    """The file can't be used; the message says why, for the dashboard."""


# ── Parsing ───────────────────────────────────────────────────────────────────


def _jsonable(value: Any) -> Any:
    """YAML's types as JSON's: string keys, dates as ISO strings. Counts every node visited (an
    alias is visited each time it's used, so a "billion laughs" file stops at MAX_NODES)."""
    count = 0

    def walk(v: Any, depth: int) -> Any:
        nonlocal count
        count += 1
        if count > MAX_NODES:
            raise SpecError("The file is too complex: it expands to too many values.")
        if depth > MAX_DEPTH:
            raise SpecError("The file nests too deeply.")
        if isinstance(v, dict):
            out = {}
            for k, x in v.items():
                key = ("true" if k else "false") if isinstance(k, bool) else k if isinstance(k, str) else str(k)
                out[key] = walk(x, depth + 1)
            return out
        if isinstance(v, (list, tuple)):
            return [walk(x, depth + 1) for x in v]
        if isinstance(v, (_dt.datetime, _dt.date)):
            return v.isoformat()
        if isinstance(v, bytes):
            raise SpecError("The file has binary data in it.")
        if v is None or isinstance(v, (str, int, float, bool)):
            return v
        return str(v)

    return walk(value, 0)


def parse(data: bytes) -> dict:
    """The description as a dict (JSON, else YAML), or :class:`SpecError`."""
    if not data or not data.strip():
        raise SpecError("That file is empty.")
    if len(data) > MAX_BYTES:
        raise SpecError(f"OpenAPI files can be at most {MAX_BYTES // (1024 * 1024)} MB.")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise SpecError("The file isn't UTF-8 text. Upload an OpenAPI file in JSON or YAML.") from None
    stripped = text.lstrip()
    if stripped.startswith("{"):
        try:
            doc = json.loads(text)
        except (ValueError, RecursionError) as exc:
            raise SpecError(f"The JSON doesn't parse: {str(exc)[:160]}") from None
    else:
        import yaml

        loader = getattr(yaml, "CSafeLoader", yaml.SafeLoader)
        try:
            doc = yaml.load(text, Loader=loader)  # noqa: S506 - a safe loader
        except (yaml.YAMLError, RecursionError, ValueError) as exc:
            first = str(exc).strip().splitlines()[0] if str(exc).strip() else "invalid YAML"
            raise SpecError(f"The file isn't valid JSON or YAML: {first[:160]}") from None
    if not isinstance(doc, dict):
        raise SpecError("That isn't an OpenAPI description: it should be an object with openapi, info and paths.")
    return _jsonable(doc)


def _ops(spec: dict) -> list[tuple[str, str, dict, dict]]:
    """(path, method, operation, path item) of every operation the engine renders, in order."""
    out = []
    for path, item in (spec.get("paths") or {}).items():
        if not isinstance(item, dict):
            continue
        for m in METHODS:
            op = item.get(m)
            if isinstance(op, dict):
                out.append((path, m, op, item))
    return out


def _pointer(spec: dict, ref: str) -> bool:
    cur: Any = spec
    for part in ref[2:].split("/") if ref != "#" else []:
        part = part.replace("~1", "/").replace("~0", "~")
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        elif isinstance(cur, list) and part.isdigit() and int(part) < len(cur):
            cur = cur[int(part)]
        else:
            return False
    return True


def _refs(spec: dict) -> tuple[list[str], list[str]]:
    """(external refs, internal refs that don't resolve), a few of each."""
    external: list[str] = []
    broken: list[str] = []
    seen: set[str] = set()
    stack: list[Any] = [spec]
    while stack:
        v = stack.pop()
        if isinstance(v, dict):
            ref = v.get("$ref")
            if isinstance(ref, str) and ref not in seen:
                seen.add(ref)
                if not ref.startswith("#"):
                    external.append(ref)
                elif not _pointer(spec, ref):
                    broken.append(ref)
            stack.extend(v.values())
        elif isinstance(v, list):
            stack.extend(v)
    return external, broken


def resolve_servers(spec: dict, source_url: str | None) -> None:
    """Relative server URLs ("/v1") made absolute against the URL the file came from (in place)."""
    if not source_url:
        return
    for s in spec.get("servers") or []:
        if isinstance(s, dict) and isinstance(s.get("url"), str) and not re.match(r"^[a-z][a-z0-9+.-]*://", s["url"], re.I) \
                and "{" not in s["url"]:
            s["url"] = urljoin(source_url, s["url"])


def _server_urls(servers: Any) -> tuple[list[str], int]:
    """(absolute http(s) URLs with variables at their defaults, how many entries aren't usable)."""
    out: list[str] = []
    bad = 0
    for s in servers if isinstance(servers, list) else []:
        if not isinstance(s, dict) or not isinstance(s.get("url"), str):
            bad += 1
            continue
        url = s["url"]
        for k, v in (s.get("variables") or {}).items() if isinstance(s.get("variables"), dict) else []:
            url = url.replace("{" + str(k) + "}", str((v or {}).get("default", "")) if isinstance(v, dict) else "")
        url = url.rstrip("/")
        if re.match(r"^https?://[^/\s]+", url, re.I) and not re.search(r"[{}\s]", url):
            if url not in out:
                out.append(url)
        else:
            bad += 1
    return out, bad


def analyze(spec: dict) -> dict:
    """What the description holds and what to look at, or :class:`SpecError` when it can't be used."""
    version = spec.get("openapi")
    if spec.get("swagger") is not None and version is None:
        raise SpecError("That's a Swagger 2.0 file. Convert it to OpenAPI 3 (for example with "
                        "swagger2openapi or editor.swagger.io) and upload that.")
    if not isinstance(version, str) or not re.match(r"^3\.[01](\.\d+)?$", version.strip()):
        raise SpecError("That isn't an OpenAPI 3.0 or 3.1 description (its \"openapi\" field should be 3.0.x or 3.1.x).")
    info = spec.get("info")
    if not isinstance(info, dict):
        raise SpecError("The description has no info section.")
    if not isinstance(spec.get("paths"), dict):
        raise SpecError("The description has no paths, so there's nothing to document.")
    ops = _ops(spec)
    if not ops:
        raise SpecError("The description has no operations (GET, POST, PUT, PATCH or DELETE under paths).")
    if len(ops) > MAX_OPERATIONS:
        raise SpecError(f"The description has {len(ops):,} operations; a guide's API reference can have at most "
                        f"{MAX_OPERATIONS:,}. Split it, or leave internal endpoints out.")

    warnings: list[str] = []
    no_id = [f"{m.upper()} {p}" for p, m, op, _ in ops if not op.get("operationId")]
    ids = [op.get("operationId") for _, _, op, _ in ops if op.get("operationId")]
    dupes = sorted({i for i in ids if ids.count(i) > 1}) if len(ids) != len(set(ids)) else []
    no_summary = [f"{m.upper()} {p}" for p, m, op, _ in ops if not (isinstance(op.get("summary"), str) and op["summary"].strip())]
    servers, bad_servers = _server_urls(spec.get("servers"))
    if no_id:
        warnings.append(f"{_n(len(no_id), 'operation')} {'has' if len(no_id) == 1 else 'have'} no operationId "
                        f"(for example {no_id[0]}). Pages still work; an id keeps an operation's address "
                        "stable when its summary changes.")
    if dupes:
        warnings.append(f"These operationIds are used more than once: {', '.join(map(str, dupes[:5]))}.")
    if no_summary:
        warnings.append(f"{_n(len(no_summary), 'operation')} {'has' if len(no_summary) == 1 else 'have'} no summary, "
                        f"so {'its' if len(no_summary) == 1 else 'their'} title comes from the operationId or the path "
                        f"(for example {no_summary[0]}).")
    if not servers:
        warnings.append("The description lists no absolute server URL (servers), so the samples have no address "
                        "and Try it can't send requests. Add one, like https://api.example.com/v1.")
    elif bad_servers:
        warnings.append(f"{_n(bad_servers, 'server')} {'isn' if bad_servers == 1 else 'aren'}'t an absolute https:// "
                        "address and won't be offered in Try it.")
    other = sum(1 for item in (spec.get("paths") or {}).values() if isinstance(item, dict)
                for m in OTHER_METHODS if isinstance(item.get(m), dict))
    if other:
        warnings.append(f"{_n(other, 'HEAD, OPTIONS or TRACE operation')} {'isn' if other == 1 else 'aren'}'t shown.")
    path_refs = [p for p, item in (spec.get("paths") or {}).items() if isinstance(item, dict) and "$ref" in item]
    if path_refs:
        warnings.append(f"{_n(len(path_refs), 'path')} {'is a $ref' if len(path_refs) == 1 else 'are $refs'} "
                        f"to another file and {'isn' if len(path_refs) == 1 else 'aren'}'t shown ({path_refs[0]}). "
                        "Bundle the description into one file first.")
    external, broken = _refs(spec)
    if external:
        warnings.append(f"{_n(len(external), 'reference')} to other files {'isn' if len(external) == 1 else 'aren'}'t "
                        f"followed (for example {external[0][:80]}). Bundle the description into one file first.")
    if broken:
        warnings.append(f"{_n(len(broken), 'reference')} point{'s' if len(broken) == 1 else ''} at nothing in the file "
                        f"(for example {broken[0][:80]}); the operations that use "
                        f"{'it' if len(broken) == 1 else 'them'} may be left out.")
    schemes = ((spec.get("components") or {}).get("securitySchemes") or {}) if isinstance(spec.get("components"), dict) else {}
    for sid, sch in schemes.items() if isinstance(schemes, dict) else []:
        if not isinstance(sch, dict):
            continue
        t = str(sch.get("type") or "").lower()
        if t == "apikey" and sch.get("in") == "cookie":
            warnings.append(f"The {sid} API key goes in a cookie, which a browser can't set: Try it leaves it out "
                            "(the code samples include it).")
        elif t == "mutualtls" or (t == "http" and str(sch.get("scheme") or "").lower() not in ("bearer", "basic")):
            warnings.append(f"The {sid} security scheme ({t}) isn't one Try it can send; readers use the samples.")
    tags = []
    for t in spec.get("tags") or []:
        if isinstance(t, dict) and isinstance(t.get("name"), str) and t["name"] not in tags:
            tags.append(t["name"])
    for _, _, op, _ in ops:
        for t in op.get("tags") or [] if isinstance(op.get("tags"), list) else []:
            if isinstance(t, str) and t not in tags:
                tags.append(t)
    return {
        "openapi": version.strip(),
        "title": str(info.get("title") or "").strip()[:200] or "API",
        "version": str(info.get("version") or "").strip()[:60],
        "operations": len(ops),
        "tags": len(tags),
        "servers": servers[:10],
        "missing_operation_ids": len(no_id),
        "warnings": warnings,
    }


def _n(n: int, word: str) -> str:
    return f"{n:,} {word}" if n == 1 else f"{n:,} {word}s"


# ── The sidebar it makes (a mirror of openapi.mjs auto mode) ─────────────────


def slugify(s: Any) -> str:
    return re.sub(r"^-+|-+$", "", re.sub(r"[^a-z0-9]+", "-", str(s).lower()))


def humanize(value: Any) -> str:
    words = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", str(value or ""))
    words = re.sub(r"[_\-.\s]+", " ", words).strip().lower()
    return words[:1].upper() + words[1:] if words else ""


def _tag_groups(spec: dict) -> list[dict]:
    defs: list[dict] = []
    ids: set[str] = set()

    def add(name: Any, meta: dict | None = None) -> None:
        meta = meta or {}
        if not isinstance(name, str) or not name.strip() or any(d["tag"] == name for d in defs):
            return
        gid = slugify(name)[:60].rstrip("-") or "group"
        n = 2
        while gid in ids or gid == "endpoints":
            gid = f"{slugify(name)[:56] or 'group'}-{n}"
            n += 1
        ids.add(gid)
        display = meta.get("x-displayName")
        title = display.strip() if isinstance(display, str) and display.strip() else name.strip()
        defs.append({"id": gid, "title": title[:80], "tag": name})

    for t in spec.get("tags") or [] if isinstance(spec.get("tags"), list) else []:
        if isinstance(t, dict):
            add(t.get("name"), t)
    for _, _, op, _ in _ops(spec):
        for t in op.get("tags") or [] if isinstance(op.get("tags"), list) else []:
            add(t)
    return defs


def nav_preview(spec: dict, base: str = BASE) -> list[dict]:
    """[{group, items: [{method, path (the API's), title, page (the guide's address)}]}], like the
    sidebar a publish makes: an "Overview" first, then one group per tag, untagged last."""
    defs = _tag_groups(spec)
    groups = {d["id"]: {"group": d["title"], "items": []} for d in defs}
    more = {"group": "Endpoints", "items": []}
    used: set[str] = set()
    for path, method, op, _item in _ops(spec):
        tags = [t for t in op.get("tags") or [] if isinstance(t, str)] if isinstance(op.get("tags"), list) else []
        d = next((d for d in defs if d["tag"] in tags), None)
        gid = d["id"] if d else "endpoints"
        key = f"{method.upper()} {path}"
        summary = op.get("summary")
        title = (summary.strip() if isinstance(summary, str) and summary.strip() else humanize(op.get("operationId")) or key)[:120]
        stem = (slugify(title) or slugify(key) or "operation")[:72].rstrip("-")
        slug, n = stem, 2
        while f"{base}/{gid}/{slug}" in used:
            slug = f"{stem}-{n}"
            n += 1
        page = f"{base}/{gid}/{slug}"
        used.add(page)
        (groups[gid] if d else more)["items"].append({"method": method.upper(), "path": path, "title": title, "page": page})
    out = [{"group": "Overview", "items": [{"method": None, "path": None, "title": "Overview", "page": base}]}]
    out += [g for g in groups.values() if g["items"]]
    if more["items"]:
        out.append(more)
    return out


# ── Versions ──────────────────────────────────────────────────────────────────


def key_for(site_id: str, sha: str) -> str:
    return f"sites/{site_id}/api/{sha}.json"


def spec_bytes(spec: dict) -> bytes:
    try:
        data = json.dumps(spec, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()
    except ValueError:
        raise SpecError("The file has a number JSON can't hold (NaN or infinity).") from None
    if len(data) > MAX_JSON_BYTES:
        raise SpecError("The description is too large once converted to JSON.")
    return data


def prepare(data: bytes, source_url: str | None = None) -> tuple[dict, dict, bytes]:
    """(spec, summary, JSON bytes to store) for an uploaded or fetched file, or :class:`SpecError`.
    CPU-bound: call it through run_in_threadpool."""
    spec = parse(data)
    summary = analyze(spec)
    if source_url:
        resolve_servers(spec, source_url)
        summary["servers"] = _server_urls(spec.get("servers"))[0][:10]
    return spec, summary, spec_bytes(spec)


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[SPECS].create_index([("site_id", 1), ("created_at", -1)])
    await db[SPECS].create_index([("site_id", 1), ("sha256", 1)])


def api_settings(site: dict) -> dict:
    from app.services.docs_site_settings import ApiReference

    return ApiReference.model_validate(((site.get("settings") or {}).get("api")) or {}).model_dump()


async def current_row(db: AsyncIOMotorDatabase, site: dict) -> dict | None:
    sid = api_settings(site).get("spec_id")
    if not sid or not ObjectId.is_valid(sid):
        return None
    return await db[SPECS].find_one({"_id": ObjectId(sid), "site_id": site["_id"]})


async def _store(db: AsyncIOMotorDatabase, site: dict, user_id: str | None, spec: dict, summary: dict,
                 data: bytes, source: dict) -> dict:
    """A new version (or the same bytes' existing one), made current."""
    from app.services.docs_site_store import now

    sha = assets.sha256(data)
    sid = str(site["_id"])
    row = await db[SPECS].find_one({"site_id": site["_id"], "sha256": sha})
    if row is None:
        if not assets.is_configured():
            raise HTTPException(status_code=503, detail="Uploads aren't available right now.")
        ok = await run_in_threadpool(assets.put_bytes, key_for(sid, sha), data, "application/json")
        if not ok:
            raise HTTPException(status_code=502, detail="Saving the file didn't go through. Try again.")
        row = {
            "site_id": site["_id"], "sha256": sha, "key": key_for(sid, sha), "size": len(data),
            "source": source, **summary, "nav": nav_preview(spec),
            "created_by": user_id, "created_at": now(), "last_fetch": None,
        }
        res = await db[SPECS].insert_one(row)
        row["_id"] = res.inserted_id
    else:
        # The same description again: that version becomes current (with where it came from now).
        await db[SPECS].update_one({"_id": row["_id"]}, {"$set": {"source": source}})
        row["source"] = source
    await _set_current(db, site, str(row["_id"]))
    return row


async def _set_current(db: AsyncIOMotorDatabase, site: dict, spec_id: str | None) -> None:
    from app.services.docs_site_store import now

    api = api_settings(site)
    api["spec_id"] = spec_id
    await db["docs_sites"].update_one({"_id": site["_id"]}, {"$set": {"settings.api": api, "updated_at": now()}})
    site.setdefault("settings", {})["api"] = api


def _bad(exc: Exception, status: int = 422) -> HTTPException:
    return HTTPException(status_code=status, detail=str(exc))


async def upload(db: AsyncIOMotorDatabase, site: dict, user: User, data: bytes, filename: str | None) -> dict:
    if len(data) > MAX_BYTES:
        raise HTTPException(status_code=413, detail=f"OpenAPI files can be at most {MAX_BYTES // (1024 * 1024)} MB.")
    try:
        spec, summary, out = await run_in_threadpool(prepare, data)
    except SpecError as exc:
        raise _bad(exc) from None
    source = {"kind": "upload", "filename": (filename or "")[:200] or None}
    row = await _store(db, site, user.id, spec, summary, out, source)
    await _log(db, site, user.id, "upload", row)
    return row


async def fetch_url(url: str) -> tuple[dict, dict, bytes, str]:
    """(spec, summary, bytes, final URL) from an https URL, or :class:`SpecError`."""
    try:
        res = await safe_fetch.safe_get(url, max_bytes=MAX_BYTES, timeout=FETCH_TIMEOUT,
                                        accept="application/json, application/yaml, text/yaml, application/x-yaml, */*;q=0.5")
    except safe_fetch.FetchError as exc:
        raise SpecError(str(exc)) from None
    if res.status != 200:
        raise SpecError(f"The address answered {res.status}, not 200.")
    ctype = res.content_type.split(";")[0].strip().lower()
    if ctype.startswith(("text/html", "image/", "video/", "audio/")):
        raise SpecError("The address returned a web page, not an OpenAPI file. Use the link to the raw JSON or YAML.")
    spec, summary, out = await run_in_threadpool(prepare, res.body, res.url)
    return spec, summary, out, res.url


async def from_url(db: AsyncIOMotorDatabase, site: dict, user: User, url: str, refetch: bool | None) -> dict:
    try:
        spec, summary, out, _final = await fetch_url(url)
    except SpecError as exc:
        raise _bad(exc) from None
    clean, _host = safe_fetch.check_url(url)
    row = await _store(db, site, user.id, spec, summary, out, {"kind": "url", "url": clean})
    now_ = _now()
    await db[SPECS].update_one({"_id": row["_id"]}, {"$set": {"last_fetch": {"at": now_, "ok": True, "error": None}}})
    row["last_fetch"] = {"at": now_, "ok": True, "error": None}
    if refetch is not None:
        api = api_settings(site)
        api["refetch"] = bool(refetch)
        await db["docs_sites"].update_one({"_id": site["_id"]}, {"$set": {"settings.api": api}})
        site["settings"]["api"] = api
    await _log(db, site, user.id, "url", row)
    return row


async def refetch_for_publish(db: AsyncIOMotorDatabase, site: dict, user_id: str) -> str | None:
    """Before a publish: a URL source with "re-fetch on publish" is fetched again, and a changed
    description becomes the current version. A failure keeps the last good version and returns a
    warning for the build (the publish goes ahead)."""
    api = api_settings(site)
    if not api.get("refetch") or not api.get("spec_id"):
        return None
    row = await current_row(db, site)
    url = ((row or {}).get("source") or {}).get("url")
    if not row or (row.get("source") or {}).get("kind") != "url" or not url:
        return None
    try:
        spec, summary, out, _final = await fetch_url(url)
        new = await _store(db, site, user_id, spec, summary, out, {"kind": "url", "url": url})
        await db[SPECS].update_one({"_id": new["_id"]}, {"$set": {"last_fetch": {"at": _now(), "ok": True, "error": None}}})
        return None
    except (SpecError, HTTPException) as exc:
        msg = str(exc.detail if isinstance(exc, HTTPException) else exc)[:300]
        await db[SPECS].update_one({"_id": row["_id"]}, {"$set": {"last_fetch": {"at": _now(), "ok": False, "error": msg}}})
        return f"The API reference couldn't be re-fetched, so the last version was published: {msg}"


async def restore(db: AsyncIOMotorDatabase, site: dict, user: User, version_id: str) -> dict:
    if not ObjectId.is_valid(version_id):
        raise HTTPException(status_code=404, detail="Version not found")
    row = await db[SPECS].find_one({"_id": ObjectId(version_id), "site_id": site["_id"]})
    if row is None:
        raise HTTPException(status_code=404, detail="Version not found")
    await _set_current(db, site, str(row["_id"]))
    await _log(db, site, user.id, "restore", row)
    return row


async def remove(db: AsyncIOMotorDatabase, site: dict, user: User) -> None:
    """No API reference at the next publish. Every version stays, to restore."""
    await _set_current(db, site, None)
    from app.services.docs_site_store import log_event

    await log_event(db, "docs_api_spec_removed", site, user.id)


async def seed_sample(db: AsyncIOMotorDatabase, site: dict, user_id: str) -> None:
    """The "API reference" template's sample description (Northwind). Skipped, not failed, when
    storage isn't available: the template's written pages still work."""
    try:
        data = SAMPLE.read_bytes()
        spec, summary, out = prepare(data)
        await _store(db, site, user_id, spec, summary, out, {"kind": "sample", "filename": "northwind-openapi.json"})
    except HTTPException as exc:  # storage unavailable
        log.warning("couldn't add the sample API description to site %s: %s", site.get("_id"), exc.detail)
    except Exception:  # noqa: BLE001 - a template must not fail over its sample
        log.warning("couldn't add the sample API description to site %s", site.get("_id"), exc_info=True)


async def _log(db: AsyncIOMotorDatabase, site: dict, user_id: str | None, how: str, row: dict) -> None:
    from app.services.docs_site_store import log_event

    # Counts and enums only: never the URL or the description's text.
    await log_event(db, "docs_api_spec_saved", site, user_id, source=how, operations=row.get("operations"))


def _now():
    from app.services.docs_site_store import now

    return now()


# ── Views ─────────────────────────────────────────────────────────────────────


def version_view(row: dict, names: dict[str, str], current_id: str | None) -> dict:
    from app.services.docs_site_store import aware

    lf = row.get("last_fetch") or None
    return {
        "id": str(row["_id"]),
        "current": str(row["_id"]) == current_id,
        "source": row.get("source") or {},
        "openapi": row.get("openapi"),
        "title": row.get("title"),
        "version": row.get("version"),
        "operations": row.get("operations"),
        "tags": row.get("tags"),
        "servers": row.get("servers") or [],
        "warnings": row.get("warnings") or [],
        "size": row.get("size"),
        "sha256": row.get("sha256"),
        "created_by": row.get("created_by"),
        "created_by_name": names.get(row.get("created_by") or ""),
        "created_at": aware(row.get("created_at")),
        "last_fetch": {**lf, "at": aware(lf.get("at"))} if lf else None,
    }


async def status(db: AsyncIOMotorDatabase, site: dict) -> dict:
    from app.services.docs_site_store import user_names

    api = api_settings(site)
    rows = await db[SPECS].find({"site_id": site["_id"]}, {"nav": 0}).sort("created_at", -1).to_list(length=HISTORY)
    cur = await current_row(db, site)
    if cur is not None and all(r["_id"] != cur["_id"] for r in rows):
        rows.insert(0, {k: v for k, v in cur.items() if k != "nav"})
    names = await user_names(db, [r.get("created_by") for r in rows])
    current_id = str(cur["_id"]) if cur else None
    return {
        "settings": api,
        "current": version_view(cur, names, current_id) if cur else None,
        "nav": (cur or {}).get("nav") or [],
        "versions": [version_view(r, names, current_id) for r in rows],
        "base": BASE,
        "limits": {"max_bytes": MAX_BYTES, "max_operations": MAX_OPERATIONS},
    }


async def download_url(db: AsyncIOMotorDatabase, site: dict, version_id: str) -> str:
    if not ObjectId.is_valid(version_id):
        raise HTTPException(status_code=404, detail="Version not found")
    row = await db[SPECS].find_one({"_id": ObjectId(version_id), "site_id": site["_id"]}, {"key": 1})
    if row is None or not assets.is_configured():
        raise HTTPException(status_code=404, detail="Version not found")
    return assets.presign_get(row["key"], 600)


async def build_ref(db: AsyncIOMotorDatabase, site: dict, settings: dict) -> dict | None:
    """The spec a build uses (``settings``: the snapshot's): {key, sha256, size, ...the row}, or None."""
    sid = ((settings or {}).get("api") or {}).get("spec_id")
    if not sid or not ObjectId.is_valid(sid):
        return None
    return await db[SPECS].find_one({"_id": ObjectId(sid), "site_id": site["_id"]}, {"nav": 0})
