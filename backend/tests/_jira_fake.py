"""A fake Atlassian (OAuth 2.0 3LO + Jira Cloud REST v3), in process, for the tests and the e2e stack
(frontend/e2e/pages/real/api_run.py, PB_FAKE_JIRA=1). Nothing leaves the machine.

* ``https://auth.jira.test/oauth/token``: codes → tokens; refresh tokens rotate (a spent one is refused
  with ``invalid_grant``, like Atlassian after its reuse window).
* ``https://api.jira.test/oauth/token/accessible-resources`` and ``/ex/jira/<cloud>/rest/api/3/…``:
  myself, project/search, createmeta issue types, priority, issue create / get, transitions,
  search/jql (``key in (…)``, ``assignee in (…)``, ``project in (…)``), user/search, webhooks.

Permissions: each account sees the projects in its ``projects`` (None: all) and may move issues
unless ``can_transition`` is False. :meth:`move` changes an issue's status as someone and returns
the webhook payload Jira would send; :meth:`jwt` signs it like Jira (HS256, the client secret).
"""

from __future__ import annotations

import json
import re
import time
from datetime import date, datetime, timezone

import httpx

AUTH = "https://auth.jira.test"
API = "https://api.jira.test"
CLOUD = "cloud-acme"
SITE_URL = "https://acme.atlassian.net"

STATUSES = {"To Do": "new", "In Progress": "indeterminate", "Blocked": "indeterminate", "In Review": "indeterminate",
            "Done": "done"}
TRANSITIONS = [("11", "To Do"), ("21", "In Progress"), ("31", "Done"), ("41", "Blocked")]


def _status(name: str) -> dict:
    return {"name": name, "statusCategory": {"key": STATUSES[name]}}


