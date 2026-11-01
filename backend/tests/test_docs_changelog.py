"""A guide's changelog (services/docs_site_changelog.py, routers/docs_site_changelog.py).

Entries and settings: every endpoint, who may use it, the checks on each field; what a publish
freezes and the exact changelog.json (and site.json tab, videos.json) the engine reads; the
"what changed" list, Compare and the publish history; and turning a page of dated release notes
into entries. The docs bucket is the in-memory one of _docs_sites_env; all data is fictional.
"""

from __future__ import annotations

import json
import unittest

from bson import ObjectId

from tests._docs_sites_env import BASE, DocsSitesCase

from app.limiter import limiter
from app.services import docs_site_changelog as changelog
from app.services import docs_snapshot

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
MP4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"\x00" * 64

RELEASE_NOTES = """# Release notes

Everything we shipped in Northwind.

## March 4, 2026 · New dark mode

Northwind now follows your system's dark mode. Pick a theme in **Settings › Appearance**.

### Also in this release

- Faster search

## v2.3.0 (2026-02-12)

Fixed a bug where exports stopped at 10,000 rows.

## 2026-01-20

Improved the import screen: it shows each file's progress.

```md
## 2025-12-01 not a heading inside code
```

## Large imports

_Released on January 5, 2026_

Fixed the import of files over 2 GB.

## Roadmap

No date here, so it isn't a release.
"""


