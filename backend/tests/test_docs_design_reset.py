"""Reset design (services/docs_site_design.py, routers/docs_sites.py /design/*).

* the baseline is recorded when a guide is created, and replaced by the design an import leaves
  when the import changes the design (a re-import that changes nothing leaves it alone);
* a reset writes exactly the baseline through the Design save path, touches nothing but
  settings.theme, never publishes, and is idempotent;
* guides from before resets were recorded get the best baseline: their design when it was never
  saved, the created design rebuilt, an old import rebuilt from its job record, else the default;
* only Guides admins may read or reset.

People (tests/_docs_sites_env.py): owner and admin are Guides admins, editor and viewer are
not, stranger is outside the workspace. Nothing reaches a network.
"""

from __future__ import annotations

from datetime import timedelta

from bson import ObjectId

from tests._docs_sites_env import DocsSitesCase, now

from app.limiter import limiter
from app.services import docs_import_job, docs_jobs, docs_site_design
from app.services.docs_site_settings import default_settings

DESIGN = {
    "preset": "midnight",
    "brand": {"enabled": True, "logo_url": "/docs-assets/mine/logo.png", "colors": ["#ff5500", "#112233"],
              "accent": "#ff5500"},
    "fonts": {"heading": "fraunces", "body": "figtree", "mono": "fira-code"},
    "mode": "dark",
    "corners": "round",
    "custom_css": ".dx-callout { border-radius: 0; }",
    "custom": {"light": {"bg": "#fbfaf7"}, "buttons": "pill"},
}
ALL_LABELS = ["Theme", "Match my brand", "Logo", "Brand colours", "Fonts", "Colour mode", "Corners", "Custom theme",
              "Custom CSS"]
GITBOOK = {"kind": "gitbook", "url": "https://docs.acme.test/"}


def import_data(theme: dict | None = None) -> dict:
    """What the runner hands back for a GitBook import (docs_import_job.apply_import)."""
    return {
        "site": {"name": "Acme", "brand": {"name": "Acme", "logo": {"light": "/docs-assets/import/brand/logo.png", "alt": "Acme"},
                                           "favicon": "/docs-assets/import/brand/logo.png", "accent": "#535061",
                                           "accentDark": "#a09fa8", "og": {"background": "#17131f", "accent": "#a09fa8"}},
                 "theme": theme if theme is not None else {"preset": "clean", "corners": "round", "mode": "both",
                                                           "fonts": {"heading": "geist", "body": "geist"}}},
        "nav": [{"group": "Getting started", "pages": ["/start"]}],
        "pages": [{"path": "/", "title": "Home", "markdown": "home"}, {"path": "/start", "title": "Start", "markdown": "s"}],
        "report": {"counts": {"pages": 2}, "items": {},
                   "brand": {"name": "Acme", "logo": True, "logoDark": False, "favicon": True, "accent": "#535061"}},
        "assets": {"files": 1, "items": [{"rel": "import/brand/logo.png", "size": 10, "sha256": "a" * 64}]},
    }


IMPORTED_THEME = {
    "preset": "clean", "mode": "both", "corners": "round", "custom_css": None, "custom": None,
    "fonts": {"heading": "geist", "body": "geist", "mono": None},
    "brand": {"enabled": True, "logo_url": "/docs-assets/import/brand/logo.png", "logo_dark_url": None,
              "colors": ["#535061"], "accent": "#535061", "accent_dark": "#a09fa8"},
}


