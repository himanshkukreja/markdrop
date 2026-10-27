"""Folders — filing for a workspace's documents, and the path in their URLs.

A document filed under Data/Reports is served at ``/data/reports/<slug>`` on the
workspace's own domain. Each folder therefore carries a `slug` as well as a
display name.

Still deliberately **not** an access-control boundary. A folder decides where a
document appears and what its address is; read access still comes from the
document's own password, expiry and workspace. Anything else would mean two
systems deciding who can read a document, and the quieter one winning by
accident.

Two rules keep folder slugs safe to put in a path:

* Siblings must differ. Two folders called "Reports" under the same parent would
  produce the same URL, and the loser would be unreachable.
* A top-level slug may not be a reserved word. ``/settings/<doc>`` on a host
  that also serves the app would shadow a real route, and the folder would win
  or lose depending on routing order rather than on anything anyone intended.
"""

from datetime import datetime, timezone

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.models.folder import Folder
from app.utils.slug import is_reserved_slug, slugify

MAX_FOLDERS_PER_WORKSPACE = 500
# Deep enough for any filing anyone actually does, bounded because every level
# is another segment every URL carries and another hop every path walk makes.
MAX_DEPTH = 8
MAX_NAME = 80
MAX_SLUG = 40


def _to_folder(raw: dict) -> Folder:
    return Folder(
        id=str(raw["_id"]),
        workspace_id=raw["workspace_id"],
        name=raw["name"],
        parent_id=raw.get("parent_id"),
        created_at=raw["created_at"],
        updated_at=raw["updated_at"],
        # Folders predating slugs fall back to their id, which is unique and
        # ugly rather than absent — a missing segment would break a path.
        slug=raw.get("slug") or str(raw["_id"]),
        share=raw.get("share") or None,
    )


def _oid(value: str, what: str = "Folder") -> ObjectId:
    try:
        return ObjectId(value)
    except Exception:
        raise HTTPException(status_code=404, detail=f"{what} not found")


def _clean_name(name: str) -> str:
    name = (name or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="Give the folder a name.")
    if len(name) > MAX_NAME:
        raise HTTPException(status_code=422, detail=f"Folder names are limited to {MAX_NAME} characters.")
    # Control characters would corrupt any list they're rendered into.
    if any(ord(c) < 32 for c in name):
        raise HTTPException(status_code=422, detail="Folder names can't contain control characters.")
    return name


async def _unique_slug(
    db: AsyncIOMotorDatabase,
    workspace_id: str,
    name: str,
    parent_id: str | None,
    exclude_id: ObjectId | None = None,
) -> str:
    """A URL-safe segment for this folder, unique among its siblings.

    Reserved words are refused outright at the top level rather than quietly
    suffixed: someone naming a folder "settings" should be told why it can't be
    that, not handed a folder silently called "settings-2".
    """
    base = slugify(name)[:MAX_SLUG].strip("-") or "folder"
    if parent_id is None and is_reserved_slug(base):
        raise HTTPException(
            status_code=422,
            detail=f"“{name}” can't be a top-level folder name — it clashes with a Markdrop URL.",
        )

    candidate, n = base, 1
    while True:
        query: dict = {
            "workspace_id": workspace_id,
            "parent_id": parent_id or None,
            "slug": candidate,
        }
        if exclude_id is not None:
            query["_id"] = {"$ne": exclude_id}
        if not await db["folders"].find_one(query, {"_id": 1}):
            return candidate
        n += 1
        candidate = f"{base}-{n}"
        if n > 200:  # pathological; stop rather than loop
            raise HTTPException(
                status_code=409, detail="Too many folders with a similar name."
            )


