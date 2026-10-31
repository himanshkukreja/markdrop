"""A guide's API reference from an OpenAPI file (services/docs_api_spec.py, routers/docs_site_api.py)
and the safe fetcher behind URL sources (services/safe_fetch.py).

Parsing and checks; the SSRF guard (addresses, URL shapes, every redirect hop, size and time);
the endpoints and who may use them; the version history; what a build gets (the bundle's spec
reference, site.json); re-fetch on publish; and the template's sample spec. DNS and the network are
faked: nothing here leaves the machine. The docs bucket is the in-memory one of _docs_sites_env.
"""

from __future__ import annotations

import asyncio
import json
import unittest
from pathlib import Path
from unittest import mock

from tests._docs_sites_env import BASE, DocsSitesCase

from bson import ObjectId

from app.limiter import limiter
from app.services import docs_api_spec as api_spec
from app.services import docs_snapshot, safe_fetch

REPO = Path(__file__).resolve().parents[2]
SAMPLE = REPO / "backend" / "app" / "assets" / "northwind-openapi.json"
GOLDEN = REPO / "frontend" / "src" / "docs" / "testdata" / "northwind.golden.json"


def spec(paths: dict | None = None, **extra) -> dict:
    return {"openapi": "3.1.0", "info": {"title": "Tiny", "version": "2"},
            "servers": [{"url": "https://api.tiny.example"}],
            "paths": paths if paths is not None else {"/ping": {"get": {"operationId": "ping", "summary": "Ping",
                                                                       "responses": {"200": {"description": "OK"}}}}},
            **extra}


def raw(d: dict) -> bytes:
    return json.dumps(d).encode()


YAML = b"""openapi: 3.0.3
info:
  title: Yaml API
  version: 1.2.0
servers:
  - url: https://api.yaml.example
paths:
  /things/{id}:
    get:
      summary: Get a thing
      parameters:
        - name: id
          in: path
          required: true
          schema: {type: string}
      responses:
        200:
          description: OK
        404:
          description: Missing
"""


