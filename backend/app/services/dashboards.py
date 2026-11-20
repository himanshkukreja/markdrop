"""Customizable Home (/dashboard; brief .work/briefs/custom-dashboard.md).

Everyone's Home is a fixed structure they fill: the greeting and the Ask bar (always there), then a wide
``main`` column and a narrow ``side`` column, each an ordered list of widgets ``{id, type, settings}``.
No drag and drop: Customize moves a widget up / down / to the other column, removes it, changes its
settings, adds one from the catalog, or starts over from a template (``PRESETS``).

Per person and workspace (the workspace the sidebar shows; ``""`` = no workspace yet), collection
``dashboards``: ``{user_id, workspace_id, main, side, updated_at}``. A workspace admin can set the
workspace's default (``workspaces.home_default``), which members who never customized see. What a
person sees resolves: their own → the workspace's default → the Default template.

``WIDGETS`` is the one registry (the website renders its ``catalog``; MCP lists the same types). Every
widget's settings are validated here: unknown types and keys are refused, counts are clamped to their
range, a team / folder / page must exist in the workspace when saved. Reading re-checks access: a team
the person left, a deleted folder or a page they can't open shows as ``available: false`` (never its
name), and the website offers Remove.
"""

from __future__ import annotations

import re
import secrets
from datetime import datetime, timezone
from typing import Any

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorDatabase

COLL = "dashboards"
MAX_WIDGETS = 16
COLUMNS = ("main", "side")
_ID = re.compile(r"^[a-z0-9]{1,12}$")
_OID = re.compile(r"^[0-9a-f]{24}$")
_SLUG = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._~-]{0,199}$")

BACKLOG_CATEGORIES = ("feature", "bug", "improvement", "task", "follow_up", "question")
BACKLOG_STATUSES = ("open", "in_progress", "done", "wont_do")
# Template placeholders, filled in per person (``_Picks``).
TOKENS = ("@team", "@sales")


class Invalid(Exception):
    """A layout or setting the registry refuses (422 on the website, a ToolError over MCP)."""


def _count(default: int, lo: int = 3, hi: int = 12) -> dict:
    return {"kind": "count", "label": "How many", "default": default, "min": lo, "max": hi}


_TEAM_REQ = {"kind": "team", "label": "Team", "required": True}
_TEAM_OPT = {"kind": "team", "label": "Team", "required": False, "empty": "All teams"}