async def backfill_slugs(db: AsyncIOMotorDatabase) -> dict:
    """Give a slug to every folder created before slugs existed.

    Folders predate this feature, and `_to_folder` falls back to the ObjectId so
    a path always has a segment. That fallback keeps URLs *working*, but it makes
    them look like ``/6aa72082ae17a8a365f50a7b/video-test`` — which is not what
    anyone filed a folder called "Data" expecting to get.

    Idempotent, so it is safe to run on every start: it only touches folders with
    no slug, and only reindexes workspaces that actually changed.

    Unlike `_unique_slug`, a reserved top-level name is suffixed rather than
    refused. Refusing is right when someone is typing a name and can pick
    another; at startup there is nobody to tell, and failing would leave the
    folder with an ObjectId for a slug forever.
    """
    rows = await db["folders"].find(
        {"$or": [{"slug": {"$exists": False}}, {"slug": None}, {"slug": ""}]},
        {"name": 1, "workspace_id": 1, "parent_id": 1},
    ).to_list(length=10_000)
    if not rows:
        return {"folders": 0, "workspaces": 0}

    touched: set[str] = set()
    for raw in rows:
        workspace_id = raw["workspace_id"]
        parent_id = raw.get("parent_id")
        base = slugify(raw.get("name") or "")[:MAX_SLUG].strip("-") or "folder"
        if parent_id is None and is_reserved_slug(base):
            base = f"{base}-folder"

        candidate, n = base, 1
        while await db["folders"].find_one(
            {"workspace_id": workspace_id, "parent_id": parent_id,
             "slug": candidate, "_id": {"$ne": raw["_id"]}},
            {"_id": 1},
        ):
            n += 1
            candidate = f"{base}-{n}"
            if n > 200:
                candidate = str(raw["_id"])  # give up gracefully rather than spin
                break

        await db["folders"].update_one({"_id": raw["_id"]}, {"$set": {"slug": candidate}})
        touched.add(workspace_id)

    # Documents carry a denormalised copy of the path, so it has to be rewritten
    # too — otherwise the folders look right and the URLs stay wrong.
    for workspace_id in touched:
        for root in await db["folders"].find(
            {"workspace_id": workspace_id, "parent_id": None}, {"_id": 1}
        ).to_list(length=MAX_FOLDERS_PER_WORKSPACE):
            await _reindex_subtree(db, workspace_id, str(root["_id"]))

    return {"folders": len(rows), "workspaces": len(touched)}


async def path_of(db: AsyncIOMotorDatabase, workspace_id: str, folder_id: str | None) -> list[str]:
    """Folder slugs from the root down, e.g. ``["data", "reports"]``.

    Walks up and reverses. Never truncates silently (D5): a chain that doesn't
    reach the root within MAX_DEPTH + 1 hops is a cycle or corruption, and a
    wrong path is a wrong URL for every document below it, so it raises.
    """
    out: list[str] = []
    cursor, hops = folder_id, 0
    while cursor:
        if hops > MAX_DEPTH + 1:
            raise HTTPException(status_code=409, detail="This folder's structure is inconsistent.")
        raw = await db["folders"].find_one(
            {"_id": _oid(cursor), "workspace_id": workspace_id},
            {"parent_id": 1, "slug": 1},
        )
        if not raw:
            break
        out.append(raw.get("slug") or str(raw["_id"]))
        cursor = raw.get("parent_id")
        hops += 1
    return list(reversed(out))


async def resolve_path(
    db: AsyncIOMotorDatabase, workspace_id: str, segments: list[str]
) -> str | None:
    """The folder id at the end of a slug path, or None if it doesn't resolve.

    Walks down from the root one segment at a time, each step scoped to the
    workspace *and* the previous segment's id — so a path only resolves if every
    link in it really is where the URL claims.
    """
    parent: str | None = None
    for segment in segments:
        raw = await db["folders"].find_one(
            {"workspace_id": workspace_id, "parent_id": parent, "slug": segment},
            {"_id": 1},
        )
        if not raw:
            return None
        parent = str(raw["_id"])
    return parent


async def _resolve_by_names(db: AsyncIOMotorDatabase, workspace_id: str,
                            segments: list[str]) -> str | None:
    """Same walk as resolve_path, matching display names case-insensitively."""
    parent: str | None = None
    for segment in segments:
        rows = await db["folders"].find(
            {"workspace_id": workspace_id, "parent_id": parent}, {"name": 1}
        ).to_list(length=MAX_FOLDERS_PER_WORKSPACE)
        match = next((r for r in rows if (r.get("name") or "").strip().lower() == segment.lower()), None)
        if match is None:
            return None
        parent = str(match["_id"])
    return parent


