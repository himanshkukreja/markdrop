"""Typed page properties and database views (Senseloaf request 7).

A workspace folder can be a *database*: it carries a property schema and saved
views, and every page filed directly in it (a top-level page: sub-pages are the
pages' own content) is a row whose values live in its own front matter::

    ---
    props: {status: "In build", owner: "<user id>", target_date: "2026-11-20", related: ["prd-x"]}
    ---

One line, a YAML flow mapping whose values are JSON (so YAML, JSON and the
editor all read it the same). A hand-written block mapping (``props:`` then
indented ``key: value`` lines) is read too; a write puts it back on one line.

The schema lives on the folder row (``folders.properties``, ``folders.views``,
``folders.properties_rev``). Changing it never touches a page: a property taken
out of the schema keeps its values in every page (hidden, and back when the
property is added again with the same key); an option taken out of a select
leaves the values that use it as they are (shown as an unknown option).

Who may do what:

- schema and views: workspace members and admins (role ``member``+);
- values: whoever may edit the page (``can(edit_content)``), through the page's
  own save path (edit lock, ``locked`` pages, revision checks);
- reading: a database lists only the pages the caller can read
  (``access.readable_filter`` and ``can(read)`` per row, never a redacted row),
  person names only inside the page's circle (``pages.sees_people``) and a linked
  page's title only when the caller can read that page.
"""

from __future__ import annotations

import json
import math
import re
import secrets
from datetime import date, datetime, timezone
from typing import Any

from bson import ObjectId
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.services import page_props

TYPES = ("select", "multi_select", "person", "date", "text", "link", "number", "checkbox")
TYPE_LABELS = {"select": "Select", "multi_select": "Multi-select", "person": "Person", "date": "Date",
               "text": "Text", "link": "Link", "number": "Number", "checkbox": "Checkbox"}
COLORS = ("default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red")
# New options take the next colour of this cycle (like Notion's).
_CYCLE = ("blue", "green", "orange", "purple", "pink", "yellow", "red", "brown", "gray")
VIEW_TYPES = ("table", "board")
FILTER_OPS = ("is", "is_not", "contains", "not_contains", "before", "after", "on_or_before", "on_or_after",
              "gt", "lt", "gte", "lte", "is_empty", "is_not_empty")

MAX_PROPERTIES = 30
MAX_OPTIONS = 50
MAX_VIEWS = 20
MAX_VIEW_RULES = 10
NAME_MAX = 60
OPTION_MAX = 60
TEXT_MAX = 2000
MAX_MULTI = 20
MAX_LINKS = 20
MAX_ROWS = 500

PROPS_KEY = "props"
KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,39}$")
# Keys a custom property can't take: the page's own properties and what a row
# already has (sorting by title / updated_at / created_at).
RESERVED = frozenset({*page_props.KEYS, PROPS_KEY, "title", "slug", "url", "template", "description",
                      "updated_at", "created_at", "id", "editor", "parent", "owner_id"})
SPECIAL_SORT = ("title", "updated_at", "created_at")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_URL = re.compile(r"^https?://[^\s<>\"']{1,2000}$", re.I)
_SLUG = re.compile(r"^[A-Za-z0-9_-]{3,64}$")
_BARE_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_-]*$")


class PropsError(ValueError):
    """A value or schema that isn't allowed; the message says why."""


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


# ── Front matter: the ``props:`` line ────────────────────────────────────────


def _plain(v: Any) -> Any:
    """A value as JSON can hold it (YAML dates → ISO strings); None for nested maps."""
    if isinstance(v, bool) or v is None or isinstance(v, str):
        return v
    if isinstance(v, (int, float)):
        return v if not (isinstance(v, float) and not math.isfinite(v)) else None
    if isinstance(v, datetime):
        return v.date().isoformat() if not (v.hour or v.minute or v.second) else v.isoformat()
    if isinstance(v, date):
        return v.isoformat()
    if isinstance(v, list):
        out = [_plain(x) for x in v if not isinstance(x, (dict, list))]
        return [x for x in out if x is not None]
    return None


def _props_span(lines: list[str]) -> tuple[int, int] | None:
    """[start, end) of the ``props:`` line and its indented continuation lines."""
    for i, line in enumerate(lines):
        if re.match(r"^props[ \t]*:", line):
            j = i + 1
            while j < len(lines) and re.match(r"^(?:[ \t]+\S|[ \t]*-\s)", lines[j]):
                j += 1
            return i, j
    return None


def read_values(markdown: str | None) -> dict[str, Any]:
    """The page's custom property values (``{}`` when there are none or the line
    can't be read: a hand-edited file never breaks the page)."""
    lines, _body = page_props.split(markdown)
    if not lines:
        return {}
    span = _props_span(lines)
    if span is None:
        return {}
    import yaml

    text = "\n".join(lines[span[0]:span[1]])
    try:
        data = yaml.safe_load(text)
    except Exception:
        return {}
    got = data.get(PROPS_KEY) if isinstance(data, dict) else None
    if not isinstance(got, dict):
        return {}
    out: dict[str, Any] = {}
    for k, v in got.items():
        if not isinstance(k, str) or len(k) > 64:
            continue
        pv = _plain(v)
        if pv is not None and pv != [] and pv != "":
            out[k] = pv
    return out