class ParseTests(unittest.TestCase):
    def test_json_and_yaml(self):
        s, summary, out = api_spec.prepare(raw(spec()))
        self.assertEqual((summary["title"], summary["version"], summary["operations"]), ("Tiny", "2", 1))
        self.assertEqual(summary["warnings"], [])
        self.assertEqual(json.loads(out), s)
        s, summary, _ = api_spec.prepare(YAML)
        self.assertEqual(summary["openapi"], "3.0.3")
        # YAML's integer status codes become JSON's string keys.
        self.assertEqual(sorted(s["paths"]["/things/{id}"]["get"]["responses"]), ["200", "404"])
        self.assertIn("1 operation has no operationId", summary["warnings"][0])
        # A UTF-8 BOM is fine.
        api_spec.prepare(b"\xef\xbb\xbf" + raw(spec()))

    def test_refused(self):
        cases = [
            (b"", "empty"),
            (b"\xff\xfe\x00", "UTF-8"),
            (b"{not json", "doesn't parse"),
            (b"key: [unclosed", "isn't valid JSON or YAML"),
            (b"- a list", "isn't an OpenAPI description"),
            (raw({"swagger": "2.0", "info": {}, "paths": {}}), "Swagger 2.0"),
            (raw({**spec(), "openapi": "3.2.0"}), "3.0 or 3.1"),
            (raw({**spec(), "openapi": 3.1}), "3.0 or 3.1"),
            (raw({"openapi": "3.1.0", "paths": {}}), "no info"),
            (raw({"openapi": "3.1.0", "info": {}}), "no paths"),
            (raw(spec({"/x": {"summary": "nothing"}})), "no operations"),
            (raw({**spec(), "x": float("nan")}), "NaN"),
        ]
        for data, why in cases:
            with self.subTest(why=why), self.assertRaises(api_spec.SpecError) as cm:
                api_spec.prepare(data)
            self.assertIn(why, str(cm.exception))

    def test_limits(self):
        with self.assertRaises(api_spec.SpecError) as cm:
            api_spec.prepare(b"a" * (api_spec.MAX_BYTES + 1))
        self.assertIn("at most 5 MB", str(cm.exception))
        ok = {"responses": {"200": {"description": "OK"}}}
        paths = {f"/r{i}": {"get": ok} for i in range(api_spec.MAX_OPERATIONS)}
        self.assertEqual(api_spec.prepare(raw(spec(paths)))[1]["operations"], 1000)
        paths["/one-more"] = {"post": ok}
        with self.assertRaises(api_spec.SpecError) as cm:
            api_spec.prepare(raw(spec(paths)))
        self.assertIn("1,001 operations", str(cm.exception))

    def test_billion_laughs(self):
        lol = "openapi: 3.1.0\na: &a [x,x,x,x,x,x,x,x,x,x]\n"
        prev = "a"
        for i in range(9):
            lol += f"{chr(98 + i)}: &{chr(98 + i)} [*{prev},*{prev},*{prev},*{prev},*{prev},*{prev},*{prev},*{prev},*{prev},*{prev}]\n"
            prev = chr(98 + i)
        with self.assertRaises(api_spec.SpecError) as cm:
            api_spec.parse(lol.encode())
        self.assertIn("too complex", str(cm.exception))

    def test_warnings(self):
        d = spec({
            "/a": {"get": {"responses": {}}, "head": {"responses": {}}},
            "/b": {"$ref": "other.yaml#/paths/b"},
            "/c": {"post": {"operationId": "dup", "summary": "C", "responses": {"200": {"$ref": "#/components/responses/Gone"}}},
                   "put": {"operationId": "dup", "summary": "C2", "requestBody": {"$ref": "./bodies.yaml#/x"}, "responses": {}}},
        }, components={"securitySchemes": {"session": {"type": "apiKey", "in": "cookie", "name": "sid"},
                                           "digest": {"type": "http", "scheme": "digest"}}})
        d["servers"] = [{"url": "/v1"}]
        warnings = " | ".join(api_spec.analyze(d)["warnings"])
        for needle in ("no operationId", "used more than once: dup", "no summary", "no absolute server URL",
                       "HEAD, OPTIONS or TRACE", "$ref to another file", "references to other files",
                       "points at nothing", "goes in a cookie", "digest"):
            self.assertIn(needle, warnings)
        # A relative server is made absolute against the URL the file came from.
        s, summary, _ = api_spec.prepare(raw({**spec(), "servers": [{"url": "/v1"}]}), "https://example.com/docs/openapi.json")
        self.assertEqual(s["servers"][0]["url"], "https://example.com/v1")
        self.assertEqual(summary["servers"], ["https://example.com/v1"])

    def test_nav_preview_matches_the_engine(self):
        """The dashboard's sidebar preview (Python) and the published one (openapi.mjs auto mode)."""
        s, _, _ = api_spec.prepare(SAMPLE.read_bytes())
        preview = api_spec.nav_preview(s)
        golden = json.loads(GOLDEN.read_text())
        self.assertEqual(preview[0]["items"][0]["page"], "/api-reference")
        self.assertEqual([(g["group"], [(i["title"], i["page"]) for i in g["items"]]) for g in preview[1:]],
                         [(g["title"], [(o["title"], o["path"]) for o in g["ops"]]) for g in golden["groups"]])
        # Same rules on the awkward cases: untagged, no summary, colliding titles, x-displayName.
        s = spec({"/x": {"get": {"operationId": "listThings", "responses": {}}, "post": {"responses": {}}},
                  "/y": {"get": {"summary": "List things", "tags": ["Zed"], "responses": {}}},
                  "/z": {"get": {"summary": "List things", "tags": ["Zed"], "responses": {}}}},
                 tags=[{"name": "Zed", "x-displayName": "The Zeds"}])
        self.assertEqual([(g["group"], [i["page"] for i in g["items"]]) for g in api_spec.nav_preview(s)[1:]], [
            ("The Zeds", ["/api-reference/zed/list-things", "/api-reference/zed/list-things-2"]),
            ("Endpoints", ["/api-reference/endpoints/list-things", "/api-reference/endpoints/post-x"]),
        ])


# ── The safe fetcher ─────────────────────────────────────────────────────────


class FakeNet:
    """DNS answers and responses by URL; records what was connected to."""

    def __init__(self, dns: dict[str, list[str]], pages: dict[str, tuple]):
        self.dns = dns
        self.pages = pages
        self.connects: list[tuple[str, str]] = []

    async def resolve(self, host):
        if host not in self.dns:
            raise OSError("NXDOMAIN")
        return self.dns[host]

    async def transport(self, url, host, ip, *, max_bytes, timeout, accept):
        self.connects.append((url, ip))
        page = self.pages[url]
        if page == "slow":
            await asyncio.sleep(5)
        if page == "huge":
            raise safe_fetch.FetchError(f"The file is larger than {max_bytes // (1024 * 1024)} MB.")
        return page