async def resolve_ref(db: AsyncIOMotorDatabase, workspace_id: str, ref: str) -> str:
    """A folder of this workspace by id, slug path ("guides/setup") or name
    path. Never created implicitly: a missing folder is a 404 naming the ones
    that exist, so an agent or script can correct itself."""
    ref = (ref or "").strip().strip("/")
    if not ref:
        raise HTTPException(status_code=422, detail="Name a folder.")
    if ObjectId.is_valid(ref):
        found = await db["folders"].find_one(
            {"_id": ObjectId(ref), "workspace_id": workspace_id}, {"_id": 1})
        if found:
            return str(found["_id"])
    segments = [p for p in ref.split("/") if p]
    folder_id = await resolve_path(db, workspace_id, segments)
    if folder_id is None:
        folder_id = await _resolve_by_names(db, workspace_id, segments)
    if folder_id is None:
        paths = sorted("/".join(p) for p in paths_by_id(await list_folders(db, workspace_id)).values())
        listing = ", ".join(paths[:40]) or "none yet"
        raise HTTPException(status_code=404,
                            detail=f"There's no folder '{ref}' in this workspace. Folders: {listing}.")
    return folder_id


def paths_by_id(folders: list[Folder]) -> dict[str, list[str]]:
    """Slug path for every folder, from a list already in hand (no queries)."""
    by_id = {f.id: f for f in folders}
    cache: dict[str, list[str]] = {}

    def walk(fid: str, depth: int = 0) -> list[str]:
        if fid in cache:
            return cache[fid]
        f = by_id.get(fid)
        if f is None or depth > MAX_DEPTH + 1:
            return []
        parent = walk(f.parent_id, depth + 1) if f.parent_id else []
        cache[fid] = parent + [f.slug]
        return cache[fid]

    return {f.id: walk(f.id) for f in folders}


def _children(folders: list[Folder]) -> dict[str | None, list[str]]:
    out: dict[str | None, list[str]] = {}
    for f in folders:
        out.setdefault(f.parent_id, []).append(f.id)
    return out


def subtree_ids(folders: list[Folder], root_id: str) -> list[str]:
    """The folder and every folder below it."""
    children = _children(folders)
    out, frontier, seen = [], [root_id], set()
    while frontier:
        fid = frontier.pop()
        if fid in seen:
            continue
        seen.add(fid)
        out.append(fid)
        frontier.extend(children.get(fid, []))
    return out


def subtree_height(folders: list[Folder], root_id: str) -> int:
    """1 for a folder with no children."""
    children = _children(folders)

    def h(fid: str, guard: int = 0) -> int:
        if guard > MAX_DEPTH + 2:
            return guard
        kids = children.get(fid, [])
        return 1 + (max(h(k, guard + 1) for k in kids) if kids else 0)

    return h(root_id)


async def _get_owned(db: AsyncIOMotorDatabase, workspace_id: str, folder_id: str) -> dict:
    """Fetch a folder, scoped to the workspace.

    Scoped in the query rather than fetched-then-checked: a folder id from
    another workspace must be indistinguishable from one that doesn't exist, or
    the API confirms the existence of other tenants' folders.
    """
    raw = await db["folders"].find_one({"_id": _oid(folder_id), "workspace_id": workspace_id})
    if not raw:
        raise HTTPException(status_code=404, detail="Folder not found")
    return raw


# ── Document slug vs folder slug (B5) ──────────────────────────────────────────
#
# On a workspace's own domain ``/<a>/<b>`` is either the folder ``b`` under
# ``a`` or the document ``b`` filed in ``a``. Both may never exist: a member's
# document must not take over a folder's address (white-label phishing) and a
# folder must not make a document unreachable. New collisions are refused
# (409) wherever either side is created or moved; collisions that predate the
# rule are listed at startup and resolved at read time in favour of the folder
# unless the document's owner administers the workspace (``slug_shadowed``).


def _clash_detail(slug: str) -> str:
    return (f"“{slug}” is already the address of a folder or document in that place. "
            "Rename one of them first.")


async def doc_slug_taken(db: AsyncIOMotorDatabase, workspace_id: str, parent_id: str | None,
                         slug: str) -> bool:
    """A document filed directly in ``parent_id`` (None = root) answers at ``slug``."""
    return bool(await db["documents"].find_one(
        {"workspace_id": workspace_id, "folder_id": parent_id or None, "slug": slug}, {"_id": 1}))


