"""The web-embed allowlist (services/web_embeds.py): only these providers, only
https, and the embed URL always built here from recognised parts."""

from __future__ import annotations

import unittest

from tests._access_env import AccessWorld  # noqa: F401  (pins settings first)

from app.services import web_embeds


class Resolve(unittest.TestCase):
    def test_providers(self):
        cases = {
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m5s": "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=65",
            "https://youtu.be/dQw4w9WgXcQ": "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
            "https://www.youtube.com/shorts/dQw4w9WgXcQ": "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
            "https://vimeo.com/76979871": "https://player.vimeo.com/video/76979871",
            "https://www.loom.com/share/abc123DEF": "https://www.loom.com/embed/abc123DEF",
            "https://www.figma.com/design/AbC123/My-File?node-id=1-2&t=x":
                "https://www.figma.com/embed?embed_host=markdrop&url=https%3A%2F%2Fwww.figma.com%2Fdesign%2FAbC123%2FMy-File%3Fnode-id%3D1-2",
            "https://www.google.com/maps/embed?pb=!1m18!1m12": "https://www.google.com/maps/embed?pb=!1m18!1m12",
            "https://codepen.io/someone/pen/xyzAB": "https://codepen.io/someone/embed/xyzAB?default-tab=result",
        }
        for url, embed in cases.items():
            self.assertEqual(web_embeds.resolve(url)["embed_url"], embed, url)
        self.assertEqual(web_embeds.resolve("https://youtu.be/dQw4w9WgXcQ")["provider"], "youtube")

    def test_refused(self):
        for url in ("http://www.youtube.com/watch?v=dQw4w9WgXcQ",  # not https
                    "https://www.youtube.com/watch?v=<script>",
                    "https://www.youtube.com.evil.com/watch?v=dQw4w9WgXcQ",
                    "https://evil.com/?u=https://youtu.be/dQw4w9WgXcQ",
                    "https://user:pw@vimeo.com/1", "https://vimeo.com:8443/1",
                    "https://www.google.com/maps/place/Somewhere", "https://www.google.com/search?q=x",
                    "https://codepen.io/someone", "https://www.figma.com/", "javascript:alert(1)",
                    "https://example.com/embed", "", None, "https://" + "a" * 3000):
            self.assertIsNone(web_embeds.resolve(url), url)

    def test_check_markdown(self):
        md = ('::embed{src="https://youtu.be/dQw4w9WgXcQ"}\n\n::embed{src="https://evil.example/x"}\n'
              '::embed{url=https://vimeo.com/1}')
        self.assertEqual(web_embeds.check_markdown(md), ["https://evil.example/x"])


class Routes(AccessWorld):
    async def test_routes(self):
        r = await self.http.get("/api/v1/web-embeds/resolve", params={"url": "https://vimeo.com/76979871"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["provider"], "vimeo")
        r = await self.http.get("/api/v1/web-embeds/resolve", params={"url": "https://evil.example/"})
        self.assertEqual(r.status_code, 422)
        r = await self.http.get("/api/v1/web-embeds/providers")
        self.assertEqual([p["id"] for p in r.json()], ["youtube", "vimeo", "loom", "figma", "google_maps", "codepen"])

    async def test_mcp_refuses_other_embeds(self):
        page = await self.mkdoc("UP")
        token = await self.mcp_token("owner")
        _s, res = await self.mcp_call(token, "append_blocks", {"document": page["slug"],
                                                               "markdown": '::embed{src="https://evil.example/x"}'})
        self.assertTrue(res["isError"])
        self.assertIn("YouTube", res["content"][0]["text"])
        _s, res = await self.mcp_call(token, "append_blocks", {"document": page["slug"],
                                                               "markdown": '::embed{src="https://youtu.be/dQw4w9WgXcQ"}'})
        self.assertFalse(res["isError"], res)
        _s, res = await self.mcp_call(token, "create_page", {"title": "x",
                                                             "content": '::embed{src="https://evil.example/x"}'})
        self.assertTrue(res["isError"])