class SafeFetchTests(unittest.IsolatedAsyncioTestCase):
    def test_blocked_addresses(self):
        blocked = ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.100.100.200",
                   "192.0.0.192", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "::1", "::",
                   "fe80::1", "fd00:ec2::254", "fc00::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254",
                   "64:ff9b::a9fe:a9fe", "2002:7f00:1::1", "2001:db8::1", "2001::1", "ff02::1", "not-an-ip"]
        for a in blocked:
            self.assertTrue(safe_fetch.blocked_address(a), a)
        for a in ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111", "64:ff9b::5db8:d822", "2002:5db8:d822::1"]:
            self.assertFalse(safe_fetch.blocked_address(a), a)

    def test_url_shapes(self):
        for url in ["http://api.example.com/o.json", "ftp://x.example.com/a", "https://user:pw@api.example.com/a",
                    "https://api.example.com:8443/a", "https://127.0.0.1/a", "https://[::1]/a", "https://0x7f.1/a",
                    "https://localhost/a", "https://x.localhost/a", "https://intranet/a", "", "https://"]:
            with self.subTest(url=url), self.assertRaises(safe_fetch.FetchError):
                safe_fetch.check_url(url)
        self.assertEqual(safe_fetch.check_url("https://API.example.com:443/o.json#frag"),
                         ("https://API.example.com:443/o.json", "api.example.com"))

    async def test_redirects_are_checked_at_every_hop(self):
        net = FakeNet(
            {"specs.example.com": ["93.184.216.34"], "cdn.example.com": ["93.184.216.35"],
             "evil.example.com": ["93.184.216.36", "10.0.0.5"], "meta.example.com": ["169.254.169.254"]},
            {"https://specs.example.com/a": (302, "https://cdn.example.com/b", "", b""),
             "https://cdn.example.com/b": (200, None, "application/json", b"{}"),
             "https://specs.example.com/to-private": (301, "https://meta.example.com/latest", "", b""),
             "https://specs.example.com/to-mixed": (307, "https://evil.example.com/x", "", b""),
             "https://specs.example.com/to-http": (302, "http://cdn.example.com/b", "", b""),
             "https://specs.example.com/to-ip": (302, "https://169.254.169.254/latest/meta-data", "", b""),
             "https://specs.example.com/loop": (302, "/loop", "", b""),
             "https://specs.example.com/slow": "slow",
             "https://specs.example.com/huge": "huge"})
        get = lambda u, **kw: safe_fetch.safe_get(u, max_bytes=1024, resolve=net.resolve, transport=net.transport, **kw)
        res = await get("https://specs.example.com/a")
        self.assertEqual((res.status, res.url, res.body), (200, "https://cdn.example.com/b", b"{}"))
        # The connection goes to the address that was checked.
        self.assertEqual(net.connects, [("https://specs.example.com/a", "93.184.216.34"),
                                        ("https://cdn.example.com/b", "93.184.216.35")])
        for url, why in [("https://specs.example.com/to-private", "private network"),
                         ("https://specs.example.com/to-mixed", "private network"),
                         ("https://specs.example.com/to-http", "Only https"),
                         ("https://specs.example.com/to-ip", "not an IP address"),
                         ("https://specs.example.com/loop", "too many times"),
                         ("https://nowhere.example.com/x", "doesn't resolve"),
                         ("https://specs.example.com/huge", "larger than")]:
            net.connects.clear()
            with self.subTest(url=url), self.assertRaises(safe_fetch.FetchError) as cm:
                await get(url)
            self.assertIn(why, str(cm.exception))
            # Nothing ever connected to a private address.
            self.assertFalse(any(safe_fetch.blocked_address(ip) for _, ip in net.connects))
        with self.assertRaises(safe_fetch.FetchError) as cm:
            await get("https://specs.example.com/slow", timeout=0.2)
        self.assertIn("longer than", str(cm.exception))


# ── The API ──────────────────────────────────────────────────────────────────