class Base(DocsSitesCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.site = await self.create("acme")
        self.sid = self.site["id"]

    async def entry(self, who: str = "editor", expect: int = 201, **body) -> dict:
        body = {"title": "Dark mode", "summary": "Northwind follows your system's dark mode.", **body}
        return await self.call("POST", f"/{self.sid}/changelog/entries", who, expect, json=body)

    async def upload(self, data: bytes, name: str, ctype: str) -> dict:
        r = await self.http.post(f"{BASE}/{self.sid}/assets", files={"file": (name, data, ctype)},
                                 headers=self.h["editor"])
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()

    async def settings(self, who: str = "editor", expect: int = 200, **body) -> dict:
        return await self.call("PUT", f"/{self.sid}/changelog/settings", who, expect, json=body)

    async def publish(self) -> dict:
        limiter.reset()
        return await self.call("POST", f"/{self.sid}/publish", "admin", 202, json={})

    async def files(self, build_id: str) -> dict:
        b = await self.db["docs_builds"].find_one({"_id": ObjectId(build_id)})
        return (await docs_snapshot.bundle(self.db, b))["bundle"]["files"]


class Entries(Base):
    async def test_create_read_list(self):
        empty = await self.get(f"/{self.sid}/changelog")
        self.assertEqual((empty["entries"], empty["removed"], empty["ever_published"]), ([], [], False))
        self.assertEqual(empty["settings"], {"title": "", "description": "", "products": [], "next": []})
        e = await self.entry(body="## What changed\n\nEverything.", highlights=["Follows the system", "  "])
        self.assertEqual((e["slug"], e["kind"], e["area"], e["status"], e["rev"]), ("dark-mode", "new", "General", "new", 1))
        self.assertEqual(e["date"], changelog.today())
        self.assertEqual(e["highlights"], ["Follows the system"])
        self.assertEqual(e["body"], "## What changed\n\nEverything.")
        self.assertEqual(e["updated_by_name"], "Editor")
        got = await self.get(f"/{self.sid}/changelog/entries/{e['id']}", "viewer")
        self.assertEqual(got["body"], e["body"])
        # The same title again: the next free address.
        e2 = await self.entry(date="2026-01-05", kind="fixed", area="Exports")
        self.assertEqual(e2["slug"], "dark-mode-2")
        listing = await self.get(f"/{self.sid}/changelog", "viewer")
        self.assertEqual([x["id"] for x in listing["entries"]], [e["id"], e2["id"]])  # newest first
        self.assertNotIn("body", listing["entries"][0])
        self.assertTrue(listing["entries"][0]["has_body"])
        kinds = [e["meta"]["entry_kind"] async for e in self.db["docs_events"].find({"kind": "docs_changelog_entry_created"})]
        self.assertEqual(sorted(kinds), ["fixed", "new"])

    async def test_permissions(self):
        e = await self.entry()
        await self.entry("viewer", 403)
        await self.entry("stranger", 404)
        await self.get(f"/{self.sid}/changelog", "stranger", 404)
        await self.call("PUT", f"/{self.sid}/changelog/entries/{e['id']}", "viewer", 403, json={"title": "x"})
        await self.call("DELETE", f"/{self.sid}/changelog/entries/{e['id']}", "viewer", 403)
        await self.call("POST", f"/{self.sid}/changelog/entries/{e['id']}/duplicate", "viewer", 403)
        await self.settings("viewer", 403, title="Releases")
        await self.call("POST", f"/{self.sid}/changelog/import-page", "viewer", 403, json={"page_id": "x" * 24})
        # Viewers read everything.
        await self.get(f"/{self.sid}/changelog/entries/{e['id']}", "viewer")
        await self.get(f"/{self.sid}/changelog/media", "viewer")
        await self.get(f"/{self.sid}/changelog/candidates", "viewer")
        # Reviewers write like editors; admins and the owner too.
        await self.grant("viewer", "reviewer")
        await self.entry("viewer", title="By a reviewer")
        await self.entry("admin", title="By an admin")
        # Another guide's entry is not found here.
        other = await self.create("other")
        await self.call("GET", f"/{other['id']}/changelog/entries/{e['id']}", expect=404)
        r = await self.http.get(f"{BASE}/{self.sid}/changelog")
        self.assertEqual(r.status_code, 401)

    async def test_validation(self):
        bad = [
            ({"title": ""}, "Add a title"),
            ({"summary": "  "}, "summary"),
            ({"title": "x" * 121}, "at most 120"),
            ({"summary": "y" * 281}, "at most 280"),
            ({"date": "2026-02-30"}, "doesn't exist"),
            ({"date": "March 4"}, "2026-11-01"),
            ({"date": "1999-12-31"}, "between 2000 and 2100"),
            ({"slug": "Not A Slug"}, "lowercase"),
            ({"area": "a" * 41}, "at most 40"),
            ({"highlights": ["h"] * 9}, "at most 8"),
            ({"products": ["web"]}, "settings"),
            ({"versions": {"web": "1.0"}}, "settings"),
            ({"try": {"label": "Open", "href": "javascript:alert(1)"}}, "https://"),
            ({"try": {"label": "Open", "href": "http://example.com"}}, "https://"),
            ({"try": {"label": "Open", "href": "https://127.0.0.1/x"}}, "public"),
            ({"docs": ["0" * 24]}, "isn't in this guide"),
            ({"media": {"image": "https://elsewhere.example/x.png"}}, "this guide's files"),
            ({"media": {"image": "/docs-assets/" + "a" * 64 + ".png"}}, "Upload it first"),
            ({"media": {"video": "/docs-assets/x.png"}}, "MP4"),
            ({"media": {"image": "/docs-assets/../secret.png"}}, "this guide's files"),
        ]
        for body, words in bad:
            r = await self.entry(expect=422, **body)
            self.assertIn(words, r["detail"], (body, r))
        r = await self.entry(expect=413, body="x" * (changelog.MAX_BODY + 1))
        self.assertIn("50,000", r["detail"])
        # Pydantic refuses unknown fields and kinds outside the engine's set.
        await self.entry(expect=422, kind="breaking")
        await self.entry(expect=422, colour="red")
        # A taken address.
        await self.entry(slug="dark-mode")
        r = await self.entry(expect=409, slug="dark-mode")
        self.assertIn("/changelog/dark-mode", r["detail"])
        # Whitespace (newlines too) in one-line fields collapses.
        e = await self.entry(title="  Faster\n search ", summary="One\nline.")
        self.assertEqual((e["title"], e["summary"]), ("Faster search", "One line."))

    async def test_products_versions_media_links(self):
        s = await self.settings(products=[{"label": "Web app"}, {"id": "ios", "label": "iOS"}],
                                next=[{"title": "Offline mode", "area": "Mobile", "body": "Read without a connection."}])
        self.assertEqual(s["settings"]["products"], [{"id": "web-app", "label": "Web app"}, {"id": "ios", "label": "iOS"}])
        img = await self.upload(PNG, "shot.png", "image/png")
        vid = await self.upload(MP4, "clip.mp4", "video/mp4")
        home = await self.home(self.sid)
        e = await self.entry(products=["web-app"], versions={"ios": "v3.1.0-beta", "web-app": ""},
                             media={"image": img["url"], "video": vid["url"], "alt": "The settings screen"},
                             docs=[home["id"]], **{"try": {"label": "Open settings", "href": "/settings-guide"}})
        self.assertEqual(e["products"], ["web-app", "ios"])  # a version names its product
        self.assertEqual(e["versions"], {"ios": "v3.1.0-beta"})
        self.assertEqual(e["media"], {"image": img["url"], "video": vid["url"], "alt": "The settings screen"})
        self.assertEqual(e["try"], {"label": "Open settings", "href": "/settings-guide"})
        self.assertEqual(e["docs"], [home["id"]])
        r = await self.entry(expect=422, versions={"ios": "three point one"})
        self.assertIn("version like", r["detail"])
        # An external Try it link.
        e2 = await self.entry(**{"try": {"href": "https://app.northwind.example/settings"}})
        self.assertEqual(e2["try"], {"label": "Try it", "href": "https://app.northwind.example/settings"})
        # The media picker lists the guide's images and videos.
        media = await self.get(f"/{self.sid}/changelog/media")
        self.assertEqual({m["kind"] for m in media["items"]}, {"image", "video"})
        only = await self.get(f"/{self.sid}/changelog/media", params={"kind": "video"})
        self.assertEqual([m["url"] for m in only["items"]], [vid["url"]])
        # Taking a product off the list takes it off every entry (and its version).
        s = await self.settings(products=[{"id": "web-app", "label": "Web app"}])
        self.assertEqual(s["entries_changed"], 1)
        got = await self.get(f"/{self.sid}/changelog/entries/{e['id']}")
        self.assertEqual((got["products"], got["versions"], got["rev"]), (["web-app"], {}, 2))

    async def test_settings_validation(self):
        await self.settings(expect=422, products=[{"label": ""}])
        await self.settings(expect=422, products=[{"id": "Web", "label": "Web"}])
        r = await self.settings(expect=422, products=[{"id": "web", "label": "Web"}, {"id": "web", "label": "Web 2"}])
        self.assertIn("share the id", r["detail"])
        await self.settings(expect=422, products=[{"label": f"P{i}"} for i in range(13)])
        await self.settings(expect=422, next=[{"title": ""}])
        await self.settings(expect=422, next=[{"title": f"N{i}"} for i in range(13)])
        await self.settings(expect=422, title="t" * 61)
        s = await self.settings(title="What's new", description="Every change to Northwind.")
        self.assertEqual((s["settings"]["title"], s["settings"]["description"]), ("What's new", "Every change to Northwind."))

    async def test_save_conflict_duplicate_delete(self):
        e = await self.entry()
        saved = await self.call("PUT", f"/{self.sid}/changelog/entries/{e['id']}", json={"kind": "improved", "base_rev": 1})
        self.assertEqual((saved["kind"], saved["rev"], saved["title"]), ("improved", 2, "Dark mode"))
        stale = await self.call("PUT", f"/{self.sid}/changelog/entries/{e['id']}", "editor", 409,
                                json={"title": "Mine", "base_rev": 1})
        self.assertEqual((stale["rev"], stale["updated_by_name"]), (2, "Owner"))
        # A new address.
        moved = await self.call("PUT", f"/{self.sid}/changelog/entries/{e['id']}", json={"slug": "night-theme"})
        self.assertEqual(moved["slug"], "night-theme")
        other = await self.entry(title="Exports")
        await self.call("PUT", f"/{self.sid}/changelog/entries/{other['id']}", expect=409, json={"slug": "night-theme"})
        dup = await self.call("POST", f"/{self.sid}/changelog/entries/{e['id']}/duplicate", "editor", 201)
        self.assertEqual((dup["slug"], dup["title"], dup["kind"], dup["status"]),
                         ("night-theme-copy", "Dark mode (copy)", "improved", "new"))
        await self.call("DELETE", f"/{self.sid}/changelog/entries/{dup['id']}", "editor")
        await self.call("GET", f"/{self.sid}/changelog/entries/{dup['id']}", expect=404)
        await self.call("GET", f"/{self.sid}/changelog/entries/not-an-id", expect=404)

    async def test_entry_limit(self):
        old = changelog.MAX_ENTRIES
        changelog.MAX_ENTRIES = 2
        try:
            e = await self.entry()
            await self.entry(title="Two")
            r = await self.entry(expect=409, title="Three")
            self.assertIn("at most 2 entries", r["detail"])
            await self.call("POST", f"/{self.sid}/changelog/entries/{e['id']}/duplicate", expect=409)
        finally:
            changelog.MAX_ENTRIES = old


class Publishing(Base):
    async def test_changelog_json_exactly_as_the_engine_reads_it(self):
        await self.settings(title="What's new", description="Every change to Northwind.",
                            products=[{"id": "web", "label": "Web app"}],
                            next=[{"title": "Offline mode", "area": "Mobile"}])
        img = await self.upload(PNG, "shot.png", "image/png")
        vid = await self.upload(MP4, "clip.mp4", "video/mp4")
        home = await self.home(self.sid)
        older = await self.entry(title="Faster exports", summary="Exports are twice as fast.", kind="improved",
                                 area="Exports", date="2026-01-10")
        newer = await self.entry(title="Dark mode", date="2026-03-04", products=["web"], versions={"web": "2.4"},
                                 body="Pick a theme in **Settings**.", highlights=["Follows the system"],
                                 media={"image": img["url"], "video": vid["url"], "alt": "Dark settings"},
                                 docs=[home["id"]], **{"try": {"label": "Open settings", "href": "/"}})
        b = await self.publish()
        files = await self.files(b["id"])
        cl = json.loads(files["changelog.json"])
        self.assertEqual(cl, {
            "products": [{"id": "web", "label": "Web app"}],
            "next": [{"title": "Offline mode", "area": "Mobile"}],
            "entries": [
                {"id": "dark-mode", "date": "2026-03-04", "title": "Dark mode", "kind": "new", "area": "General",
                 "products": ["web"], "summary": newer["summary"], "versions": {"web": "2.4"},
                 "body": "Pick a theme in **Settings**.",
                 "media": {"video": "changelog-dark-mode", "image": img["url"], "alt": "Dark settings"},
                 "try": {"label": "Open settings", "href": "/"}, "docs": ["/"],
                 "highlights": ["Follows the system"]},
                {"id": "faster-exports", "date": "2026-01-10", "title": "Faster exports", "kind": "improved",
                 "area": "Exports", "products": [], "summary": "Exports are twice as fast."},
            ],
        })
        self.assertEqual(json.loads(files["videos.json"]), {
            "changelog-dark-mode": {"src": vid["url"], "title": "Dark mode", "poster": img["url"]}})
        site = json.loads(files["site.json"])
        self.assertEqual(site["tabs"], [{"id": "docs", "label": "Docs", "href": "/"},
                                        {"id": "changelog", "label": "What's new", "href": "/changelog"}])
        self.assertEqual(site["changelog"], {"title": "What's new", "description": "Every change to Northwind."})
        # The runner fetches the files the text refers to: the image and the video are in it.
        text = "\n".join(files.values())
        self.assertIn(img["url"], text)
        self.assertIn(vid["url"], text)
        # Published: the studio says so, and nothing is left to publish.
        await self.mark_live(b["id"])
        listing = await self.get(f"/{self.sid}/changelog")
        self.assertEqual([e["status"] for e in listing["entries"]], ["published", "published"])
        self.assertTrue(listing["settings_published"])
        ch = await self.get(f"/{self.sid}/changes")
        self.assertEqual((ch["changelog"], ch["count"]), ([], 0))
        del older

    async def test_no_entries_no_changelog(self):
        b = await self.publish()
        files = await self.files(b["id"])
        self.assertNotIn("changelog.json", files)
        site = json.loads(files["site.json"])
        self.assertEqual(site["tabs"], [])
        self.assertNotIn("changelog", site)
        # Settings alone (no entries) don't make a changelog.
        await self.settings(title="Releases")
        b = await self.publish()
        self.assertNotIn("changelog.json", await self.files(b["id"]))

    async def test_tabs_beside_imported_tabs_and_the_api_reference(self):
        out = {"tabs": [{"id": "guides", "label": "Guides", "href": "/"}, {"id": "changelog", "label": "API", "href": "/api"}]}
        changelog.add_to_site(out, {"meta": {"title": "A very long changelog title indeed"}, "entries": [{}]})
        self.assertEqual(out["tabs"][-1], {"id": "changelog-tab", "label": "Changelog", "href": "/changelog"})
        # An existing /changelog tab isn't doubled.
        again = {"tabs": [{"id": "x", "label": "Updates", "href": "/changelog"}]}
        changelog.add_to_site(again, {"meta": {}})
        self.assertEqual(len(again["tabs"]), 1)

    async def test_changes_compare_and_history(self):
        a = await self.entry(title="Dark mode", date="2026-03-04")
        b_ = await self.entry(title="Faster exports", date="2026-01-10")
        ch = await self.get(f"/{self.sid}/changes")
        self.assertEqual(sorted((c["title"], c["change"]) for c in ch["changelog"]),
                         [("Dark mode", "added"), ("Faster exports", "added")])
        status = await self.get(f"/{self.sid}/publish-status")
        self.assertEqual(status["summary"]["changelog"], 2)
        b1 = await self.publish()
        await self.mark_live(b1["id"])
        # Edit one, delete one, add one, change the settings.
        await self.call("PUT", f"/{self.sid}/changelog/entries/{a['id']}", json={"summary": "Now on iOS too."})
        await self.call("DELETE", f"/{self.sid}/changelog/entries/{b_['id']}")
        await self.entry(title="Offline mode")
        await self.settings(title="Releases")
        ch = await self.get(f"/{self.sid}/changes")
        self.assertEqual(sorted((c["title"], c["change"]) for c in ch["changelog"]),
                         [("Dark mode", "modified"), ("Faster exports", "deleted"), ("Offline mode", "added")])
        self.assertIn("changelog", ch["settings_changed"])
        self.assertEqual(ch["count"], 4)
        listing = await self.get(f"/{self.sid}/changelog")
        self.assertEqual({e["title"]: e["status"] for e in listing["entries"]},
                         {"Dark mode": "changed", "Offline mode": "new"})
        self.assertEqual([r["title"] for r in listing["removed"]], ["Faster exports"])
        self.assertFalse(listing["settings_published"])
        cmp = await self.get(f"/{self.sid}/compare", params={"from": "live", "to": "drafts"})
        self.assertEqual(sorted((c["title"], c["change"]) for c in cmp["changelog"]),
                         [("Dark mode", "edited"), ("Faster exports", "removed"), ("Offline mode", "added")])
        self.assertEqual(cmp["summary"]["changelog"], 3)
        self.assertIn("changelog", cmp["summary"]["settings"])
        # A review counts changelog changes too (nothing else changed).
        await self.call("PATCH", f"/{self.sid}", json={"settings": {"review": {"required": True}}})
        review = await self.call("POST", f"/{self.sid}/reviews", "editor", 201, json={"note": "Releases"})
        self.assertEqual(review["status"], "open")
        await self.call("POST", f"/{self.sid}/reviews/{review['id']}/withdraw", "editor")
        b2 = await self.publish()
        await self.mark_live(b2["id"])
        builds = await self.get(f"/{self.sid}/builds")
        self.assertEqual([x["changes"]["changelog"] for x in builds], [3, 2])
        ch = await self.get(f"/{self.sid}/changes")
        self.assertEqual((ch["changelog"], ch["count"]), ([], 0))
        setup = await self.get(f"/{self.sid}/setup")
        self.assertEqual(setup["changelog_entries"], 2)

    async def test_snapshot_from_before_the_changelog(self):
        """A live snapshot written before the changelog existed has no changelog key: every entry
        is new, and its settings don't count as changed."""
        b1 = await self.publish()
        await self.mark_live(b1["id"])
        await self.db["docs_snapshots"].update_many({}, {"$unset": {"changelog": ""}})
        ch = await self.get(f"/{self.sid}/changes")
        self.assertEqual((ch["changelog"], ch["count"]), ([], 0))
        await self.entry()
        ch = await self.get(f"/{self.sid}/changes")
        self.assertEqual([c["change"] for c in ch["changelog"]], ["added"])
        self.assertNotIn("changelog", ch["settings_changed"])

    async def test_related_page_left_out_of_the_publish(self):
        home = await self.home(self.sid)
        e = await self.entry(docs=[home["id"]])
        part = await changelog.snapshot_part(self.db, await self.db["docs_sites"].find_one({"_id": ObjectId(self.sid)}))
        cl, videos = changelog.changelog_json(part, pages=[])
        self.assertNotIn("docs", cl["entries"][0])
        self.assertEqual(videos, {})
        self.assertEqual(part["entries"][0]["entry_id"], e["id"])


class ReleaseNotes(Base):
    def test_parse(self):
        out = changelog.parse_release_notes(RELEASE_NOTES)
        self.assertEqual(out["level"], 2)
        self.assertEqual(out["skipped"], 1)  # Roadmap: no date
        es = out["entries"]
        self.assertEqual([(e["date"], e["title"], e["kind"]) for e in es], [
            ("2026-03-04", "New dark mode", "new"),
            ("2026-02-12", "Version 2.3.0", "fixed"),
            ("2026-01-20", "Release notes for January 20, 2026", "improved"),
            ("2026-01-05", "Large imports", "fixed"),
        ])
        self.assertEqual(es[0]["summary"], "Northwind now follows your system's dark mode.")
        self.assertIn("### Also in this release", es[0]["body"])
        self.assertIn("not a heading inside code", es[2]["body"])
        # The date on the line under the heading is the entry's date, not part of its details.
        self.assertEqual(es[3]["body"], "Fixed the import of files over 2 GB.")
        self.assertEqual(es[3]["summary"], "Fixed the import of files over 2 GB.")
        self.assertEqual([e["slug"] for e in es],
                         ["new-dark-mode", "version-2-3-0", "release-notes-for-january-20-2026", "large-imports"])

    def test_dates(self):
        cases = {
            "2026-03-04": "2026-03-04", "2026/3/4 hotfix": "2026-03-04", "March 4, 2026": "2026-03-04",
            "Mar 4th 2026": "2026-03-04", "4 March 2026": "2026-03-04", "4th of March, 2026": "2026-03-04",
            "Sept. 9, 2025": "2025-09-09", "October 2025 roundup": "2025-10-01",
        }
        for text, iso in cases.items():
            self.assertEqual(changelog.find_date(text)[0], iso, text)
        for text in ("Getting started", "2026-13-40", "Version 2.3", "Feb 30, 2026"):
            self.assertIsNone(changelog.find_date(text), text)

    def test_not_release_notes(self):
        self.assertEqual(changelog.parse_release_notes("# Guide\n\n## Install\n\n## Configure\n")["entries"], [])
        # One dated section isn't enough; neither are dates on a minority of headings.
        self.assertEqual(changelog.parse_release_notes("## 2026-01-01\n\nx\n\n## Setup\n")["entries"], [])
        mostly_undated = "## 2026-01-01\n\n## 2026-02-01\n\n## A\n\n## B\n\n## C\n"
        self.assertEqual(changelog.parse_release_notes(mostly_undated)["entries"], [])
        self.assertTrue(changelog.looks_like_changelog("What's New", "/x"))
        self.assertTrue(changelog.looks_like_changelog("Anything", "/product/release-notes"))
        self.assertFalse(changelog.looks_like_changelog("Release process", "/release-process"))

    async def test_candidates_and_import(self):
        page = await self.call("POST", f"/{self.sid}/pages", "editor", 201,
                               json={"path": "/release-notes", "title": "Release notes", "markdown": RELEASE_NOTES})
        await self.call("POST", f"/{self.sid}/pages", "editor", 201,
                        json={"path": "/install", "title": "Install", "markdown": "## 2026-01-01\n\n## 2026-02-01\n"})
        c = await self.get(f"/{self.sid}/changelog/candidates")
        self.assertEqual([(p["page_id"], p["entries"], p["newest"], p["oldest"]) for p in c["pages"]],
                         [(page["id"], 4, "2026-03-04", "2026-01-05")])
        out = await self.call("POST", f"/{self.sid}/changelog/import-page", "editor", 201, json={"page_id": page["id"]})
        self.assertEqual((out["created"], out["skipped"], out["page"]["path"]), (4, 1, "/release-notes"))
        listing = await self.get(f"/{self.sid}/changelog")
        self.assertEqual([e["title"] for e in listing["entries"]],
                         ["New dark mode", "Version 2.3.0", "Release notes for January 20, 2026", "Large imports"])
        # Again: new addresses, never a clash.
        again = await self.call("POST", f"/{self.sid}/changelog/import-page", "editor", 201, json={"page_id": page["id"]})
        self.assertEqual([e["slug"] for e in again["entries"]][0], "new-dark-mode-2")
        # A page that isn't release notes.
        home = await self.home(self.sid)
        r = await self.call("POST", f"/{self.sid}/changelog/import-page", "editor", 422, json={"page_id": home["id"]})
        self.assertIn("dated release notes", r["detail"])
        # The entries publish like any other.
        b = await self.publish()
        cl = json.loads((await self.files(b["id"]))["changelog.json"])
        self.assertEqual(len(cl["entries"]), 8)


if __name__ == "__main__":
    unittest.main()