def _format_key(k: str) -> str:
    return k if _BARE_KEY.match(k) and k.lower() not in ("true", "false", "null", "yes", "no", "on", "off") \
        else json.dumps(k, ensure_ascii=False)


def format_line(values: dict[str, Any]) -> str:
    inner = ", ".join(f"{_format_key(k)}: {json.dumps(v, ensure_ascii=False)}" for k, v in values.items())
    return f"{PROPS_KEY}: {{{inner}}}"


def write_values(markdown: str | None, changes: dict[str, Any]) -> str:
    """The Markdown with ``changes`` applied to its ``props:`` line (None or an
    empty value removes a key; other keys and every other line stay as written).
    The line goes away when nothing is left in it."""
    values = read_values(markdown)
    for k, v in changes.items():
        if v is None or v == "" or v == []:
            values.pop(k, None)
        else:
            values[k] = v
    lines, body = page_props.split(markdown)
    has_front = lines is not None
    lines = list(lines or [])
    span = _props_span(lines)
    new = [format_line(values)] if values else []
    if span is not None:
        lines[span[0]:span[1]] = new
    else:
        lines.extend(new)
    if not any(ln.strip() for ln in lines):
        return body if has_front else (markdown or "")
    return "---\n" + "\n".join(lines) + "\n---\n" + (body if has_front else (markdown or ""))


# ── Schema ───────────────────────────────────────────────────────────────────


def key_from_name(name: str) -> str:
    k = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
    if not k or not k[0].isalpha():
        k = "p_" + k
    return k[:40].rstrip("_") or "p"


def _clean_text(v: Any, what: str, limit: int) -> str:
    if not isinstance(v, str):
        raise PropsError(f"{what} must be text.")
    t = " ".join(v.split())
    if not t:
        raise PropsError(f"{what} can't be empty.")
    if len(t) > limit:
        raise PropsError(f"{what} is longer than {limit} characters.")
    return t


def clean_options(raw: Any, prop_name: str, old: list[dict] | None = None) -> list[dict]:
    if raw is None:
        raw = []
    if not isinstance(raw, list):
        raise PropsError(f"options of {prop_name!r} must be a list.")
    if len(raw) > MAX_OPTIONS:
        raise PropsError(f"{prop_name!r} has more than {MAX_OPTIONS} options.")
    prev = {o["name"].casefold(): o for o in (old or [])}
    out: list[dict] = []
    seen: set[str] = set()
    for i, o in enumerate(raw):
        if isinstance(o, str):
            o = {"name": o}
        if not isinstance(o, dict):
            raise PropsError(f"Each option of {prop_name!r} is a name or {{name, color}}.")
        name = _clean_text(o.get("name"), f"An option of {prop_name!r}", OPTION_MAX)
        if name.casefold() in seen:
            raise PropsError(f"{prop_name!r} has the option {name!r} twice.")
        seen.add(name.casefold())
        color = o.get("color")
        if color is None:
            color = (prev.get(name.casefold()) or {}).get("color") or _CYCLE[len(out) % len(_CYCLE)]
        if color not in COLORS:
            raise PropsError(f"Option colours are {', '.join(COLORS)}.")
        out.append({"name": name, "color": color})
    return out


def clean_schema(items: Any, old: list[dict] | None = None) -> list[dict]:
    """The schema as given, checked: keys kept (or matched by name to the old
    schema, or made from the name), names unique, options for select types."""
    if not isinstance(items, list):
        raise PropsError("properties must be a list of {name, type, options?}.")
    if len(items) > MAX_PROPERTIES:
        raise PropsError(f"A folder has at most {MAX_PROPERTIES} properties.")
    old = old or []
    by_key = {p["key"]: p for p in old}
    by_name = {p["name"].casefold(): p for p in old}
    out: list[dict] = []
    keys: set[str] = set()
    names: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            raise PropsError("Each property is {name, type, options?} (key optional).")
        name = _clean_text(item.get("name"), "A property's name", NAME_MAX)
        if name.casefold() in names:
            raise PropsError(f"Two properties are called {name!r}.")
        if name.casefold() in ("title", "name") and not item.get("key"):
            raise PropsError("Every page already has a title: pick another name.")
        names.add(name.casefold())
        typ = item.get("type")
        if typ not in TYPES:
            raise PropsError(f"{name!r}: type must be one of {', '.join(TYPES)}.")
        key = item.get("key")
        if key is None:
            prev = by_name.get(name.casefold())
            key = prev["key"] if prev and prev["key"] not in keys else key_from_name(name)
            base, n = key, 2
            while key in keys or key in RESERVED:
                key = f"{base[:36]}_{n}"
                n += 1
        if not isinstance(key, str) or not KEY_RE.match(key):
            raise PropsError(f"{name!r}: a key is 1-40 lowercase letters, digits or _, starting with a letter.")
        if key in RESERVED:
            raise PropsError(f"{key!r} is reserved (the page's own properties use it): choose another key.")
        if key in keys:
            raise PropsError(f"Two properties have the key {key!r}.")
        keys.add(key)
        prop: dict[str, Any] = {"key": key, "name": name, "type": typ}
        if typ in ("select", "multi_select"):
            prev = by_key.get(key)
            prop["options"] = clean_options(item.get("options"), name,
                                            prev.get("options") if prev else None)
        out.append(prop)
    return out