async def folder_slug_taken(db: AsyncIOMotorDatabase, workspace_id: str, parent_id: str | None,
                            slug: str | None, exclude_id=None) -> bool:
    """A folder directly in ``parent_id`` (None = root) answers at ``slug``."""
    if not slug:
        return False
    query: dict = {"workspace_id": workspace_id, "parent_id": parent_id or None, "slug": slug}
    if exclude_id is not None:
        query["_id"] = {"$ne": exclude_id}
    return bool(await db["folders"].find_one(query, {"_id": 1}))


async def assert_doc_fits(db: AsyncIOMotorDatabase, workspace_id: str, folder_id: str | None,
                          slug: str | None) -> None:
    """409 when a document with ``slug`` would sit next to a folder of that slug."""
    if await folder_slug_taken(db, workspace_id, folder_id, slug):
        raise HTTPException(status_code=409, detail=_clash_detail(slug or ""))


async def slug_shadowed(db: AsyncIOMotorDatabase, raw: dict | None) -> bool:
    """A pre-existing collision: a folder next to this filed document has its
    slug. On the workspace's domain the folder wins, unless the document's
    owner is an admin/owner of the workspace (they could have renamed it)."""
    if not raw or not raw.get("workspace_id"):
        return False
    ws_id = raw["workspace_id"]
    if not await folder_slug_taken(db, ws_id, raw.get("folder_id"), raw.get("slug")):
        return False
    owner = raw.get("owner_id")
    m = await db["memberships"].find_one({"workspace_id": ws_id, "user_id": owner}, {"role": 1}) \
        if owner else None
    return not (m and m.get("role") in ("owner", "admin"))


async def list_slug_collisions(db: AsyncIOMotorDatabase, *, limit: int = 1000) -> list[dict]:
    """Every (folder, document) pair that already shares an address."""
    out: list[dict] = []
    async for f in db["folders"].find({}, {"workspace_id": 1, "parent_id": 1, "slug": 1}):
        if not f.get("slug"):
            continue
        d = await db["documents"].find_one(
            {"workspace_id": f["workspace_id"], "folder_id": f.get("parent_id") or None, "slug": f["slug"]},
            {"_id": 1, "owner_id": 1})
        if d:
            out.append({"workspace_id": f["workspace_id"], "folder_id": str(f["_id"]),
                        "document_id": str(d["_id"]), "slug": f["slug"], "parent_id": f.get("parent_id")})
            if len(out) >= limit:
                break
    return out


async def _depth_of(db: AsyncIOMotorDatabase, workspace_id: str, folder_id: str | None) -> int:
    """How deep a folder sits (a top-level folder is 1). Bounded walk."""
    depth = 0
    cursor = folder_id
    while cursor and depth <= MAX_DEPTH + 1:
        raw = await db["folders"].find_one({"_id": _oid(cursor), "workspace_id": workspace_id}, {"parent_id": 1})
        if not raw:
            break
        cursor = raw.get("parent_id")
        depth += 1
    return depth


async def _reindex_subtree(db: AsyncIOMotorDatabase, workspace_id: str, root_id: str) -> list[str]:
    """Rewrite `folder_path` on every document at or below this folder.
    Returns the slugs of the documents touched (they each need a purge).

    Breadth-first from the changed folder down: a rename at the root rewrites
    the whole subtree, and nothing below it keeps a stale prefix.
    """
    slugs: list[str] = []
    frontier = [(root_id, await path_of(db, workspace_id, root_id))]
    seen, hops = set(), 0
    while frontier and hops <= MAX_FOLDERS_PER_WORKSPACE:
        folder_id, path = frontier.pop()
        if folder_id in seen:
            continue
        seen.add(folder_id)
        hops += 1
        rows = await db["documents"].find(
            {"workspace_id": workspace_id, "folder_id": folder_id}, {"slug": 1}
        ).to_list(length=20_000)
        slugs.extend(r["slug"] for r in rows)
        await db["documents"].update_many(
            {"workspace_id": workspace_id, "folder_id": folder_id},
            {"$set": {"folder_path": path}},
        )
        children = await db["folders"].find(
            {"workspace_id": workspace_id, "parent_id": folder_id}, {"slug": 1}
        ).to_list(length=MAX_FOLDERS_PER_WORKSPACE)
        for child in children:
            frontier.append((str(child["_id"]), path + [child.get("slug") or str(child["_id"])]))
    return slugs


