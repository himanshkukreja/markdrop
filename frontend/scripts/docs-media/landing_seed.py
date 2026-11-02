#!/usr/bin/env python3
"""The guide the Markdrop Guides landing loops read (shots/e-guides-landing.mjs): "Acme Cloud".

    STACK_ID=51 backend/.venv/bin/python frontend/scripts/docs-media/landing_seed.py

Run after seed.py (+ seed_extra_studio.py for the Fix list clip), with the whole stack up and
MARKDROP_DOCS_ACCESS_SECRET set in stack/.env (stack.sh hands it to the site server; private pages
need it). Builds, as Maya Chen (maya@acme.com):

  file   the Acme pricing calculator (embeds/acme-pricing-calculator.html) as a Markdrop HTML file,
         marked as seed data so the capture runner's /__sandbox/cleanup keeps it
  guide  Acme Cloud (acme-cloud): Plans and pricing (the calculator embedded), Single sign-on (a
         Northwind-only private section), Get started, and an Enterprise group private to Northwind
         (anyone @northwind.com); published
  host   acme-cloud.guides.localhost: the site server answers it, and the API counts it as one of the
         guide's addresses. A *.localhost origin is a secure context on plain http, so the reader
         sign-in's __Host- cookie sticks in the capture browser.

Local only (seed.py's guards: local Mongo db markdrop_docs_demo*, local API).
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import seed as S  # noqa: E402

db, http, DATA, STACK_ID = S.db, S.http, S.DATA, S.STACK_ID
SITES_PORT = 3405 + 10 * STACK_ID
SLUG = "acme-cloud"
LOCAL_HOST = f"{SLUG}.guides.localhost"

CALC = ("::markdrop{src=\"https://markdrop.in/acme-pricing-calculator\" title=\"Acme pricing calculator\" height=560 "
        "summary=\"Pick a plan (Starter 9, Team 19 or Scale 39 dollars per seat a month), set the number of seats and choose "
        "monthly or yearly billing; the monthly and yearly totals update as you go. Fictional prices.\"}")
PAGES = [
    ("/billing/pricing", "Plans and pricing", "Work out what Acme costs for your team before you upgrade.", "Billing",
     "Work out what Acme costs for your team before you upgrade. Pick a plan and the number of seats: the totals update as you go.\n\n"
     f"{CALC}\n\n## Change your plan\n\nOpen **Settings › Billing** and choose **Change plan**. The new price starts with your next invoice.\n"),
    ("/guides/single-sign-on", "Single sign-on", "Connect Acme Cloud to your identity provider with SAML or OIDC.", "Get started",
     "Single sign-on lets your people sign in with the identity provider you already use.\n\n"
     ":::private[Northwind tenant values]{access=\"northwind\"}\n## Northwind tenant values\n\n"
     "Use the entity id `urn:acme:northwind-prod-4471` and the reply address from your onboarding email.\n\n"
     "The signing certificate rotates every ninety days, on the first Monday.\n:::\n\n"
     "## Choose a protocol\n\nAcme Cloud speaks SAML 2.0 and OpenID Connect. Pick the one your provider recommends.\n\n"
     "## Test the connection\n\nOpen **Settings › Single sign-on** and choose **Test**. A new window signs you in through your provider.\n"),
    ("/guides/start", "Get started", "Create a workspace, invite your team and deploy.", "Get started",
     "Acme Cloud runs your builds close to your users.\n\n## Create a workspace\n\nOpen the dashboard and choose **New workspace**.\n"),
    ("/enterprise/sso-northwind", "SSO setup for Northwind", "Northwind's SAML connection, step by step.", "Enterprise",
     "This page is for Northwind's identity team.\n\n## Configure Okta\n\n1. Create a SAML app named **Acme Cloud (Northwind)**.\n2. Upload the metadata file.\n"),
]


def main() -> None:
    if not S.env_value("MARKDROP_DOCS_ACCESS_SECRET"):
        sys.exit("landing_seed.py: set MARKDROP_DOCS_ACCESS_SECRET in stack/.env (then stack.sh restart) first")
    owner = http.post("/__sandbox/user", json={"email": "maya@acme.com", "name": "Maya Chen"}).json()
    tok = owner["token"]

    calc = (HERE / "embeds/acme-pricing-calculator.html").read_text()
    S.call("POST", "/api/v1/artifacts/paste", tok, json={"content": calc, "title": "Acme pricing calculator",
                                                          "custom_slug": "acme-pricing-calculator", "access_level": "link", "expires_in": "never"})
    db["documents"].update_many({"slug": "acme-pricing-calculator"}, {"$set": {"demo_seed": True}})

    R = "/api/v1/docs-sites"
    site = S.call("POST", R, tok, json={"workspace_id": None, "name": "Acme Cloud", "slug": SLUG, "source": {"kind": "blank"}})
    sid = site["id"]
    for path, title, desc, group, md in PAGES:
        S.call("POST", f"{R}/{sid}/pages", tok, json={"path": path, "title": title, "description": desc, "group": group, "markdown": md})
    home = next(p for p in S.call("GET", f"{R}/{sid}/pages", tok)["pages"] if p["path"] == "/")
    full = S.call("GET", f"{R}/{sid}/pages/{home['id']}", tok)
    S.call("PUT", f"{R}/{sid}/pages/{home['id']}", tok, json={"base_rev": full["rev"], "title": "Acme Cloud docs", "markdown": "Guides for Acme Cloud.\n"})
    S.call("POST", f"{R}/{sid}/private/rules", tok, json={"kind": "people", "name": "Northwind", "emails": [], "domains": ["northwind.com"]})
    S.call("PUT", f"{R}/{sid}/private/groups", tok, json={"groups": {"Enterprise": "northwind"}})
    for p in S.call("GET", f"{R}/{sid}/pages", tok)["pages"]:
        http.request("DELETE", f"{R}/{sid}/pages/{p['id']}/lock", headers={"Authorization": f"Bearer {tok}"})
    S.call("POST", f"{R}/{sid}/publish", tok, json={"note": "Pricing and single sign-on"})
    for _ in range(240):
        if (S.call("GET", f"{R}/{sid}", tok) or {}).get("status") == "live":
            break
        time.sleep(2)
    else:
        sys.exit("landing_seed.py: the publish didn't go live (see the docs worker's log)")

    # The *.localhost address: the API's list of the guide's hosts, and the site server's host map.
    from bson import ObjectId

    db["docs_sites"].update_one({"_id": ObjectId(sid)}, {"$push": {"domains": {"host": f"{LOCAL_HOST}:{SITES_PORT}", "status": "live"}}})
    hosts = DATA / "docs-store" / "hosts"
    (hosts / f"{LOCAL_HOST}.json").write_text((hosts / f"{SLUG}.guides.markdrop.in.json").read_text())
    (DATA / "fixtures_landing.json").write_text(json.dumps({"site": sid, "slug": SLUG, "url": f"http://{LOCAL_HOST}:{SITES_PORT}"}, indent=2))
    print(f"seeded Acme Cloud ({sid}) at http://{LOCAL_HOST}:{SITES_PORT}")


if __name__ == "__main__":
    main()