def _clean_rule(r: Any, keys: set[str], what: str) -> dict:
    if not isinstance(r, dict):
        raise PropsError(f"Each {what} is an object.")
    key = r.get("key") or r.get("property")
    if key not in keys and key not in SPECIAL_SORT:
        raise PropsError(f"A view's {what} names {key!r}, which isn't a property of this folder.")
    return {"key": key}


def clean_views(items: Any, schema: list[dict]) -> list[dict]:
    if not isinstance(items, list):
        raise PropsError("views must be a list.")
    if len(items) > MAX_VIEWS:
        raise PropsError(f"A folder has at most {MAX_VIEWS} saved views.")
    keys = {p["key"] for p in schema}
    types = {p["key"]: p["type"] for p in schema}
    out = []
    ids: set[str] = set()
    for v in items:
        if not isinstance(v, dict):
            raise PropsError("Each view is {name, type, sort?, filter?, group?}.")
        name = _clean_text(v.get("name"), "A view's name", NAME_MAX)
        typ = v.get("type") or "table"
        if typ not in VIEW_TYPES:
            raise PropsError("A view's type is table or board.")
        vid = v.get("id")
        if not isinstance(vid, str) or not re.match(r"^[A-Za-z0-9_-]{4,24}$", vid) or vid in ids:
            vid = "v" + secrets.token_hex(4)
        ids.add(vid)
        sort = []
        for s in (v.get("sort") or [])[:MAX_VIEW_RULES]:
            rule = _clean_rule(s, keys, "sort")
            rule["dir"] = "desc" if (s.get("dir") or s.get("direction")) in ("desc", "descending") else "asc"
            sort.append(rule)
        filt = []
        for f in (v.get("filter") or [])[:MAX_VIEW_RULES]:
            rule = _clean_rule(f, keys, "filter")
            op = f.get("op") or "is"
            if op not in FILTER_OPS:
                raise PropsError(f"Filter operators are {', '.join(FILTER_OPS)}.")
            rule["op"] = op
            val = f.get("value")
            if val is not None and not isinstance(val, (str, int, float, bool)):
                raise PropsError("A filter's value is text, a number or true/false.")
            if isinstance(val, str) and len(val) > TEXT_MAX:
                raise PropsError("A filter's value is too long.")
            rule["value"] = val
            filt.append(rule)
        group = v.get("group") or v.get("group_by")
        if group is not None and group not in keys:
            raise PropsError(f"A view groups by {group!r}, which isn't a property of this folder.")
        if typ == "board":
            if group is None:
                group = next((p["key"] for p in schema if p["type"] == "select"), None)
            if group is None or types.get(group) != "select":
                raise PropsError("A board groups by a Select property: add one first.")
        hidden = [k for k in (v.get("hidden") or []) if isinstance(k, str) and k in keys][:MAX_PROPERTIES]
        widths: dict[str, int] = {}
        for k, w in (v.get("widths") or {}).items() if isinstance(v.get("widths"), dict) else []:
            if (k in keys or k == "title") and isinstance(w, (int, float)) and not isinstance(w, bool):
                widths[k] = int(min(800, max(60, w)))
        order = [k for k in (v.get("order") or []) if isinstance(k, str) and k in keys][:MAX_PROPERTIES]
        out.append({"id": vid, "name": name, "type": typ, "sort": sort, "filter": filt, "group": group,
                    "hidden": hidden, "widths": widths, "order": order})
    return out


# ── Values ────────────────────────────────────────────────────────────────────


def _option(prop: dict, v: Any) -> str:
    if not isinstance(v, str) or not v.strip():
        raise PropsError(f"{prop['name']}: give an option's name.")
    want = " ".join(v.split())
    for o in prop.get("options") or []:
        if o["name"] == want:
            return o["name"]
    for o in prop.get("options") or []:
        if o["name"].casefold() == want.casefold():
            return o["name"]
    names = ", ".join(o["name"] for o in prop.get("options") or []) or "none yet"
    raise PropsError(f"{prop['name']}: {want!r} isn't one of its options ({names}). Add it to the folder's "
                     "properties first (set_folder_properties).")