async def _purge(db: AsyncIOMotorDatabase, workspace_id: str, slugs: list[str],
                 share_ids: list[str] | None = None) -> None:
    """D5/D6: every document in the subtree, plus the folder listings."""
    from app.services import revalidate

    tags = [f"wsl:{workspace_id}", *[f"share:{s}" for s in (share_ids or []) if s]]
    await revalidate.enqueue(db, slugs=slugs, tags=tags)


async def list_folders(db: AsyncIOMotorDatabase, workspace_id: str) -> list[Folder]:
    rows = await db["folders"].find({"workspace_id": workspace_id}).to_list(length=MAX_FOLDERS_PER_WORKSPACE)
    rows.sort(key=lambda r: (r.get("parent_id") or "", r["name"].lower()))
    return [_to_folder(r) for r in rows]


async def create_folder(
    db: AsyncIOMotorDatabase, workspace_id: str, name: str, parent_id: str | None
) -> Folder:
    name = _clean_name(name)
    count = await db["folders"].count_documents({"workspace_id": workspace_id})
    if count >= MAX_FOLDERS_PER_WORKSPACE:
        raise HTTPException(status_code=429, detail="This workspace has reached its folder limit.")

    # A nested folder is a structural change: under the workspace folder lock
    # (C9), like moves, so a concurrent move of an ancestor can't push the new
    # folder past MAX_DEPTH. The depth is read after the revision and the
    # lock is a CAS on that revision; a lost race re-reads and re-checks.
    for attempt in range(3):
        rev = await folders_rev(db, workspace_id) if parent_id else None
        if parent_id:
            await _get_owned(db, workspace_id, parent_id)  # must exist, and be ours
            if await _depth_of(db, workspace_id, parent_id) >= MAX_DEPTH:
                raise HTTPException(status_code=422, detail=f"Folders can nest at most {MAX_DEPTH} deep.")
        slug = await _unique_slug(db, workspace_id, name, parent_id)
        if await doc_slug_taken(db, workspace_id, parent_id, slug):
            raise HTTPException(status_code=409, detail=_clash_detail(slug))
        if not parent_id:
            break
        try:
            await _lock(db, workspace_id, rev)
            break
        except HTTPException:
            if attempt == 2:
                raise
    now = datetime.now(timezone.utc)
    doc = {
        "workspace_id": workspace_id,
        "name": name,
        "slug": slug,
        "parent_id": parent_id or None,
        "created_at": now,
        "updated_at": now,
    }
    result = await db["folders"].insert_one(doc)
    doc["_id"] = result.inserted_id
    return _to_folder(doc)


async def ensure_path(db: AsyncIOMotorDatabase, workspace_id: str, path: str) -> tuple[str, list[str]]:
    """Create every missing folder along a name path ("Guides/Setup"); returns
    (folder id, names created). For agents (MCP create_folder)."""
    segments = [p.strip() for p in (path or "").strip().strip("/").split("/") if p.strip()]
    if not segments:
        raise HTTPException(status_code=422, detail="Give a folder path, like 'guides/setup'.")
    if len(segments) > MAX_DEPTH:
        raise HTTPException(status_code=422, detail=f"Folders can nest at most {MAX_DEPTH} deep.")
    parent: str | None = None
    created: list[str] = []
    for segment in segments:
        existing = await _resolve_by_names(db, workspace_id, [segment]) if parent is None else None
        if parent is not None:
            rows = await db["folders"].find({"workspace_id": workspace_id, "parent_id": parent},
                                            {"name": 1, "slug": 1}).to_list(length=MAX_FOLDERS_PER_WORKSPACE)
            hit = next((r for r in rows if (r.get("name") or "").lower() == segment.lower()
                        or r.get("slug") == segment), None)
            existing = str(hit["_id"]) if hit else None
        elif existing is None:
            hit = await db["folders"].find_one({"workspace_id": workspace_id, "parent_id": None,
                                                "slug": segment}, {"_id": 1})
            existing = str(hit["_id"]) if hit else None
        if existing is None:
            folder = await create_folder(db, workspace_id, segment, parent)
            existing = folder.id
            created.append(segment)
        parent = existing
    return parent, created


