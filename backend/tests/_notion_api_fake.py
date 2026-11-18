"""A fake Notion API (OAuth + the read endpoints Connect Notion uses), in process: an httpx.MockTransport for
app.services.notion_import.api.TRANSPORT. Nothing leaves the machine.

* ``POST /v1/oauth/token``: HTTP Basic (client id:secret) checked; authorization codes → tokens (one Notion
  workspace each), refresh tokens; ``POST /v1/oauth/revoke``.
* ``POST /v1/search`` (pages and data sources, newest edit first, paginated), ``GET /v1/pages/{id}``,
  ``GET /v1/blocks/{id}`` and ``/children`` (paginated), ``GET /v1/databases/{id}``,
  ``GET /v1/data_sources/{id}``, ``POST /v1/data_sources/{id}/query``.
* Files Notion hosts: ``https://files.notion.test/<key>/<name>?sig=<n>`` — a signature is good until
  :meth:`expire_files` (or always already expired in listings with ``expire_in_listings``); reading the
  block (or page) again signs a fresh one, like Notion.
* ``throttle = n``: the next n API calls answer 429 with Retry-After ``retry_after``.
* ``deny_access``: tokens that now answer 401 (refresh works unless ``deny_refresh``).
"""

from __future__ import annotations

import base64
import hashlib
import json
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlsplit

import httpx

API = "https://api.notion.test"
FILES = "https://files.notion.test"
CLIENT_ID = "notion-client-1"
CLIENT_SECRET = "notion-secret-xyz"
WS = "ws-acme-1111"


def nid(name: str) -> str:
    return hashlib.md5(name.encode()).hexdigest()


def dashed(h: str) -> str:
    h = h.replace("-", "")
    return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}"


def ts(minutes_ago: float) -> str:
    t = datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)
    return t.replace(second=0, microsecond=0).strftime("%Y-%m-%dT%H:%M:00.000Z")


def rt(text: str, **ann) -> dict:
    a = {"bold": False, "italic": False, "strikethrough": False, "underline": False, "code": False, "color": "default"}
    a.update(ann)
    return {"type": "text", "text": {"content": text, "link": None}, "annotations": a, "plain_text": text, "href": None}


def link(text: str, href: str) -> dict:
    r = rt(text)
    r["text"]["link"] = {"url": href}
    r["href"] = href
    return r


def mention_page(title: str, page: str) -> dict:
    return {"type": "mention", "mention": {"type": "page", "page": {"id": dashed(page)}}, "plain_text": title,
            "href": f"https://www.notion.so/{page}", "annotations": rt("")["annotations"]}


PNG = (b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
       b"\x00\x00\x00\rIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82")


