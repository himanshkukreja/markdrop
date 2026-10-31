"""Setting up a guide's own domain: the DNS provider in its own words (services/dns_provider.py, shared
with workspace domains), one-click Domain Connect links (services/domain_connect.py), the setup and
public check endpoints (services/docs_domain_setup.py, routers/docs_site_domains.py), and the email
when a domain goes live or is given up on. DNS lookups and every provider are stand-ins here: nothing
reaches the network."""

from __future__ import annotations

from tests import _email_env as env  # noqa: F401  (pins settings first)

import base64
import json
from unittest import mock
from urllib.parse import parse_qsl, unquote, urlsplit

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from app.config import get_settings
from app.services import dns_provider, docs_custom_domains as cd, docs_domain_setup as setup, domain_connect as dc
from app.services import mailer
from app.services.docs_jobs import SITES
from app.services.docs_site_redirects import after_move, clean, with_why
from tests._docs_sites_env import DocsSitesCase
from tests.test_docs_build_worker import JS, DbCase
from tests.test_docs_custom_domains import HOST, FakeSaaS, _configure

CLOUDFLARE = dns_provider._match(["amy.ns.cloudflare.com"])
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
PEM = KEY.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                        serialization.NoEncryption()).decode()


def fake_dns(case, *, provider=CLOUDFLARE, zone="acme.com", cname="cname.guides.markdrop.in"):
    """The DNS answers the setup helpers see (no lookups)."""
    setup._cache.clear()
    for name, value in (("detect", lambda host: (provider, ["amy.ns.cloudflare.com", "bob.ns.cloudflare.com"])),
                        ("zone_for", lambda host: zone), ("cname_of", lambda host: cname)):
        p = mock.patch.object(dns_provider, name, value)
        p.start()
        case.addCleanup(p.stop)


class FakeProvider:
    """A DNS provider's Domain Connect API, behind safe_fetch's transport hook."""

    def __init__(self, *, supports=True, sync_ux="https://dash.example-dns.test/dc"):
        self.supports = supports
        self.sync_ux = sync_ux
        self.calls: list[str] = []

    async def transport(self, url, host, ip, *, max_bytes, timeout, accept):
        self.calls.append(url)
        if url == "https://api.example-dns.test/dc/v2/acme.com/settings":
            body = {"providerId": "example-dns.test", "providerName": "ExampleDNS", "providerDisplayName": "Example DNS",
                    "urlSyncUX": self.sync_ux, "urlAPI": "https://api.example-dns.test/dc", "width": 640, "height": 9999}
            return 200, None, "application/json", json.dumps(body).encode()
        if url == "https://api.example-dns.test/dc/v2/domainTemplates/providers/markdrop.in/services/guides":
            return (200 if self.supports else 404), None, "application/json", b"{}"
        return 404, None, "application/json", b"{}"

    def install(self, case, txt=("api.example-dns.test/dc",)):
        dc._cache.clear()
        for name, value in (("_TXT", lambda name: list(txt) if name == "_domainconnect.acme.com" else []),
                            ("_RESOLVE", self.resolve), ("_TRANSPORT", self.transport)):
            p = mock.patch.object(dc, name, value)
            p.start()
            case.addCleanup(p.stop)
        p = mock.patch.object(JS, "docs_domain_connect_key", PEM.replace("\n", "\\n"))
        p.start()
        case.addCleanup(p.stop)

    @staticmethod
    async def resolve(host):
        return ["93.184.216.34"]


class ProviderHintTests(DbCase):
    def test_relative_names(self):
        self.assertEqual(dns_provider.relative_name("help.acme.com", "acme.com", CLOUDFLARE), "help")
        self.assertEqual(dns_provider.relative_name("acme.com.", "acme.com", CLOUDFLARE), "@")
        self.assertEqual(dns_provider.relative_name("a.b.acme.co.uk", "acme.co.uk", CLOUDFLARE), "a.b")
        self.assertEqual(dns_provider.relative_name("help.acme.com", "acme.com", None), "help.acme.com")

    def test_hint(self):
        h = dns_provider.hint("help.acme.com", {"record": "help.acme.com"}, zone="acme.com",
                              found=(CLOUDFLARE, ["amy.ns.cloudflare.com"]))
        self.assertTrue(h["detected"])
        self.assertEqual((h["provider_id"], h["host_field"], h["value_field"]), ("cloudflare", "Name", "Target"))
        self.assertEqual(h["names"], {"record": "help"})
        self.assertEqual(h["extras"], [{"label": "Proxy status", "value": "DNS only (grey cloud)"}])
        self.assertIn("acme.com", h["panel_url"])
        unknown = dns_provider.hint("help.acme.com", {"record": "help.acme.com"}, zone="acme.com", found=(None, []))
        self.assertEqual((unknown["detected"], unknown["names"]), (False, {"record": "help.acme.com"}))