class DesignResetCase(DocsSitesCase):
    async def baseline(self, sid: str, who: str = "owner", expect: int = 200) -> dict:
        return await self.get(f"/{sid}/design/baseline", who, expect)

    async def reset(self, sid: str, who: str = "owner", expect: int = 200) -> dict:
        limiter.reset()
        return await self.call("POST", f"/{sid}/design/reset", who, expect)

    async def save_design(self, sid: str, theme: dict) -> dict:
        return await self.call("PATCH", f"/{sid}", json={"settings": {"theme": theme}})

    async def row(self, sid: str) -> dict:
        return await self.db["docs_sites"].find_one({"_id": ObjectId(sid)})

    async def run_import(self, sid: str, data: dict | None = None) -> dict:
        """Claim the site's queued import job and store the runner's result."""
        job = await docs_jobs.claim_next(self.db, "w1", kinds=("import",), target=None)
        self.assertIsNotNone(job)
        self.assertEqual(str(job["site_id"]), sid)
        await docs_import_job.apply_import(self.db, job, "w1", data or import_data())
        return await self.db["docs_jobs"].find_one({"_id": job["_id"]})

    async def make_legacy(self, sid: str, **set_fields) -> None:
        """A guide from before resets were recorded: no baseline on its row."""
        await self.db["docs_sites"].update_one({"_id": ObjectId(sid)}, {
            "$unset": {k: "" for k in ("design_baseline", "design_baseline_source", "design_baseline_how",
                                       "design_baseline_note", "design_baseline_at")},
            **({"$set": set_fields} if set_fields else {})})


class Created(DesignResetCase):
    async def test_baseline_recorded_at_create_and_reset_restores_it_exactly(self):
        site = await self.create()
        sid = site["id"]
        row = await self.row(sid)
        self.assertEqual((row["design_baseline_source"], row["design_baseline_how"]), ("created", "recorded"))
        self.assertEqual(row["design_baseline"], default_settings()["theme"])
        b = await self.baseline(sid)
        self.assertEqual((b["source"], b["how"], b["same"], b["changes"], b["note"]), ("created", "recorded", True, [], None))

        await self.save_design(sid, DESIGN)
        b = await self.baseline(sid)
        self.assertFalse(b["same"])
        self.assertEqual([c["label"] for c in b["changes"]], ALL_LABELS)
        self.assertEqual(b["changes"][0], {"field": "preset", "label": "Theme"})

        out = await self.reset(sid)
        self.assertEqual(out["settings"]["theme"], default_settings()["theme"])
        self.assertTrue(out["design"]["same"])
        self.assertEqual((await self.row(sid))["settings"]["theme"], row["design_baseline"])
        # A design save: the setup checklist's "Choose a look" and the publish diff see it; nothing published.
        self.assertIsNotNone((await self.row(sid))["design_saved_at"])
        self.assertEqual(await self.db["docs_builds"].count_documents({}), 0)
        self.assertEqual(await self.db["docs_jobs"].count_documents({"kind": "build"}), 0)

    async def test_reset_is_idempotent(self):
        sid = (await self.create())["id"]
        await self.save_design(sid, {"preset": "paper"})
        first = await self.reset(sid)
        before = await self.row(sid)
        second = await self.reset(sid)
        after = await self.row(sid)
        self.assertEqual(first["settings"]["theme"], second["settings"]["theme"])
        # Already the baseline: nothing is written.
        self.assertEqual(before["updated_at"], after["updated_at"])

    async def test_template_preset_is_the_created_design(self):
        sid = (await self.create("api-docs", source={"kind": "template", "template": "api"}))["id"]
        self.assertEqual((await self.row(sid))["design_baseline"]["preset"], "technical")
        await self.save_design(sid, {"preset": "playful"})
        self.assertEqual((await self.reset(sid))["settings"]["theme"]["preset"], "technical")

    async def test_only_the_design_changes(self):
        sid = (await self.create())["id"]
        await self.call("PATCH", f"/{sid}", json={"name": "Renamed", "settings": {
            "ai": {"enabled": True, "name": "Ada"}, "seo": {"index": False}, "review": {"required": True},
            "access": {"level": "password", "password": "correct horse"}, "theme": DESIGN}})
        await self.db["docs_sites"].update_one({"_id": ObjectId(sid)}, {"$set": {
            "domains": [{"host": "docs.acme.test", "status": "live"}], "engine_extra": {"brand": {"favicon_url": "/docs-assets/f.png"}}}})
        before = await self.row(sid)
        pages_before = await self.db["docs_pages"].find({"site_id": ObjectId(sid)}).to_list(length=None)
        await self.reset(sid)
        after = await self.row(sid)
        for key in ("ai", "access", "seo", "review", "insights", "nav", "api", "redirects"):
            self.assertEqual(after["settings"][key], before["settings"][key], key)
        for key in ("name", "slug", "domains", "engine_extra", "status", "live_build_id", "access_version"):
            self.assertEqual(after.get(key), before.get(key), key)
        self.assertEqual(await self.db["docs_pages"].find({"site_id": ObjectId(sid)}).to_list(length=None), pages_before)
        self.assertEqual(after["settings"]["theme"], default_settings()["theme"])

    async def test_saved_templates_are_kept_and_logos_stay_uploaded(self):
        sid = (await self.create())["id"]
        await self.db["docs_theme_templates"].insert_one({"workspace_id": self.ws, "name": "Night", "theme": {"preset": "midnight"}})
        await self.db["docs_assets"].insert_one({"site_id": ObjectId(sid), "name": "mine/logo.png", "url": "/docs-assets/mine/logo.png"})
        await self.save_design(sid, DESIGN)
        await self.reset(sid)
        self.assertEqual(await self.db["docs_theme_templates"].count_documents({"workspace_id": self.ws}), 1)
        self.assertEqual(await self.db["docs_assets"].count_documents({"site_id": ObjectId(sid)}), 1)

    async def test_permissions(self):
        sid = (await self.create())["id"]
        await self.save_design(sid, {"preset": "paper"})
        for who, code in (("editor", 403), ("viewer", 403), ("stranger", 404)):
            with self.subTest(who=who):
                await self.baseline(sid, who, code)
                await self.reset(sid, who, code)
        self.assertEqual((await self.row(sid))["settings"]["theme"]["preset"], "paper")
        self.assertTrue((await self.reset(sid, "admin"))["design"]["same"])
        await self.reset("0" * 24, expect=404)

    def test_changes_ignore_an_empty_custom_theme(self):
        base = default_settings()["theme"]
        empty = {**base, "custom": {"light": {"bg": None}, "dark": None, "buttons": None}, "custom_css": "  "}
        self.assertEqual(docs_site_design.changes(empty, base), [])
        self.assertEqual(docs_site_design._lighten("#535061", 0.45), "#a09fa8")


