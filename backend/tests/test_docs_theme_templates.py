"""Custom themes and saved designs ("Your templates").

* settings.theme.custom (the theme builder): validated like the engine's normalizeCustom
  (frontend/src/docs/theme.mjs), stored with snake_case keys, written to site.json in camelCase;
* /api/v1/docs-studio/theme-templates: a workspace's (or a person's) saved designs, listed for
  anyone with Guides access there, changed by its Guides admins, validated like a site's theme,
  at most 50 per workspace; applying one is an ordinary design save on the guide.

People (tests/_docs_sites_env.py): owner and admin are Guides admins, editor and viewer are
not, stranger is outside the workspace. Nothing reaches a network.
"""

from __future__ import annotations

from tests._docs_sites_env import BASE, DocsSitesCase

from app.limiter import limiter
from app.services import docs_site_settings as site_settings
from app.services import docs_theme_templates as templates
from app.services.docs_site_settings import SettingsError, default_settings, deep_merge, validate
from app.services.docs_snapshot import _theme

T = "/api/v1/docs-studio/theme-templates"

CUSTOM = {
    "light": {"bg": "#FBFAF7", "accent": "#0f766e", "code_bg": "#0d1117", "note": None},
    "dark": {"accent": "#5eead4"},
    "base_size": 17,
    "line_height": 1.7,
    "heading_weight": 600,
    "content_width": 720,
    "radius": "large",
    "buttons": "pill",
    "cards": "raised",
    "header_align": "center",
    "header_style": "transparent",
    "tab_style": "underline",
    "sidebar_style": "lines",
    "sidebar_icons": False,
    "section_tabs": True,
    "callouts": "bar",
    "code_theme": "dark",
    "links": "accent",
    "icons": "duotone",
}
DESIGN = {"preset": "editorial", "fonts": {"heading": "fraunces", "body": "figtree", "mono": "fira-code"},
          "mode": "both", "corners": None, "custom_css": None, "custom": CUSTOM}


def with_theme(theme: dict) -> dict:
    return validate(deep_merge(default_settings(), {"theme": theme}))


class CustomThemeSettings(DocsSitesCase):
    """No HTTP: the settings model and site.json (the case's DB is unused)."""

    def test_custom_theme_validates_and_normalises(self):
        got = with_theme({"preset": "editorial", "custom": CUSTOM, "fonts": DESIGN["fonts"]})["theme"]
        self.assertEqual(got["custom"]["light"]["bg"], "#fbfaf7")
        self.assertIsNone(got["custom"]["light"]["note"])
        self.assertEqual(got["custom"]["icons"], "duotone")
        self.assertEqual(got["fonts"]["mono"], "fira-code")
        # Unset is the preset as designed.
        self.assertIsNone(default_settings()["theme"]["custom"])
        self.assertIsNone(with_theme({"preset": "clean"})["theme"]["custom"])

    def test_bad_values_refused(self):
        bad = [
            {"custom": {"light": {"bg": "white"}}},
            {"custom": {"light": {"glow": "#ffffff"}}},
            {"custom": {"buttons": "blob"}},
            {"custom": {"icons": "emoji"}},
            {"custom": {"base_size": 30}},
            {"custom": {"base_size": 16.3}},
            {"custom": {"heading_weight": 650}},
            {"custom": {"line_height": 1.33}},
            {"custom": {"content_width": 2000}},
            {"custom": {"sparkle": 1}},
            {"fonts": {"mono": "inter"}},
            {"fonts": {"heading": "comic-sans"}},
        ]
        for theme in bad:
            with self.subTest(theme=theme), self.assertRaises(SettingsError):
                with_theme(theme)

    def test_site_json_gets_camel_case_and_leaves_out_unset_values(self):
        settings = with_theme({"preset": "editorial", "custom": CUSTOM, "fonts": DESIGN["fonts"]})
        out = _theme(settings)
        self.assertEqual(out["fonts"], {"heading": "fraunces", "body": "figtree", "mono": "fira-code"})
        c = out["custom"]
        self.assertEqual(c["light"], {"bg": "#fbfaf7", "accent": "#0f766e", "codeBg": "#0d1117"})
        self.assertEqual(c["dark"], {"accent": "#5eead4"})
        for k in ("baseSize", "lineHeight", "headingWeight", "contentWidth", "headerAlign", "headerStyle", "tabStyle",
                  "sidebarStyle", "codeTheme", "sectionTabs"):
            self.assertIn(k, c)
        self.assertIs(c["sidebarIcons"], False)  # false is a choice, not "unset"
        # An untouched custom block writes nothing.
        empty = with_theme({"custom": {"light": {"bg": None}, "buttons": None}})
        self.assertNotIn("custom", _theme(empty))
        self.assertNotIn("custom", _theme(default_settings()))

    def test_template_theme_has_no_brand(self):
        got = site_settings.validate_theme({**DESIGN, "brand": {"enabled": True, "logo_url": "https://x/l.png"}})
        self.assertNotIn("brand", got)
        self.assertEqual(got["custom"]["buttons"], "pill")
        with self.assertRaises(SettingsError):
            site_settings.validate_theme({"preset": "nope"})
        with self.assertRaises(SettingsError):
            site_settings.validate_theme("editorial")


