"""Markdrop Guides' own roles (services/docs_studio_roles.py): admin / reviewer / editor / viewer /
none, per workspace with per-site overrides, and what each may do on every docs-sites endpoint.

People in the workspace "Acme" (tests/_docs_sites_env.py plus the ones added here):

    owner     workspace owner                          → admin (locked)
    admin     workspace admin                          → admin (locked)
    gadmin    member, studio admin                     → admin
    reviewer  member, studio reviewer                  → reviewer
    editor    member, studio editor                    → editor
    viewer    workspace viewer, studio viewer          → viewer
    nobody    member, no studio role                   → none (404)
    stranger  not in the workspace                     → none (404)
    upped     member, no studio role, admin on site A  → admin on A only
    downed    member, studio editor, none on site A    → none on A, editor on B
    left      was an editor, then removed from Acme    → none, rows cleaned up

The docs R2 bucket is in memory; nothing reaches a network.
"""

from __future__ import annotations

import io

from bson import ObjectId

from tests._docs_sites_env import BASE, DocsSitesCase, now

from app.limiter import limiter
from app.services import docs_studio_roles as roles
from app.utils.auth import create_access_token

STUDIO = "/api/v1/docs-studio"

# The effective role on site A for each person (None: no access).
ON_A = {
    "owner": "admin", "admin": "admin", "gadmin": "admin", "reviewer": "reviewer", "editor": "editor",
    "viewer": "viewer", "nobody": None, "stranger": None, "upped": "admin", "downed": None, "left": None,
}
RANK = roles.ROLE_RANK


def png() -> bytes:
    from PIL import Image

    out = io.BytesIO()
    Image.new("RGB", (3, 3), (10, 20, 30)).save(out, format="PNG")
    return out.getvalue()