async def _lock(db: AsyncIOMotorDatabase, workspace_id: str, expected_rev: int | None) -> None:
    """Per-workspace folder lock (D5): compare-and-set on `folders_rev`. A
    concurrent structural change makes this 409 rather than form a cycle."""
    filt: dict = {"_id": _oid(workspace_id, "Workspace")}
    filt["folders_rev"] = expected_rev  # None matches a workspace that never had one
    res = await db["workspaces"].update_one(filt, {"$inc": {"folders_rev": 1}})
    if res.matched_count == 0:
        raise HTTPException(status_code=409, detail="Folders changed meanwhile. Reload and try again.")


async def folders_rev(db: AsyncIOMotorDatabase, workspace_id: str) -> int | None:
    raw = await db["workspaces"].find_one({"_id": _oid(workspace_id, "Workspace")}, {"folders_rev": 1})
    return (raw or {}).get("folders_rev")


async def update_folder(
    db: AsyncIOMotorDatabase,
    workspace_id: str,
    folder_id: str,
    *,
    name: str | None = None,
    slug: str | None = None,
    parent_id: str | None = None,
    reparent: bool = False,
    expected_rev: int | None = ...,  # type: ignore[assignment]
) -> Folder:
    """Rename (name/slug) and/or move (reparent → parent_id; None = top level).

    A move validates the whole subtree: target depth + subtree height ≤
    MAX_DEPTH, no cycle, under the workspace's folder lock. Every document in
    the subtree gets its new `folder_path` and a purge; old document URLs keep
    working (307 to canonical); folder shares keep working (share id)."""
    raw = await _get_owned(db, workspace_id, folder_id)
    rev = await folders_rev(db, workspace_id) if expected_rev is ... else expected_rev
    updates: dict = {"updated_at": datetime.now(timezone.utc)}
    target_parent = (parent_id or None) if reparent else raw.get("parent_id")

    if reparent:
        all_folders = await list_folders(db, workspace_id)
        if parent_id:
            if parent_id == folder_id:
                raise HTTPException(status_code=422, detail="A folder can't contain itself.")
            await _get_owned(db, workspace_id, parent_id)
            if parent_id in subtree_ids(all_folders, folder_id):
                raise HTTPException(status_code=422, detail="That would put a folder inside itself.")
            target_depth = await _depth_of(db, workspace_id, parent_id)
        else:
            target_depth = 0
        if target_depth + subtree_height(all_folders, folder_id) > MAX_DEPTH:
            raise HTTPException(
                status_code=422,
                detail=f"Folders can nest at most {MAX_DEPTH} deep, counting the folders inside this one.",
            )
        updates["parent_id"] = target_parent

    if name is not None:
        updates["name"] = _clean_name(name)
    if slug is not None or name is not None or reparent:
        base_name = slug if slug is not None else updates.get("name", raw["name"])
        if slug is not None:
            cleaned = slugify(slug)[:MAX_SLUG].strip("-")
            if not cleaned:
                raise HTTPException(status_code=422, detail="That folder address isn't valid.")
            base_name = cleaned
        new_slug = await _unique_slug(db, workspace_id, base_name, target_parent, exclude_id=raw["_id"])
        if new_slug != raw.get("slug") or "parent_id" in updates:
            if await doc_slug_taken(db, workspace_id, target_parent, new_slug):
                raise HTTPException(status_code=409, detail=_clash_detail(new_slug))
            updates["slug"] = new_slug

    structural = "slug" in updates or "parent_id" in updates
    if structural:
        await _lock(db, workspace_id, rev)
    await db["folders"].update_one({"_id": raw["_id"]}, {"$set": updates})
    raw.update(updates)
    if structural:
        slugs = await _reindex_subtree(db, workspace_id, folder_id)
        current = await list_folders(db, workspace_id)
        below = set(subtree_ids(current, folder_id))
        shares = [f.share.get("id") for f in current if f.share and f.id in below]
        await _purge(db, workspace_id, slugs, shares)
    return _to_folder(raw)