class DomainConnectTests(DbCase):
    async def test_signed_apply_link(self):
        prov = FakeProvider()
        prov.install(self)
        got = await dc.one_click("help.acme.com", "acme.com", redirect_uri="https://markdrop.in/guides/x?connected=1")
        self.assertEqual((got["provider_name"], got["width"], got["height"]), ("Example DNS", 640, 750))
        url = urlsplit(got["url"])
        self.assertEqual(f"{url.scheme}://{url.netloc}{url.path}",
                         "https://dash.example-dns.test/dc/v2/domainTemplates/providers/markdrop.in/services/guides/apply")
        params = parse_qsl(url.query)
        self.assertEqual([k for k, _ in params], ["domain", "host", "redirect_uri", "key", "sig"])  # sig last
        self.assertEqual(dict(params)["host"], "help")
        self.assertEqual(dict(params)["key"], "_dcpubkeyv1")
        signed = url.query.split("&key=")[0]
        sig = base64.b64decode(unquote(url.query.rsplit("&sig=", 1)[1]))
        KEY.public_key().verify(sig, signed.encode(), padding.PKCS1v15(), hashes.SHA256())  # raises if wrong
        # Cached per zone: the second ask makes no calls.
        n = len(prov.calls)
        await dc.one_click("docs.acme.com", "acme.com")
        self.assertEqual(len(prov.calls), n)

    async def test_hidden_unless_everything_lines_up(self):
        FakeProvider(supports=False).install(self)
        self.assertIsNone(await dc.one_click("help.acme.com", "acme.com"))
        FakeProvider(sync_ux="http://insecure.example-dns.test").install(self)
        self.assertIsNone(await dc.one_click("help.acme.com", "acme.com"))
        prov = FakeProvider()
        prov.install(self, txt=())
        self.assertIsNone(await dc.one_click("help.acme.com", "acme.com"))
        self.assertEqual(prov.calls, [])
        prov.install(self, txt=("https://169.254.169.254/latest",))
        # The address is checked before any request: a private one is never fetched.
        with mock.patch.object(dc, "_RESOLVE", self._private):
            self.assertIsNone(await dc.one_click("help.acme.com", "acme.com"))
        self.assertEqual(prov.calls, [])
        prov.install(self)
        self.assertIsNone(await dc.one_click("acme.com", "acme.com"))  # a root domain: no CNAME there
        with mock.patch.object(JS, "docs_domain_connect_key", ""):
            self.assertFalse(dc.enabled())
            self.assertIsNone(await dc.one_click("help.acme.com", "acme.com"))

    @staticmethod
    async def _private(host):
        return ["10.0.0.5"]

    def test_public_key_records(self):
        with mock.patch.object(JS, "docs_domain_connect_key", PEM):
            recs = dc.public_key_records()
        self.assertTrue(recs[0].startswith("p=1,a=RS256,d="))
        der = base64.b64decode("".join(r.split(",d=", 1)[1] for r in recs))
        self.assertEqual(serialization.load_der_public_key(der).public_numbers(), KEY.public_key().public_numbers())

    def test_template_file(self):
        import pathlib

        path = pathlib.Path(__file__).resolve().parents[2] / "docs-platform/domain-connect/markdrop.in.guides.json"
        t = json.loads(path.read_text())
        self.assertEqual((t["providerId"], t["serviceId"]), (dc.PROVIDER_ID, dc.SERVICE_ID))
        self.assertEqual(t["records"], [{"type": "CNAME", "host": "@", "pointsTo": "cname.guides.markdrop.in", "ttl": 3600}])
        self.assertTrue(t["hostRequired"])
        self.assertFalse(t["syncBlock"])
        self.assertEqual(t["syncPubKeyDomain"], "markdrop.in")


