"""Renderer, merge tags, link rules and templates (pure; no database).

Run: cd backend && python -m unittest discover -s tests -v   (or pytest tests)
"""

from __future__ import annotations

import unittest

from tests import _email_env  # noqa: F401  (settings first)

from app.services.email_campaigns import links, render, tags, templates


def blocks(*bs, footer="", top_label=""):
    return {"layout": "blocks", "top_label": top_label, "footer": footer,
            "blocks": [{"id": f"b{i}", **b} for i, b in enumerate(bs)]}


def content(doc, subject="Hello {{first_name|there}}", **kw):
    return {"name": "Launch day", "subject": subject, "subject_fallback": None, "preheader": None,
            "doc": doc, "track_opens": True, "track_clicks": True, **kw}


VARS = {**tags.SAMPLE_VARS}


class MergeTags(unittest.TestCase):
    def test_value_fallback_and_empty(self):
        v = {"first_name": "Priya", "name": ""}
        self.assertEqual(tags.resolve_tags("Hi {{first_name}}", v), "Hi Priya")
        self.assertEqual(tags.resolve_tags("Hi {{ name | friend }}", v), "Hi friend")
        self.assertEqual(tags.resolve_tags("Hi {{name}}!", v), "Hi !")
        self.assertEqual(tags.resolve_tags("{{FIRST_NAME}}", v), "Priya")

    def test_conditionals(self):
        tpl = "{{#if first_name}}Hi {{first_name}}{{else}}Hello{{/if}}, you have {{#if doc_count}}{{doc_count}} docs{{else}}no docs{{/if}}"
        self.assertEqual(tags.resolve_tags(tpl, {"first_name": "Ann", "doc_count": "3"}), "Hi Ann, you have 3 docs")
        # "0" counts as empty for #if, so counts read naturally.
        self.assertEqual(tags.resolve_tags(tpl, {"first_name": " ", "doc_count": "0"}), "Hello, you have no docs")
        self.assertEqual(tags.resolve_tags("{{#if vscode_user}}VS Code{{/if}}", {}), "")

    def test_html_escaping(self):
        v = {"name": '<script>alert("x")</script> & \'co\''}
        out = tags.resolve_tags("<p>{{name}}</p>", v, "html")
        self.assertNotIn("<script>", out)
        self.assertIn("&lt;script&gt;", out)
        self.assertIn("&quot;", out)
        self.assertIn("&#x27;", out)
        self.assertIn("&amp;", out)
        # text mode leaves it alone (plain-text part)
        self.assertIn("<script>", tags.resolve_tags("{{name}}", v, "text"))

    def test_problems(self):
        msgs = [p["message"] for p in tags.check_field("Subject", "Hi {{frist_name}}")]
        self.assertTrue(any("did you mean {{first_name}}" in m for m in msgs), msgs)
        msgs = [p["message"] for p in tags.check_field("Body", "{{#if first_name}}x")]
        self.assertTrue(any("1 {{#if …}} but 0 {{/if}}" in m for m in msgs), msgs)
        msgs = [p["message"] for p in tags.check_field("Body", "Hi {{first_name")]
        self.assertTrue(any("Malformed" in m for m in msgs), msgs)
        msgs = [p["message"] for p in tags.check_field("Body", "{{#if nope}}x{{/if}}")]
        self.assertTrue(any("Unknown tag in" in m for m in msgs), msgs)
        self.assertEqual(tags.check_field("Body", "{{first_name|there}} {{#if email}}a{{else}}b{{/if}}"), [])

    def test_first_name(self):
        self.assertEqual(tags.first_name_of("Priya Raman"), "Priya")
        self.assertEqual(tags.first_name_of("p@x.com"), "")
        self.assertEqual(tags.first_name_of("A"), "")
        self.assertEqual(tags.first_name_of(None), "")

    def test_subject_fallback(self):
        c = {"subject": "{{first_name}}, news", "subject_fallback": "News"}
        self.assertEqual(render.render_subject(c, {"first_name": "Ann"}), "Ann, news")
        self.assertEqual(render.render_subject(c, {"first_name": ""}), "News")
        c2 = {"subject": "{{first_name|Friend}},   news", "subject_fallback": "News"}
        self.assertEqual(render.render_subject(c2, {}), "Friend, news")