class FakeJira:
    def __init__(self):
        self.sites = {CLOUD: {"id": CLOUD, "url": SITE_URL, "name": "Acme Jira",
                              "scopes": ["read:jira-work", "write:jira-work"], "avatarUrl": None}}
        # account id -> {name, email, projects (None = all), can_transition, sites}
        self.accounts: dict[str, dict] = {}
        self.codes: dict[str, str] = {}
        self.access: dict[str, tuple[str, float]] = {}
        self.refresh: dict[str, str] = {}
        self.spent: set[str] = set()
        self.projects = {"PAY": "Payments", "WEB": "Website", "SEC": "Secret"}
        self.priorities = ["Highest", "High", "Medium", "Low"]
        self.issues: dict[str, dict] = {}
        self.seq: dict[str, int] = {}
        self.webhooks: dict[int, dict] = {}
        self.calls: list[tuple[str, str, dict | None, str | None]] = []
        self.fail: dict[str, int] = {}      # "<METHOD> <path suffix>" -> status
        self.n = 0
        self.ttl = 3600

    # ── World building ──

    def add_account(self, account_id: str, name: str, email: str | None, *, projects=None, can_transition=True,
                    sites=(CLOUD,)) -> str:
        self.accounts[account_id] = {"name": name, "email": email, "projects": set(projects) if projects else None,
                                     "can_transition": can_transition, "sites": list(sites)}
        code = f"code-{account_id}"
        self.codes[code] = account_id
        return code

    def add_issue(self, project: str, summary: str, *, status: str = "To Do", assignee: str | None = None,
                  due: str | None = None, labels=(), priority: str | None = "Medium") -> str:
        self.seq[project] = self.seq.get(project, 0) + 1
        key = f"{project}-{self.seq[project]}"
        self.issues[key] = {"id": str(10000 + len(self.issues)), "key": key, "fields": {
            "summary": summary, "status": _status(status), "project": {"key": project, "name": self.projects[project]},
            "issuetype": {"name": "Task"}, "assignee": self._user(assignee) if assignee else None, "duedate": due,
            "priority": {"name": priority} if priority else None, "labels": list(labels),
            "updated": datetime.now(timezone.utc).isoformat(), "created": datetime.now(timezone.utc).isoformat(),
            "resolutiondate": datetime.now(timezone.utc).isoformat() if STATUSES[status] == "done" else None,
            "reporter": None, "description": None}}
        return key

    def _user(self, account_id: str | None) -> dict | None:
        a = self.accounts.get(account_id or "")
        if a is None:
            return None
        return {"accountId": account_id, "displayName": a["name"], "emailAddress": a.get("email"),
                "accountType": "atlassian", "avatarUrls": {"48x48": f"https://avatar.jira.test/{account_id}.png"}}

    def move(self, key: str, status: str, by: str | None = None) -> dict:
        """Change the status as ``by`` and return Jira's webhook payload for it."""
        it = self.issues[key]
        old = it["fields"]["status"]["name"]
        it["fields"]["status"] = _status(status)
        it["fields"]["updated"] = datetime.now(timezone.utc).isoformat()
        it["fields"]["resolutiondate"] = datetime.now(timezone.utc).isoformat() if STATUSES[status] == "done" else None
        self.n += 1
        return {"timestamp": int(time.time() * 1000) + self.n, "webhookEvent": "jira:issue_updated",
                "issue_event_type_name": "issue_generic", "user": self._user(by) or {"accountId": by},
                "issue": json.loads(json.dumps(it)), "matchedWebhookIds": list(self.webhooks),
                "changelog": {"id": str(5000 + self.n), "items": [{"field": "status", "fromString": old, "toString": status}]}}

    @staticmethod
    def jwt(secret: str, *, exp_in: int = 300, **claims) -> str:
        import jwt

        now = int(time.time())
        return jwt.encode({"iss": "jira", "iat": now, "exp": now + exp_in, **claims}, secret, algorithm="HS256")

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)

    # ── HTTP ──

    def _who(self, request: httpx.Request) -> str | None:
        tok = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
        hit = self.access.get(tok)
        if hit is None or hit[1] < time.time():
            return None
        return hit[0]

    def _tokens(self, account_id: str) -> dict:
        self.n += 1
        at, rt = f"at-{account_id}-{self.n}", f"rt-{account_id}-{self.n}"
        self.access[at] = (account_id, time.time() + self.ttl)
        self.refresh[rt] = account_id
        return {"access_token": at, "refresh_token": rt, "expires_in": self.ttl, "token_type": "Bearer",
                "scope": "read:jira-work write:jira-work read:jira-user manage:jira-webhook offline_access"}

    def of(self, method: str, suffix: str) -> list[dict | None]:
        return [b for m, p, b, _w in self.calls if m == method and p.endswith(suffix)]

    def _sees(self, account_id: str, key_or_project: str) -> bool:
        p = key_or_project.split("-")[0]
        allowed = (self.accounts.get(account_id) or {}).get("projects")
        return allowed is None or p in allowed

    async def handler(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        path = request.url.path
        body = json.loads(request.content or b"null") if request.content else None
        who = self._who(request)
        self.calls.append((request.method, path, body, who))
        for k, st in self.fail.items():
            m, _, suffix = k.partition(" ")
            if request.method == m and path.endswith(suffix):
                return httpx.Response(st, json={"errorMessages": [f"forced {st}"]})
        if url.startswith(AUTH):
            if path == "/oauth/token":
                if body.get("grant_type") == "authorization_code":
                    acc = self.codes.get(body.get("code"))
                    if acc is None:
                        return httpx.Response(403, json={"error": "invalid_grant"})
                    return httpx.Response(200, json=self._tokens(acc))
                if body.get("grant_type") == "refresh_token":
                    rt = body.get("refresh_token")
                    acc = self.refresh.pop(rt, None)
                    if acc is None or rt in self.spent:
                        return httpx.Response(403, json={"error": "invalid_grant", "error_description": "Unknown or invalid refresh token."})
                    self.spent.add(rt)
                    return httpx.Response(200, json=self._tokens(acc))
            return httpx.Response(404)
        if path == "/oauth/token/accessible-resources":
            if who is None:
                return httpx.Response(401, json={"message": "Unauthorized"})
            return httpx.Response(200, json=[self.sites[s] for s in self.accounts[who]["sites"] if s in self.sites])
        m = re.match(r"^/ex/jira/([^/]+)/rest/api/3/(.*)$", path)
        if not m:
            return httpx.Response(404)
        cloud, rest = m.group(1), m.group(2)
        if who is None:
            return httpx.Response(401, json={"message": "Unauthorized"})
        if cloud not in self.accounts[who]["sites"]:
            return httpx.Response(403, json={"errorMessages": ["No access to this site"]})
        return self._rest(request.method, rest, body, who, request)

    def _rest(self, method: str, rest: str, body, who: str, request: httpx.Request) -> httpx.Response:
        acc = self.accounts[who]
        if rest == "myself":
            return httpx.Response(200, json=self._user(who))
        if rest == "project/search":
            vals = [{"id": str(i), "key": k, "name": n} for i, (k, n) in enumerate(self.projects.items(), 1) if self._sees(who, k)]
            return httpx.Response(200, json={"values": vals, "isLast": True})
        mm = re.match(r"^issue/createmeta/([A-Z0-9_]+)/issuetypes$", rest)
        if mm:
            if not self._sees(who, mm.group(1)):
                return httpx.Response(404, json={"errorMessages": ["No project"]})
            return httpx.Response(200, json={"issueTypes": [{"id": "1", "name": "Task"}, {"id": "2", "name": "Bug"},
                                                            {"id": "3", "name": "Story"}, {"id": "4", "name": "Sub-task", "subtask": True}]})
        if rest == "priority":
            return httpx.Response(200, json=[{"id": str(i), "name": n} for i, n in enumerate(self.priorities, 1)])
        if rest == "issue" and method == "POST":
            f = (body or {}).get("fields") or {}
            p = (f.get("project") or {}).get("key")
            if p not in self.projects or not self._sees(who, p):
                return httpx.Response(400, json={"errors": {"project": "valid project is required"}})
            if not f.get("summary"):
                return httpx.Response(400, json={"errors": {"summary": "You must specify a summary of the issue."}})
            if f.get("priority") and f["priority"].get("name") not in self.priorities:
                return httpx.Response(400, json={"errors": {"priority": "priority is invalid"}})
            key = self.add_issue(p, f["summary"], assignee=(f.get("assignee") or {}).get("accountId"), due=f.get("duedate"),
                                 labels=f.get("labels") or (), priority=(f.get("priority") or {}).get("name"))
            self.issues[key]["fields"]["issuetype"] = {"name": (f.get("issuetype") or {}).get("name") or "Task"}
            self.issues[key]["fields"]["description"] = f.get("description")
            self.issues[key]["fields"]["reporter"] = self._user(who)
            return httpx.Response(201, json={"id": self.issues[key]["id"], "key": key, "self": f"{API}/issue/{key}"})
        mm = re.match(r"^issue/([A-Z0-9_]+-\d+)(/transitions)?$", rest)
        if mm:
            key = mm.group(1)
            it = self.issues.get(key)
            if it is None or not self._sees(who, key):
                return httpx.Response(404, json={"errorMessages": ["Issue does not exist or you do not have permission to see it."]})
            if not mm.group(2):
                return httpx.Response(200, json=it)
            if method == "GET":
                if not acc["can_transition"]:
                    return httpx.Response(200, json={"transitions": []})
                cur = it["fields"]["status"]["name"]
                return httpx.Response(200, json={"transitions": [
                    {"id": tid, "name": name, "to": _status(name)} for tid, name in TRANSITIONS if name != cur]})
            if not acc["can_transition"]:
                return httpx.Response(403, json={"errorMessages": ["You don't have permission to transition this issue."]})
            tid = str(((body or {}).get("transition") or {}).get("id"))
            name = dict(TRANSITIONS).get(tid)
            if name is None:
                return httpx.Response(400, json={"errorMessages": ["Transition id is not valid."]})
            it["fields"]["status"] = _status(name)
            it["fields"]["updated"] = datetime.now(timezone.utc).isoformat()
            it["fields"]["resolutiondate"] = datetime.now(timezone.utc).isoformat() if STATUSES[name] == "done" else None
            return httpx.Response(204)
        if rest == "search/jql" and method == "POST":
            jql = (body or {}).get("jql") or ""
            keys = None
            km = re.search(r"key in \(([^)]*)\)", jql)
            if km:
                keys = [x.strip().strip('"') for x in km.group(1).split(",")]
                bad = [k for k in keys if k not in self.issues]
                if bad:
                    return httpx.Response(400, json={"errorMessages": [f"An issue with key '{bad[0]}' does not exist for field 'key'."]})
            am = re.search(r"assignee in \(([^)]*)\)", jql)
            assignees = [x.strip().strip('"') for x in am.group(1).split(",")] if am else None
            pm = re.search(r"project in \(([^)]*)\)", jql)
            projects = [x.strip().strip('"') for x in pm.group(1).split(",")] if pm else None
            out = []
            for key, it in self.issues.items():
                if keys is not None and key not in keys:
                    continue
                if assignees is not None and ((it["fields"].get("assignee") or {}).get("accountId") not in assignees):
                    continue
                if projects is not None and it["fields"]["project"]["key"] not in projects:
                    continue
                if not self._sees(who, key):
                    continue
                out.append(it)
            return httpx.Response(200, json={"issues": out, "isLast": True})
        if rest == "user/search":
            q = (request.url.params.get("query") or "").lower()
            hits = [self._user(a) for a, v in self.accounts.items() if (v.get("email") or "").lower() == q]
            return httpx.Response(200, json=hits)
        if rest == "webhook" and method == "POST":
            out = []
            for w in (body or {}).get("webhooks") or []:
                wid = 1000 + len(self.webhooks) + 1
                self.webhooks[wid] = {"url": body.get("url"), "jql": w.get("jqlFilter"), "events": w.get("events"), "by": who}
                out.append({"createdWebhookId": wid})
            return httpx.Response(200, json={"webhookRegistrationResult": out})
        if rest == "webhook" and method == "DELETE":
            for wid in (body or {}).get("webhookIds") or []:
                self.webhooks.pop(wid, None)
            return httpx.Response(202)
        if rest == "webhook/refresh" and method == "PUT":
            return httpx.Response(200, json={"expirationDate": int((time.time() + 30 * 86400) * 1000)})
        return httpx.Response(404, json={"errorMessages": [f"fake: no {method} {rest}"]})


def today_plus(days: int) -> str:
    from datetime import timedelta

    return (date.today() + timedelta(days=days)).isoformat()