class Imported(DesignResetCase):
    async def test_import_look_becomes_the_baseline(self):
        sid = (await self.create("imported", source=GITBOOK))["id"]
        self.assertEqual((await self.row(sid))["design_baseline_source"], "created")
        job = await self.run_import(sid)
        row = await self.row(sid)
        self.assertEqual(row["settings"]["theme"], IMPORTED_THEME)
        self.assertEqual((row["design_baseline"], row["design_baseline_source"], row["design_baseline_how"]),
                         (IMPORTED_THEME, "import", "recorded"))
        # The job records the design it left.
        self.assertEqual(job["result"]["design"], IMPORTED_THEME)
        b = await self.baseline(sid)
        self.assertEqual((b["source"], b["same"]), ("import", True))

        await self.save_design(sid, {**DESIGN, "brand": {**DESIGN["brand"], "enabled": False}})
        out = await self.reset(sid)
        self.assertEqual(out["settings"]["theme"], IMPORTED_THEME)

    async def test_reimport_changing_nothing_keeps_the_baseline(self):
        sid = (await self.create("imported", source=GITBOOK))["id"]
        job = await self.run_import(sid)
        at = (await self.row(sid))["design_baseline_at"]
        await self.db["docs_jobs"].update_one({"_id": job["_id"]}, {"$set": {"status": "running", "locked_by": "w1"}})
        await docs_import_job.apply_import(self.db, job, "w1", import_data())
        self.assertEqual((await self.row(sid))["design_baseline_at"], at)
        # A re-import that changes the design (a new brand colour) replaces it.
        data = import_data()
        data["site"]["brand"]["accent"] = "#0f766e"
        await self.db["docs_jobs"].update_one({"_id": job["_id"]}, {"$set": {"status": "running", "locked_by": "w1"}})
        await docs_import_job.apply_import(self.db, job, "w1", data)
        row = await self.row(sid)
        self.assertEqual(row["design_baseline"]["brand"]["accent"], "#0f766e")
        self.assertEqual(row["design_baseline_source"], "import")


