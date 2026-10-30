#!/usr/bin/env python3
"""Extra demo data for the docs media of group C (workspaces, analytics, P2P share, AI pages).

Run after seed.py, against the same instance (STACK_ID). Idempotent: every run puts the same
state back.

    STACK_ID=3 backend/.venv/bin/python frontend/scripts/docs-media/seed_extra_c.py
        Dana's display name is "Dana Park" (as on /workspaces/sign-in-on-your-domain), the Releases
        folder has a folder link at "Anyone with the link", the password-protected Pricing FAQ is
        filed in Sales; writes .data/<N>/fixtures_c.json.

    seed_extra_c.py --live SECONDS
        Simulated live presence for /dashboard/live: five visitors (three watching Product demo at
        different points, two reading Getting started) send real engagement beacons
        (POST /api/v1/documents/<slug>/engage, browser User-Agents) every 10 s for SECONDS, plus a
        few views and a Slack unfurl in the last 30 minutes for the feed. Prints "live: ready" once
        every visitor is on the board.

    seed_extra_c.py --dns-cname-only HOST
        The fake resolver answers HOST's routing (CNAME) record but not its ownership (TXT) record,
        as when only one of the two records was added yet ("Found" / "Not found yet"). (With the
        TXT record alone the domain verifies at once and the records fold away.)

    seed_extra_c.py --new-workspace NAME     (prints its id)
    seed_extra_c.py --drop-workspace NAME
        Make a brand-new workspace of Riya's called NAME / delete Riya's workspaces called NAME.

Local only: the sandbox API (127.0.0.1) and the local demo Mongo db (markdrop_docs_demo*).
"""

from __future__ import annotations

import argparse
import json
import secrets
import signal
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import seed as S  # noqa: E402  (reuses its guards: local Mongo db + local API only)

db, call, DATA = S.db, S.call, S.DATA

UA = {
    "iphone": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
    "android": "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
    "mac": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "windows": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
}


def fixtures() -> dict:
    return json.loads((DATA / "fixtures.json").read_text())


def token(fx: dict, who: str = "riya") -> str:
    return call("POST", "/__sandbox/mint", json={"email": fx["users"][who]["email"]})["token"]


def seed_extra() -> dict:
    fx = fixtures()
    riya = token(fx)
    ws = fx["workspace"]["id"]
    db["users"].update_one({"email": "dana@globex.com"}, {"$set": {"name": "Dana Park"}})
    share = call("PUT", f"/api/v1/workspaces/{ws}/folders/{fx['workspace']['folders']['Releases']}/share", riya,
                 json={"level": "link"})
    share_id = (share.get("share") or {}).get("id") or share.get("id")
    if not share_id:
        raw = db["folders"].find_one({"_id": S.ObjectId(fx["workspace"]["folders"]["Releases"])})
        share_id = ((raw or {}).get("share") or {}).get("id")
    # The password-protected Pricing FAQ filed into Sales, so "Preview as" on Sales lists every
    # kind of reason an item stays hidden (People added, Password, Sign-in needed).
    raw = db["documents"].find_one({"slug": "pricing-faq"})
    if raw and not raw.get("workspace_id"):
        call("POST", f"/api/v1/workspaces/{ws}/items/add", riya,
             json={"slugs": ["pricing-faq"], "folder_id": fx["workspace"]["folders"]["Sales"]})
        db["documents"].update_one({"_id": raw["_id"]}, {"$set": {"updated_at": raw["updated_at"]}})
    out = {"releases_share_id": share_id}
    (DATA / "fixtures_c.json").write_text(json.dumps(out, indent=2))
    print(f"seed_extra_c: Dana Park, Releases folder link {share_id}")
    return out


# ── Live presence ─────────────────────────────────────────────────────────────

# (slug, kind, device, country, start position, referrer)
VISITORS = [
    ("product-demo", "video", "iphone", "US", 8.0, "https://acme.slack.com/"),
    ("product-demo", "video", "mac", "DE", 19.5, "https://www.linkedin.com/"),
    ("product-demo", "video", "windows", "IN", 31.0, None),
    ("getting-started", "doc", "mac", "GB", "install-the-cli", "https://www.google.com/"),
    ("getting-started", "doc", "android", "CA", "connect-a-data-source", None),
]


def recent_feed(fx: dict) -> None:
    """A few views and a Slack unfurl in the last 30 minutes (the live page's feed)."""
    # On the demo clock (the capture browser's "now"), which seed.py keeps within 20 minutes of
    # the real one: the feed's window is the server's last 30 minutes.
    now = min(datetime.now(timezone.utc), datetime.fromisoformat(fx["demo_now"]))
    db["events"].delete_many({"demo_extra_c": True})
    db["engage_sessions"].delete_many({"sid": {"$regex": "^democ"}})  # an earlier run's visitors
    rows = []
    for slug, country, mins in (("product-demo", "US", 2), ("getting-started", "GB", 4), ("q3-board-deck", "IN", 6),
                                ("product-demo", "DE", 8), ("release-notes-2-4", "FR", 9)):
        raw = db["documents"].find_one({"slug": slug})
        rows.append({"doc_id": str(raw["_id"]), "owner_id": raw.get("owner_id"), "type": "view",
                     "ts": now - timedelta(minutes=mins), "country": country, "region": None, "city": None,
                     "referrer": None, "ip_hash": f"demo-c-{secrets.token_hex(6)}", "channel": "Direct",
                     "utm_source": None, "utm_medium": None, "utm_campaign": None, "ver": None,
                     "internal": False, "device": "Desktop", "os": "macOS", "browser": "Chrome", "demo_extra_c": True})
    raw = db["documents"].find_one({"slug": "product-demo"})
    rows.append({"doc_id": str(raw["_id"]), "owner_id": raw.get("owner_id"), "type": "preview", "platform": "Slack",
                 "ts": now - timedelta(minutes=5), "demo_extra_c": True})
    db["events"].insert_many(rows)


