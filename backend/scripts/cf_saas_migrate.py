"""Move workspace custom domains to Cloudflare for SaaS with zero downtime (services/cf_saas.py).

Every live workspace domain (verified, attached, not lapsed: today served by Vercel through its
CNAME to edge.markdrop.in) gets a Cloudflare for SaaS custom hostname with TXT pre-validation and a
Worker route ``<host>/*`` → markdrop-web, while its traffic still goes to Vercel. The customer adds
the certificate's ``_acme-challenge`` TXT record; hostname ownership is proven over HTTP on the host
itself (routers/domains.hostname_challenge), with the ``_cf-custom-hostname`` TXT record as the
fallback. edge.markdrop.in moves only once every host here shows READY (.work/cf-audit/SAAS-OWNER-STEPS.md).

    cd backend && .venv/bin/python -m scripts.cf_saas_migrate               # dry run: status, nothing written
    cd backend && .venv/bin/python -m scripts.cf_saas_migrate --apply       # create hostnames + routes, store state
    cd backend && .venv/bin/python -m scripts.cf_saas_migrate --recheck     # ask Cloudflare to validate again now
    cd backend && .venv/bin/python -m scripts.cf_saas_migrate --after-cutover  # mark ready rows attached_via cloudflare_saas
    add --json for machine-readable output.

Dry by default: it reads (Mongo, public DNS and, when MARKDROP_CF_ZONE_ID / MARKDROP_CF_SAAS_TOKEN are
set, Cloudflare's GETs) and prints what --apply would create and which TXT records each customer must
add. Idempotent: --apply adopts a hostname Cloudflare already has and never duplicates a route.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from typing import Any

from app.config import get_settings  # noqa: F401  (loads .env before the services)
from app.services import cf_saas
from app.services import domain as domain_service

LIVE_QUERY = {"status": "verified", "attached": True, "lapsed": {"$ne": True}}


def _nameservers(host: str) -> list[str]:
    """The host's zone nameservers (public DNS). A function so tests replace it."""
    try:
        from app.services import dns_provider

        return dns_provider.nameservers_for(host)
    except Exception:
        return []


def _routing(host: str) -> str:
    try:
        return domain_service.check_routing(host)[0]
    except Exception:
        return "error"


async def plan(db, mode: str = "dry-run") -> list[dict[str, Any]]:
    """One row per live domain: what Cloudflare has (or would get) and what the customer must add."""
    rows = await db["domains"].find(LIVE_QUERY).sort("host", 1).to_list(length=1000)
    out: list[dict[str, Any]] = []
    for raw in rows:
        host = raw["host"]
        ns = await domain_service._run(_nameservers, host)
        routing = await domain_service._run(_routing, host)
        item: dict[str, Any] = {
            "host": host, "workspace_id": raw.get("workspace_id"), "kind": raw.get("kind"),
            "routing": routing, "customer_dns_on_cloudflare": any(n.rstrip(".").endswith("ns.cloudflare.com") for n in ns),
            "action": None, "cf_status": None, "ssl_status": None, "ready": False, "records": [], "message": None,
        }
        cur = raw.get("cf_saas") if isinstance(raw.get("cf_saas"), dict) else {}
        st = None
        try:
            if not cf_saas.configured():
                item["action"] = "would create (Cloudflare credentials not set here)"
            elif mode == "apply":
                st = await cf_saas.ensure(host, db=db)
                item["action"] = "created or adopted, routed"
            else:
                st = await cf_saas.refresh(host, cur.get("id"), nudge=mode == "recheck")
                if st is None:
                    item["action"] = "would create" if mode != "recheck" else "missing: run --apply"
                else:
                    item["action"] = "exists" + (" (validation nudged)" if mode == "recheck" else "")
                    if "routed" in cur:
                        st["routed"] = cur["routed"]
        except cf_saas.CfSaasRefused as exc:
            item["action"] = f"refused: {exc}"
        except cf_saas.CfSaasError as exc:
            item["action"] = f"error: {exc}"
        if st is not None:
            item.update(cf_status=st["status"], ssl_status=st["ssl_status"], ready=st["ready"],
                        message=st["message"], records=[r for r in st["records"] if r["needed"]],
                        http_ownership=bool(st.get("http_body")))
            if mode != "dry-run":
                # the Domains card shows these records (a dry run writes nothing)
                await db["domains"].update_one({"_id": raw["_id"]}, {"$set": {"cf_saas": st}})
            if mode == "after-cutover" and st["ready"] and cf_saas.is_provider():
                await db["domains"].update_one({"_id": raw["_id"]}, {"$set": {"attached_via": "cloudflare_saas"}})
                item["action"] = "marked attached_via cloudflare_saas"
        out.append(item)
    return out


def render(items: list[dict[str, Any]], mode: str) -> str:
    lines = [f"Cloudflare for SaaS migration ({mode}); provider now: {get_settings().domain_provider}; "
             f"Cloudflare credentials {'set' if cf_saas.configured() else 'NOT set'}", ""]
    for it in items:
        state = "READY" if it["ready"] else "not ready"
        lines.append(f"- {it['host']}  [{it['kind']}]  workspace {it['workspace_id']}")
        lines.append(f"    routing: {it['routing']} (CNAME to the edge target)  ·  action: {it['action']}")
        if it["cf_status"] is not None:
            lines.append(f"    hostname: {it['cf_status']}  ·  certificate: {it['ssl_status']}  ·  {state}")
        if it.get("message"):
            lines.append(f"    cloudflare says: {it['message']}")
        if it["customer_dns_on_cloudflare"]:
            lines.append("    NOTE: the customer's DNS is on Cloudflare: their CNAME must stay DNS only (grey cloud);"
                         " a proxied one (orange-to-orange) can't be pre-validated")
        for r in it["records"]:
            extra = " (only if ownership isn't proven over HTTP within the hour)" if r["purpose"] == "ownership" else ""
            lines.append(f"    customer adds: {r['type']} {r['name']} = {r['value']}{extra}")
        if it["cf_status"] is not None and not it["records"] and not it["ready"]:
            lines.append("    customer adds: nothing yet (waiting on Cloudflare)")
    ready = sum(1 for it in items if it["ready"])
    lines += ["", f"{ready}/{len(items)} ready. Move edge.markdrop.in only when every live domain is READY."]
    return "\n".join(lines)


async def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = p.add_mutually_exclusive_group()
    g.add_argument("--apply", action="store_true", help="create the custom hostnames and routes")
    g.add_argument("--recheck", action="store_true", help="ask Cloudflare to validate again now")
    g.add_argument("--after-cutover", action="store_true", help="mark ready rows attached via cloudflare_saas")
    p.add_argument("--json", action="store_true")
    a = p.parse_args(argv)
    mode = "apply" if a.apply else "recheck" if a.recheck else "after-cutover" if a.after_cutover else "dry-run"
    if mode == "after-cutover" and not cf_saas.is_provider():
        print("--after-cutover needs MARKDROP_DOMAIN_PROVIDER=cloudflare_saas (set it after edge.markdrop.in moved).")
        return 2
    if mode in ("apply", "recheck") and not cf_saas.configured():
        print("Set MARKDROP_CF_ZONE_ID and MARKDROP_CF_SAAS_TOKEN first.")
        return 2

    from app.database import connect, disconnect, get_database

    await connect()
    try:
        items = await plan(get_database(), mode)
    finally:
        await disconnect()
    print(json.dumps(items, default=str, indent=2) if a.json else render(items, mode))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