def check_value(prop: dict, v: Any, *, members: set[str] | None) -> Any:
    """``v`` for ``prop``, normalised (None: clear it). PropsError with a
    message when it doesn't fit. ``members``: the workspace's member ids (None:
    don't check people). Links to Markdrop pages are checked by the caller."""
    if v is None or v == "" or v == []:
        return None
    t = prop["type"]
    name = prop["name"]
    if t == "select":
        return _option(prop, v)
    if t == "multi_select":
        vals = v if isinstance(v, list) else [v]
        if len(vals) > MAX_MULTI:
            raise PropsError(f"{name}: at most {MAX_MULTI} options.")
        out: list[str] = []
        for x in vals:
            o = _option(prop, x)
            if o not in out:
                out.append(o)
        return out
    if t == "person":
        if not isinstance(v, str) or not re.match(r"^[0-9a-f]{24}$", v.strip()):
            raise PropsError(f"{name}: a person is a user id (see list_workspace_members).")
        v = v.strip()
        if members is not None and v not in members:
            raise PropsError(f"{name}: {v} isn't a member of this page's workspace. Pick someone from "
                             "list_workspace_members.")
        return v
    if t == "date":
        if not isinstance(v, str) or not _DATE.match(v.strip()):
            raise PropsError(f"{name}: a date is written YYYY-MM-DD.")
        try:
            return date.fromisoformat(v.strip()).isoformat()
        except ValueError:
            raise PropsError(f"{name}: {v!r} isn't a real date.")
    if t == "text":
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            v = str(v)
        if not isinstance(v, str):
            raise PropsError(f"{name}: text, please.")
        v = v.strip()
        if len(v) > TEXT_MAX:
            raise PropsError(f"{name}: at most {TEXT_MAX} characters.")
        return v or None
    if t == "number":
        if isinstance(v, str):
            try:
                v = float(v.strip().replace(",", ""))
            except ValueError:
                raise PropsError(f"{name}: a number, please.")
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
            raise PropsError(f"{name}: a number, please.")
        return int(v) if float(v).is_integer() and abs(v) < 2 ** 53 else float(v)
    if t == "checkbox":
        if isinstance(v, str) and v.strip().lower() in ("true", "false", "yes", "no"):
            return v.strip().lower() in ("true", "yes")
        if not isinstance(v, bool):
            raise PropsError(f"{name}: true or false.")
        return v
    if t == "link":
        vals = v if isinstance(v, list) else [v]
        if len(vals) > MAX_LINKS:
            raise PropsError(f"{name}: at most {MAX_LINKS} links.")
        out = []
        for x in vals:
            if not isinstance(x, str) or not x.strip():
                raise PropsError(f"{name}: a link is an https:// address or a Markdrop page's slug.")
            x = x.strip()
            if not (_URL.match(x) or _SLUG.match(x)):
                raise PropsError(f"{name}: {x[:80]!r} isn't an http(s) address or a Markdrop page's slug.")
            if x not in out:
                out.append(x)
        return out[0] if len(out) == 1 else out
    raise PropsError(f"{name}: unknown type.")


def link_slugs(values: Any) -> list[str]:
    vals = values if isinstance(values, list) else [values]
    return [x for x in vals if isinstance(x, str) and _SLUG.match(x)]


def find_prop(schema: list[dict], ref: str) -> dict | None:
    """A property by key, or by name (any case)."""
    for p in schema:
        if p["key"] == ref:
            return p
    for p in schema:
        if p["name"].casefold() == str(ref).strip().casefold():
            return p
    return None


# ── Folders ───────────────────────────────────────────────────────────────────


def view_of(folder: dict | None) -> dict:
    f = folder or {}
    return {"properties": list(f.get("properties") or []), "views": list(f.get("views") or []),
            "rev": int(f.get("properties_rev") or 0)}


async def folder_row(db: AsyncIOMotorDatabase, workspace_id: str | None, folder_id: str | None) -> dict | None:
    if not workspace_id or not folder_id or not ObjectId.is_valid(str(folder_id)):
        return None
    return await db["folders"].find_one({"_id": ObjectId(str(folder_id)), "workspace_id": workspace_id})


async def schema_for_page(db: AsyncIOMotorDatabase, raw: dict) -> tuple[dict | None, str | None]:
    """(the folder whose schema applies to this page, why: "row" | "template").

    A top-level page filed in a folder with properties is a row of it. A
    template page holds the defaults of the folder that uses it as its default
    template (or of its own folder, when that has properties)."""
    if raw.get("kind") == "artifact" or raw.get("encrypted") or raw.get("parent_id") is not None:
        return None, None
    ws = raw.get("workspace_id")
    own = await folder_row(db, ws, raw.get("folder_id"))
    if own is not None and own.get("properties"):
        return own, ("template" if raw.get("template") else "row")
    if raw.get("template") and ws:
        f = await db["folders"].find_one({"workspace_id": ws, "default_template": str(raw["_id"]),
                                          "properties.0": {"$exists": True}})
        if f is not None:
            return f, "template"
    if own is not None and not raw.get("template"):
        return own, "row"
    return None, None


async def member_ids(db: AsyncIOMotorDatabase, workspace_id: str | None) -> set[str]:
    if not workspace_id:
        return set()
    rows = await db["memberships"].find({"workspace_id": workspace_id}, {"user_id": 1}).to_list(length=5000)
    return {r["user_id"] for r in rows if r.get("user_id")}


async def _role(db: AsyncIOMotorDatabase, workspace_id: str, user_id: str | None) -> str | None:
    from app.services import workspace as ws_service

    return await ws_service.role_for(db, workspace_id, user_id) if user_id else None