async def delete_folder(db: AsyncIOMotorDatabase, workspace_id: str, folder_id: str,
                        mode: str = "unfile") -> list[dict]:
    """Remove a folder (D6). Documents inside are never deleted: ``unfile``
    puts them at the workspace root, ``move_up`` into the parent folder. Child
    folders move up a level. The folder's share dies with it; children's shares
    keep working. Returns the rows of the documents that were inside (the
    caller counts only those the caller can read)."""
    raw = await _get_owned(db, workspace_id, folder_id)
    fid = str(raw["_id"])
    new_parent = raw.get("parent_id")
    # B5: the documents inside move to the parent (move_up) or the root; none
    # may land on the address of a folder already there.
    dest = new_parent if (mode == "move_up" and new_parent) else None
    for d in await db["documents"].find({"workspace_id": workspace_id, "folder_id": fid},
                                        {"slug": 1}).to_list(length=20_000):
        if await folder_slug_taken(db, workspace_id, dest, d.get("slug"), exclude_id=raw["_id"]):
            raise HTTPException(status_code=409, detail=_clash_detail(d["slug"]))
    await _lock(db, workspace_id, await folders_rev(db, workspace_id))

    children = await db["folders"].find(
        {"workspace_id": workspace_id, "parent_id": fid}, {"slug": 1}
    ).to_list(length=MAX_FOLDERS_PER_WORKSPACE)
    if any((c.get("slug") or "") == raw.get("slug") for c in children):
        await db["folders"].update_one(
            {"_id": raw["_id"]}, {"$set": {"slug": f"deleting-{fid}"}}
        )
    for child in children:
        base = child.get("slug") or str(child["_id"])
        if new_parent is None and is_reserved_slug(base):
            base = f"{base}-folder"
        candidate, n = base, 1
        while await db["folders"].find_one(
            {"workspace_id": workspace_id, "parent_id": new_parent,
             "slug": candidate, "_id": {"$nin": [child["_id"], raw["_id"]]}},
            {"_id": 1},
        ) or await doc_slug_taken(db, workspace_id, new_parent, candidate) or (
            new_parent == dest and await db["documents"].find_one(
                {"workspace_id": workspace_id, "folder_id": fid, "slug": candidate}, {"_id": 1})):
            n += 1
            candidate = f"{base}-{n}"
            if n > 200:
                candidate = str(child["_id"])
                break
        await db["folders"].update_one(
            {"_id": child["_id"]},
            {"$set": {"parent_id": new_parent, "slug": candidate}},
        )
    inside = await db["documents"].find({"workspace_id": workspace_id, "folder_id": fid}).to_list(length=20_000)
    if mode == "move_up" and new_parent:
        await db["documents"].update_many(
            {"workspace_id": workspace_id, "folder_id": fid},
            {"$set": {"folder_id": new_parent, "folder_path": await path_of(db, workspace_id, new_parent)}},
        )
    else:
        await db["documents"].update_many(
            {"workspace_id": workspace_id, "folder_id": fid},
            {"$set": {"folder_id": None, "folder_path": []}},
        )
    await db["folders"].delete_one({"_id": raw["_id"]})
    # C8: a move that wrote between the update above and the delete would
    # otherwise point at a folder that no longer exists.
    late = await db["documents"].find({"workspace_id": workspace_id, "folder_id": fid},
                                      {"slug": 1}).to_list(length=20_000)
    if late:
        await db["documents"].update_many({"workspace_id": workspace_id, "folder_id": fid},
                                          {"$set": {"folder_id": None, "folder_path": []}})
        inside = inside + [d for d in late if d["_id"] not in {i["_id"] for i in inside}]
    slugs = [d["slug"] for d in inside]
    for child in await db["folders"].find(
        {"workspace_id": workspace_id, "parent_id": raw.get("parent_id")}, {"_id": 1}
    ).to_list(length=MAX_FOLDERS_PER_WORKSPACE):
        slugs.extend(await _reindex_subtree(db, workspace_id, str(child["_id"])))
    share_id = (raw.get("share") or {}).get("id")
    await _purge(db, workspace_id, slugs, [share_id] if share_id else [])
    return inside