class TemplatesApi(DocsSitesCase):
    async def t(self, method: str, path: str = "", who: str = "owner", expect: int = 200, **kw):
        limiter.reset()
        r = await self.http.request(method, T + path, headers=self.h[who], **kw)
        self.assertEqual(r.status_code, expect, r.text)
        return r.json()

    async def test_create_list_rename_duplicate_delete(self):
        made = await self.t("POST", json={"workspace_id": self.ws, "name": "  Acme   house style ", "theme": DESIGN}, expect=201)
        self.assertEqual(made["name"], "Acme house style")
        self.assertEqual(made["workspace_id"], self.ws)
        self.assertEqual(made["theme"]["custom"]["light"]["bg"], "#fbfaf7")
        self.assertNotIn("brand", made["theme"])

        listed = await self.t("GET", params={"workspace_id": self.ws})
        self.assertEqual([x["id"] for x in listed["templates"]], [made["id"]])
        self.assertTrue(listed["can_edit"])
        self.assertEqual(listed["limit"], 50)

        renamed = await self.t("PATCH", f"/{made['id']}", json={"name": "House style"})
        self.assertEqual(renamed["name"], "House style")
        changed = await self.t("PATCH", f"/{made['id']}", json={"theme": {**DESIGN, "preset": "minimal"}})
        self.assertEqual(changed["theme"]["preset"], "minimal")

        copy = await self.t("POST", f"/{made['id']}/duplicate", expect=201)
        self.assertEqual(copy["name"], "House style copy")
        copy2 = await self.t("POST", f"/{made['id']}/duplicate", json={}, expect=201)
        self.assertEqual(copy2["name"], "House style copy 2")
        named = await self.t("POST", f"/{made['id']}/duplicate", json={"name": "Dark launch"}, expect=201)
        self.assertEqual(named["theme"], changed["theme"])

        # Names are unique per workspace (ignoring case).
        await self.t("POST", json={"workspace_id": self.ws, "name": "house STYLE", "theme": DESIGN}, expect=409)
        await self.t("PATCH", f"/{copy['id']}", json={"name": "House style"}, expect=409)

        self.assertEqual(await self.t("DELETE", f"/{copy['id']}"), {"deleted": True, "id": copy["id"]})
        await self.t("DELETE", f"/{copy['id']}", expect=404)
        names = [x["name"] for x in (await self.t("GET", params={"workspace_id": self.ws}))["templates"]]
        self.assertEqual(sorted(names), ["Dark launch", "House style", "House style copy 2"])

    async def test_validated_like_a_sites_theme(self):
        for theme in ({"preset": "nope"}, {"custom": {"icons": "emoji"}}, {"custom_css": "@import url(https://x)"},
                      {"fonts": {"mono": "inter"}}, {"surprise": 1}):
            with self.subTest(theme=theme):
                await self.t("POST", json={"workspace_id": self.ws, "name": "Bad", "theme": theme}, expect=422)
        await self.t("POST", json={"workspace_id": self.ws, "name": "   ", "theme": DESIGN}, expect=422)
        await self.t("POST", json={"workspace_id": self.ws, "name": "x" * 61, "theme": DESIGN}, expect=422)
        made = await self.t("POST", json={"workspace_id": self.ws, "name": "Ok", "theme": DESIGN}, expect=201)
        await self.t("PATCH", f"/{made['id']}", json={"theme": {"custom": {"base_size": 99}}}, expect=422)
        await self.t("PATCH", "/not-an-id", json={"name": "x"}, expect=404)

    async def test_roles(self):
        made = await self.t("POST", json={"workspace_id": self.ws, "name": "Shared", "theme": DESIGN}, expect=201)
        # Guides admins (owner, admin) change templates; editors and viewers may only list them.
        for who in ("editor", "viewer"):
            listed = await self.t("GET", who=who, params={"workspace_id": self.ws})
            self.assertEqual(len(listed["templates"]), 1)
            self.assertFalse(listed["can_edit"])
            await self.t("POST", who=who, json={"workspace_id": self.ws, "name": "Mine", "theme": DESIGN}, expect=403)
            await self.t("PATCH", f"/{made['id']}", who=who, json={"name": "Taken"}, expect=403)
            await self.t("POST", f"/{made['id']}/duplicate", who=who, expect=403)
            await self.t("DELETE", f"/{made['id']}", who=who, expect=403)
        self.assertTrue((await self.t("GET", who="admin", params={"workspace_id": self.ws}))["can_edit"])
        await self.t("PATCH", f"/{made['id']}", who="admin", json={"name": "Renamed by admin"})
        # Outside the workspace: it doesn't exist.
        await self.t("GET", who="stranger", params={"workspace_id": self.ws}, expect=404)
        await self.t("PATCH", f"/{made['id']}", who="stranger", json={"name": "x"}, expect=404)
        await self.t("DELETE", f"/{made['id']}", who="stranger", expect=404)
        # A member with no Guides role sees nothing either.
        await self.db["docs_studio_members"].delete_many({"workspace_id": self.ws, "user_id": self.uid["viewer"]})
        await self.t("GET", who="viewer", params={"workspace_id": self.ws}, expect=404)

    async def test_personal_templates_are_their_owners(self):
        mine = await self.t("POST", who="stranger", json={"name": "My look", "theme": DESIGN}, expect=201)
        self.assertIsNone(mine["workspace_id"])
        self.assertEqual([x["name"] for x in (await self.t("GET", who="stranger"))["templates"]], ["My look"])
        # Nobody else sees or changes it, and it isn't in any workspace's list.
        self.assertEqual((await self.t("GET", who="owner"))["templates"], [])
        self.assertEqual((await self.t("GET", who="owner", params={"workspace_id": self.ws}))["templates"], [])
        await self.t("PATCH", f"/{mine['id']}", who="owner", json={"name": "Stolen"}, expect=404)
        await self.t("DELETE", f"/{mine['id']}", who="owner", expect=404)
        await self.t("DELETE", f"/{mine['id']}", who="stranger")

    async def test_limit_per_workspace(self):
        rows = [{"workspace_id": self.ws, "owner_id": self.uid["owner"], "name": f"T{i}", "name_key": f"t{i}",
                 "theme": site_settings.validate_theme(DESIGN), "created_by": self.uid["owner"],
                 "created_at": None, "updated_at": None} for i in range(templates.LIMIT)]
        await self.db[templates.COLLECTION].insert_many(rows)
        out = await self.t("POST", json={"workspace_id": self.ws, "name": "One more", "theme": DESIGN}, expect=409)
        self.assertIn("50 templates", out["detail"])
        some = (await self.t("GET", params={"workspace_id": self.ws}))["templates"][0]
        await self.t("POST", f"/{some['id']}/duplicate", expect=409)
        # Another place (a person's own) has its own room.
        await self.t("POST", json={"name": "Personal", "theme": DESIGN}, expect=201)

    async def test_applying_a_template_is_a_design_save_on_the_guide(self):
        site = await self.create("acme")
        made = await self.t("POST", json={"workspace_id": self.ws, "name": "House", "theme": DESIGN}, expect=201)
        limiter.reset()
        # The Design panel keeps the guide's brand and sends the template's design.
        r = await self.http.patch(f"{BASE}/{site['id']}", json={"settings": {"theme": made["theme"]}}, headers=self.h["owner"])
        self.assertEqual(r.status_code, 200, r.text)
        theme = r.json()["settings"]["theme"]
        self.assertEqual(theme["custom"], made["theme"]["custom"])
        self.assertEqual(theme["preset"], "editorial")
        # Whoever can't change the design (an editor) can't apply one either.
        limiter.reset()
        r = await self.http.patch(f"{BASE}/{site['id']}", json={"settings": {"theme": made["theme"]}}, headers=self.h["editor"])
        self.assertEqual(r.status_code, 403, r.text)