class Links(unittest.TestCase):
    def test_allow_list(self):
        self.assertTrue(links.allowed_url("https://markdrop.in/new"))
        self.assertTrue(links.allowed_url("https://www.markdrop.in"))
        self.assertTrue(links.allowed_url("https://MARKDROP.IN./x"))
        self.assertTrue(links.allowed_url("https://github.com/himanshkukreja/markdrop"))
        self.assertTrue(links.allowed_url("https://github.com/himanshkukreja"))
        self.assertIsNone(links.allowed_url("https://github.com/someone-else/repo"))
        self.assertIsNone(links.allowed_url("https://github.com/himanshkukrejaX"))
        self.assertIsNone(links.allowed_url("https://evil.example/markdrop.in"))
        self.assertIsNone(links.allowed_url("https://markdrop.in.evil.example/"))
        self.assertIsNone(links.allowed_url("https://user:pw@markdrop.in/"))
        self.assertIsNone(links.allowed_url("javascript:alert(1)//markdrop.in"))
        self.assertIsNone(links.allowed_url("//markdrop.in/x"))
        self.assertTrue(links.allowed_url("https://api.markdrop.in/health"))  # same site

    def test_schemes(self):
        self.assertTrue(links.safe_scheme("https://x.y"))
        self.assertTrue(links.safe_scheme("mailto:a@b.c"))
        self.assertFalse(links.safe_scheme("javascript:alert(1)"))
        self.assertFalse(links.safe_scheme(" JavaScript:alert(1)"))
        self.assertFalse(links.safe_scheme("data:text/html,x"))
        self.assertFalse(links.safe_scheme("http://x.y", image=True))
        self.assertTrue(links.safe_scheme("https://x.y/a.png", image=True))

    def test_tokens(self):
        t = links.new_token()
        self.assertEqual(len(t), 24)
        self.assertTrue(links.valid_token(t))
        self.assertTrue(links.valid_token("test"))
        self.assertFalse(links.valid_token("../../etc"))
        self.assertTrue(links.is_non_tracking_token("preview"))