async def can_edit_schema(db: AsyncIOMotorDatabase, workspace_id: str | None, user_id: str | None) -> bool:
    from app.models.workspace import role_allows

    if not workspace_id or not user_id:
        return False
    return role_allows(await _role(db, workspace_id, user_id), "member")


async def set_schema(db: AsyncIOMotorDatabase, workspace_id: str, folder_id: str, user_id: str | None,
                     properties: Any, *, views: Any = None, base_rev: int | None = None) -> dict:
    """Members+: replace the folder's properties (and views, when given)."""
    if not await can_edit_schema(db, workspace_id, user_id):
        if await _role(db, workspace_id, user_id) is None:
            raise HTTPException(status_code=404, detail="Folder not found")
        raise HTTPException(status_code=403, detail="Only the workspace's members and admins can change a "
                                                    "folder's properties.")
    f = await folder_row(db, workspace_id, folder_id)
    if f is None:
        raise HTTPException(status_code=404, detail="Folder not found")
    cur = view_of(f)
    if base_rev is not None and base_rev != cur["rev"]:
        raise HTTPException(status_code=409, detail="Someone changed this folder's properties meanwhile. "
                                                    "Reload and try again.")
    sets: dict[str, Any] = {}
    try:
        schema = clean_schema(properties, cur["properties"]) if properties is not None else cur["properties"]
        sets["properties"] = schema
        if views is not None:
            sets["views"] = clean_views(views, schema)
        else:
            # Views that name a property no longer in the schema drop those rules (the view stays).
            sets["views"] = _prune_views(cur["views"], schema)
    except PropsError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    sets["properties_updated_at"] = now_utc()
    q: dict[str, Any] = {"_id": f["_id"]}
    q["properties_rev"] = cur["rev"] if f.get("properties_rev") is not None else {"$in": [None, 0]}
    res = await db["folders"].find_one_and_update(q, {"$set": sets, "$inc": {"properties_rev": 1}},
                                                  return_document=True)
    if res is None:
        raise HTTPException(status_code=409, detail="Someone changed this folder's properties meanwhile. "
                                                    "Reload and try again.")
    return {"folder_id": str(f["_id"]), **view_of(res)}


def _prune_views(views: list[dict], schema: list[dict]) -> list[dict]:
    keys = {p["key"] for p in schema} | set(SPECIAL_SORT)
    selects = {p["key"] for p in schema if p["type"] == "select"}
    out = []
    for v in views:
        v = dict(v)
        v["sort"] = [r for r in v.get("sort") or [] if r.get("key") in keys]
        v["filter"] = [r for r in v.get("filter") or [] if r.get("key") in keys]
        if v.get("group") not in keys:
            v["group"] = None
        if v.get("type") == "board" and v.get("group") not in selects:
            v["group"] = next(iter(p["key"] for p in schema if p["type"] == "select"), None)
            if v["group"] is None:
                v["type"] = "table"
        v["hidden"] = [k for k in v.get("hidden") or [] if k in keys]
        out.append(v)
    return out


async def set_views(db: AsyncIOMotorDatabase, workspace_id: str, folder_id: str, user_id: str | None,
                    views: Any, *, base_rev: int | None = None) -> dict:
    return await set_schema(db, workspace_id, folder_id, user_id, None, views=views, base_rev=base_rev)


# ── Checking values on a write ───────────────────────────────────────────────


async def check_values(db: AsyncIOMotorDatabase, raw: dict, changes: dict[str, Any], actor, ctx,
                       *, schema: list[dict] | None = None) -> dict[str, Any]:
    """``changes`` ({key or name: value or None}) checked against the page's
    schema: {key: normalised value or None}. PropsError when one doesn't fit."""
    if schema is None:
        folder, _why = await schema_for_page(db, raw)
        schema = (folder or {}).get("properties") or []
    if not schema:
        raise PropsError("This page isn't in a folder with properties. Give its folder some with "
                         "set_folder_properties (pages directly in that folder get them).")
    members: set[str] | None = None
    out: dict[str, Any] = {}
    for ref, v in changes.items():
        prop = find_prop(schema, ref)
        if prop is None:
            known = ", ".join(f"{p['name']} ({p['key']})" for p in schema)
            raise PropsError(f"No property {ref!r} in this folder. Its properties: {known}.")
        if prop["type"] == "person" and members is None:
            members = await member_ids(db, raw.get("workspace_id"))
        val = check_value(prop, v, members=members if prop["type"] == "person" else None)
        if prop["type"] == "link" and val is not None:
            await _check_links(db, link_slugs(val), actor, ctx, prop["name"])
        out[prop["key"]] = val
    return out


async def _check_links(db: AsyncIOMotorDatabase, slugs: list[str], actor, ctx, name: str) -> None:
    from app.services import access
    from app.services import document as doc_service

    for s in slugs:
        found, _moved = await doc_service.find_for_read(db, s)
        if found is None or not (await access.can(actor, found, "read", ctx)).allowed:
            raise PropsError(f"{name}: couldn't find a page at {s!r} that you can open.")