def live(seconds: float) -> None:
    fx = fixtures()
    recent_feed(fx)
    http = S.httpx.Client(base_url=S.API, timeout=10)
    vis = []
    for slug, kind, dev, country, pos, ref in VISITORS:
        vis.append({"slug": slug, "kind": kind, "ua": UA[dev], "country": country, "pos": pos, "ref": ref,
                    "sid": f"democ{secrets.token_hex(8)}", "seq": 0, "patched": False})

    def send(v: dict, step: float) -> None:
        v["seq"] += 1
        body: dict = {"sid": v["sid"], "seq": v["seq"], "d": {"active_s": step}}
        if v["seq"] == 1:
            body["first"] = {"ref": v["ref"]} if v["ref"] else {}
        if v["kind"] == "video":
            start = v["pos"]
            v["pos"] = min(40.5, v["pos"] + step)
            if v["pos"] >= 40.5:
                v["pos"] = 2.0  # watched to the end: starts it again
            body["pos"] = {"s": round(v["pos"], 1)}
            body["d"]["media"] = {"dur": 40.6, "segs": [[round(start, 2), round(max(start + 0.5, v["pos"]), 2)]],
                                  **({"plays": 1, "startup_ms": 900} if v["seq"] == 1 else {})}
        else:
            body["pos"] = {"h": v["pos"]}
            body["d"]["depth"] = 35 if v["pos"] == "install-the-cli" else 52
            body["d"]["reached"] = ["before-you-begin", "install-the-cli"] + (
                ["connect-a-data-source"] if v["pos"] == "connect-a-data-source" else [])
        r = http.post(f"/api/v1/documents/{v['slug']}/engage", content=json.dumps(body),
                      headers={"content-type": "text/plain", "user-agent": v["ua"]})
        r.raise_for_status()
        if not v["patched"]:
            # The sandbox has no GeoIP database: give the session its country, so the live board
            # reads "someone in the US" from the next beacon on.
            raw = db["documents"].find_one({"slug": v["slug"]})
            res = db["engage_sessions"].update_one({"sid": v["sid"], "doc_id": str(raw["_id"])},
                                                   {"$set": {"country": v["country"]}})
            v["patched"] = res.matched_count > 0

    for v in vis:
        send(v, 4.0)
    for v in vis:
        send(v, 3.0)  # now carrying the country
    print("live: ready", flush=True)
    # SIGTERM (the capture stopping us) still sends each visitor's final beacon below.
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    end = time.time() + seconds
    try:
        while time.time() < end:
            time.sleep(10)
            for v in vis:
                send(v, 10.0)
    except KeyboardInterrupt:
        pass
    for v in vis:  # leave
        v["seq"] += 1
        http.post(f"/api/v1/documents/{v['slug']}/engage",
                  content=json.dumps({"sid": v["sid"], "seq": v["seq"], "final": True, "d": {}}),
                  headers={"content-type": "text/plain", "user-agent": v["ua"]})


# ── DNS, workspaces ───────────────────────────────────────────────────────────


def dns_cname_only(host: str) -> None:
    state = json.loads((DATA / "dns.json").read_text() or "{}") if (DATA / "dns.json").exists() else {}
    state[host] = {"txt": [], "cname": S.env_value("MARKDROP_CUSTOM_DOMAIN_CNAME_TARGET", "edge.markdrop.in")}
    (DATA / "dns.json").write_text(json.dumps(state, indent=2))
    print(f"dns: {host} has its CNAME record only")


def drop_workspace(name: str) -> None:
    fx = fixtures()
    riya = token(fx)
    for w in (call("GET", "/api/v1/workspaces", riya) or {}).get("workspaces", []):
        if w.get("name") == name and w.get("id") not in (fx["workspace"]["id"], fx["northwind"]["id"]):
            call("DELETE", f"/api/v1/workspaces/{w['id']}", riya, json={"confirm_name": name})
            print(f"dropped workspace {name} ({w['id']})")


def new_workspace(name: str) -> None:
    """A brand-new workspace of Riya's (its "Get set up" checklist), dated an hour before the
    demo clock so the capture browser (frozen at demo_now) sees it as new. Prints its id."""
    drop_workspace(name)
    fx = fixtures()
    w = call("POST", "/api/v1/workspaces", token(fx), json={"name": name})
    at = datetime.fromisoformat(fx["demo_now"]) - timedelta(hours=1)
    db["workspaces"].update_one({"_id": S.ObjectId(w["id"])}, {"$set": {"created_at": at}})
    db["memberships"].update_many({"workspace_id": w["id"]}, {"$set": {"created_at": at}})
    print(w["id"])


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--live", type=float, metavar="SECONDS")
    ap.add_argument("--dns-cname-only", metavar="HOST")
    ap.add_argument("--drop-workspace", metavar="NAME")
    ap.add_argument("--new-workspace", metavar="NAME")
    a = ap.parse_args()
    if a.live:
        live(a.live)
    elif a.dns_cname_only:
        dns_cname_only(a.dns_cname_only)
    elif a.new_workspace:
        new_workspace(a.new_workspace)
    elif a.drop_workspace:
        drop_workspace(a.drop_workspace)
    else:
        seed_extra()