# type → what the catalog shows and which settings it takes. ``workspace``: only on a workspace's Home.
# ``needs``: a workspace feature it depends on (``hubspot``: the workspace has HubSpot connected).
WIDGETS: dict[str, dict[str, Any]] = {
    "needs_you": {"label": "Needs you", "icon": "inbox", "workspace": False,
                  "description": "Today's meetings, mentions, sign-off and access requests: what's waiting on you.",
                  "settings": {"count": _count(4, 3, 10)}},
    "todos": {"label": "My to-dos", "icon": "checkSquare", "workspace": False,
              "description": "Open action items that mention you, from meeting notes and any page. Tick them here.",
              "settings": {"count": _count(5, 3, 12)}},
    "backlog": {"label": "Team backlog", "icon": "list", "workspace": True,
                "description": "A team's shared backlog from its calls, filtered by category or status.",
                "settings": {"team": _TEAM_REQ,
                             "category": {"kind": "enum", "label": "Category", "options": list(BACKLOG_CATEGORIES), "empty": "Every category"},
                             "status": {"kind": "enum", "label": "Status", "options": list(BACKLOG_STATUSES), "empty": "Open and in progress"},
                             "count": _count(6, 3, 12)}},
    "recent": {"label": "Recent pages & files", "icon": "history", "workspace": False,
               "description": "What you opened last, anywhere, with previews.",
               "settings": {"count": _count(8, 3, 12)}},
    "favorites": {"label": "Favorites", "icon": "star", "workspace": True,
                  "description": "The pages, files, teams and projects you starred in this workspace.",
                  "settings": {"count": _count(6, 3, 12)}},
    "folder": {"label": "A folder", "icon": "folder", "workspace": True,
               "description": "The newest items in one folder you pick.",
               "settings": {"folder": {"kind": "folder", "label": "Folder", "required": True}, "count": _count(6, 3, 12)}},
    "meetings": {"label": "Meetings", "icon": "mic", "workspace": False,
                 "description": "The latest calls with their summaries: every team's, or one team's.",
                 "settings": {"team": _TEAM_OPT, "count": _count(6, 3, 12)}},
    "brief": {"label": "Team brief", "icon": "newspaper", "workspace": True,
              "description": "A team's weekly brief: what shipped, what was decided, what's blocked.",
              "settings": {"team": _TEAM_REQ}},
    "memory": {"label": "Who's doing what", "icon": "users", "workspace": True,
               "description": "A team's memory: who's working on what, from its pages and calls.",
               "settings": {"team": _TEAM_REQ}},
    "deals": {"label": "Deals", "icon": "briefcase", "workspace": True, "needs": "hubspot",
              "description": "Open HubSpot deals with their stage, amount and calls.",
              "settings": {"count": _count(6, 3, 12)}},
    "activity": {"label": "Activity", "icon": "activity", "workspace": True,
                 "description": "What's happening across the teams you can see: new pages, files and meetings.",
                 "settings": {"count": _count(6, 3, 12)}},
    "views": {"label": "My documents' views", "icon": "chart", "workspace": False,
              "description": "How your published pages and files are read: views, people, top links.",
              "settings": {"range": {"kind": "enum", "label": "Period", "options": ["7d", "30d"], "default": "7d"}}},
    "pinned": {"label": "Pinned page", "icon": "pin", "workspace": False,
               "description": "One page you choose, shown right here to read.",
               "settings": {"page": {"kind": "page", "label": "Page", "required": True}}},
    "quick": {"label": "Quick actions", "icon": "zap", "workspace": False,
              "description": "New page, upload a file, import a meeting: one tap each.", "settings": {}},
    "ask": {"label": "Ask suggestions", "icon": "sparkle", "workspace": True,
            "description": "Questions your team is asking, ready to ask again.", "settings": {}},
    "workspaces": {"label": "Workspaces", "icon": "building", "workspace": False,
                   "description": "Your workspaces with their people, items and meetings.", "settings": {}},
}

PRESETS: dict[str, dict[str, Any]] = {
    "default": {"label": "Default", "description": "Recent work, what needs you, your to-dos, meetings and workspaces.",
                "main": [("recent", {}), ("meetings", {}), ("workspaces", {})],
                "side": [("needs_you", {}), ("todos", {})]},
    "writer": {"label": "Writer", "description": "Your recent pages, favorites and one page pinned to read.",
               "main": [("recent", {"count": 9}), ("pinned", {"page": "@latest"})],
               "side": [("favorites", {}), ("quick", {})]},
    "meetings": {"label": "Meetings first", "description": "Meetings up top, then your to-dos and who's doing what.",
                 "main": [("meetings", {"count": 9}), ("memory", {"team": "@team"})],
                 "side": [("todos", {}), ("needs_you", {}), ("ask", {})]},
    "sales": {"label": "Sales", "description": "Deals, calls, the backlog of customer asks and your follow-ups.",
              "main": [("deals", {}), ("meetings", {"team": "@sales"})],
              "side": [("todos", {}), ("backlog", {"team": "@sales", "category": "follow_up"})]},
    "manager": {"label": "Manager", "description": "What needs you, the team's brief, who's doing what, backlog and activity.",
                "main": [("brief", {"team": "@team"}), ("memory", {"team": "@team"}), ("activity", {})],
                "side": [("needs_you", {}), ("backlog", {"team": "@team"})]},
}


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def new_id() -> str:
    return secrets.token_hex(4)


async def ensure_indexes(db: AsyncIOMotorDatabase) -> None:
    await db[COLL].create_index([("user_id", 1), ("workspace_id", 1)], unique=True)


# ── Validation ────────────────────────────────────────────────────────────────


