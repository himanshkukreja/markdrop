"""Markdrop Guides ↔ GitHub: the app settings, connecting an installation, the repository picker,
creating a guide from a repository, the sync job (spec and apply: create / update / move / delete,
studio pages untouched, publish mode), disconnect, and the webhook.

GitHub is an httpx.MockTransport (services/docs_github_app.TRANSPORT): no network.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
import unittest
from unittest import mock

import httpx
from bson import ObjectId
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from tests._docs_sites_env import BASE, DocsSitesCase, settings

from app.services import docs_github_app as gh
from app.services import docs_github_detect as detect
from app.services import docs_github_sync as sync
from app.services import docs_import_job, docs_jobs

KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
PEM = KEY.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                        serialization.NoEncryption()).decode()
APP = {
    "docs_github_app_id": "12345", "docs_github_app_slug": "markdrop-guides",
    "docs_github_app_private_key": PEM.replace("\n", "\\n"), "docs_github_webhook_secret": "whsec-test-0123456789abcdef",
    "docs_github_client_id": "Iv23liTest", "docs_github_client_secret": "client-secret-test",
}
GH = "/api/v1/github"
SHA1 = "1" * 40
SHA2 = "2" * 40


class FakeGitHub:
    """Just enough of api.github.com, github.com and raw/codeload for these tests."""

    def __init__(self):
        self.calls: list[httpx.Request] = []
        self.repos = {
            "acme/docs": {"id": 7, "name": "docs", "owner": {"login": "acme"}, "full_name": "acme/docs", "private": False,
                          "default_branch": "main", "description": "Acme docs", "pushed_at": "2026-11-01T00:00:00Z"},
            "acme/secret": {"id": 8, "name": "secret", "owner": {"login": "acme"}, "full_name": "acme/secret", "private": True,
                            "default_branch": "main", "description": None, "pushed_at": "2026-10-01T00:00:00Z"},
        }
        self.tree = ["README.md", "docs/index.md", "docs/guide/start.md", "docs/guide/advanced.md", "docs/img/shot.png",
                     "website/docusaurus.config.js", "website/docs/intro.md", "mint/mint.json", "mint/intro.mdx",
                     "mint/openapi.yaml"]
        self.files = {"mint/mint.json": json.dumps({"name": "Acme", "navigation": [
            {"group": "Get started", "pages": ["intro"]}], "openapi": "openapi.yaml"}).encode(),
            "website/docusaurus.config.js": b"module.exports = { presets: [['classic', { docs: { path: 'docs' } }]] }"}
        self.user_installations = [{"id": 99, "app_id": 12345, "account": {"login": "acme", "type": "Organization", "id": 1},
                                    "repository_selection": "selected", "suspended_at": None},
                                   {"id": 55, "app_id": 777, "account": {"login": "other"}}]
        self.rate_limited = False

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        u = request.url
        path = u.path
        if self.rate_limited and u.host == "api.github.com":
            return httpx.Response(403, headers={"x-ratelimit-remaining": "0", "x-ratelimit-reset": str(int(time.time()) + 120)},
                                  json={"message": "API rate limit exceeded"})
        if u.host == "github.com" and path == "/login/oauth/access_token":
            body = dict(x.split("=") for x in request.content.decode().split("&"))
            if body.get("code") == "good" and body.get("client_secret") == APP["docs_github_client_secret"]:
                return httpx.Response(200, json={"access_token": "gho_user"})
            return httpx.Response(200, json={"error": "bad_verification_code"})
        if path.startswith("/applications/") and request.method == "DELETE":
            return httpx.Response(204)
        if path == "/user/installations":
            assert request.headers["authorization"] == "token gho_user"
            return httpx.Response(200, json={"installations": self.user_installations})
        if path.startswith("/app/installations/") and path.endswith("/access_tokens"):
            assert request.headers["authorization"].startswith("Bearer ")
            return httpx.Response(201, json={"token": "ghs_inst", "expires_at": "2099-01-01T00:00:00Z"})
        if path == "/installation/repositories":
            assert request.headers["authorization"] == "token ghs_inst"
            return httpx.Response(200, json={"repositories": list(self.repos.values())})
        parts = path.strip("/").split("/")
        if parts[0] == "repos" and len(parts) >= 3:
            full = f"{parts[1]}/{parts[2]}"
            repo = self.repos.get(full)
            authed = request.headers.get("authorization") == "token ghs_inst"
            if repo is None or (repo["private"] and not authed):
                return httpx.Response(404, json={"message": "Not Found"})
            rest = parts[3:]
            if not rest:
                return httpx.Response(200, json=repo)
            if rest == ["branches"]:
                return httpx.Response(200, json=[{"name": "dev"}, {"name": "main"}])
            if rest[0] == "commits":
                if rest[1] not in ("main", "dev"):
                    return httpx.Response(404, json={"message": "No commit found"})
                return httpx.Response(200, text=SHA1)
            if rest[:2] == ["git", "trees"]:
                return httpx.Response(200, json={"tree": [{"path": p, "type": "blob"} for p in self.tree], "truncated": False})
            if rest[0] == "tarball":
                return httpx.Response(302, headers={"location": f"https://codeload.github.com/{full}/legacy.tar.gz/{rest[1]}?token=tmp"})
            if rest[0] == "contents":
                f = "/".join(rest[1:])
                return httpx.Response(200, content=self.files[f]) if f in self.files else httpx.Response(404)
        if u.host == "raw.githubusercontent.com":
            f = "/".join(parts[3:])
            return httpx.Response(200, content=self.files[f]) if f in self.files else httpx.Response(404, text="404")
        return httpx.Response(404, json={"message": f"unexpected {request.method} {u}"})


class GitHubCase(DocsSitesCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.fake = FakeGitHub()
        self._saved_gh = gh.TRANSPORT
        gh.TRANSPORT = httpx.MockTransport(self.fake.handler)
        gh.clear_caches()
        self._saved_app = {k: getattr(settings, k) for k in APP}
        for k, v in APP.items():
            setattr(settings, k, v)

    async def asyncTearDown(self):
        gh.TRANSPORT = self._saved_gh
        gh.clear_caches()
        for k, v in self._saved_app.items():
            setattr(settings, k, v)
        await super().asyncTearDown()

    async def gh(self, method: str, path: str, who: str = "owner", expect: int = 200, **kw):
        r = await self.http.request(method, GH + path, headers=self.h[who], **kw)
        self.assertEqual(r.status_code, expect, r.text)
        return r.json()

    async def link_installation(self, workspace_id=None, owner_id=None, iid=99):
        await self.db[sync.INSTALLS].insert_one({
            "installation_id": iid, "workspace_id": workspace_id if workspace_id is not None else self.ws,
            "owner_id": owner_id, "account": {"login": "acme", "type": "Organization"}, "repository_selection": "selected",
            "suspended": False, "deleted_at": None, "linked_by": self.uid["owner"], "linked_at": sync.now()})

    def signed(self, event: str, body: dict, delivery: str | None = None, secret: str | None = None) -> dict:
        raw = json.dumps(body).encode()
        sig = "sha256=" + hmac.new((secret or APP["docs_github_webhook_secret"]).encode(), raw, hashlib.sha256).hexdigest()
        return {"content": raw, "headers": {"x-hub-signature-256": sig, "x-github-event": event,
                                            "x-github-delivery": delivery or str(ObjectId()), "content-type": "application/json"}}

    async def github_site(self, slug="acme-gh", *, installation=True, sync_on=True, mode="drafts", path="docs"):
        if installation:
            await self.link_installation()
        source = {"kind": "github", "repo": {"owner": "acme", "name": "docs", "branch": "main", "path": path},
                  "installation_id": 99 if installation else None, "sync": sync_on, "mode": mode}
        return await self.create(slug, source=source)

    async def run_job(self, job_id, data: dict) -> dict:
        job = await docs_jobs.claim_job(self.db, job_id, "runner-1")
        self.assertIsNotNone(job[0], job[1])
        return await docs_import_job.apply_import(self.db, job[0], "runner-1", data)


def page(path, title, md, origin, **kw):
    return {"path": path, "title": title, "description": kw.get("description", ""), "markdown": md, "hidden": False,
            "frontmatter_extra": {}, **({"icon": kw["icon"]} if "icon" in kw else {}), "_origin": origin}


def result(pages, nav, commit=SHA1, **kw) -> dict:
    return {"pages": [{k: v for k, v in p.items() if k != "_origin"} for p in pages],
            "origins": {p["path"]: p["_origin"] for p in pages}, "nav": nav, "commit": commit,
            "site": kw.get("site", {"name": "Acme"}), "redirects": kw.get("redirects", {}),
            "report": {"repoFormat": "markdown", "counts": {"pages": len(pages)}, "items": {}},
            "openapi": kw.get("openapi", []), "assets": kw.get("assets", {"files": 0, "items": []})}


V1 = [page("/", "Acme", "Welcome", "docs/index.md"), page("/guide/start", "Start", "Step one", "docs/guide/start.md"),
      page("/guide/advanced", "Advanced", "Deep", "docs/guide/advanced.md")]
NAV1 = [{"group": "Guide", "pages": ["/guide/start", "/guide/advanced"]}]


# ── Settings, state, signatures ────────────────────────────────────────────────


class AppSettings(GitHubCase):
    async def test_not_set_up(self):
        for k in APP:
            setattr(settings, k, "")
        st = await self.gh("GET", "/status", params={"workspace_id": self.ws})
        self.assertEqual(st["app"]["configured"], False)
        await self.gh("POST", "/install", json={"workspace_id": self.ws, "return_to": "/guides/new"}, expect=503)
        r = await self.http.post(GH + "/webhook", **self.signed("ping", {}))
        self.assertEqual(r.status_code, 503)
        # Public repositories still import (once, no sync).
        site = await self.create("pub", source={"kind": "github", "repo": {"owner": "acme", "name": "docs", "branch": "main", "path": "docs"}})
        self.assertEqual(site["github"]["public"], True)
        self.assertEqual(site["github"]["sync"], False)
        self.assertEqual(site["job"]["kind"], "import")
        # …but sync, or a private repository, needs the app.
        await self.create("pub2", source={"kind": "github", "repo": {"owner": "acme", "name": "docs"}, "sync": True}, expect=422)
        await self.create("priv", source={"kind": "github", "repo": {"owner": "acme", "name": "secret"}}, expect=404)
        await self.create("priv2", source={"kind": "github", "repo": {"owner": "acme", "name": "secret"}, "installation_id": 99},
                          expect=503)

    async def test_jwt_state_and_signature(self):
        tok = gh.app_jwt(at=1_700_000_000)
        import jwt as pyjwt

        claims = pyjwt.decode(tok, KEY.public_key(), algorithms=["RS256"], options={"verify_exp": False})
        self.assertEqual((claims["iss"], claims["iat"], claims["exp"]), ("12345", 1_700_000_000 - 60, 1_700_000_000 + 540))
        st = gh.sign_state("u1", "ws1", "/guides/new")
        self.assertEqual(gh.verify_state(st, "u1"), {"workspace_id": "ws1", "return_to": "/guides/new"})
        self.assertIsNone(gh.verify_state(st, "u2"))
        self.assertIsNone(gh.verify_state(st[:-2] + "xx", "u1"))
        self.assertIsNone(gh.verify_state(gh.sign_state("u1", None, "/guides", at=time.time() - 3600), "u1"))
        body = b'{"a":1}'
        good = "sha256=" + hmac.new(APP["docs_github_webhook_secret"].encode(), body, hashlib.sha256).hexdigest()
        self.assertTrue(gh.verify_signature(body, good))
        self.assertFalse(gh.verify_signature(body + b" ", good))
        self.assertFalse(gh.verify_signature(body, "sha1=abc"))
        self.assertFalse(gh.verify_signature(body, None))
        self.assertEqual(sync.safe_return("//evil.test"), "/guides")
        self.assertEqual(sync.safe_return("https://evil.test/guides"), "/guides")
        self.assertEqual(sync.safe_return("/guides/new?ws=1&start=github"), "/guides/new?ws=1&start=github")


# ── Connecting an installation ─────────────────────────────────────────────────


class Connect(GitHubCase):
    async def test_install_round_trip(self):
        out = await self.gh("POST", "/install", json={"workspace_id": self.ws, "return_to": "/guides/new?start=github"})
        self.assertTrue(out["url"].startswith("https://github.com/apps/markdrop-guides/installations/new?state="))
        state = out["url"].split("state=", 1)[1]
        from urllib.parse import unquote

        state = unquote(state)
        # Someone else can't use the state; an installation the user can't reach is refused.
        await self.gh("POST", "/connect", "admin", json={"code": "good", "state": state, "installation_id": 99}, expect=400)
        await self.gh("POST", "/connect", json={"code": "good", "state": state, "installation_id": 55}, expect=403)
        await self.gh("POST", "/connect", json={"code": "bad", "state": state, "installation_id": 99}, expect=400)
        res = await self.gh("POST", "/connect", json={"code": "good", "state": state, "installation_id": 99})
        self.assertEqual(res["linked"], [99])
        self.assertEqual(res["return_to"], "/guides/new?start=github")
        self.assertEqual([i["installation_id"] for i in res["installations"]], [99])
        # The other app's installation (55) is never linked; the user token is revoked after use.
        self.assertTrue(any(c.method == "DELETE" and "/applications/" in c.url.path for c in self.fake.calls))
        st = await self.gh("GET", "/status", params={"workspace_id": self.ws})
        self.assertEqual(st["installations"][0]["account"]["login"], "acme")
        # Editors don't connect GitHub; strangers don't see the workspace.
        await self.gh("GET", "/status", "editor", params={"workspace_id": self.ws}, expect=403)
        await self.gh("GET", "/status", "stranger", params={"workspace_id": self.ws}, expect=404)
        # Personal scope: linked to the person only.
        st = await self.gh("GET", "/status", "editor", params={"workspace_id": "personal"})
        self.assertEqual(st["installations"], [])
        await self.gh("DELETE", "/installations/99", params={"workspace_id": self.ws})
        st = await self.gh("GET", "/status", params={"workspace_id": self.ws})
        self.assertEqual(st["installations"], [])

    async def test_authorize_links_every_reachable_installation(self):
        out = await self.gh("POST", "/authorize", json={"workspace_id": "personal", "return_to": "/guides"})
        self.assertIn("/login/oauth/authorize?", out["url"])
        self.assertIn("redirect_uri=https%3A%2F%2Fmarkdrop.in%2Fguides%2Fgithub%2Finstalled", out["url"])
        from urllib.parse import parse_qs, urlsplit

        state = parse_qs(urlsplit(out["url"]).query)["state"][0]
        res = await self.gh("POST", "/connect", json={"code": "good", "state": state})
        self.assertEqual(res["linked"], [99])
        self.assertEqual(res["workspace_id"], "personal")


# ── Picker ─────────────────────────────────────────────────────────────────────


class Picker(GitHubCase):
    async def test_repos_need_a_linked_installation(self):
        await self.gh("GET", "/repos", params={"workspace_id": self.ws, "installation_id": 99}, expect=404)
        await self.link_installation()
        out = await self.gh("GET", "/repos", params={"workspace_id": self.ws, "installation_id": 99})
        self.assertEqual({r["full_name"] for r in out["repos"]}, {"acme/docs", "acme/secret"})
        out = await self.gh("GET", "/repos", params={"workspace_id": self.ws, "installation_id": 99, "q": "sec"})
        self.assertEqual([r["full_name"] for r in out["repos"]], ["acme/secret"])
        # An installation linked to another workspace is not usable here.
        await self.gh("GET", "/repos", params={"workspace_id": "personal", "installation_id": 99}, expect=404)

    async def test_public_repo_and_inspect(self):
        out = await self.gh("GET", "/repo", params={"workspace_id": self.ws, "owner": "acme", "name": "docs"})
        self.assertEqual((out["repo"]["public"], out["branches"][0], out["via"]), (True, "main", "public"))
        await self.gh("GET", "/repo", params={"workspace_id": self.ws, "owner": "acme", "name": "secret"}, expect=404)
        await self.gh("GET", "/repo", params={"workspace_id": self.ws, "owner": "a b", "name": "x"}, expect=422)
        ins = await self.gh("GET", "/inspect", params={"workspace_id": self.ws, "owner": "acme", "name": "docs", "branch": "main"})
        self.assertEqual(ins["sha"], SHA1)
        self.assertEqual([(f["path"], f["format"]) for f in ins["folders"]],
                         [("mint", "mintlify"), ("website", "docusaurus"), ("docs", "markdown"), ("", "markdown")])
        self.assertEqual(ins["selected"]["format"], "mintlify")
        self.assertEqual(ins["selected"]["openapi"], ["mint/openapi.yaml"])
        self.assertEqual(ins["selected"]["groups"], [{"group": "Get started", "count": 1, "pages": ["Intro"]}])
        ins = await self.gh("GET", "/inspect", params={"workspace_id": self.ws, "owner": "acme", "name": "docs", "branch": "main",
                                                       "path": "docs"})
        self.assertEqual((ins["selected"]["format"], ins["selected"]["pages"]), ("markdown", 3))
        self.assertEqual(ins["selected"]["groups"], [{"group": "Guide", "count": 2, "pages": ["Advanced", "Start"]}])
        ins = await self.gh("GET", "/inspect", params={"workspace_id": self.ws, "owner": "acme", "name": "docs", "branch": "main",
                                                       "path": "website"})
        self.assertEqual((ins["selected"]["format"], ins["selected"]["content_root"], ins["selected"]["pages"]),
                         ("docusaurus", "website/docs", 1))
        ins = await self.gh("GET", "/inspect", params={"workspace_id": self.ws, "owner": "acme", "name": "docs", "branch": "main",
                                                       "path": "docs", "format": "mkdocs"})
        self.assertIn("will be read as MkDocs", " ".join(ins["selected"]["warnings"]))
        await self.gh("GET", "/inspect", params={"workspace_id": self.ws, "owner": "acme", "name": "docs", "branch": "nope"},
                      expect=404)
        await self.gh("GET", "/inspect", params={"workspace_id": self.ws, "owner": "acme", "name": "docs", "branch": "main",
                                                 "path": "../x"}, expect=422)

    async def test_rate_limit_says_when(self):
        self.fake.rate_limited = True
        r = await self.http.get(GH + "/repo", params={"workspace_id": self.ws, "owner": "acme", "name": "docs"},
                                headers=self.h["owner"])
        self.assertEqual(r.status_code, 429)
        self.assertGreater(r.json()["retry_after"], 60)
        self.assertIn("Retry-After", r.headers)


class Detect(unittest.IsolatedAsyncioTestCase):
    async def test_formats(self):
        async def read(files):
            async def r(p):
                return files.get(p)
            return r

        cases = [
            (["docs.json", "intro.mdx"], {"docs.json": b'{"navigation": {"groups": []}}'}, "", "mintlify", ""),
            (["docs.json", "a.md"], {"docs.json": b'{"other": 1}'}, "", "markdown", ""),
            ([".gitbook.yaml", "docs/README.md", "docs/SUMMARY.md"], {".gitbook.yaml": b"root: ./docs/\n"}, "", "gitbook", "docs"),
            (["book/SUMMARY.md", "book/README.md"], {}, "book", "gitbook", "book"),
            (["mkdocs.yml", "content/index.md"], {"mkdocs.yml": b"site_name: A\ndocs_dir: content\nmarkdown_extensions:\n  - pymdownx.emoji:\n      emoji_index: !!python/name:material.extensions.emoji.twemoji\n"},
             "", "mkdocs", "content"),
            (["site/docusaurus.config.ts", "site/docs/a.md"], {"site/docusaurus.config.ts": b"export default {}"}, "site", "docusaurus", "site/docs"),
            (["notes/a.md"], {}, "notes", "markdown", "notes"),
        ]
        for paths, files, folder, fmt, root in cases:
            det = await detect.detect(paths, folder, await read(files))
            self.assertEqual((det["format"], det["content_root"]), (fmt, root), paths)
        self.assertEqual(detect.suggest_folders(["node_modules/x/docs.json", "a/mint.json", "docs/x.md"]), ["a", "docs", ""])
        self.assertEqual(detect.summary_groups("# Table of contents\n\n* [Intro](README.md)\n\n## Guides\n\n* [A](a.md)\n  * [B](b.md)\n"),
                         [{"group": "Getting started", "count": 1, "pages": ["Intro"]}, {"group": "Guides", "count": 2, "pages": ["A", "B"]}])
        self.assertEqual(detect.mkdocs_groups({"nav": ["index.md", {"Guide": [{"Start": "guide/start.md"}, "guide/b.md"]},
                                                       {"GitHub": "https://github.com/acme"}]}),
                         [{"group": "Getting started", "count": 1, "pages": ["Overview"]}, {"group": "Guide", "count": 2, "pages": ["Start", "B"]}])
        self.assertEqual(detect.mintlify_groups({"navigation": {"tabs": [{"tab": "Docs", "groups": [{"group": "A", "pages": ["x", {"group": "N", "pages": ["y"]}]}]}]}}),
                         [{"group": "A", "count": 2, "pages": ["X", "Y"]}])
        with self.assertRaises(ValueError):
            detect.norm_folder("a/../b")


# ── Guides from a repository, and syncing ─────────────────────────────────────


class Sync(GitHubCase):
    async def test_create_spec_and_first_import(self):
        site = await self.github_site()
        g = site["github"]
        self.assertEqual((g["owner"], g["name"], g["branch"], g["path"], g["sync"], g["mode"], g["status"], g["public"]),
                         ("acme", "docs", "main", "docs", True, "drafts", "queued", False))
        self.assertEqual(site["source"], {"kind": "github", "repo": {"owner": "acme", "name": "docs", "branch": "main", "path": "docs"}})
        job_id = site["job"]["id"]
        job = (await docs_jobs.claim_job(self.db, job_id, "runner-1"))[0]
        spec = await docs_import_job.spec_for(self.db, job)
        self.assertEqual(spec["import"]["kind"], "github")
        self.assertEqual(spec["import"]["tarball_url"], "https://codeload.github.com/acme/docs/legacy.tar.gz/main?token=tmp")
        self.assertEqual((spec["import"]["path"], spec["import"]["repo"], spec["import"]["ref"]), ("docs", {"owner": "acme", "name": "docs"}, "main"))
        out = await docs_import_job.apply_import(self.db, job, "runner-1", result(V1, NAV1))
        self.assertEqual(out["github"]["pages"]["created"], 3)
        self.assertEqual(out["github"]["sha"], SHA1)
        listing = await self.get(f"/{site['id']}/pages")
        by = {p["path"]: p for p in listing["pages"]}
        self.assertEqual(by["/guide/start"]["origin"], {"kind": "github", "path": "docs/guide/start.md", "sha": SHA1})
        self.assertEqual(listing["nav"], [{"group": "Guide", "pages": [by["/"]["id"], by["/guide/start"]["id"], by["/guide/advanced"]["id"]]}])
        gl = await self.get(f"/{site['id']}/github")
        self.assertEqual((gl["link"]["status"], gl["link"]["last_synced_sha"]), ("idle", SHA1))
        self.assertEqual([(s["trigger"], s["status"], s["pages"]["created"]) for s in gl["syncs"]], [("import", "done", 3)])
        # A public import's spec: codeload directly, no API call.
        pub = await self.create("pub", source={"kind": "github", "repo": {"owner": "acme", "name": "docs", "branch": "dev"}})
        job = (await docs_jobs.claim_job(self.db, pub["job"]["id"], "runner-2"))[0]
        spec = await docs_import_job.spec_for(self.db, job)
        self.assertEqual(spec["import"]["tarball_url"], "https://codeload.github.com/acme/docs/tar.gz/dev")

    async def test_sync_diff_rules(self):
        site = await self.github_site()
        sid = ObjectId(site["id"])
        await self.run_job(site["job"]["id"], result(V1, NAV1))
        home = await self.home(site["id"])
        # The studio: a page of its own, and an edit to a GitHub page.
        mine = await self.call("POST", f"/{site['id']}/pages", json={"path": "/faq", "title": "FAQ", "markdown": "Ours", "group": "Guide"},
                               expect=201)
        start = await self.db["docs_pages"].find_one({"site_id": sid, "path": "/guide/start"})
        await self.db["docs_pages"].update_one({"_id": start["_id"]}, {"$set": {"draft.markdown": "studio edit", "draft.rev": 2}})
        # The next push: start changed, advanced renamed to /guide/deep, a new page, one at the studio's /faq.
        v2 = [page("/", "Acme", "Welcome", "docs/index.md"), page("/guide/start", "Start", "Step one, better", "docs/guide/start.md"),
              page("/guide/deep", "Advanced", "Deep", "docs/guide/deep.md"), page("/guide/new", "New", "Fresh", "docs/guide/new.md"),
              page("/faq", "FAQ from git", "theirs", "docs/faq.md")]
        nav2 = [{"group": "Guide", "pages": ["/guide/start", "/guide/deep", "/guide/new", "/faq"]}]
        job = await sync.start_job(self.db, await self.db["docs_sites"].find_one({"_id": sid}), trigger="manual",
                                   user_id=self.uid["owner"], sha=SHA2)
        out = await self.run_job(job["_id"], result(v2, nav2, commit=SHA2))
        p = out["github"]["pages"]
        # advanced → deep is a new file to GitHub (a different path): advanced goes, deep comes.
        self.assertEqual((p["created"], p["updated"], p["deleted"], p["unchanged"]), (2, 1, 1, 1))
        self.assertIn("/faq: a page made in the studio has this address; kept the studio page", out["skipped"])
        faq = await self.db["docs_pages"].find_one({"_id": ObjectId(mine["id"])})
        self.assertEqual((faq["draft"]["markdown"], faq.get("origin")), ("Ours", None))
        start = await self.db["docs_pages"].find_one({"_id": start["_id"]})
        self.assertEqual((start["draft"]["markdown"], start["draft"]["rev"]), ("Step one, better", 3))
        self.assertIsNone(await self.db["docs_pages"].find_one({"site_id": sid, "path": "/guide/advanced"}))
        listing = await self.get(f"/{site['id']}/pages")
        ids = {x["path"]: x["id"] for x in listing["pages"]}
        self.assertEqual(listing["nav"], [{"group": "Guide", "pages": [home["id"], ids["/guide/start"], ids["/guide/deep"],
                                                                         ids["/guide/new"], ids["/faq"]]}])
        # A file moved in the repository but the same origin path: the page moves and keeps its id.
        v3 = [page("/", "Acme", "Welcome", "docs/index.md"), page("/start-here", "Start", "Step one, better", "docs/guide/start.md")]
        job = await sync.start_job(self.db, await self.db["docs_sites"].find_one({"_id": sid}), trigger="push",
                                   user_id=self.uid["owner"], sha="3" * 40)
        out = await self.run_job(job["_id"], result(v3, [{"group": "Guide", "pages": ["/start-here"]}], commit="3" * 40))
        self.assertEqual(out["github"]["pages"]["moved"], 1)
        moved = await self.db["docs_pages"].find_one({"_id": start["_id"]})
        self.assertEqual(moved["path"], "/start-here")
        # Gone files are deleted; the studio page stays.
        self.assertEqual(out["github"]["pages"]["deleted"], 2)
        self.assertIsNotNone(await self.db["docs_pages"].find_one({"_id": ObjectId(mine["id"]), "deleted_at": None}))
        hist = await self.get(f"/{site['id']}/github")
        self.assertEqual([s["trigger"] for s in hist["syncs"]], ["push", "manual", "import"])
        self.assertEqual(hist["syncs"][0]["short_sha"], "3333333")

    async def test_older_run_finishing_late_is_ignored(self):
        site = await self.github_site()
        sid = ObjectId(site["id"])
        await self.run_job(site["job"]["id"], result(V1, NAV1))
        s = await self.db["docs_sites"].find_one({"_id": sid})
        old = await sync.start_job(self.db, s, trigger="push", user_id=None, sha=SHA1)
        await docs_jobs.claim_job(self.db, old["_id"], "runner-old")  # running: a newer push queues its own
        new = await sync.start_job(self.db, s, trigger="push", user_id=None, sha=SHA2)
        self.assertNotEqual(old["_id"], new["_id"])
        newer = [page("/", "Acme", "v2", "docs/index.md")]
        await self.run_job(new["_id"], result(newer, [], commit=SHA2))
        job = await self.db["docs_jobs"].find_one({"_id": old["_id"]})
        out = await docs_import_job.apply_import(self.db, job, "runner-old", result(V1, NAV1))
        self.assertTrue(out.get("superseded"))
        home = await self.db["docs_pages"].find_one({"site_id": sid, "path": "/"})
        self.assertEqual(home["draft"]["markdown"], "v2")

    async def test_queued_sync_takes_the_newer_commit(self):
        site = await self.github_site()
        await self.run_job(site["job"]["id"], result(V1, NAV1))
        s = await self.db["docs_sites"].find_one({"_id": ObjectId(site["id"])})
        a = await sync.start_job(self.db, s, trigger="push", user_id=None, sha=SHA1)
        b = await sync.start_job(self.db, s, trigger="push", user_id=None, sha=SHA2)
        self.assertEqual(a["_id"], b["_id"])
        self.assertEqual(b["payload"]["source"]["sha"], SHA2)
        self.assertEqual(await self.db[sync.SYNCS].count_documents({"site_id": s["_id"], "trigger": "push"}), 1)

    async def test_publish_mode_publishes_after_a_sync(self):
        site = await self.github_site(mode="publish")
        out = await self.run_job(site["job"]["id"], result(V1, NAV1))
        self.assertEqual(out["github"]["published_build"], 1)
        builds = await self.get(f"/{site['id']}/builds")
        self.assertEqual(builds[0]["note"], "GitHub 1111111")
        hist = await self.get(f"/{site['id']}/github")
        self.assertEqual(hist["syncs"][0]["published_build"], 1)
        # Nothing changed: no publish.
        s = await self.db["docs_sites"].find_one({"_id": ObjectId(site["id"])})
        job = await sync.start_job(self.db, s, trigger="push", user_id=None, sha=SHA1)
        out = await self.run_job(job["_id"], result(V1, NAV1))
        self.assertIsNone(out["github"]["published_build"])

    async def test_connect_existing_guide_adopts_same_addresses_then_disconnect(self):
        site = await self.create("old-guide")  # blank: a studio home page
        await self.link_installation()
        await self.call("PUT", f"/{site['id']}/github", "editor",
                        json={"installation_id": 99, "owner": "acme", "name": "docs", "branch": "main", "path": "docs"}, expect=403)
        out = await self.call("PUT", f"/{site['id']}/github",
                              json={"installation_id": 99, "owner": "acme", "name": "docs", "branch": "main", "path": "docs",
                                    "mode": "drafts", "sync": True})
        self.assertEqual(out["link"]["status"], "queued")
        res = await self.run_job(out["job"]["id"], result(V1, NAV1))
        self.assertEqual(res["github"]["pages"]["adopted"], 1)
        home = await self.home(site["id"])
        self.assertEqual(home["origin"]["path"], "docs/index.md")
        # Viewers read, editors sync, admins change the mode.
        await self.call("POST", f"/{site['id']}/github/sync", "viewer", expect=403)
        await self.call("POST", f"/{site['id']}/github/sync", "editor", expect=202)
        await self.call("PATCH", f"/{site['id']}/github", "editor", json={"mode": "publish"}, expect=403)
        g = await self.call("PATCH", f"/{site['id']}/github", json={"mode": "publish", "sync": False})
        self.assertEqual((g["link"]["mode"], g["link"]["sync"]), ("publish", False))
        # Disconnect: pages stay, origins go, the waiting sync is cancelled.
        await self.call("DELETE", f"/{site['id']}/github")
        listing = await self.get(f"/{site['id']}/pages")
        self.assertEqual(len(listing["pages"]), 3)
        self.assertTrue(all(p["origin"] is None for p in listing["pages"]))
        self.assertIsNone((await self.get(f"/{site['id']}"))["github"])
        self.assertEqual(await self.db["docs_jobs"].count_documents({"site_id": ObjectId(site["id"]), "status": "queued"}), 0)
        await self.call("POST", f"/{site['id']}/github/sync", expect=409)

    async def test_failed_run_shows_in_the_link(self):
        site = await self.github_site()
        job = (await docs_jobs.claim_job(self.db, site["job"]["id"], "runner-1"))[0]
        await docs_jobs.fail(self.db, job["_id"], "runner-1", "no pages in docs")
        await sync.job_failed(self.db, job, "no pages in docs")
        g = await self.get(f"/{site['id']}/github")
        self.assertEqual((g["link"]["status"], g["link"]["last_error"]), ("error", "no pages in docs"))
        self.assertEqual((g["syncs"][0]["status"], g["syncs"][0]["error"]), ("failed", "no pages in docs"))

    async def test_openapi_from_the_repository(self):
        site = await self.github_site(path="mint")
        await self.run_job(site["job"]["id"], result(V1, NAV1, openapi=[{"path": "mint/openapi.yaml", "from": "mint.json"}]))
        g = await self.get(f"/{site['id']}/github")
        self.assertEqual(g["link"]["openapi_paths"], ["mint/openapi.yaml"])
        self.fake.files["mint/openapi.yaml"] = (b"openapi: 3.0.0\ninfo: {title: Acme, version: '1'}\npaths:\n"
                                                b"  /things:\n    get: {summary: List things, responses: {'200': {description: ok}}}\n")
        await self.call("POST", f"/{site['id']}/github/openapi", json={"path": "docs/other.yaml"}, expect=404)
        st = await self.call("POST", f"/{site['id']}/github/openapi", json={"path": "mint/openapi.yaml"})
        self.assertEqual(st["current"]["source"]["kind"], "github")


# ── Webhook ────────────────────────────────────────────────────────────────────


def push(branch="main", files=("docs/guide/start.md",), full="acme/docs", iid=99, **kw):
    return {"ref": f"refs/heads/{branch}", "after": SHA2, "repository": {"full_name": full}, "installation": {"id": iid},
            "commits": [{"added": [], "removed": [], "modified": list(files)}], "pusher": {"name": "ada"}, **kw}


class Webhook(GitHubCase):
    async def test_signature_and_duplicates(self):
        r = await self.http.post(GH + "/webhook", **self.signed("ping", {"zen": "x"}, secret="wrong"))
        self.assertEqual(r.status_code, 401)
        r = await self.http.post(GH + "/webhook", content=b"{}", headers={"x-github-event": "ping"})
        self.assertEqual(r.status_code, 401)
        req = self.signed("ping", {"zen": "x"}, delivery="d-1")
        r = await self.http.post(GH + "/webhook", **req)
        self.assertEqual(r.json(), {"ok": True, "event": "ping"})
        r = await self.http.post(GH + "/webhook", **req)
        self.assertEqual(r.json(), {"ok": True, "duplicate": True})

    async def test_push_filtering(self):
        site = await self.github_site()
        sid = ObjectId(site["id"])
        await self.run_job(site["job"]["id"], result(V1, NAV1))

        async def deliver(body):
            r = await self.http.post(GH + "/webhook", **self.signed("push", body))
            self.assertEqual(r.status_code, 200, r.text)
            return r.json()

        self.assertEqual((await deliver(push(branch="dev")))["jobs"], [])
        self.assertEqual((await deliver(push(files=("src/app.py", "README.md"))))["jobs"], [])
        self.assertEqual((await deliver(push(full="acme/other")))["jobs"], [])
        self.assertEqual((await deliver(push(iid=55)))["jobs"], [])
        self.assertTrue((await deliver(push(branch="main", deleted=True))).get("ignored"))
        out = await deliver(push())
        self.assertEqual(len(out["jobs"]), 1)
        job = await self.db["docs_jobs"].find_one({"_id": ObjectId(out["jobs"][0])})
        self.assertEqual((job["payload"]["trigger"], job["payload"]["source"]["sha"], job["payload"]["pusher"]), ("push", SHA2, "ada"))
        # 20 commits (GitHub's cap) or a force push: assumed to touch the docs; coalesced with the waiting job.
        many = push(files=("src/x.py",))
        many["commits"] = many["commits"] * 20
        self.assertEqual((await deliver(many))["jobs"], out["jobs"])
        # Sync off: pushes do nothing.
        await self.call("PATCH", f"/{site['id']}/github", json={"sync": False})
        await self.db["docs_jobs"].delete_many({"site_id": sid, "status": "queued"})
        self.assertEqual((await deliver(push()))["jobs"], [])

    async def test_daily_sync_cap(self):
        site = await self.github_site()
        await self.run_job(site["job"]["id"], result(V1, NAV1))
        with mock.patch.object(settings, "docs_github_syncs_per_site_per_day", 1):
            r = await self.http.post(GH + "/webhook", **self.signed("push", push()))
            self.assertEqual(r.json()["jobs"], [])
            g = await self.get(f"/{site['id']}/github")
            self.assertIn("sync limit", g["link"]["last_error"])
            await self.call("POST", f"/{site['id']}/github/sync", expect=429)

    async def test_installation_events(self):
        site = await self.github_site()
        await self.http.post(GH + "/webhook", **self.signed("installation_repositories", {
            "action": "removed", "installation": {"id": 99}, "repositories_removed": [{"full_name": "acme/docs"}]}))
        g = (await self.get(f"/{site['id']}/github"))["link"]
        self.assertEqual((g["sync"], g["status"]), (False, "error"))
        await self.http.post(GH + "/webhook", **self.signed("installation", {"action": "suspend", "installation": {"id": 99}}))
        await self.gh("GET", "/repos", params={"workspace_id": self.ws, "installation_id": 99}, expect=409)
        await self.http.post(GH + "/webhook", **self.signed("installation", {"action": "deleted", "installation": {"id": 99}}))
        st = await self.gh("GET", "/status", params={"workspace_id": self.ws})
        self.assertEqual(st["installations"], [])


if __name__ == "__main__":
    unittest.main()