class ApiReferenceTests(DocsSitesCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.site = await self.create()
        self.sid = self.site["id"]
        self.net = FakeNet({"specs.example.com": ["93.184.216.34"], "evil.example.com": ["10.0.0.5"]}, {})
        for p in (mock.patch.object(safe_fetch, "system_resolve", self.net.resolve),
                  mock.patch.object(safe_fetch, "_get_pinned", self.net.transport)):
            p.start()
            self.addCleanup(p.stop)

    async def upload(self, data: bytes, who: str = "editor", expect: int = 201, name: str = "openapi.json") -> dict:
        limiter.reset()
        return await self.call("POST", f"/{self.sid}/api-reference/upload", who, expect,
                               files={"file": (name, data, "application/octet-stream")})

    async def bundle(self, build_id: str) -> dict:
        b = await self.db["docs_builds"].find_one({"_id": ObjectId(build_id)})
        return await docs_snapshot.bundle(self.db, b)

    async def test_upload_status_and_roles(self):
        st = await self.get(f"/{self.sid}/api-reference", "viewer")
        self.assertIsNone(st["current"])
        self.assertEqual(st["settings"], {"spec_id": None, "label": "API reference", "placement": "tab",
                                          "try_it": True, "refetch": False})
        self.assertEqual(st["limits"], {"max_bytes": 5 * 1024 * 1024, "max_operations": 1000})
        # Viewers read, editors and admins upload, strangers don't learn the guide exists.
        await self.upload(raw(spec()), "viewer", 403)
        await self.upload(raw(spec()), "stranger", 404)
        await self.get(f"/{self.sid}/api-reference", "stranger", 404)
        st = await self.upload(SAMPLE.read_bytes(), "editor", name="northwind.json")
        cur = st["current"]
        self.assertEqual((cur["title"], cur["version"], cur["operations"], cur["tags"]), ("Northwind API", "1.0.0", 7, 3))
        self.assertEqual(cur["source"], {"kind": "upload", "filename": "northwind.json"})
        self.assertEqual([g["group"] for g in st["nav"]], ["Overview", "Products", "Orders", "Customers"])
        self.assertEqual(st["settings"]["spec_id"], cur["id"])
        # Stored as JSON in the docs bucket, outside the site's files.
        key = f"sites/{self.sid}/api/{cur['sha256']}.json"
        self.assertEqual(json.loads(self.bucket.objects[key]["data"])["info"]["title"], "Northwind API")
        self.assertEqual(self.bucket.objects[key]["content_type"], "application/json")
        # YAML too; each upload is a version; the same bytes again reuse theirs.
        st = await self.upload(YAML, "admin", name="api.yaml")
        self.assertEqual(st["current"]["title"], "Yaml API")
        self.assertEqual(len(st["versions"]), 2)
        st = await self.upload(SAMPLE.read_bytes(), "editor")
        self.assertEqual(len(st["versions"]), 2)
        self.assertEqual(st["current"]["id"], cur["id"])
        # The site view carries the setting with its defaults.
        site = await self.get(f"/{self.sid}", "viewer")
        self.assertEqual(site["settings"]["api"]["spec_id"], cur["id"])
        # Bad files: a clear message, nothing changes.
        r = await self.upload(b"swagger: '2.0'\ninfo: {}\npaths: {}\n", expect=422)
        self.assertIn("Swagger 2.0", r["detail"])
        r = await self.upload(b"x" * (api_spec.MAX_BYTES + 10), expect=413)
        self.assertIn("5 MB", r["detail"])
        self.assertEqual((await self.get(f"/{self.sid}/api-reference"))["current"]["id"], cur["id"])
        # Storage down: 503, not a half-saved version.
        self.bucket.configured = False
        await self.upload(raw(spec()), expect=503)
        self.bucket.configured = True
        self.bucket.fail = True
        await self.upload(raw(spec()), expect=502)

    async def test_restore_remove_and_options(self):
        v1 = (await self.upload(raw(spec())))["current"]["id"]
        v2 = (await self.upload(YAML))["current"]["id"]
        self.assertNotEqual(v1, v2)
        limiter.reset()
        await self.call("POST", f"/{self.sid}/api-reference/versions/{v1}/restore", "viewer", 403)
        await self.call("POST", f"/{self.sid}/api-reference/versions/{'0' * 24}/restore", "editor", 404)
        st = await self.call("POST", f"/{self.sid}/api-reference/versions/{v1}/restore", "editor")
        self.assertEqual(st["current"]["id"], v1)
        st = await self.call("DELETE", f"/{self.sid}/api-reference", "editor")
        self.assertIsNone(st["current"])
        self.assertEqual(len(st["versions"]), 2)  # kept, to restore
        # The options are settings: admins change them; nobody sets spec_id by PATCH.
        await self.call("PATCH", f"/{self.sid}", "editor", 403, json={"settings": {"api": {"try_it": False}}})
        r = await self.call("PATCH", f"/{self.sid}", "admin", json={
            "settings": {"api": {"try_it": False, "placement": "sidebar", "label": "  REST API ", "refetch": True}}})
        self.assertEqual(r["settings"]["api"], {"spec_id": None, "label": "REST API", "placement": "sidebar",
                                                "try_it": False, "refetch": True})
        await self.call("PATCH", f"/{self.sid}", "admin", 422, json={"settings": {"api": {"spec_id": v1}}})
        await self.call("PATCH", f"/{self.sid}", "admin", 422, json={"settings": {"api": {"placement": "header"}}})
        await self.call("PATCH", f"/{self.sid}", "admin", 422, json={"settings": {"api": {"label": "x" * 41}}})
        # Another site's version can't be restored here.
        other = await self.create("other")
        r = await self.http.post(f"{BASE}/{other['id']}/api-reference/upload", headers=self.h["owner"],
                                 files={"file": ("o.json", raw(spec(info={"title": "Other", "version": "1"})), "application/json")})
        self.assertEqual(r.status_code, 201, r.text)
        await self.call("POST", f"/{self.sid}/api-reference/versions/{r.json()['current']['id']}/restore", "owner", 404)
        # Download: a short-lived link, for anyone on the guide.
        r = await self.http.get(f"{BASE}/{self.sid}/api-reference/versions/{v1}/download", headers=self.h["viewer"])
        self.assertEqual(r.status_code, 302)
        self.assertIn(f"sites/{self.sid}/api/", r.headers["location"])

    async def test_url_source(self):
        good = "https://specs.example.com/openapi.yaml"
        self.net.pages = {
            good: (200, None, "application/yaml", YAML),
            "https://specs.example.com/redir": (302, "https://evil.example.com/latest/meta-data", "", b""),
            "https://specs.example.com/page": (200, None, "text/html; charset=utf-8", b"<html>"),
            "https://specs.example.com/404": (404, None, "text/plain", b"nope"),
        }
        url = f"/{self.sid}/api-reference/url"
        for bad, why in [("http://specs.example.com/openapi.yaml", "Only https"),
                         ("https://169.254.169.254/latest", "not an IP address"),
                         ("https://evil.example.com/openapi.json", "private network"),
                         ("https://specs.example.com/redir", "private network"),
                         ("https://specs.example.com/page", "web page"),
                         ("https://specs.example.com/404", "answered 404")]:
            limiter.reset()
            r = await self.call("POST", url, "editor", 422, json={"url": bad})
            self.assertIn(why, r["detail"], bad)
        self.assertFalse(any(safe_fetch.blocked_address(ip) for _, ip in self.net.connects))
        limiter.reset()
        await self.call("POST", url, "viewer", 403, json={"url": good})
        # An editor's refetch choice is ignored (it's a setting); an admin's is kept.
        st = await self.call("POST", url, "editor", 201, json={"url": good, "refetch": True})
        self.assertEqual(st["current"]["source"], {"kind": "url", "url": good})
        self.assertTrue(st["current"]["last_fetch"]["ok"])
        self.assertFalse(st["settings"]["refetch"])
        st = await self.call("POST", url, "admin", 201, json={"url": good, "refetch": True})
        self.assertTrue(st["settings"]["refetch"])

    async def test_build_spec(self):
        await self.upload(SAMPLE.read_bytes())
        st = await self.get(f"/{self.sid}/api-reference")
        v1 = st["current"]
        b = await self.call("POST", f"/{self.sid}/publish", "editor", 202, json={})
        # The next version doesn't change what that build uses (its snapshot pins the version).
        await self.upload(YAML)
        out = await self.bundle(b["id"])
        self.assertEqual(out["bundle"]["openapi"], {"key": f"sites/{self.sid}/api/{v1['sha256']}.json",
                                                    "sha256": v1["sha256"], "size": v1["size"], "file": "openapi.json"})
        self.assertNotIn("openapi.json", out["bundle"]["files"])
        site = json.loads(out["bundle"]["files"]["site.json"])
        self.assertEqual(site["openapi"]["spec"], "openapi.json")
        self.assertEqual(site["openapi"]["base"], "/api-reference")
        self.assertTrue(site["openapi"]["auto"])
        self.assertEqual(site["tabs"], [{"id": "docs", "label": "Docs", "href": "/"},
                                        {"id": "api", "label": "API reference", "href": "/api-reference"}])
        self.assertEqual(site["openapi"]["tab"], "api")
        self.assertEqual(site["tryIt"], {"enabled": True})
        # Published since: the change list counts a new version; sidebar placement, Try it off.
        await self.mark_live(b["id"])
        ch = await self.get(f"/{self.sid}/changes")
        self.assertIn("api", ch["settings_changed"])
        await self.call("PATCH", f"/{self.sid}", json={"settings": {"api": {"placement": "sidebar", "try_it": False}}})
        b2 = await self.call("POST", f"/{self.sid}/publish", json={}, expect=202)
        site = json.loads((await self.bundle(b2["id"]))["bundle"]["files"]["site.json"])
        self.assertEqual(site["tabs"], [])
        self.assertEqual(site["openapi"]["tab"], "guides")
        self.assertEqual(site["tryIt"], {"enabled": False})
        # Removed: no reference in the next build.
        await self.call("DELETE", f"/{self.sid}/api-reference", "editor")
        b3 = await self.call("POST", f"/{self.sid}/publish", json={}, expect=202)
        out = await self.bundle(b3["id"])
        self.assertNotIn("openapi", out["bundle"])
        self.assertNotIn("openapi", json.loads(out["bundle"]["files"]["site.json"]))
        # Imported tabs keep theirs; the reference's tab is added after them.
        sj = {"tabs": [{"id": "api", "label": "API", "href": "/api"}]}
        docs_snapshot.add_api_reference(sj, {"api": {"label": "Endpoints"}}, {}, "2026-10-31")
        self.assertEqual(sj["tabs"][-1], {"id": "api-reference", "label": "Endpoints", "href": "/api-reference"})
        self.assertEqual(sj["openapi"]["tab"], "api-reference")

    async def test_refetch_on_publish(self):
        url = "https://specs.example.com/openapi.json"
        self.net.pages = {url: (200, None, "application/json", raw(spec()))}
        st = await self.call("POST", f"/{self.sid}/api-reference/url", "admin", 201, json={"url": url, "refetch": True})
        v1 = st["current"]["id"]
        # The API changed: the publish takes the new description.
        self.net.pages[url] = (200, None, "application/json", raw(spec(info={"title": "Tiny", "version": "3"})))
        b = await self.call("POST", f"/{self.sid}/publish", json={}, expect=202)
        st = await self.get(f"/{self.sid}/api-reference")
        self.assertNotEqual(st["current"]["id"], v1)
        self.assertEqual(st["current"]["version"], "3")
        self.assertEqual(b["warnings"], [])
        out = await self.bundle(b["id"])
        self.assertEqual(out["bundle"]["openapi"]["sha256"], st["current"]["sha256"])
        # It's down: the publish goes ahead with the last good version, and says so.
        self.net.pages[url] = (503, None, "text/plain", b"down")
        b2 = await self.call("POST", f"/{self.sid}/publish", json={}, expect=202)
        self.assertEqual(len(b2["warnings"]), 1)
        self.assertIn("answered 503", b2["warnings"][0])
        st2 = await self.get(f"/{self.sid}/api-reference")
        self.assertEqual(st2["current"]["id"], st["current"]["id"])
        self.assertFalse(st2["current"]["last_fetch"]["ok"])

    async def test_template_starts_with_the_sample(self):
        site = await self.create("tpl-api", source={"kind": "template", "template": "api"})
        st = await self.get(f"/{site['id']}/api-reference")
        self.assertEqual(st["current"]["title"], "Northwind API")
        self.assertEqual(st["current"]["source"]["kind"], "sample")
        listing = await self.get(f"/{site['id']}/pages")
        self.assertFalse(any(p["path"].startswith("/api-reference") for p in listing["pages"]))
        # Without storage the template still works, just without the sample.
        self.bucket.configured = False
        site = await self.create("tpl-api-2", source={"kind": "template", "template": "api"})
        self.assertIsNone((await self.get(f"/{site['id']}/api-reference"))["current"])
        # A page can't take the reference's prefix.
        limiter.reset()
        r = await self.http.post(f"{BASE}/{site['id']}/pages", headers=self.h["owner"],
                                 json={"path": "/api-reference/mine", "title": "Mine"})
        self.assertEqual(r.status_code, 422, r.text)