def clean_settings(kind: str, raw: Any) -> dict:
    """A widget's settings, normalized: unknown keys refused, defaults filled, counts clamped. Shape only
    (references are checked against the workspace by ``check_refs``)."""
    spec = WIDGETS[kind]["settings"]
    raw = raw or {}
    if not isinstance(raw, dict):
        raise Invalid(f"{kind}: settings must be an object")
    extra = sorted(set(raw) - set(spec))
    if extra:
        raise Invalid(f"{kind}: unknown setting {', '.join(extra)}" + (f" (it takes {', '.join(spec)})" if spec else " (it takes none)"))
    out: dict[str, Any] = {}
    for key, f in spec.items():
        v = raw.get(key)
        k = f["kind"]
        if k == "count":
            if v is None:
                v = f["default"]
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                raise Invalid(f"{kind}.{key}: a number from {f['min']} to {f['max']}")
            out[key] = max(f["min"], min(f["max"], int(v)))
        elif k == "enum":
            if v in (None, ""):
                v = f.get("default")
            if v is not None and v not in f["options"]:
                raise Invalid(f"{kind}.{key}: one of {', '.join(f['options'])}")
            out[key] = v
        elif k in ("team", "folder"):
            if v in (None, ""):
                v = None
            elif not isinstance(v, str) or not (_OID.match(v) or (k == "team" and v in TOKENS)):
                raise Invalid(f"{kind}.{key}: a {k} id")
            out[key] = v
        elif k == "page":
            if v in (None, ""):
                v = None
            elif not isinstance(v, str) or not (_SLUG.match(v) or v == "@latest"):
                raise Invalid(f"{kind}.{key}: a page's slug")
            out[key] = v
    return out


def clean_layout(main: Any, side: Any, *, workspace: bool) -> tuple[list[dict], list[dict]]:
    """Both columns, shape-checked: known types (workspace-only ones only on a workspace's Home), at most
    ``MAX_WIDGETS`` in all, each with a unique short id (new ones get one)."""
    cols = []
    seen: set[str] = set()
    for name, col in (("main", main), ("side", side)):
        if col is None:
            col = []
        if not isinstance(col, list):
            raise Invalid(f"{name}: a list of widgets")
        out = []
        for w in col:
            if isinstance(w, str):
                w = {"type": w}
            if not isinstance(w, dict) or not isinstance(w.get("type"), str):
                raise Invalid(f"{name}: each widget is {{type, settings}}")
            kind = w["type"]
            if kind not in WIDGETS:
                raise Invalid(f"Unknown widget “{kind}”. One of: {', '.join(WIDGETS)}")
            if WIDGETS[kind]["workspace"] and not workspace:
                raise Invalid(f"{WIDGETS[kind]['label']} needs a workspace.")
            wid = w.get("id")
            if not (isinstance(wid, str) and _ID.match(wid)) or wid in seen:
                wid = new_id()
                while wid in seen:
                    wid = new_id()
            seen.add(wid)
            out.append({"id": wid, "type": kind, "settings": clean_settings(kind, w.get("settings"))})
        cols.append(out)
    if len(cols[0]) + len(cols[1]) > MAX_WIDGETS:
        raise Invalid(f"At most {MAX_WIDGETS} widgets on a Home.")
    return cols[0], cols[1]


async def check_refs(db: AsyncIOMotorDatabase, actor, ctx, workspace_id: str | None, main: list[dict], side: list[dict]) -> None:
    """Saving: every team / folder / page a widget names exists in this workspace and the saver can open it."""
    view = await ctx.team_view(workspace_id, actor.user_id) if workspace_id else None
    for w in [*main, *side]:
        s = w["settings"]
        label = WIDGETS[w["type"]]["label"]
        team = s.get("team")
        if team:
            if view is None or team not in view.readable_teams:
                raise Invalid(f"{label}: no team {team} you can open in this workspace.")
            if w["type"] == "backlog" and view.general_id == team:
                raise Invalid("Team backlog: General has no backlog. Pick one of your other teams.")
        folder = s.get("folder")
        if folder:
            row = await db["folders"].find_one({"_id": ObjectId(folder), "workspace_id": workspace_id}, {"_id": 1})
            if row is None:
                raise Invalid(f"{label}: no folder {folder} in this workspace.")
        page = s.get("page")
        if page and not await _page_readable(db, actor, ctx, page):
            raise Invalid(f"{label}: no page “{page}” you can open.")