class Legacy(DesignResetCase):
    async def test_never_saved_keeps_its_current_design(self):
        sid = (await self.create())["id"]
        await self.db["docs_sites"].update_one({"_id": ObjectId(sid)}, {"$set": {"settings.theme.preset": "atlas"}})
        await self.make_legacy(sid)
        b = await self.baseline(sid)
        self.assertEqual((b["source"], b["how"], b["theme"]["preset"], b["same"]), ("created", "unchanged", "atlas", True))
        self.assertEqual((await self.row(sid))["design_baseline_how"], "unchanged")  # stored

    async def test_first_save_keeps_the_design_it_replaces(self):
        sid = (await self.create("imported", source=GITBOOK))["id"]
        await self.run_import(sid)
        await self.make_legacy(sid)
        await self.save_design(sid, DESIGN)
        row = await self.row(sid)
        self.assertEqual(row["design_baseline"], IMPORTED_THEME)
        self.assertEqual((row["design_baseline_source"], row["design_baseline_how"]), ("import", "recorded"))
        self.assertEqual((await self.reset(sid))["settings"]["theme"], IMPORTED_THEME)

    async def test_saved_created_guide_is_rebuilt(self):
        sid = (await self.create("support-hub", source={"kind": "template", "template": "helpcenter"}))["id"]
        await self.save_design(sid, {"preset": "paper", "corners": "sharp"})
        await self.make_legacy(sid)
        b = await self.baseline(sid)
        self.assertEqual((b["source"], b["how"], b["note"]), ("created", "rebuilt", None))
        self.assertEqual(b["theme"], {**default_settings()["theme"], "preset": "helpcenter"})
        self.assertEqual([c["field"] for c in b["changes"]], ["preset", "corners"])

    async def _old_import(self, sid: str, *, snapshot_theme: dict | None) -> None:
        """An import from before the job recorded its design, then a design save after it."""
        job = await self.run_import(sid)
        await self.db["docs_jobs"].update_one({"_id": job["_id"]}, {"$unset": {"result.design": ""}})
        if snapshot_theme is not None:
            await self.db["docs_snapshots"].insert_one({
                "site_id": ObjectId(sid), "settings": {"theme": snapshot_theme}, "created_at": now() + timedelta(seconds=1)})
        await self.save_design(sid, DESIGN)
        await self.db["docs_sites"].update_one({"_id": ObjectId(sid)}, {"$set": {"design_saved_at": now() + timedelta(seconds=5)}})
        await self.make_legacy(sid)

    async def test_old_import_is_rebuilt_from_its_record_and_first_publish(self):
        sid = (await self.create("imported", source=GITBOOK))["id"]
        await self._old_import(sid, snapshot_theme=IMPORTED_THEME)
        b = await self.baseline(sid)
        self.assertEqual((b["source"], b["how"]), ("import", "reconstructed"))
        self.assertEqual(b["theme"], IMPORTED_THEME)
        self.assertIn("rebuilt from the import", b["note"])
        self.assertIn("first publish", b["note"])
        self.assertEqual((await self.reset(sid))["settings"]["theme"], IMPORTED_THEME)

    async def test_old_import_without_a_publish_follows_the_theme_for_shape(self):
        sid = (await self.create("imported", source=GITBOOK))["id"]
        # A first publish that no longer had the import's look isn't used.
        await self._old_import(sid, snapshot_theme={**IMPORTED_THEME, "preset": "paper"})
        b = await self.baseline(sid)
        self.assertEqual(b["how"], "reconstructed")
        self.assertEqual(b["theme"], {**IMPORTED_THEME, "corners": None, "fonts": {"heading": None, "body": None, "mono": None}})
        self.assertIn("weren't recorded", b["note"])

    async def test_import_without_a_record_falls_back_to_the_default(self):
        sid = (await self.create("imported", source=GITBOOK))["id"]
        await self.db["docs_jobs"].delete_many({"site_id": ObjectId(sid)})
        await self.db["docs_sites"].update_one({"_id": ObjectId(sid)}, {"$unset": {"last_import_job_id": ""}})
        await self.save_design(sid, DESIGN)
        await self.make_legacy(sid)
        b = await self.baseline(sid)
        self.assertEqual((b["source"], b["how"]), ("created", "default"))
        self.assertEqual(b["note"], docs_site_design.NOTES["default"])
        self.assertEqual((await self.reset(sid))["settings"]["theme"], default_settings()["theme"])