class StudioRolesCase(DocsSitesCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        for who, ws_role, grant in (("gadmin", "member", "admin"), ("reviewer", "member", "reviewer"),
                                    ("nobody", "member", None), ("upped", "member", None),
                                    ("downed", "member", "editor"), ("left", "member", "editor")):
            await self.add_person(who, ws_role, grant)
        self.a = await self.create("site-a", name="Site A")
        self.b = await self.create("site-b", name="Site B")
        await self.override(self.a["id"], "upped", "admin")
        await self.override(self.a["id"], "downed", "none")
        await self.override(self.b["id"], "left", "viewer")
        r = await self.http.delete(f"/api/v1/workspaces/{self.ws}/members/{self.uid['left']}", headers=self.h["owner"])
        self.assertEqual(r.status_code, 204, r.text)

    async def add_person(self, who: str, ws_role: str | None, grant: str | None) -> None:
        email = f"{who}@example.com"
        res = await self.db["users"].insert_one({"email": email, "name": who.capitalize(), "providers": ["email"],
                                                 "created_at": now(), "updated_at": now()})
        self.uid[who] = str(res.inserted_id)
        self.h[who] = {"Authorization": f"Bearer {create_access_token(self.uid[who], email)[0]}"}
        if ws_role:
            await self.db["memberships"].insert_one({"workspace_id": self.ws, "user_id": self.uid[who], "role": ws_role,
                                                     "created_at": now(), "email": email, "name": who.capitalize()})
        if grant:
            await self.grant(who, grant)

    async def override(self, site_id: str, who: str, role: str, by: str = "owner", expect: int = 200) -> dict:
        limiter.reset()
        r = await self.http.put(f"{BASE}/{site_id}/members/{self.uid[who]}", json={"role": role}, headers=self.h[by])
        self.assertEqual(r.status_code, expect, r.text)
        return r.json()

    async def studio(self, method: str, path: str, who: str = "owner", expect: int = 200, **kw) -> dict:
        limiter.reset()
        r = await self.http.request(method, STUDIO + path, headers=self.h[who], **kw)
        self.assertEqual(r.status_code, expect, r.text)
        return r.json()


class Resolution(StudioRolesCase):
    async def test_your_role_on_each_site(self):
        for who, role in ON_A.items():
            r = await self.http.get(f"{BASE}/{self.a['id']}", headers=self.h[who])
            if role is None:
                self.assertEqual((who, r.status_code, r.json()["detail"]), (who, 404, "Guide not found"))
            else:
                self.assertEqual((who, r.status_code, r.json()["your_role"]), (who, 200, role))
        b = {who: (await self.http.get(f"{BASE}/{self.b['id']}", headers=self.h[who])) for who in ON_A}
        self.assertEqual(b["downed"].json()["your_role"], "editor")
        self.assertEqual(b["upped"].status_code, 404)
        self.assertEqual(b["left"].status_code, 404)  # their override went with their membership
        sources = {who: (await self.get(f"/{self.a['id']}", who))["your_role_source"]
                   for who in ("owner", "admin", "gadmin", "upped")}
        self.assertEqual(sources, {"owner": "workspace_owner", "admin": "workspace_admin", "gadmin": "workspace",
                                   "upped": "site"})

    async def test_listings_leave_out_what_you_cant_open(self):
        def ids(out):
            return {s["slug"]: s["your_role"] for s in out["sites"]}

        expect = {
            "owner": {"site-a": "admin", "site-b": "admin"},
            "reviewer": {"site-a": "reviewer", "site-b": "reviewer"},
            "viewer": {"site-a": "viewer", "site-b": "viewer"},
            "nobody": {},
            "upped": {"site-a": "admin"},
            "downed": {"site-b": "editor"},
        }
        for who, sites in expect.items():
            self.assertEqual(ids(await self.get("", who, params={"workspace_id": self.ws})), sites, who)
            self.assertEqual(ids(await self.get("", who, params={"scope": "all"})), sites, who)
        await self.get("", "left", params={"workspace_id": self.ws}, expect=404)
        self.assertEqual((await self.get("", "left", params={"scope": "all"}))["sites"], [])

        all_nobody = await self.get("", "nobody", params={"scope": "all"})
        ws = all_nobody["workspaces"][0]
        self.assertEqual((ws["your_role"], ws["can_create"], ws["can_manage_people"], ws["usage"]["sites"]),
                         ("none", False, False, 0))
        listing = await self.get("", "nobody", params={"workspace_id": self.ws})
        self.assertEqual((listing["your_role"], listing["usage"]["sites"]), ("none", 0))
        ws = (await self.get("", "gadmin", params={"scope": "all"}))["workspaces"][0]
        self.assertEqual((ws["your_role"], ws["can_create"], ws["can_manage_people"], ws["usage"]["sites"]),
                         ("admin", True, True, 2))
        ws = (await self.get("", "upped", params={"scope": "all"}))["workspaces"][0]
        self.assertEqual((ws["your_role"], ws["can_create"], ws["usage"]["sites"]), ("none", False, 1))

    async def test_who_can_create_a_site(self):
        await self.create("by-gadmin", "gadmin")
        for who, code in (("reviewer", 403), ("editor", 403), ("viewer", 403), ("nobody", 403), ("upped", 403),
                          ("stranger", 404), ("left", 404)):
            await self.create(f"by-{who}", who, expect=code)

    async def test_workspace_admin_demoted_falls_back_to_their_grant(self):
        await self.db["memberships"].update_one({"workspace_id": self.ws, "user_id": self.uid["admin"]},
                                                {"$set": {"role": "member"}})
        await self.get(f"/{self.a['id']}", "admin", expect=404)  # no studio role of their own
        await self.grant("admin", "viewer")
        self.assertEqual((await self.get(f"/{self.a['id']}", "admin"))["your_role"], "viewer")
        # Promoted again: admin whatever is stored.
        await self.db["memberships"].update_one({"workspace_id": self.ws, "user_id": self.uid["admin"]},
                                                {"$set": {"role": "admin"}})
        self.assertEqual((await self.get(f"/{self.a['id']}", "admin"))["your_role"], "admin")

    async def test_membership_is_checked_at_read_time(self):
        # A row left behind (no cleanup ran) gives nothing once they're out of the workspace.
        await self.db["memberships"].delete_one({"workspace_id": self.ws, "user_id": self.uid["reviewer"]})
        await self.get(f"/{self.a['id']}", "reviewer", expect=404)
        self.assertEqual((await self.get("", "reviewer", params={"scope": "all"}))["sites"], [])

    async def test_personal_sites_are_the_owners_alone(self):
        mine = await self.create("gadmins-own", "gadmin", workspace=False)
        self.assertEqual((mine["your_role"], mine["your_role_source"]), ("admin", "personal"))
        await self.get(f"/{mine['id']}", "owner", expect=404)
        people = await self.get(f"/{mine['id']}/members", "gadmin")
        self.assertTrue(people["personal"])
        self.assertEqual([m["user_id"] for m in people["members"]], [self.uid["gadmin"]])
        await self.override(mine["id"], "reviewer", "editor", by="gadmin", expect=422)


class Matrix(StudioRolesCase):
    """Every docs-sites endpoint × every person: no role → 404, too little → 403, else through."""

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.sid = self.a["id"]
        listing = await self.get(f"/{self.sid}/pages")
        self.page = next(p for p in listing["pages"] if p["path"] == "/")
        self.nav = listing["nav"]

    def verdict(self, r) -> str:
        if r.status_code == 404 and r.json().get("detail") == "Guide not found":
            return "hidden"
        if r.status_code == 403:
            return "refused"
        self.assertLess(r.status_code, 500, r.text)
        return "through"

    def expected(self, who: str, need: str) -> str:
        role = ON_A[who]
        if role is None:
            return "hidden"
        return "through" if RANK[role] >= RANK[need] else "refused"

    async def check(self, need: str, name: str, call) -> None:
        for who in ON_A:
            limiter.reset()
            r = await call(who)
            self.assertEqual(self.verdict(r), self.expected(who, need), f"{name} as {who}: {r.status_code} {r.text}")

    def req(self, method: str, path: str, **kw):
        async def run(who):
            return await self.http.request(method, f"{BASE}/{self.sid}{path}", headers=self.h[who], **kw)
        return run

    async def test_viewer_endpoints(self):
        pid = self.page["id"]
        for name, path in (("site", ""), ("pages", "/pages"), ("page", f"/pages/{pid}"),
                           ("versions", f"/pages/{pid}/versions"), ("version", f"/pages/{pid}/versions/1"),
                           ("changes", "/changes"), ("reviews", "/reviews"), ("builds", "/builds"),
                           ("job", f"/jobs/{ObjectId()}")):
            await self.check("viewer", name, self.req("GET", path))

    async def test_editor_endpoints(self):
        pid = self.page["id"]
        n = iter(range(1000))

        async def new_page(who):
            return await self.http.post(f"{BASE}/{self.sid}/pages", headers=self.h[who],
                                        json={"path": f"/p-{next(n)}", "title": "P"})

        async def delete_page(who):
            p = await self.call("POST", f"/{self.sid}/pages", "owner", 201,
                                json={"path": f"/del-{next(n)}", "title": "D"})
            return await self.http.delete(f"{BASE}/{self.sid}/pages/{p['id']}", headers=self.h[who])

        async def lock_and_release(who):
            r = await self.http.post(f"{BASE}/{self.sid}/pages/{pid}/lock", headers=self.h[who])
            await self.http.delete(f"{BASE}/{self.sid}/pages/{pid}/lock", headers=self.h[who])
            return r

        async def upload(who):
            return await self.http.post(f"{BASE}/{self.sid}/assets", headers=self.h[who],
                                        files={"file": ("a.png", png(), "image/png")})

        async def nav(who):
            current = (await self.get(f"/{self.sid}/pages"))["nav"]
            return await self.http.put(f"{BASE}/{self.sid}/nav", headers=self.h[who], json={"nav": current})

        async def submit_and_withdraw(who):
            r = await self.http.post(f"{BASE}/{self.sid}/reviews", headers=self.h[who], json={"note": "x"})
            if r.status_code == 201:
                w = await self.http.post(f"{BASE}/{self.sid}/reviews/{r.json()['id']}/withdraw", headers=self.h[who])
                self.assertEqual(w.status_code, 200, w.text)
            return r

        await self.check("editor", "create page", new_page)
        await self.check("editor", "save page (stale rev → 409)", self.req(
            "PUT", f"/pages/{pid}", json={"base_rev": 999, "markdown": "x"}))
        await self.check("editor", "delete page", delete_page)
        await self.check("editor", "lock", lock_and_release)
        await self.check("editor", "unlock", self.req("DELETE", f"/pages/{pid}/lock"))
        await self.check("editor", "restore version", self.req("POST", f"/pages/{pid}/versions/1/restore"))
        await self.check("editor", "nav", nav)
        await self.check("editor", "upload", upload)
        await self.check("editor", "submit review", submit_and_withdraw)
        await self.check("editor", "withdraw (unknown review)", self.req("POST", f"/reviews/{ObjectId()}/withdraw"))
        await self.check("editor", "publish", self.req("POST", "/publish", json={}))

    async def test_reviewer_endpoints(self):
        await self.check("reviewer", "approve (unknown review)", self.req("POST", f"/reviews/{ObjectId()}/approve", json={}))
        await self.check("reviewer", "request changes (unknown review)",
                         self.req("POST", f"/reviews/{ObjectId()}/request-changes", json={}))

    async def test_admin_endpoints(self):
        target = self.uid["viewer"]

        async def override_round_trip(who):
            r = await self.http.put(f"{BASE}/{self.sid}/members/{target}", headers=self.h[who], json={"role": "editor"})
            if r.status_code == 200:
                d = await self.http.delete(f"{BASE}/{self.sid}/members/{target}", headers=self.h[who])
                self.assertEqual(d.status_code, 200, d.text)
            return r

        await self.check("admin", "settings", self.req("PATCH", "", json={"name": "Site A"}))
        await self.check("admin", "unpublish (not live → 409)", self.req("POST", "/unpublish"))
        await self.check("admin", "restore (unknown build)", self.req("POST", f"/builds/{ObjectId()}/restore"))
        await self.check("admin", "people", self.req("GET", "/members"))
        await self.check("admin", "person", self.req("GET", f"/members/{target}"))
        await self.check("admin", "people history", self.req("GET", "/members-history"))
        await self.check("admin", "override", override_round_trip)
        await self.check("admin", "remove override", self.req("DELETE", f"/members/{target}"))

        async def takeover(who):
            await self.call("POST", f"/{self.sid}/pages/{self.page['id']}/lock", "owner", params={"takeover": 1})
            return await self.http.post(f"{BASE}/{self.sid}/pages/{self.page['id']}/lock", headers=self.h[who],
                                        params={"takeover": 1})

        for who in ON_A:
            limiter.reset()
            r = await takeover(who)
            want = {None: 404, "viewer": 403, "editor": 403, "reviewer": 403}.get(ON_A[who], 200)
            self.assertEqual(r.status_code, want, f"takeover as {who}: {r.text}")

    async def test_delete_site(self):
        for who in ON_A:
            if ON_A[who] != "admin":
                limiter.reset()
                r = await self.http.delete(f"{BASE}/{self.sid}", headers=self.h[who])
                self.assertEqual(self.verdict(r), self.expected(who, "admin"), who)
        await self.call("DELETE", f"/{self.sid}", "upped")  # admin on this site only
        await self.get(f"/{self.sid}", "owner", expect=404)

    async def test_editor_publishes_reviewer_submits_when_review_is_required(self):
        await self.call("PATCH", f"/{self.sid}", json={"settings": {"review": {"required": True}}})
        r = await self.http.post(f"{BASE}/{self.sid}/publish", json={}, headers=self.h["reviewer"])
        self.assertEqual((r.status_code, r.json()["detail"]), (409, "review required"))
        # A reviewer approves someone else's review, never their own.
        own = await self.call("POST", f"/{self.sid}/reviews", "reviewer", 201, json={"note": "mine"})
        await self.call("POST", f"/{self.sid}/reviews/{own['id']}/approve", "reviewer", 403, json={})
        await self.call("POST", f"/{self.sid}/reviews/{own['id']}/request-changes", "reviewer", 403, json={})
        await self.call("POST", f"/{self.sid}/reviews/{own['id']}/withdraw", "reviewer")
        theirs = await self.call("POST", f"/{self.sid}/reviews", "editor", 201, json={"note": "please"})
        await self.call("POST", f"/{self.sid}/reviews/{theirs['id']}/approve", "editor", 403, json={})
        out = await self.call("POST", f"/{self.sid}/reviews/{theirs['id']}/approve", "reviewer", 202, json={})
        self.assertEqual((out["review"]["status"], out["review"]["decided_by"]), ("approved", self.uid["reviewer"]))
        self.assertEqual(out["build"]["requested_by"], self.uid["reviewer"])
        again = await self.call("POST", f"/{self.sid}/reviews", "editor", 201, json={})
        sent_back = await self.call("POST", f"/{self.sid}/reviews/{again['id']}/request-changes", "reviewer",
                                    json={"comment": "Fix the intro"})
        self.assertEqual(sent_back["status"], "changes_requested")


class People(StudioRolesCase):
    async def test_workspace_members_listing(self):
        out = await self.studio("GET", f"/workspaces/{self.ws}/members")
        self.assertEqual((out["workspace"]["name"], out["your_role"], out["you"]), ("Acme", "admin", self.uid["owner"]))
        rows = {m["user_id"]: m for m in out["members"]}
        self.assertNotIn(self.uid["left"], rows)
        self.assertNotIn(self.uid["stranger"], rows)
        u = self.uid
        self.assertEqual(out["members"][0]["user_id"], u["owner"])  # owner first, then admins
        got = {who: (rows[u[who]]["role"], rows[u[who]]["source"], rows[u[who]]["locked"])
               for who in ("owner", "admin", "gadmin", "reviewer", "editor", "viewer", "nobody", "upped")}
        self.assertEqual(got, {
            "owner": ("admin", "workspace_owner", True), "admin": ("admin", "workspace_admin", True),
            "gadmin": ("admin", "workspace", False), "reviewer": ("reviewer", "workspace", False),
            "editor": ("editor", "workspace", False), "viewer": ("viewer", "workspace", False),
            "nobody": ("none", "none", False), "upped": ("none", "none", False)})
        self.assertEqual(rows[u["upped"]]["site_overrides"], [{"site_id": self.a["id"], "site_name": "Site A", "role": "admin"}])
        self.assertEqual(rows[u["gadmin"]]["granted_by_name"], "Owner")
        self.assertEqual(rows[u["reviewer"]]["email"], "reviewer@example.com")
        self.assertEqual(rows[u["viewer"]]["workspace_role"], "viewer")
        self.assertEqual({s["name"] for s in out["sites"]}, {"Site A", "Site B"})

    async def test_who_may_manage_members(self):
        for who in ("owner", "admin", "gadmin"):
            await self.studio("GET", f"/workspaces/{self.ws}/members", who)
            await self.studio("GET", f"/workspaces/{self.ws}/history", who)
        for who in ("reviewer", "editor", "viewer", "nobody", "upped"):
            await self.studio("GET", f"/workspaces/{self.ws}/members", who, 403)
            await self.studio("PUT", f"/workspaces/{self.ws}/members/{self.uid['nobody']}", who, 403, json={"role": "viewer"})
            await self.studio("GET", f"/workspaces/{self.ws}/history", who, 403)
        for who in ("stranger", "left"):
            await self.studio("GET", f"/workspaces/{self.ws}/members", who, 404)
        await self.studio("GET", f"/workspaces/{ObjectId()}/members", "owner", 404)
        await self.studio("GET", "/workspaces/not-an-id/members", "owner", 404)

    async def test_grant_change_remove_with_audit(self):
        nb = self.uid["nobody"]
        await self.get(f"/{self.a['id']}", "nobody", expect=404)
        row = await self.studio("PUT", f"/workspaces/{self.ws}/members/{nb}", "gadmin", json={"role": "viewer"})
        self.assertEqual((row["role"], row["source"], row["granted_by"]), ("viewer", "workspace", self.uid["gadmin"]))
        self.assertEqual((await self.get(f"/{self.a['id']}", "nobody"))["your_role"], "viewer")
        await self.studio("PUT", f"/workspaces/{self.ws}/members/{nb}", "gadmin", json={"role": "viewer"})  # no-op
        await self.studio("PUT", f"/workspaces/{self.ws}/members/{nb}", "owner", json={"role": "reviewer"})
        self.assertEqual((await self.get(f"/{self.a['id']}", "nobody"))["your_role"], "reviewer")
        await self.studio("PUT", f"/workspaces/{self.ws}/members/{nb}", "owner", json={"role": "none"})
        await self.get(f"/{self.a['id']}", "nobody", expect=404)
        await self.studio("PUT", f"/workspaces/{self.ws}/members/{nb}", "owner", json={"role": "none"})  # no-op

        events = await self.db["docs_events"].find(
            {"kind": {"$regex": "^docs_role_"}, "meta.target_user_id": nb}).sort("ts", 1).to_list(length=None)
        self.assertEqual([(e["kind"], e["user_id"], e["meta"]["role"], e["meta"]["previous"], e["meta"]["scope"])
                          for e in events], [
            ("docs_role_granted", self.uid["gadmin"], "viewer", None, "workspace"),
            ("docs_role_changed", self.uid["owner"], "reviewer", "viewer", "workspace"),
            ("docs_role_removed", self.uid["owner"], None, "reviewer", "workspace"),
        ])
        self.assertTrue(all(e["workspace_id"] == self.ws for e in events))
        hist = (await self.studio("GET", f"/workspaces/{self.ws}/history"))["events"]
        mine = [h for h in hist if h["target_user_id"] == nb]
        self.assertEqual([(h["kind"], h["actor_name"], h["target_name"]) for h in mine], [
            ("docs_role_removed", "Owner", "Nobody"), ("docs_role_changed", "Owner", "Nobody"),
            ("docs_role_granted", "Gadmin", "Nobody")])

    async def test_refusals(self):
        ws = f"/workspaces/{self.ws}/members"
        for who in ("owner", "admin"):  # locked
            await self.studio("PUT", f"{ws}/{self.uid[who]}", "gadmin", 422, json={"role": "viewer"})
            await self.override(self.a["id"], who, "viewer", by="gadmin", expect=422)
        await self.studio("PUT", f"{ws}/{self.uid['gadmin']}", "gadmin", 422, json={"role": "viewer"})  # yourself
        await self.studio("PUT", f"{ws}/{self.uid['stranger']}", "owner", 404, json={"role": "viewer"})
        await self.studio("PUT", f"{ws}/{self.uid['left']}", "owner", 404, json={"role": "viewer"})
        await self.studio("PUT", f"{ws}/{self.uid['nobody']}", "owner", 422, json={"role": "owner"})
        await self.override(self.a["id"], "stranger", "viewer", expect=404)
        await self.override(self.a["id"], "upped", "editor", by="upped", expect=422)  # yourself, on the site

    async def test_bulk_update_is_all_or_nothing(self):
        ws = f"/workspaces/{self.ws}/members"
        await self.studio("PUT", ws, "owner", 404, json={"members": [
            {"user_id": self.uid["nobody"], "role": "editor"}, {"user_id": self.uid["stranger"], "role": "viewer"}]})
        await self.get(f"/{self.a['id']}", "nobody", expect=404)
        out = await self.studio("PUT", ws, "owner", json={"members": [
            {"user_id": self.uid["nobody"], "role": "editor"}, {"user_id": self.uid["viewer"], "role": "reviewer"}]})
        rows = {m["user_id"]: m["role"] for m in out["members"]}
        self.assertEqual((rows[self.uid["nobody"]], rows[self.uid["viewer"]]), ("editor", "reviewer"))
        await self.studio("PUT", ws, "owner", 422, json={"members": [
            {"user_id": self.uid["nobody"], "role": "editor"}, {"user_id": self.uid["nobody"], "role": "viewer"}]})

    async def test_site_overrides_raise_lower_and_audit(self):
        sid = self.b["id"]
        rv = self.uid["reviewer"]
        row = await self.override(sid, "reviewer", "none", by="gadmin")
        self.assertEqual((row["override"], row["effective_role"], row["studio_role"], row["source"]),
                         ("none", "none", "reviewer", "site"))
        await self.get(f"/{sid}", "reviewer", expect=404)
        self.assertEqual((await self.get(f"/{self.a['id']}", "reviewer"))["your_role"], "reviewer")
        row = await self.override(sid, "reviewer", "admin", by="gadmin")
        self.assertEqual((row["override_by_name"], row["effective_role"]), ("Gadmin", "admin"))
        self.assertEqual((await self.get(f"/{sid}", "reviewer"))["your_role"], "admin")
        row = await self.call("DELETE", f"/{sid}/members/{rv}", "gadmin")
        self.assertEqual((row["override"], row["effective_role"], row["source"]), (None, "reviewer", "workspace"))
        await self.call("DELETE", f"/{sid}/members/{rv}", "gadmin")  # nothing to remove: no event
        people = await self.get(f"/{sid}/members", "gadmin")
        self.assertEqual(people["your_role"], "admin")
        self.assertNotIn(self.uid["left"], {m["user_id"] for m in people["members"]})
        got = await self.get(f"/{sid}/members/{self.uid['owner']}", "gadmin")
        self.assertEqual((got["effective_role"], got["locked"], got["source"]), ("admin", True, "workspace_owner"))
        await self.get(f"/{sid}/members/{self.uid['stranger']}", "gadmin", expect=404)

        hist = (await self.get(f"/{sid}/members-history", "gadmin"))["events"]
        mine = [(h["kind"], h["role"], h["previous"], h["scope"], h["site_name"]) for h in hist if h["target_user_id"] == rv]
        self.assertEqual(mine, [
            ("docs_role_removed", None, "admin", "site", "Site B"),
            ("docs_role_changed", "admin", "none", "site", "Site B"),
            ("docs_role_granted", "none", None, "site", "Site B"),
        ])
        # A site admin by override manages that site's people, not the workspace's.
        await self.override(self.a["id"], "nobody", "viewer", by="upped")
        self.assertEqual((await self.get(f"/{self.a['id']}", "nobody"))["your_role"], "viewer")
        await self.override(sid, "nobody", "viewer", by="upped", expect=404)


class Lifecycle(StudioRolesCase):
    async def test_leaving_the_workspace_removes_studio_access(self):
        self.assertIsNone(await self.db["docs_studio_members"].find_one({"user_id": self.uid["left"]}))
        self.assertIsNone(await self.db["docs_site_members"].find_one({"user_id": self.uid["left"]}))
        ev = await self.db["docs_events"].find(
            {"kind": "docs_role_removed", "meta.target_user_id": self.uid["left"]}).to_list(length=None)
        self.assertEqual(sorted((e["meta"]["scope"], e["meta"]["previous"], e["meta"]["reason"], e["user_id"]) for e in ev),
                         [("site", "viewer", "left_workspace", self.uid["owner"]),
                          ("workspace", "editor", "left_workspace", self.uid["owner"])])
        # Re-joining starts from none.
        await self.db["memberships"].insert_one({"workspace_id": self.ws, "user_id": self.uid["left"], "role": "member",
                                                 "created_at": now()})
        await self.get(f"/{self.b['id']}", "left", expect=404)

    async def test_deleting_the_workspace_drops_its_roles(self):
        await roles.workspace_deleted(self.db, self.ws)
        self.assertEqual(await self.db["docs_studio_members"].count_documents({"workspace_id": self.ws}), 0)
        self.assertEqual(await self.db["docs_site_members"].count_documents({"workspace_id": self.ws}), 0)


class CarryOver(DocsSitesCase):
    async def test_existing_sites_keep_their_members_access_once(self):
        await self.db["docs_studio_members"].delete_many({})
        site = await self.create("acme")
        empty_ws = str((await self.db["workspaces"].insert_one({
            "name": "Empty", "owner_id": self.uid["owner"], "created_at": now(), "updated_at": now(),
            "branding": {}, "settings": {}})).inserted_id)
        await self.db["memberships"].insert_one({"workspace_id": empty_ws, "user_id": self.uid["editor"],
                                                 "role": "member", "created_at": now()})
        # Someone already given a role keeps it.
        await self.grant("viewer", "reviewer")
        await self.get(f"/{site['id']}", "editor", expect=404)

        self.assertEqual(await roles.carry_over_legacy_roles(self.db), 1)
        self.assertEqual((await self.get(f"/{site['id']}", "editor"))["your_role"], "editor")
        self.assertEqual((await self.get(f"/{site['id']}", "viewer"))["your_role"], "reviewer")
        row = await self.db["docs_studio_members"].find_one({"workspace_id": self.ws, "user_id": self.uid["editor"]})
        self.assertEqual(row["granted_by"], roles.LEGACY_GRANTOR)
        self.assertIsNone(await self.db["docs_studio_members"].find_one({"workspace_id": empty_ws}))
        people = await self.call("GET", "", "owner", 200)  # noqa: F841  (listing still works)
        members = await self.http.get(f"/api/v1/docs-studio/workspaces/{self.ws}/members", headers=self.h["owner"])
        rows = {m["user_id"]: m for m in members.json()["members"]}
        self.assertEqual(rows[self.uid["editor"]]["granted_by_name"], "Markdrop")

        # Once only: later members of the workspace start from none.
        await self.db["docs_studio_members"].delete_many({"user_id": self.uid["editor"]})
        self.assertEqual(await roles.carry_over_legacy_roles(self.db), 0)
        await self.get(f"/{site['id']}", "editor", expect=404)