async def check_save(db: AsyncIOMotorDatabase, raw: dict, new_content: str | None, actor, ctx) -> None:
    """On every save (services/document.update_document): values that changed,
    of properties in the page's schema, must fit (422 otherwise). Values that
    didn't change are never checked, so a schema change or a person who left
    the workspace never blocks someone's edit; a template is never checked."""
    if raw.get("kind") == "artifact" or raw.get("encrypted") or raw.get("template") or new_content is None:
        return
    new = read_values(new_content) if "props" in new_content else {}
    old = read_values(raw.get("content")) if "props" in (raw.get("content") or "") else {}
    if new == old:
        return
    changed = {k: v for k, v in new.items() if old.get(k) != v}
    if not changed:
        return
    folder, why = await schema_for_page(db, raw)
    schema = (folder or {}).get("properties") or []
    if why != "row" or not schema:
        return
    keys = {p["key"] for p in schema}
    changed = {k: v for k, v in changed.items() if k in keys}
    if not changed:
        return
    try:
        await check_values(db, raw, changed, actor, ctx, schema=schema)
    except PropsError as exc:
        raise HTTPException(status_code=422, detail=f"Page property: {exc}")


async def set_values(db: AsyncIOMotorDatabase, raw: dict, changes: dict[str, Any], actor, ctx, *,
                     base_rev: int | None = None, extra=None) -> dict:
    """Write ``changes`` into the page through its own save path (edit lock,
    locked pages, revision). ``extra(content) -> content``: other front-matter
    changes made in the same save. Returns the saved row."""
    from pydantic import ValidationError

    from app.schemas.document import DocumentUpdate
    from app.services import document as doc_service

    clean = await check_values(db, raw, changes, actor, ctx) if changes else {}
    content = write_values(raw.get("content") or "", clean) if clean else (raw.get("content") or "")
    if extra is not None:
        content = extra(content)
    try:
        data = DocumentUpdate(title=raw.get("title"), content=content or "\n",
                              base_rev=base_rev if base_rev is not None else int(raw.get("rev") or 1))
    except ValidationError:
        raise PropsError("That content isn't valid.")
    return await doc_service.update_document(db, raw["slug"], data, actor, ctx)


# ── Reading: a page's panel, a folder's rows ─────────────────────────────────


async def people_for(db: AsyncIOMotorDatabase, ids: set[str]) -> dict[str, dict]:
    from app.services import viewers

    oids = [ObjectId(i) for i in ids if ObjectId.is_valid(i)]
    if not oids:
        return {}
    out = {}
    for u in await db["users"].find({"_id": {"$in": oids}}, {"name": 1, "email": 1, "picture": 1}).to_list(
            length=len(oids)):
        pic = u.get("picture")
        out[str(u["_id"])] = {
            "name": viewers.display_name(type("U", (), {"name": u.get("name"), "email": u.get("email")})),
            "avatar_url": pic if isinstance(pic, str) and pic.startswith("https://") else None,
        }
    return out


async def links_for(db: AsyncIOMotorDatabase, slugs: set[str], actor, ctx, *, limit: int = 300) -> dict[str, dict]:
    """``{slug: {state, title?, url?, icon?}}``: a title only when the caller can
    read the page ("ok"); otherwise "locked" (it exists but isn't theirs to
    open, or needs a sign-in or password) or "missing" — the same answers an
    embed gets, never a title."""
    from app.services import access, pages, urls
    from app.services import document as doc_service

    out: dict[str, dict] = {}
    for s in list(slugs)[:limit]:
        raw, _moved = await doc_service.find_for_read(db, s)
        d = await access.can(actor, raw, "read", ctx)
        if not d.allowed:
            out[s] = {"state": "missing" if d.status == 404 and d.code not in ("signin", "password") else "locked"}
            continue
        if raw.get("encrypted"):
            out[s] = {"state": "locked"}
            continue
        title = raw.get("title") or (raw.get("original_filename") if raw.get("kind") == "artifact" else None)
        out[s] = {"state": "ok", "title": title or raw["slug"], "slug": raw["slug"],
                  "url": await urls.workspace_url(db, raw) or urls.markdrop_url(raw["slug"]),
                  "kind": raw.get("kind") or "markdown", **await pages.icon_fields(db, raw)}
    return out


def _people_in(schema: list[dict], values: dict) -> set[str]:
    return {values[p["key"]] for p in schema if p["type"] == "person" and isinstance(values.get(p["key"]), str)}


def _links_in(schema: list[dict], values: dict) -> set[str]:
    out: set[str] = set()
    for p in schema:
        if p["type"] == "link" and p["key"] in values:
            out.update(link_slugs(values[p["key"]]))
    return out


async def panel(db: AsyncIOMotorDatabase, raw: dict, actor, ctx) -> dict | None:
    """What a page's properties panel shows this reader (None: no panel).
    The reader is already past ``can(read)``."""
    from app.services import access, pages

    folder, why = await schema_for_page(db, raw)
    values = read_values(raw.get("content")) if not raw.get("encrypted") else {}
    if folder is None:
        return None
    schema = list(folder.get("properties") or [])
    f = await access.facts(actor, raw, ctx)
    may_schema = bool(actor.user_id) and f.ws_role is not None and await can_edit_schema(
        db, raw.get("workspace_id"), actor.user_id)
    if not schema and not may_schema:
        return None
    sees = await pages.sees_people(actor, raw, ctx)
    people = await people_for(db, _people_in(schema, values)) if sees else {}
    links = await links_for(db, _links_in(schema, values), actor, ctx)
    return {
        "folder": {"id": str(folder["_id"]), "name": folder.get("name")} if f.ws_role is not None else None,
        "mode": why,
        "properties": schema,
        "rev": int(folder.get("properties_rev") or 0),
        "values": {k: v for k, v in values.items()},
        "people": people,
        "people_hidden": not sees,
        "links": links,
        "can_edit_schema": may_schema,
    }


