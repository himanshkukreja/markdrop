"""Print the API's public OpenAPI description, for the docs site's API reference.

Read-only: it imports the app and calls `app.openapi()`. Nothing connects to a
database, Redis or R2, and nothing is written except stdout.

    npm run docs:openapi            # from frontend/: runs this and writes content/docs/openapi.json

Run it from a scratch directory (the npm script does), never from backend/:
settings read `.env` from the working directory, and the reference must
describe the code's defaults, not one machine's configuration. The npm script
also passes a bare environment with MARKDROP_REDIS_URL=memory://.

Each operation gains an `x-markdrop` object the schema can't express:

- `auth`: "token" (a bearer token is required), "optional" (a token changes
  the result: ownership, private documents), "session" (only markdrop.in's
  own sign-in works, not an API token) or "none".
- `rateLimits`: the slowapi limits on the route, as written in the code
  (`"10/minute"`), per client IP. Production may configure some differently.
"""

from __future__ import annotations

import json
import sys

from fastapi.routing import APIRoute

from app.limiter import limiter
from app.main import app

AUTH_DEPS = {
    "require_user": "token",
    "require_session_user": "session",
    "optional_user": "optional",
    "docs_caller": "optional",
}
RANK = {"none": 0, "optional": 1, "token": 2, "session": 3}


def _auth(dependant) -> str:
    found = "none"
    stack = list(dependant.dependencies)
    while stack:
        dep = stack.pop()
        name = getattr(dep.call, "__name__", "")
        kind = AUTH_DEPS.get(name)
        if kind and RANK[kind] > RANK[found]:
            found = kind
        stack.extend(dep.dependencies)
    return found


def _limits(endpoint) -> list[str]:
    key = f"{endpoint.__module__}.{endpoint.__name__}"
    out: list[str] = []
    for lim in limiter._route_limits.get(key, []):  # noqa: SLF001 - read-only
        item = lim.limit
        n, per, unit = item.amount, item.multiples, item.GRANULARITY.name
        out.append(f"{n}/{unit}" if per == 1 else f"{n}/{per} {unit}s")
    return out


def main() -> int:
    spec = app.openapi()
    for route in app.routes:
        if not isinstance(route, APIRoute) or not route.include_in_schema:
            continue
        path_item = spec["paths"].get(route.path_format)
        if not path_item:
            continue
        extra = {"auth": _auth(route.dependant)}
        limits = _limits(route.endpoint)
        if limits:
            extra["rateLimits"] = limits
        for method in route.methods:
            op = path_item.get(method.lower())
            if op is not None:
                op["x-markdrop"] = extra
    json.dump(spec, sys.stdout, indent=2, sort_keys=False, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
