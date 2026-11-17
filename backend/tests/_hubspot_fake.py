"""A fake HubSpot (the REST API Markdrop's HubSpot integration calls), in process, for the tests. Nothing
leaves the machine.

* ``POST /oauth/v2/private-apps/get/access-token-info`` {tokenKey}: the token's hubId and scopes (a
  private app token); for a service key (:attr:`FakeHubSpot.service_key`) it answers 400 like a token
  HubSpot doesn't describe there, and the scopes are probed.
* ``GET /account-info/v3/details``, ``GET /crm/v3/owners``, ``GET /crm/v3/pipelines/deals``.
* CRM v3 objects (contacts, companies, deals, meetings, tasks): list (``?limit``), get, create (with
  ``associations``), PATCH, ``batch/read``, ``search`` (EQ, IN, BETWEEN and ``query`` on the name).
* Associations v4: a record's list, ``batch/read`` and ``PUT …/associations/default/<to>/<id>``.

Scopes are enforced like HubSpot (403 ``MISSING_SCOPES``); activities (meetings, tasks) need the contacts
scopes. :meth:`limit` makes the next calls answer 429 with Retry-After. :attr:`calls` logs every request.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

import httpx

API = "https://api.hubspot.test"
TOKEN = "fake-hubspot-key-for-tests-only"
PORTAL = 4242
ALL_SCOPES = ["crm.objects.contacts.read", "crm.objects.contacts.write", "crm.objects.companies.read",
              "crm.objects.deals.read", "crm.objects.owners.read", "oauth"]
NEEDS = {"contacts": "crm.objects.contacts", "companies": "crm.objects.companies", "deals": "crm.objects.deals",
         "meetings": "crm.objects.contacts", "tasks": "crm.objects.contacts"}


def ms(dt: str) -> int:
    return int(datetime.fromisoformat(dt.replace("Z", "+00:00")).timestamp() * 1000)


class FakeHubSpot:
    def __init__(self):
        self.token = TOKEN
        self.portal = PORTAL
        self.scopes = list(ALL_SCOPES)
        self.service_key = False
        self.objects: dict[str, dict[str, dict]] = {k: {} for k in ("contacts", "companies", "deals", "meetings", "tasks")}
        self.links: set[tuple[str, str, str, str]] = set()
        self.owners: list[dict] = []
        self.pipelines = [{"id": "default", "label": "Sales Pipeline", "stages": [
            {"id": "appointmentscheduled", "label": "Appointment scheduled", "metadata": {"isClosed": "false"}},
            {"id": "qualifiedtobuy", "label": "Qualified to buy", "metadata": {"isClosed": "false"}},
            {"id": "closedwon", "label": "Closed won", "metadata": {"isClosed": "true"}},
            {"id": "closedlost", "label": "Closed lost", "metadata": {"isClosed": "true"}}]}]
        self.calls: list[tuple[str, str]] = []
        self.bodies: list[tuple[str, str, dict | None]] = []
        self.n = 1000
        self._limit = 0

    # ── World ──

    def _id(self) -> str:
        self.n += 1
        return str(self.n)

    def add_owner(self, email: str, first: str, last: str = "") -> str:
        oid = str(70000 + len(self.owners))
        self.owners.append({"id": oid, "email": email, "firstName": first, "lastName": last, "userId": 9000 + len(self.owners)})
        return oid

    def add(self, kind: str, **props) -> str:
        rid = self._id()
        self.objects[kind][rid] = {"id": rid, "properties": {k: (None if v is None else str(v)) for k, v in props.items()},
                                   "updatedAt": props.get("hs_lastmodifieddate") or "2026-11-01T00:00:00Z"}
        return rid

    def link(self, a: str, aid: str, b: str, bid: str) -> None:
        self.links.add((a, str(aid), b, str(bid)))
        self.links.add((b, str(bid), a, str(aid)))

    def linked(self, a: str, aid: str, b: str) -> list[str]:
        return sorted({t for (x, xid, y, t) in self.links if x == a and xid == str(aid) and y == b})

    def limit(self, n: int = 1) -> None:
        self._limit = n

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    # ── HTTP ──

    def _json(self, status: int, body, **headers) -> httpx.Response:
        return httpx.Response(status, json=body, headers=headers)

    def _err(self, status: int, message: str, category: str = "") -> httpx.Response:
        return self._json(status, {"status": "error", "message": message, "category": category, "correlationId": "x"})

    def _need(self, scope: str) -> httpx.Response | None:
        if scope not in self.scopes:
            return self._err(403, f"This app hasn't been granted all required scopes: {scope}", "MISSING_SCOPES")
        return None

    def _handle(self, req: httpx.Request) -> httpx.Response:
        path = req.url.path
        body = json.loads(req.content) if req.content else None
        self.calls.append((req.method, path))
        self.bodies.append((req.method, path, body))
        if self._limit > 0:
            self._limit -= 1
            return self._json(429, {"status": "error", "message": "You have reached your secondly limit.", "category": "RATE_LIMITS"},
                              **{"Retry-After": "1"})
        if path == "/oauth/v2/private-apps/get/access-token-info":
            if (body or {}).get("tokenKey") != self.token or self.service_key:
                return self._err(400, "Token not found")
            return self._json(200, {"userId": 1, "hubId": self.portal, "appId": 77, "scopes": self.scopes})
        if req.headers.get("Authorization") != f"Bearer {self.token}":
            return self._err(401, "Authentication credentials not found.", "INVALID_AUTHENTICATION")
        parts = [p for p in path.split("/") if p]
        if path == "/account-info/v3/details":
            return self._json(200, {"portalId": self.portal, "uiDomain": "app-eu1.hubspot.com", "timeZone": "Asia/Kolkata",
                                    "companyCurrency": "USD", "accountType": "STANDARD"})
        if path.rstrip("/") == "/crm/v3/owners":
            return self._need("crm.objects.owners.read") or self._json(200, {"results": self.owners})
        if path == "/crm/v3/pipelines/deals":
            return self._need("crm.objects.deals.read") or self._json(200, {"results": self.pipelines})
        if parts[:3] == ["crm", "v3", "objects"]:
            return self._objects(req.method, parts[3:], dict(req.url.params), body)
        if parts[:3] == ["crm", "v4", "objects"]:
            a, aid, _x, b = parts[3:7]
            if len(parts) == 9 and parts[6] == "default":
                b, bid = parts[7], parts[8]
                miss = self._need(NEEDS[a] + ".write")
                if miss:
                    return miss
                self.link(a, aid, b, bid)
                return self._json(200, {"status": "COMPLETE"})
            miss = self._need(NEEDS[a] + ".read")
            return miss or self._json(200, {"results": [{"toObjectId": int(t), "associationTypes": []} for t in self.linked(a, aid, b)]})
        if parts[:3] == ["crm", "v4", "associations"] and parts[-2:] == ["batch", "read"]:
            a, b = parts[3], parts[4]
            miss = self._need(NEEDS[a] + ".read")
            if miss:
                return miss
            res = []
            for inp in (body or {}).get("inputs") or []:
                to = self.linked(a, inp["id"], b)
                if to:
                    res.append({"from": {"id": str(inp["id"])}, "to": [{"toObjectId": int(t), "associationTypes": []} for t in to]})
            return self._json(200, {"status": "COMPLETE", "results": res})
        return self._err(404, f"No route {req.method} {path}")

    def _objects(self, method: str, rest: list[str], params: dict, body: dict | None) -> httpx.Response:
        kind = rest[0]
        store = self.objects[kind]
        write = method in ("POST", "PATCH", "PUT", "DELETE") and rest[1:2] not in (["search"], ["batch"])
        miss = self._need(NEEDS[kind] + (".write" if write else ".read"))
        if miss:
            return miss
        if len(rest) == 1 and method == "GET":
            return self._json(200, {"results": list(store.values())[: int(params.get("limit") or 10)]})
        if len(rest) == 1 and method == "POST":
            rid = self._id()
            store[rid] = {"id": rid, "properties": dict((body or {}).get("properties") or {}), "updatedAt": "2026-11-17T00:00:00Z"}
            for a in (body or {}).get("associations") or []:
                tid = str(a["to"]["id"])
                to = next((k for k, v in self.objects.items() if tid in v), None)
                if to:
                    self.link(kind, rid, to, tid)
            return self._json(201, store[rid])
        if rest[1:] == ["search"]:
            return self._json(200, self._search(kind, body or {}))
        if rest[1:] == ["batch", "read"]:
            return self._json(200, {"status": "COMPLETE", "results": [store[str(i["id"])] for i in (body or {}).get("inputs") or []
                                                                      if str(i["id"]) in store]})
        rid = rest[1]
        if rid not in store:
            return self._err(404, "Object not found", "OBJECT_NOT_FOUND")
        if method == "GET":
            return self._json(200, store[rid])
        if method == "PATCH":
            store[rid]["properties"].update((body or {}).get("properties") or {})
            return self._json(200, store[rid])
        return self._err(405, "no")

    def _search(self, kind: str, body: dict) -> dict:
        out = []
        for o in self.objects[kind].values():
            p = o["properties"]
            ok = not body.get("filterGroups")
            for g in body.get("filterGroups") or []:
                good = True
                for f in g.get("filters") or []:
                    v = p.get(f["propertyName"])
                    op = f["operator"]
                    if op == "EQ":
                        good &= str(v or "").casefold() == str(f["value"]).casefold()
                    elif op == "IN":
                        good &= str(v or "").casefold() in {str(x).casefold() for x in f["values"]}
                    elif op == "BETWEEN":
                        good &= v is not None and int(f["value"]) <= ms(v) <= int(f["highValue"])
                    else:
                        good = False
                ok |= good
            if body.get("query"):
                ok &= str(body["query"]).casefold() in str(p.get("dealname") or p.get("name") or "").casefold()
            if ok:
                out.append(o)
        return {"total": len(out), "results": out[: int(body.get("limit") or 10)]}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