class FakeNotion:
    def __init__(self):
        self.codes: dict[str, dict] = {}
        self.access: dict[str, str] = {}       # token → workspace
        self.refresh: dict[str, str] = {}
        self.revoked: list[str] = []
        self.deny_access: set[str] = set()
        self.deny_refresh = False
        self.pages: dict[str, dict] = {}       # hex → {title, parent, icon, cover, last_edited, props?, in_trash}
        self.blocks: dict[str, list[dict]] = {}  # parent hex → [block]
        self.block_by_id: dict[str, dict] = {}
        self.databases: dict[str, dict] = {}   # hex → {title, parent, ds}
        self.sources: dict[str, dict] = {}     # ds hex → {db, properties, rows: [page hex]}
        self.files: dict[str, bytes] = {}      # key → bytes
        self.sig = 1
        self.expire_in_listings = False
        self.throttle = 0
        self.retry_after = "1"
        self.calls: list[tuple[str, str]] = []
        self.n = 0

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)

    # ── building the workspace ──

    def grant(self, code: str = "code-1", workspace: str = WS, name: str = "Acme Notion") -> str:
        self.codes[code] = {"workspace_id": workspace, "workspace_name": name}
        return code

    def page(self, key: str, title: str, *, parent: str | None = None, minutes_ago: float = 60, icon: str | None = None,
             cover_file: str | None = None, blocks: list[dict] | None = None, db: str | None = None,
             props: dict | None = None) -> str:
        h = nid(key)
        p = {"title": title, "parent": parent, "db": db, "icon": icon, "cover_file": cover_file,
             "last_edited": ts(minutes_ago), "props": props or {}, "in_trash": False}
        self.pages[h] = p
        self.blocks[h] = []
        for b in blocks or []:
            self.add_block(h, b)
        if parent and not db:
            self.add_block(parent, {"type": "child_page", "child_page": {"title": title}, "id": h})
        return h

    def add_block(self, parent: str, b: dict) -> dict:
        b = dict(b)
        self.n += 1
        b.setdefault("id", nid(f"block-{self.n}"))
        b.setdefault("object", "block")
        kids = b.pop("children", None)
        b["has_children"] = bool(kids) or b.get("type") in ("child_page", "child_database")
        if b["type"] in ("child_page", "child_database"):
            b["has_children"] = True
        self.blocks.setdefault(parent, []).append(b)
        self.block_by_id[b["id"]] = b
        if kids:
            self.blocks[b["id"]] = []
            for k in kids:
                self.add_block(b["id"], k)
        return b

    def database(self, key: str, title: str, *, parent: str, properties: dict, minutes_ago: float = 60) -> str:
        h = nid(key)
        ds = nid(key + "-ds")
        self.databases[h] = {"title": title, "parent": parent, "ds": ds, "last_edited": ts(minutes_ago)}
        self.sources[ds] = {"db": h, "properties": properties, "rows": []}
        self.add_block(parent, {"type": "child_database", "child_database": {"title": title}, "id": h})
        return h

    def row(self, db: str, key: str, title: str, props: dict, *, minutes_ago: float = 60,
            blocks: list[dict] | None = None) -> str:
        ds = self.databases[db]["ds"]
        h = self.page(key, title, db=db, minutes_ago=minutes_ago, blocks=blocks, props=props)
        self.sources[ds]["rows"].append(h)
        return h

    def file(self, key: str, data: bytes = PNG) -> dict:
        self.files[key] = data
        return {"type": "file", "file": {"url": self._url(key), "expiry_time": ts(-60)}}

    def _url(self, key: str) -> str:
        sig = self.sig - 1 if self.expire_in_listings else self.sig
        return f"{FILES}/{key}?sig={sig}"

    def expire_files(self) -> None:
        self.sig += 1

    def edit(self, h: str, *, blocks: list[dict] | None = None, title: str | None = None, props: dict | None = None,
             minutes_ago: float = 3) -> None:
        p = self.pages[h]
        p["last_edited"] = ts(minutes_ago)
        if title:
            p["title"] = title
        if props:
            p["props"].update(props)
        if blocks is not None:
            keep = [b for b in self.blocks[h] if b["type"] in ("child_page", "child_database")]
            self.blocks[h] = []
            for b in blocks:
                self.add_block(h, b)
            self.blocks[h].extend(keep)

    # ── shapes ──

    def _fresh_file(self, f: dict | None) -> dict | None:
        if not f or f.get("type") != "file":
            return f
        key = urlsplit(f["file"]["url"]).path.lstrip("/")
        return {**f, "file": {"url": self._url(key), "expiry_time": f["file"]["expiry_time"]}}

    def _block(self, b: dict, fresh: bool = False) -> dict:
        out = json.loads(json.dumps(b))
        out["id"] = dashed(b["id"])
        t = out["type"]
        if t in ("image", "file", "pdf", "video", "audio") and out[t].get("type") == "file":
            key = urlsplit(out[t]["file"]["url"]).path.lstrip("/")
            sig = self.sig if fresh else (self.sig - 1 if self.expire_in_listings else self.sig)
            out[t] = {**out[t], "file": {"url": f"{FILES}/{key}?sig={sig}", "expiry_time": ts(-60)}}
        return out

    def _title_prop(self, h: str) -> dict:
        p = self.pages[h]
        name = "Name"
        if p["db"]:
            props = self.sources[self.databases[p["db"]]["ds"]]["properties"]
            name = next(k for k, v in props.items() if v["type"] == "title")
        return {name: {"id": "title", "type": "title", "title": [rt(p["title"])]}}

    def _page(self, h: str) -> dict:
        p = self.pages[h]
        if p["db"]:
            parent = {"type": "data_source_id", "data_source_id": dashed(self.databases[p["db"]]["ds"]),
                      "database_id": dashed(p["db"])}
        elif p["parent"]:
            parent = {"type": "page_id", "page_id": dashed(p["parent"])}
        else:
            parent = {"type": "workspace", "workspace": True}
        cover = None
        if p["cover_file"]:
            cover = {"type": "file", "file": {"url": self._url(p["cover_file"]), "expiry_time": ts(-60)}}
        return {"object": "page", "id": dashed(h), "created_time": ts(600), "last_edited_time": p["last_edited"],
                "in_trash": p["in_trash"], "parent": parent, "url": f"https://www.notion.so/{h}",
                "icon": {"type": "emoji", "emoji": p["icon"]} if p["icon"] else None, "cover": cover,
                "properties": {**self._title_prop(h), **p["props"]}}

    def _ds(self, ds: str) -> dict:
        s = self.sources[ds]
        d = self.databases[s["db"]]
        return {"object": "data_source", "id": dashed(ds), "title": [rt(d["title"])],
                "parent": {"type": "database_id", "database_id": dashed(s["db"])},
                "database_parent": {"type": "page_id", "page_id": dashed(d["parent"])},
                "properties": s["properties"], "last_edited_time": d["last_edited"], "url": f"https://www.notion.so/{s['db']}"}

    @staticmethod
    def _paged(items: list, start: str | None, size: int) -> dict:
        i = int(start or 0)
        chunk = items[i:i + size]
        more = i + size < len(items)
        return {"object": "list", "results": chunk, "has_more": more, "next_cursor": str(i + size) if more else None}

    # ── HTTP ──

    def of(self, method: str, prefix: str) -> list[str]:
        return [p for m, p in self.calls if m == method and p.startswith(prefix)]

    def _basic_ok(self, request: httpx.Request) -> bool:
        want = "Basic " + base64.b64encode(f"{CLIENT_ID}:{CLIENT_SECRET}".encode()).decode()
        return request.headers.get("authorization") == want

    def _issue(self, ws: str) -> dict:
        self.n += 1
        at, rft = f"secret_at_{self.n}", f"secret_rt_{self.n}"
        self.access[at] = ws
        self.refresh[rft] = ws
        return {"access_token": at, "refresh_token": rft, "token_type": "bearer", "bot_id": f"bot-{self.n}",
                "workspace_id": ws, "workspace_name": "Acme Notion", "workspace_icon": None,
                "owner": {"type": "user", "user": {"object": "user", "id": "u-1", "name": "Ada Notion",
                                                   "person": {"email": "ada@notion.test"}}},
                "duplicated_template_id": None}

    async def handler(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        path = request.url.path
        body = json.loads(request.content) if request.content else {}
        if url.startswith(FILES):
            key = path.lstrip("/")
            sig = int((parse_qs(urlsplit(url).query).get("sig") or ["0"])[0])
            self.calls.append(("FILE", path))
            if sig != self.sig or key not in self.files:
                return httpx.Response(403, text="<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>")
            return httpx.Response(200, content=self.files[key])
        self.calls.append((request.method, path))
        if request.headers.get("notion-version") != "2026-03-11":
            return httpx.Response(400, json={"code": "missing_version", "message": "Notion-Version"})
        if path == "/v1/oauth/token":
            if not self._basic_ok(request):
                return httpx.Response(401, json={"error": "invalid_client"})
            if body.get("grant_type") == "authorization_code":
                g = self.codes.pop(body.get("code"), None)
                if g is None or body.get("redirect_uri") != "https://markdrop.in/integrations/notion/callback":
                    return httpx.Response(400, json={"error": "invalid_grant"})
                return httpx.Response(200, json=self._issue(g["workspace_id"]))
            if body.get("grant_type") == "refresh_token":
                ws = self.refresh.pop(body.get("refresh_token"), None)
                if ws is None or self.deny_refresh:
                    return httpx.Response(400, json={"error": "invalid_grant"})
                return httpx.Response(200, json=self._issue(ws))
            return httpx.Response(400, json={"error": "unsupported_grant_type"})
        if path == "/v1/oauth/revoke":
            if not self._basic_ok(request):
                return httpx.Response(401, json={"error": "invalid_client"})
            self.revoked.append(body.get("token"))
            self.access.pop(body.get("token"), None)
            return httpx.Response(200, json={"request_id": "r1"})
        tok = request.headers.get("authorization", "").removeprefix("Bearer ")
        if tok not in self.access or tok in self.deny_access:
            return httpx.Response(401, json={"object": "error", "status": 401, "code": "unauthorized",
                                             "message": "API token is invalid."})
        if self.throttle > 0:
            self.throttle -= 1
            return httpx.Response(429, json={"object": "error", "status": 429, "code": "rate_limited",
                                             "message": "Rate limited"}, headers={"Retry-After": self.retry_after})
        q = request.url.params
        if path == "/v1/search":
            items = [self._page(h) for h, p in self.pages.items() if not p["in_trash"]]
            items += [self._ds(ds) for ds in self.sources]
            items.sort(key=lambda o: o["last_edited_time"], reverse=True)
            return httpx.Response(200, json=self._paged(items, body.get("start_cursor"), int(body.get("page_size") or 100)))
        parts = path.strip("/").split("/")
        if len(parts) >= 3:
            h = parts[2].replace("-", "")
            if parts[1] == "pages" and len(parts) == 3:
                if h not in self.pages:
                    return httpx.Response(404, json={"code": "object_not_found", "message": "Not found"})
                return httpx.Response(200, json=self._page(h))
            if parts[1] == "blocks" and len(parts) == 3:
                b = self.block_by_id.get(h)
                return httpx.Response(200, json=self._block(b, fresh=True)) if b else httpx.Response(404, json={"code": "object_not_found"})
            if parts[1] == "blocks" and parts[3:] == ["children"]:
                kids = [self._block(b) for b in self.blocks.get(h, [])]
                return httpx.Response(200, json=self._paged(kids, q.get("start_cursor"), int(q.get("page_size") or 100)))
            if parts[1] == "databases":
                d = self.databases.get(h)
                if d is None:
                    return httpx.Response(404, json={"code": "object_not_found"})
                return httpx.Response(200, json={"object": "database", "id": dashed(h), "title": [rt(d["title"])],
                                                 "parent": {"type": "page_id", "page_id": dashed(d["parent"])},
                                                 "data_sources": [{"id": dashed(d["ds"]), "name": d["title"]}],
                                                 "in_trash": False, "icon": None, "last_edited_time": d["last_edited"]})
            if parts[1] == "data_sources" and len(parts) == 3:
                return httpx.Response(200, json=self._ds(h))
            if parts[1] == "data_sources" and parts[3:] == ["query"]:
                rows = [self._page(r) for r in self.sources[h]["rows"]]
                return httpx.Response(200, json=self._paged(rows, body.get("start_cursor"), int(body.get("page_size") or 100)))
        return httpx.Response(404, json={"code": "object_not_found", "message": path})