def _rows_query(folder_id: str) -> list[dict]:
    return [{"folder_id": folder_id}, {"parent_id": None}, {"kind": {"$ne": "artifact"}},
            {"encrypted": {"$ne": True}}]


async def rows(db: AsyncIOMotorDatabase, actor, ctx, workspace_id: str, folder_id: str, *,
               limit: int = MAX_ROWS) -> tuple[list[dict], bool]:
    """The folder's pages this caller can read (newest first), with their values:
    ([row], truncated)."""
    from app.services import access, pages, urls

    rf = await access.readable_filter(actor, workspace_id, ctx)
    cursor = db["documents"].find(rf.query(*_rows_query(folder_id))).sort([("updated_at", -1), ("_id", -1)])
    got = await cursor.limit(limit + 1).to_list(length=limit + 1)
    truncated = len(got) > limit
    out = []
    hosts = urls.HostCache(db)
    for raw in got[:limit]:
        if not (await access.can(actor, raw, "read", ctx)).allowed:
            continue
        values = read_values(raw.get("content"))
        edit = (await access.can(actor, raw, "edit_content", ctx)).allowed
        if edit and page_props.is_locked(raw.get("content")):
            # A locked page: its owner and the workspace's admins only (pages.check_page_lock).
            edit = await pages.may_edit_locked(actor, raw, ctx)
        out.append({
            "slug": raw["slug"],
            "title": raw.get("title") or raw["slug"],
            "url": await urls.workspace_url(db, raw, hosts) or urls.markdrop_url(raw["slug"]),
            "markdrop_url": urls.markdrop_url(raw["slug"]),
            "editor": raw.get("editor"),
            "updated_at": _iso(raw.get("updated_at")),
            "created_at": _iso(raw.get("created_at")),
            "rev": int(raw.get("rev") or 1),
            "values": values,
            "can_edit": edit,
            **await pages.icon_fields(db, raw),
        })
    return out, truncated


def _iso(v: Any) -> str | None:
    if isinstance(v, datetime):
        return (v if v.tzinfo else v.replace(tzinfo=timezone.utc)).isoformat()
    return v if isinstance(v, str) else None


async def database(db: AsyncIOMotorDatabase, actor, ctx, workspace_id: str, folder_id: str, *,
                   with_rows: bool = True) -> dict:
    """A folder as a database, for a workspace member (viewer+): its schema,
    saved views and readable rows, with the people and links they name
    (``with_rows=False``: the schema and views alone)."""
    f = await folder_row(db, workspace_id, folder_id)
    if f is None:
        raise HTTPException(status_code=404, detail="Folder not found")
    rows_, truncated = await rows(db, actor, ctx, workspace_id, folder_id) if with_rows else ([], False)
    schema = list(f.get("properties") or [])
    ids: set[str] = set()
    slugs: set[str] = set()
    for r in rows_:
        ids |= _people_in(schema, r["values"])
        slugs |= _links_in(schema, r["values"])
    role = await _role(db, workspace_id, actor.user_id)
    return {
        "folder": {"id": str(f["_id"]), "name": f.get("name")},
        **view_of(f),
        "rows": rows_,
        "truncated": truncated,
        "people": await people_for(db, ids) if role is not None else {},
        "links": await links_for(db, slugs, actor, ctx),
        "can_edit_schema": await can_edit_schema(db, workspace_id, actor.user_id),
        "role": role,
    }


def display_text(p: dict, v: Any, people: dict, links: dict) -> str:
    """A value as text for this reader: a person's name (or "a person"
    outside the page's circle), a linked page's title only when they can open
    it ("a page you can't open" otherwise)."""
    if v is None or v == [] or v == "":
        return ""
    if p["type"] == "person":
        return (people.get(v) or {}).get("name") or "a person"
    if p["type"] == "checkbox":
        return "yes" if v is True else "no"
    if p["type"] == "link":
        vals = v if isinstance(v, list) else [v]
        return ", ".join((links.get(x) or {}).get("title") or x if (links.get(x) or {}).get("state") == "ok"
                         else (x if str(x).startswith("http") else "a page you can't open") for x in vals)
    if isinstance(v, list):
        return ", ".join(str(x) for x in v)
    return str(v)


