"""Link previews for bookmark blocks (services/bookmarks.py, routers/bookmarks.py).

The SSRF guard is the point: no request ever reaches a private, loopback,
link-local or metadata address — not directly, not through DNS, not through a
redirect hop — and only http(s) on the standard ports. DNS and the connection
are stand-ins here (bookmarks._resolve / _transport): nothing leaves the box.
"""

from __future__ import annotations

import asyncio
from unittest import mock

from tests._access_env import AccessWorld  # noqa: F401  (pins settings first)

from app.services import bookmarks, safe_fetch

PAGE = (b'<!doctype html><html><head><meta charset="utf-8"><title>Fallback &amp; title</title>'
        b'<meta property="og:title" content="The Title">'
        b'<meta property="og:description" content="What it is &lt;b&gt;about&lt;/b&gt;.">'
        b'<meta property="og:site_name" content="Example">'
        b'<meta property="og:image" content="/img/card.png">'
        b'<link rel="icon" sizes="16x16" href="/s.ico"><link rel="icon" sizes="64x64" href="/big.png">'
        b'</head><body><meta property="og:title" content="ignored"></body></html>')


class Bookmarks(AccessWorld):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.dns: dict[str, list[str]] = {"example.com": ["93.184.216.34"], "www.example.com": ["93.184.216.34"]}
        self.pages: dict[str, tuple] = {}
        self.connects: list[tuple[str, str]] = []

        async def resolve(host):
            if host not in self.dns:
                raise OSError("nxdomain")
            return self.dns[host]

        async def transport(url, host, ip, *, max_bytes, timeout, accept):
            self.connects.append((url, ip))
            assert not safe_fetch.blocked_address(ip), f"connected to {ip}"
            hit = self.pages.get(url)
            if hit is None:
                return 404, None, "text/html", b""
            if hit[0] == "redirect":
                return 302, hit[1], "", b""
            if hit[0] == "slow":
                await asyncio.sleep(10)
            body = hit[2]
            if len(body) > max_bytes:
                raise safe_fetch.FetchError("The file is larger than 1 MB.")
            return hit[0], None, hit[1], body

        p1 = mock.patch.object(bookmarks, "_resolve", resolve)
        p2 = mock.patch.object(bookmarks, "_transport", transport)
        for p in (p1, p2):
            p.start()
            self.addCleanup(p.stop)

    async def post(self, url, who="owner", headers=None):
        return await self.http.post("/api/v1/bookmarks/preview", json={"url": url},
                                    headers=headers if headers is not None else self.session(who))

    async def test_sign_in_required(self):
        self.assertEqual((await self.post("https://example.com/", headers={})).status_code, 401)
        self.assertEqual(self.connects, [])

    async def test_preview_parses_meta(self):
        self.pages["https://example.com/post"] = (200, "text/html; charset=utf-8", PAGE)
        r = await self.post("https://example.com/post#frag")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), {
            "url": "https://example.com/post", "title": "The Title", "description": "What it is <b>about</b>.",
            "site_name": "Example", "favicon": "https://example.com/big.png",
            "image": "https://example.com/img/card.png", "fetched": True})

    async def test_cached_for_a_day(self):
        self.pages["https://example.com/post"] = (200, "text/html", PAGE)
        await self.post("https://example.com/post")
        await self.post("https://example.com/post", "wm")
        self.assertEqual(len(self.connects), 1)
        row = await self.db["bookmark_cache"].find_one({})
        from datetime import datetime, timedelta, timezone

        exp = row["expires_at"].replace(tzinfo=timezone.utc)
        self.assertGreater(exp, datetime.now(timezone.utc) + timedelta(hours=23))

    async def test_bare_host_and_http(self):
        self.pages["https://example.com/"] = (200, "text/html", b"<title>Home</title>")
        r = await self.post("example.com")
        self.assertEqual((r.json()["url"], r.json()["title"]), ("https://example.com/", "Home"))
        self.pages["http://example.com/plain"] = (200, "text/html", b"<title>Plain</title>")
        r = await self.post("http://example.com/plain")
        self.assertEqual(r.json()["title"], "Plain")

    async def test_refused_addresses(self):
        self.dns.update({"evil.test": ["169.254.169.254"], "mixed.test": ["93.184.216.34", "10.0.0.5"],
                         "v6.test": ["fd00:ec2::254"], "mapped.test": ["::ffff:127.0.0.1"],
                         "nat64.test": ["64:ff9b::a9fe:a9fe"], "cgnat.test": ["100.100.100.200"]})
        for url in ("http://127.0.0.1/", "https://10.0.0.1/", "http://[::1]/", "http://2130706433/",
                    "http://0x7f.1/", "http://localhost/", "http://api.localhost/", "http://intranet/",
                    "https://evil.test/", "https://mixed.test/", "https://v6.test/", "https://mapped.test/",
                    "https://nat64.test/", "https://cgnat.test/",
                    "ftp://example.com/", "file:///etc/passwd", "gopher://example.com/", "javascript:alert(1)",
                    "https://user:pw@example.com/", "https://example.com:8443/", "http://example.com:6379/",
                    "https://" + "a" * 2050 + ".com/"):
            r = await self.post(url)
            self.assertEqual(r.status_code, 422, url)
        self.assertEqual(self.connects, [])
        self.assertEqual(await self.db["bookmark_cache"].count_documents({}), 0)

    async def test_every_redirect_hop_is_checked(self):
        self.dns["internal.test"] = ["192.168.1.10"]
        for target in ("http://169.254.169.254/latest/meta-data/", "https://internal.test/admin",
                       "http://127.0.0.1:8000/", "file:///etc/passwd", "https://example.com:444/"):
            self.connects.clear()
            self.pages["https://example.com/go"] = ("redirect", target)
            r = await self.post("https://example.com/go")
            self.assertEqual(r.status_code, 422, target)
            self.assertEqual([c[0] for c in self.connects], ["https://example.com/go"], target)
            await self.db["bookmark_cache"].delete_many({})

    async def test_redirect_to_public_is_followed_and_limited(self):
        self.pages["https://example.com/a"] = ("redirect", "https://www.example.com/b")
        self.pages["https://www.example.com/b"] = (200, "text/html", b"<title>B</title>")
        r = await self.post("https://example.com/a")
        self.assertEqual((r.json()["title"], r.json()["url"]), ("B", "https://example.com/a"))
        for i in range(10):
            self.pages[f"https://example.com/loop{i}"] = ("redirect", f"https://example.com/loop{i + 1}")
        r = await self.post("https://example.com/loop0")
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["fetched"])
        self.assertLessEqual(len([c for c in self.connects if "loop" in c[0]]), 6)

    async def test_failures_answer_what_we_know(self):
        r = await self.post("https://example.com/missing")  # 404
        self.assertEqual(r.json(), {"url": "https://example.com/missing", "title": "missing", "description": None,
                                    "site_name": "example.com", "favicon": "https://example.com/favicon.ico",
                                    "image": None, "fetched": False})
        r = await self.post("https://nowhere.test/")  # doesn't resolve
        self.assertFalse(r.json()["fetched"])
        self.pages["https://example.com/big"] = (200, "text/html", b"x" * (bookmarks.MAX_BYTES + 1))
        self.assertFalse((await self.post("https://example.com/big")).json()["fetched"])

    async def test_timeout(self):
        self.pages["https://example.com/slow"] = ("slow", "text/html", b"")
        with mock.patch.object(bookmarks, "TIMEOUT_S", 0.2):
            r = await self.post("https://example.com/slow")
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["fetched"])

    async def test_only_http_urls_come_back(self):
        page = (b'<title>T</title><meta property="og:image" content="javascript:alert(1)">'
                b'<link rel="icon" href="data:image/png;base64,AAAA">')
        self.pages["https://example.com/x"] = (200, "text/html", page)
        r = (await self.post("https://example.com/x")).json()
        self.assertIsNone(r["image"])
        self.assertEqual(r["favicon"], "https://example.com/favicon.ico")

    async def test_rate_limited_per_user(self):
        self.pages["https://example.com/"] = (200, "text/html", b"<title>x</title>")
        codes = [(await self.post("https://example.com/")).status_code for _ in range(31)]
        self.assertEqual(codes[:30], [200] * 30)
        self.assertEqual(codes[30], 429)
        self.assertEqual((await self.post("https://example.com/", "wm")).status_code, 200)