async def _page_readable(db: AsyncIOMotorDatabase, actor, ctx, slug: str) -> dict | None:
    from app.services import access

    raw = await db["documents"].find_one({"slug": slug, "deleted_at": None})
    if raw is None or raw.get("encrypted"):
        return None
    return raw if (await access.can(actor, raw, "read", ctx)).allowed else None


# ── Presets ───────────────────────────────────────────────────────────────────


async def _hubspot(db: AsyncIOMotorDatabase, workspace_id: str | None, user_id: str | None) -> dict | None:
    """The workspace's HubSpot connection when it's connected and this person may use it."""
    if not workspace_id:
        return None
    from app.services import hubspot as H

    conn = await H.get(db, workspace_id)
    if not H.is_connected(conn):
        return None
    return conn if await H.can_use(db, user_id, conn) else None


class _Picks:
    """What a template's placeholders mean for one person: ``@team`` = their first team (not General; else
    General), ``@sales`` = the HubSpot team when they can open it (else ``@team``), ``@latest`` = their newest
    page here."""

    def __init__(self, db, actor, workspace_id: str | None, view, hub: dict | None):
        self.db, self.actor, self.workspace_id, self.view, self.hub = db, actor, workspace_id, view, hub
        general = view.general_id if view else None
        mine = sorted((t for tid, t in (view.teams.items() if view else []) if tid in view.member_teams and tid != general),
                      key=lambda t: str(t.get("name") or "").casefold())
        self.general = general
        self.first = str(mine[0]["_id"]) if mine else None
        readable = view.readable_teams if view else set()
        self.sales = hub.get("team_id") if hub and hub.get("team_id") in readable else None
        self._latest: str | None | bool = False

    def team(self, token: str, kind: str) -> str | None:
        t = (self.sales or self.first) if token == "@sales" else self.first
        if t is None and kind != "backlog":
            t = self.general
        return t

    async def latest(self) -> str | None:
        if self._latest is False:
            raw = await self.db["documents"].find_one(
                {"owner_id": self.actor.user_id, "workspace_id": self.workspace_id or None, "editor": "blocks",
                 "deleted_at": None, "encrypted": {"$ne": True}, "meeting_id": None},
                {"slug": 1}, sort=[("updated_at", -1)])
            self._latest = raw["slug"] if raw else None
        return self._latest  # type: ignore[return-value]


async def _picks(db, actor, ctx, workspace_id: str | None) -> _Picks:
    view = await ctx.team_view(workspace_id, actor.user_id) if workspace_id else None
    return _Picks(db, actor, workspace_id, view, await _hubspot(db, workspace_id, actor.user_id))


async def build_preset(db: AsyncIOMotorDatabase, actor, ctx, workspace_id: str | None, preset: str, *,
                       keep_tokens: bool = False) -> tuple[list[dict], list[dict]]:
    """A template made concrete for this person (``_Picks``). A widget that can't apply (no workspace, no
    HubSpot, no team with a backlog, no page) is left out. ``keep_tokens`` (a workspace default): the
    placeholders stay, and each member's Home fills them in for them."""
    if preset not in PRESETS:
        raise Invalid(f"Unknown template “{preset}”. One of: {', '.join(PRESETS)}")
    p = PRESETS[preset]
    picks = await _picks(db, actor, ctx, workspace_id)

    async def make(col: list[tuple[str, dict]], prefix: str) -> list[dict]:
        out = []
        for i, (kind, settings) in enumerate(col):
            spec = WIDGETS[kind]
            if spec["workspace"] and not workspace_id:
                continue
            if spec.get("needs") == "hubspot" and not (picks.hub or keep_tokens):
                continue
            s = dict(settings)
            if not keep_tokens:
                if s.get("team") in TOKENS:
                    team = picks.team(s["team"], kind)
                    if team is None and kind == "meetings":
                        s.pop("team")
                    elif team is None:
                        continue
                    else:
                        s["team"] = team
                if s.get("page") == "@latest":
                    slug = await picks.latest()
                    if slug is None:
                        continue
                    s["page"] = slug
            out.append({"id": f"{prefix}{i}", "type": kind, "settings": clean_settings(kind, s)})
        return out

    return await make(p["main"], "m"), await make(p["side"], "s")