async def folder_index_props(db: AsyncIOMotorDatabase, actor, ctx, workspace_id: str, folder_id: str | None,
                             documents: list[dict], *, insider: bool) -> list[dict] | None:
    """For a workspace domain's folder index (routers/folder_pages.py): the
    folder's properties, with each listed page's values as text added to its
    row (``props: [{name, type, text, color?}]``, at most 6, empty ones left
    out). People are named only to members; linked pages' titles only when
    this reader can open them. None when the folder has no properties."""
    folder = await folder_row(db, workspace_id, folder_id)
    schema = list((folder or {}).get("properties") or [])
    if not schema or not documents:
        return None
    slugs = [d["slug"] for d in documents if d.get("kind") in (None, "markdown")]
    raws = {r["slug"]: r for r in await db["documents"].find(
        {"slug": {"$in": slugs}, "parent_id": None, "encrypted": {"$ne": True}},
        {"slug": 1, "content": 1}).to_list(length=len(slugs) or 1)}
    values = {s: read_values(r.get("content")) for s, r in raws.items()}
    ids: set[str] = set()
    refs: set[str] = set()
    for v in values.values():
        ids |= _people_in(schema, v)
        refs |= _links_in(schema, v)
    people = await people_for(db, ids) if insider else {}
    links = await links_for(db, refs, actor, ctx)
    for d in documents:
        v = values.get(d["slug"])
        if not v:
            continue
        out = []
        for p in schema:
            text = display_text(p, v.get(p["key"]), people, links)
            if not text or (p["type"] == "checkbox" and text == "no"):
                continue
            item = {"name": p["name"], "type": p["type"], "text": text[:200]}
            if p["type"] == "select":
                item["color"] = next((o["color"] for o in p.get("options") or [] if o["name"] == v.get(p["key"])),
                                     "default")
            out.append(item)
            if len(out) >= 6:
                break
        d["props"] = out
    return [{"key": p["key"], "name": p["name"], "type": p["type"]} for p in schema]


# ── Filtering and sorting (MCP list_folder_pages; the app does the same client side) ──


def _cmp_value(prop: dict | None, v: Any, people: dict[str, dict]) -> Any:
    if v is None:
        return None
    t = prop["type"] if prop else "text"
    if t == "select" and prop:
        names = [o["name"] for o in prop.get("options") or []]
        return names.index(v) if v in names else len(names)
    if t == "person":
        return ((people.get(v) or {}).get("name") or v).casefold()
    if t == "number":
        return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None
    if t == "checkbox":
        return 1 if v is True else 0
    if isinstance(v, list):
        return ", ".join(str(x) for x in v).casefold()
    return str(v).casefold()


def row_value(row: dict, key: str) -> Any:
    if key in SPECIAL_SORT:
        return row.get(key)
    return row["values"].get(key)


def matches(row: dict, rule: dict, schema: list[dict]) -> bool:
    prop = find_prop(schema, rule["key"]) if rule["key"] not in SPECIAL_SORT else None
    t = prop["type"] if prop else "text"
    v = row_value(row, prop["key"] if prop else rule["key"])
    op = rule.get("op") or "is"
    want = rule.get("value")
    empty = v is None or v == "" or v == [] or (t == "checkbox" and v is not True)
    if op == "is_empty":
        return empty
    if op == "is_not_empty":
        return not empty
    if t != "checkbox" and (want is None or want == ""):
        return True  # a rule without a value (still being written) filters nothing out
    if t == "checkbox":
        on = v is True
        w = want if isinstance(want, bool) else str(want).lower() in ("true", "yes", "1")
        return (on == w) if op != "is_not" else (on != w)
    vals = v if isinstance(v, list) else ([] if v is None else [v])
    if t == "number" and op in ("gt", "lt", "gte", "lte", "is", "is_not"):
        try:
            w = float(want)
        except (TypeError, ValueError):
            return False
        if not isinstance(v, (int, float)) or isinstance(v, bool):
            return op == "is_not"
        return {"gt": v > w, "lt": v < w, "gte": v >= w, "lte": v <= w, "is": v == w, "is_not": v != w}[op]
    if t == "date" and op in ("before", "after", "on_or_before", "on_or_after"):
        if not isinstance(v, str) or not isinstance(want, str):
            return False
        return {"before": v < want, "after": v > want, "on_or_before": v <= want, "on_or_after": v >= want}[op]
    w = "" if want is None else str(want).casefold()
    hay = [str(x).casefold() for x in vals]
    if op == "is":
        return w in hay if t in ("multi_select", "link") else (bool(hay) and hay[0] == w)
    if op == "is_not":
        return w not in hay
    if op == "contains":
        return any(w in h for h in hay)
    if op == "not_contains":
        return not any(w in h for h in hay)
    return False


def sort_rows(rows_: list[dict], sort: list[dict], schema: list[dict], people: dict[str, dict]) -> list[dict]:
    out = list(rows_)
    for rule in reversed(sort):
        key = rule["key"]
        prop = find_prop(schema, key) if key not in SPECIAL_SORT else None
        k = prop["key"] if prop else key
        desc = rule.get("dir") == "desc"
        present = [r for r in out if _cmp_value(prop, row_value(r, k), people) is not None]
        missing = [r for r in out if _cmp_value(prop, row_value(r, k), people) is None]
        present.sort(key=lambda r: _cmp_value(prop, row_value(r, k), people), reverse=desc)
        out = present + missing  # empty values last, either way
    return out