class EmailTests(DbCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.cf = FakeSaaS()
        _configure(self, self.cf)
        self.sent: list[dict] = []

        async def post(payload):
            self.sent.append(payload)

        for target, name, value in ((mailer, "is_configured", lambda: True), (mailer, "_post", post)):
            p = mock.patch.object(target, name, value)
            p.start()
            self.addCleanup(p.stop)
        uid = (await self.db["users"].insert_one({"email": "Ada@Acme.com", "name": "Ada"})).inserted_id
        self.uid = str(uid)

    async def test_once_per_outcome(self):
        s = await self.make_site("acme", name="Acme Help")
        await cd.add(self.db, s, HOST, self.uid)
        self.assertTrue(await cd.notify(self.db, s["_id"], HOST, cd.LIVE))
        self.assertFalse(await cd.notify(self.db, s["_id"], HOST, cd.LIVE))  # never twice
        [mail] = self.sent
        self.assertEqual((mail["to"], mail["subject"]), (["Ada@Acme.com"], f"{HOST} is live"))
        self.assertIn("Acme Help", mail["html"])
        self.assertIn(f"https://{HOST}", mail["html"])
        self.assertTrue(await cd.notify(self.db, s["_id"], HOST, cd.FAILED))
        self.assertIn(f"/guides/{s['_id']}/settings/domains/{HOST}", self.sent[-1]["html"])

    async def test_suppressed_and_unknown_people_get_nothing(self):
        s = await self.make_site("acme")
        await cd.add(self.db, s, HOST, self.uid)
        await self.db["email_suppressions"].insert_one({"_id": "ada@acme.com", "reason": "bounce"})
        self.assertFalse(await cd.notify(self.db, s["_id"], HOST, cd.LIVE))
        await cd.add(self.db, s, "docs.acme.com", "not-an-id")
        self.assertFalse(await cd.notify(self.db, s["_id"], "docs.acme.com", cd.LIVE))
        self.assertEqual(self.sent, [])

    async def test_the_job_emails_when_it_goes_live(self):
        s = await self.make_site("acme")
        await cd.add(self.db, s, HOST, self.uid)
        await cd.reconcile(self.db, s["_id"])
        self.assertEqual(self.sent, [])
        self.cf.activate(HOST)
        await cd.reconcile(self.db, s["_id"], [HOST])
        self.assertEqual([m["subject"] for m in self.sent], [f"{HOST} is live"])
        await cd.reconcile(self.db, s["_id"], [HOST])
        self.assertEqual(len(self.sent), 1)


class RedirectWhyTests(DbCase):
    def test_why(self):
        self.assertEqual(clean([{"from": "/a/", "to": "/b", "why": "moved"}, {"from": "/c", "to": "/d", "why": "nope"}]),
                         [{"from": "/a", "to": "/b", "why": "moved"}, {"from": "/c", "to": "/d"}])
        old = [{"from": "/a", "to": "/b", "why": "moved"}]
        self.assertEqual(with_why([{"from": "/a", "to": "/b"}, {"from": "/x", "to": "/y"}], old),
                         [{"from": "/a", "to": "/b", "why": "moved"}, {"from": "/x", "to": "/y", "why": "added"}])
        self.assertEqual(with_why([{"from": "/a", "to": "/c"}], old), [{"from": "/a", "to": "/c", "why": "added"}])
        self.assertEqual(after_move([{"from": "/x", "to": "/old", "why": "added"}], "/old", "/new", add=True),
                         [{"from": "/x", "to": "/new", "why": "added"}, {"from": "/old", "to": "/new", "why": "moved"}])


class SetupApiTests(DocsSitesCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.cf = FakeSaaS()
        _configure(self, self.cf)
        p = mock.patch.object(get_settings(), "background_workers_enabled", False)
        p.start()
        self.addCleanup(p.stop)
        fake_dns(self, cname="")
        site = await self.create("acme")
        self.sid = site["id"]
        await self.call("POST", f"/{self.sid}/domains", "admin", expect=201, json={"host": HOST})

    async def test_setup_view(self):
        for who, code in (("editor", 403), ("viewer", 403), ("stranger", 404)):
            await self.call("GET", f"/{self.sid}/domains/{HOST}/setup", who, expect=code)
        await self.call("GET", f"/{self.sid}/domains/nope.acme.com/setup", "admin", expect=404)
        v = await self.get(f"/{self.sid}/domains/{HOST}/setup", "admin")
        self.assertEqual((v["zone"], v["label"]), ("acme.com", "help"))
        self.assertEqual(v["record"], {"type": "CNAME", "name": HOST, "value": "cname.guides.markdrop.in", "host": "help"})
        self.assertEqual(v["provider"]["provider_name"], "Cloudflare")
        self.assertEqual((v["record_seen"], v["record_points_to"]), (False, None))
        self.assertIsNone(v["one_click"])  # no signing key here
        self.assertEqual(v["check_url"], f"https://markdrop.in/d/check/{HOST}")
        # The record appears; "fresh" reads DNS again rather than the minute's cache.
        with mock.patch.object(dns_provider, "cname_of", lambda host: "cname.guides.markdrop.in"):
            self.assertFalse((await self.get(f"/{self.sid}/domains/{HOST}/setup", "admin"))["record_seen"])
            self.assertTrue((await self.get(f"/{self.sid}/domains/{HOST}/setup?fresh=true", "admin"))["record_seen"])
        with mock.patch.object(dns_provider, "cname_of", lambda host: "old.vendor.example.net"):
            v = await self.get(f"/{self.sid}/domains/{HOST}/setup?fresh=true", "admin")
            self.assertEqual((v["record_seen"], v["record_points_to"]), (False, "old.vendor.example.net"))

    async def test_one_click_when_the_provider_offers_it(self):
        FakeProvider().install(self)
        v = await self.get(f"/{self.sid}/domains/{HOST}/setup", "admin")
        self.assertEqual(v["one_click"]["provider_name"], "Example DNS")
        q = dict(parse_qsl(urlsplit(v["one_click"]["url"]).query))
        self.assertEqual(q["redirect_uri"], f"https://markdrop.in/guides/{self.sid}/settings/domains/{HOST}?connected=1")

    async def test_public_check(self):
        r = await self.http.get(f"/api/v1/docs-sites/domain-check/{HOST}")
        self.assertEqual(r.status_code, 200)
        v = r.json()
        self.assertEqual((v["host"], v["status"], v["record"]["host"]), (HOST, "pending", "help"))
        text = json.dumps(v)
        for secret in (self.sid, "_cf-custom-hostname", "Acme", "owner", "added_by"):
            self.assertNotIn(secret, text)
        for bad in ("nope.acme.com", "markdrop.in", "10.0.0.1"):
            self.assertEqual((await self.http.get(f"/api/v1/docs-sites/domain-check/{bad}")).status_code, 404, bad)
        # Rate-limited: it's public.
        codes = [(await self.http.get(f"/api/v1/docs-sites/domain-check/{HOST}")).status_code for _ in range(25)]
        self.assertIn(429, codes)

    async def test_imported_redirects(self):
        await self.db[SITES].update_one({"slug": "acme"}, {"$set": {"engine_extra": {"redirects": {"/old": "/new", "/a": "/b"}}}})
        got = await self.get(f"/{self.sid}/redirects/imported", "viewer")
        self.assertEqual(got, {"count": 2, "redirects": [{"from": "/old", "to": "/new"}, {"from": "/a", "to": "/b"}]})
        await self.call("GET", f"/{self.sid}/redirects/imported", "stranger", expect=404)

    async def test_redirects_keep_why(self):
        await self.db[SITES].update_one({"slug": "acme"}, {"$set": {"settings.redirects": [
            {"from": "/old", "to": "https://acme.example/x", "why": "moved"}]}})
        site = await self.call("PATCH", f"/{self.sid}", json={"settings": {"redirects": [
            {"from": "/old", "to": "https://acme.example/x"}, {"from": "/blog", "to": "https://acme.example/blog"}]}})
        self.assertEqual([r.get("why") for r in site["settings"]["redirects"]], ["moved", "added"])