class Rendering(unittest.TestCase):
    def render(self, c, token="tok_abcdefgh12345678", v=None):
        return render.render_for(c, v or VARS, token)

    def test_blocks_render_html_and_text(self):
        c = content(blocks(
            {"type": "hero", "eyebrow": "New", "title": "Hi {{first_name}}"},
            {"type": "text", "md": "Some **bold**, *it*, `code` and [a link](https://markdrop.in/new).\n\n- one\n- two\n\n1. a\n2. b\n\n> quote\n\n### Heading"},
            {"type": "button", "label": "Open →", "url": "{{dashboard_url}}"},
            {"type": "feature", "tag": "01", "title": "Feature", "md": "Body"},
            {"type": "callout", "eyebrow": "Today", "title": "Punchy", "label": "Go", "url": "https://markdrop.in"},
            {"type": "image", "src": "https://markdrop.in/email/hero.png", "alt": "Hero", "href": "https://markdrop.in"},
            {"type": "divider"},
            {"type": "html", "html": "<p>Raw <b>bit</b></p>"},
            footer="Sent to {{email}}.", top_label="Product update",
        ))
        r = self.render(c)
        h, t = r["html"], r["text"]
        self.assertIn("Hi Priya", h)
        self.assertIn("<strong", h)
        self.assertIn("<em>it</em>", h)
        self.assertIn("<ul", h)
        self.assertIn("<ol", h)
        self.assertIn("Product update", h)
        self.assertIn("Unsubscribe</a>", h)
        self.assertIn("/api/v1/email/u/tok_abcdefgh12345678", h)
        self.assertIn("/api/v1/email/o/tok_abcdefgh12345678.gif", h)
        self.assertIn("Sent to priya@example.com.", h)
        # plain-text twin
        self.assertIn("NEW\nHi Priya", t)
        self.assertIn("- one", t)
        self.assertIn("1. a", t)
        self.assertIn("> quote", t)
        self.assertIn("HEADING", t)
        self.assertIn("Open: https://markdrop.in/dashboard", t)
        self.assertIn("a link (https://markdrop.in/new)", t)
        self.assertIn("Unsubscribe: https://api.markdrop.in/api/v1/email/u/tok_abcdefgh12345678", t)
        self.assertIn("Raw bit", t)
        self.assertEqual(render.content_problems(c), [])

    def test_click_wrapping_and_utm(self):
        c = content(blocks({"type": "text", "md": " ".join([
            "[a](https://markdrop.in/new)", "[b](https://github.com/himanshkukreja/markdrop)",
            "[c](https://github.com/other/x)", "[d](https://evil.example/x)", "[e](mailto:hi@markdrop.in)",
            "[f](https://markdrop.in/x?utm_source=keep)",
        ])}))
        h = self.render(c)["html"]
        wrapped = "https://api.markdrop.in/api/v1/email/c/tok_abcdefgh12345678?u="
        # own domain: UTM added, then wrapped
        self.assertIn(wrapped + "https%3A%2F%2Fmarkdrop.in%2Fnew%3Futm_source%3Demail%26utm_medium%3Demail%26utm_campaign%3Dlaunch-day", h)
        self.assertIn(wrapped + "https%3A%2F%2Fgithub.com%2Fhimanshkukreja%2Fmarkdrop", h)  # allow-listed, no UTM
        self.assertIn('href="https://github.com/other/x"', h)  # not allow-listed: untouched
        self.assertIn('href="https://evil.example/x"', h)
        self.assertIn('href="mailto:hi@markdrop.in"', h)
        self.assertIn("utm_source%3Dkeep", h)  # existing utm kept
        self.assertNotIn("utm_source%3Dkeep%26utm_source", h)
        # the unsubscribe link is never wrapped
        self.assertIn('href="https://api.markdrop.in/api/v1/email/u/tok_abcdefgh12345678"', h)

    def test_tracking_off(self):
        c = content(blocks({"type": "text", "md": "[a](https://markdrop.in/new)"}), track_opens=False, track_clicks=False)
        h = self.render(c)["html"]
        self.assertNotIn("/api/v1/email/o/", h)
        self.assertNotIn("/api/v1/email/c/", h)
        self.assertIn("utm_campaign=launch-day", h)  # UTM still added

    def test_url_schemes_rejected(self):
        c = content(blocks(
            {"type": "button", "label": "Click", "url": "javascript:alert(1)"},
            {"type": "image", "src": "http://insecure.example/a.png", "alt": "x", "href": ""},
            {"type": "callout", "eyebrow": "", "title": "t", "label": "go", "url": "data:text/html,hi"},
            {"type": "text", "md": "[x](javascript:alert(2))"},
            {"type": "image", "src": "https://ok.example/a.png", "alt": "", "href": "vbscript:x"},
        ))
        problems = render.content_problems(c)
        wheres = {p["where"] for p in problems}
        self.assertIn("Block 1 · Button · url", wheres)
        self.assertIn("Block 2 · Image · src", wheres)
        self.assertIn("Block 3 · Callout · url", wheres)
        self.assertIn("Block 5 · Image · href", wheres)
        self.assertIn("Block 5 · Image · alt", wheres)
        h = self.render(c)["html"].lower()
        self.assertNotIn("javascript:", h)
        self.assertNotIn("vbscript:", h)
        self.assertNotIn("data:text", h)
        self.assertNotIn("insecure.example", h)

    def test_raw_html_neutralised_and_checked(self):
        raw = {"layout": "raw", "html": '<html><body><a href="javascript:alert(1)">x</a><a href="{{unsubscribe_url}}">u</a></body></html>', "text": ""}
        c = content(raw)
        self.assertTrue(any("javascript" in p["message"] for p in render.content_problems(c)))
        h = self.render(c)["html"]
        self.assertNotIn("javascript:", h)
        self.assertIn('href="#"', h)
        self.assertTrue(self.render(c)["text"].strip())  # text derived when empty
        no_unsub = content({"layout": "raw", "html": "<p>hi</p><!-- {{unsubscribe_url}} -->", "text": "x"})
        self.assertTrue(any("unsubscribe_url" in p["message"] for p in render.content_problems(no_unsub)))

    def test_merge_values_escaped_in_html(self):
        c = content(blocks({"type": "text", "md": "Hi {{name}}"}))
        r = self.render(c, v={**VARS, "name": "<img src=x onerror=alert(1)>"})
        self.assertNotIn("<img src=x", r["html"])
        self.assertIn("&lt;img src=x", r["html"])

    def test_empty_subject_and_blocks(self):
        problems = render.content_problems(content(blocks(), subject=" "))
        self.assertEqual({p["message"] for p in problems}, {"Subject is empty.", "Add at least one block."})

    def test_parse_content_clips_and_strips(self):
        c = render.parse_content({"subject": "a\r\nBcc: x@y.z", "doc": {"layout": "blocks", "blocks": [
            {"type": "text", "md": "x" * 30000, "evil": 1}, {"type": "nope"}]}, "audience": {"kind": "weird", "days": 99999}})
        self.assertNotIn("\n", c["subject"])
        self.assertEqual(len(c["doc"]["blocks"]), 1)
        self.assertEqual(len(c["doc"]["blocks"][0]["md"]), 20000)
        self.assertNotIn("evil", c["doc"]["blocks"][0])
        self.assertEqual(c["audience"], {"kind": "all", "days": 3650, "min": 1, "emails": ""})
        with self.assertRaises(render.ContentError):
            render.parse_content({"doc": {"layout": "pdf"}})


class Templates(unittest.TestCase):
    def test_every_template_renders(self):
        for t in templates.all_templates():
            c = {**t, "name": t["name"], "track_opens": True, "track_clicks": True}
            r = render.render_for(c, VARS, "preview")
            self.assertIn("/api/v1/email/u/preview", r["html"], t["id"])
            self.assertTrue(r["text"].strip(), t["id"])
            self.assertNotRegex(r["html"], r"\{\{[^}]*\}\}", t["id"])
            problems = render.content_problems(c)
            if t["id"] == "blank-html":
                self.assertEqual([p["message"] for p in problems], ["Subject is empty."])
            else:
                self.assertEqual(problems, [], t["id"])

    def test_welcome_conditional(self):
        t = templates.get_template("welcome")
        c = {**t, "name": "w"}
        self.assertIn("Welcome, Priya", render.render_for(c, VARS, "preview")["html"])
        self.assertIn("Welcome to Markdrop", render.render_for(c, {**VARS, "first_name": ""}, "preview")["html"])
        self.assertNotIn("only welcome email", t["doc"]["html"])


if __name__ == "__main__":
    unittest.main()