# ── Reading ───────────────────────────────────────────────────────────────────


async def annotate(db: AsyncIOMotorDatabase, actor, ctx, workspace_id: str | None, col: list[dict], picks: _Picks) -> list[dict]:
    """Each widget with ``available`` (and ``note`` when it isn't) for this person now, placeholders filled
    in for them; a pinned page's ``title`` only when they can open it. Nothing about a team, folder or page
    they can't open."""
    view, hub = picks.view, picks.hub
    out = []
    for w in col:
        kind = w.get("type")
        spec = WIDGETS.get(kind)
        row = {"id": w.get("id") or new_id(), "type": kind, "settings": dict(w.get("settings") or {}), "available": True}
        s = row["settings"]
        if spec is not None and s.get("team") in TOKENS:
            team = picks.team(s["team"], kind)
            if team is None:
                s.pop("team")
            else:
                s["team"] = team
        if spec is not None and s.get("page") == "@latest":
            s["page"] = await picks.latest()
            if s["page"] is None:
                s.pop("page")
        if spec is None:
            row.update(available=False, note="This widget isn't available any more.")
        elif spec["workspace"] and not workspace_id:
            row.update(available=False, note="This widget needs a workspace.")
        elif spec.get("needs") == "hubspot" and not hub:
            row.update(available=False, note="HubSpot isn't connected for you in this workspace.")
        else:
            missing = next((k for k, f in spec["settings"].items() if f.get("required") and not s.get(k)), None)
            if missing:
                row.update(available=False, setup=missing, note=f"Choose a {spec['settings'][missing]['label'].lower()} in its settings.")
            elif s.get("team") and (view is None or s["team"] not in view.readable_teams):
                row.update(available=False, note="You can't open this team any more.")
            elif kind == "backlog" and view is not None and s.get("team") == view.general_id:
                row.update(available=False, note="General has no backlog. Pick another team in its settings.")
            elif s.get("folder"):
                try:
                    ok = await db["folders"].find_one({"_id": ObjectId(s["folder"]), "workspace_id": workspace_id}, {"_id": 1})
                except Exception:
                    ok = None
                if ok is None:
                    row.update(available=False, note="This folder was deleted or moved.")
            elif s.get("page"):
                raw = await _page_readable(db, actor, ctx, s["page"])
                if raw is None:
                    row.update(available=False, note="You can't open this page any more.")
                else:
                    row["title"] = raw.get("title") or s["page"]
        out.append(row)
    return out


def catalog(workspace: bool, hub: bool) -> list[dict]:
    return [{"type": k, "label": v["label"], "description": v["description"], "icon": v["icon"],
             "settings": {sk: {kk: vv for kk, vv in sv.items()} for sk, sv in v["settings"].items()},
             "available": (workspace or not v["workspace"]) and (v.get("needs") != "hubspot" or hub)}
            for k, v in WIDGETS.items()]