async def file_document(db: AsyncIOMotorDatabase, raw: dict, workspace_id: str,
                        folder_id: str | None) -> dict:
    """Refile one document within its workspace (D3): CAS on the workspace,
    new `folder_path`, purge. The caller has checked can(move_in_workspace)."""
    from app.services import revalidate

    if folder_id:
        await _get_owned(db, workspace_id, folder_id)
    if (folder_id or None) != (raw.get("folder_id") or None):
        await assert_doc_fits(db, workspace_id, folder_id, raw.get("slug"))
    path = await path_of(db, workspace_id, folder_id) if folder_id else []
    after = await db["documents"].find_one_and_update(
        {"_id": raw["_id"], "workspace_id": workspace_id},
        {"$set": {"folder_id": folder_id or None, "folder_path": path,
                  "updated_at": datetime.now(timezone.utc)}},
        return_document=True,
    )
    if after is None:
        raise HTTPException(status_code=404, detail="That document isn't in this workspace.")
    if folder_id and not await unfile_if_folder_gone(db, after):
        # C8: the folder was deleted while we wrote; the document is back at
        # the workspace root rather than pointing at nothing.
        raise HTTPException(status_code=404, detail="Folder not found")
    await revalidate.purge_doc(db, after)
    return after


async def unfile_if_folder_gone(db: AsyncIOMotorDatabase, raw: dict) -> bool:
    """True when ``raw``'s folder exists. Otherwise (a move or filing raced
    the folder's deletion) put the document at the workspace root — CAS on
    the dangling ``folder_id`` — purge it, and return False (C8)."""
    from app.services import revalidate

    fid = raw.get("folder_id")
    if not fid:
        return True
    try:
        found = await db["folders"].find_one({"_id": ObjectId(fid), "workspace_id": raw.get("workspace_id")},
                                             {"_id": 1})
    except Exception:
        found = None
    if found is not None:
        return True
    res = await db["documents"].update_one(
        {"_id": raw["_id"], "folder_id": fid},
        {"$set": {"folder_id": None, "folder_path": [], "updated_at": datetime.now(timezone.utc)}})
    if res.modified_count:
        await revalidate.purge_doc(db, {**raw, "folder_id": None, "folder_path": []})
    return False


async def move_document(
    db: AsyncIOMotorDatabase, workspace_id: str, slug: str, folder_id: str | None, actor=None,
    ctx=None,
) -> None:
    """Legacy single-document move (POST /workspaces/{id}/documents/move).
    can(move_in_workspace): read + member+ (A1: never a document the caller
    can't read)."""
    from app.services import access

    raw = await db["documents"].find_one({"slug": slug, "workspace_id": workspace_id})
    if actor is not None:
        d = await access.can(actor, raw, "move_in_workspace", ctx or access.Ctx(db))
        if not d.allowed:
            if d.status in (401, 404):
                raise HTTPException(status_code=404, detail="Document not found in this workspace")
            raise d.exception()
    elif raw is None:
        raise HTTPException(status_code=404, detail="Document not found in this workspace")
    await file_document(db, raw, workspace_id, folder_id)


# ── Folder shares (D2, D7, D8) ────────────────────────────────────────────────


def new_share_id() -> str:
    """10–12 url-safe characters; stable across renames and moves."""
    import secrets

    return secrets.token_urlsafe(8)


async def set_share(db: AsyncIOMotorDatabase, workspace_id: str, folder_id: str, level: str,
                    user_id: str) -> dict:
    raw = await _get_owned(db, workspace_id, folder_id)
    share = raw.get("share") or {}
    share_id = share.get("id") or new_share_id()
    now = datetime.now(timezone.utc)
    share = {"id": share_id, "level": level, "created_at": share.get("created_at") or now,
             "created_by": share.get("created_by") or user_id, "updated_at": now}
    await db["folders"].update_one({"_id": raw["_id"]}, {"$set": {"share": share}})
    await _purge(db, workspace_id, [], [share_id])
    return share


async def clear_share(db: AsyncIOMotorDatabase, workspace_id: str, folder_id: str) -> None:
    raw = await _get_owned(db, workspace_id, folder_id)
    share_id = (raw.get("share") or {}).get("id")
    await db["folders"].update_one({"_id": raw["_id"]}, {"$unset": {"share": ""}})
    if share_id:
        await _purge(db, workspace_id, [], [share_id])


async def find_share(db: AsyncIOMotorDatabase, share_id: str) -> dict | None:
    if not share_id or len(share_id) > 32:
        return None
    return await db["folders"].find_one({"share.id": share_id})
