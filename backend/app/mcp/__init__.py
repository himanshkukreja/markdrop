"""Markdrop's MCP server: a hand-written, stateless, tools-only implementation
of the Model Context Protocol over streamable HTTP (POST /mcp, JSON responses).

* `protocol` - JSON-RPC dispatch for both protocol eras (initialize-handshake
  2024-11-05 … 2025-11-25, and the per-request envelope of 2026-07-28).
* `auth` - bearer-token authentication against the OAuth server's `mdat_`
  tokens (services/oauth_server.py), audience and scope checks.
* `tools` - the tool catalogue and handlers, built on the existing services.
* `schema` - the small JSON Schema subset used to validate tool arguments.

The official `mcp` SDK is deliberately not a dependency (it needs newer
Starlette and PyJWT than the backend pins); it is only used as a test client.
"""