async def resolve(db: AsyncIOMotorDatabase, actor, ctx, workspace_id: str | None, *, with_catalog: bool = True) -> dict:
    """What this person's Home shows in this workspace (None: no workspace), and where it came from:
    ``mine`` (they customized it), ``workspace`` (the admins' default) or ``default``."""
    from app.services import workspace as ws_service

    uid = actor.user_id
    ws_row = None
    role = None
    if workspace_id:
        role = await ws_service.role_for(db, workspace_id, uid)
        ws_row = await db["workspaces"].find_one({"_id": ObjectId(workspace_id)}, {"name": 1, "home_default": 1})
    mine = await db[COLL].find_one({"user_id": uid, "workspace_id": workspace_id or ""})
    wsd = (ws_row or {}).get("home_default") if ws_row else None
    wsd = wsd if isinstance(wsd, dict) and isinstance(wsd.get("main"), list) else None
    if mine:
        source, main, side, updated = "mine", mine.get("main") or [], mine.get("side") or [], mine.get("updated_at")
    elif wsd:
        source, main, side, updated = "workspace", wsd.get("main") or [], wsd.get("side") or [], wsd.get("updated_at")
    else:
        main, side = await build_preset(db, actor, ctx, workspace_id, "default")
        source, updated = "default", None
    picks = await _picks(db, actor, ctx, workspace_id)
    hub = picks.hub
    main = await annotate(db, actor, ctx, workspace_id, main, picks)
    side = await annotate(db, actor, ctx, workspace_id, side, picks)
    if source != "mine":
        # A default (the admins' or ours) never shows someone a card they can't use: it simply isn't there.
        main, side = [w for w in main if w["available"]], [w for w in side if w["available"]]
    out = {
        "workspace": {"id": workspace_id, "name": (ws_row or {}).get("name"), "role": role} if workspace_id else None,
        "source": source,
        "main": main,
        "side": side,
        "updated_at": updated.isoformat() if isinstance(updated, datetime) else None,
        "can_set_default": role in ("owner", "admin"),
        "has_workspace_default": wsd is not None,
        "max": MAX_WIDGETS,
    }
    if with_catalog:
        out["catalog"] = catalog(bool(workspace_id), bool(hub))
        out["presets"] = [{"id": k, "label": v["label"], "description": v["description"]} for k, v in PRESETS.items()]
    return out


# ── Writing ───────────────────────────────────────────────────────────────────


async def member_workspace(db: AsyncIOMotorDatabase, user_id: str, workspace_id: str | None) -> str | None:
    """``workspace_id`` when the person belongs to it (None/"" = no workspace); raises LookupError otherwise."""
    from app.services import workspace as ws_service

    if not workspace_id:
        return None
    if not _OID.match(workspace_id) or await ws_service.role_for(db, workspace_id, user_id) is None:
        raise LookupError("Workspace not found")
    return workspace_id


async def layout_from(db: AsyncIOMotorDatabase, actor, ctx, workspace_id: str | None, *, main: Any = None, side: Any = None,
                      preset: str | None = None, keep_tokens: bool = False) -> tuple[list[dict], list[dict]]:
    if preset:
        return await build_preset(db, actor, ctx, workspace_id, preset, keep_tokens=keep_tokens)
    m, s = clean_layout(main, side, workspace=bool(workspace_id))
    await check_refs(db, actor, ctx, workspace_id, m, s)
    return m, s


async def save(db: AsyncIOMotorDatabase, actor, ctx, workspace_id: str | None, *, main: Any = None, side: Any = None,
               preset: str | None = None) -> dict:
    m, s = await layout_from(db, actor, ctx, workspace_id, main=main, side=side, preset=preset)
    await db[COLL].update_one({"user_id": actor.user_id, "workspace_id": workspace_id or ""},
                              {"$set": {"main": m, "side": s, "updated_at": now_utc()}}, upsert=True)
    return await resolve(db, actor, ctx, workspace_id)


async def reset(db: AsyncIOMotorDatabase, actor, ctx, workspace_id: str | None) -> dict:
    """Forget this person's layout: they see the workspace's default again (else Default)."""
    await db[COLL].delete_one({"user_id": actor.user_id, "workspace_id": workspace_id or ""})
    return await resolve(db, actor, ctx, workspace_id)


async def set_workspace_default(db: AsyncIOMotorDatabase, actor, ctx, workspace_id: str, *, main: Any = None, side: Any = None,
                                preset: str | None = None, clear: bool = False) -> dict:
    """Admins: what members who never customized see. ``clear``: back to Default. The caller checks the role."""
    if clear:
        await db["workspaces"].update_one({"_id": ObjectId(workspace_id)}, {"$unset": {"home_default": ""}})
    else:
        m, s = await layout_from(db, actor, ctx, workspace_id, main=main, side=side, preset=preset, keep_tokens=True)
        await db["workspaces"].update_one({"_id": ObjectId(workspace_id)}, {"$set": {"home_default": {
            "main": m, "side": s, "updated_at": now_utc(), "by": actor.user_id}}})
    return await resolve(db, actor, ctx, workspace_id)
