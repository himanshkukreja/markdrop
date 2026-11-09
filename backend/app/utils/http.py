"""One TLS context for every outgoing httpx client.

``httpx.AsyncClient()`` builds a fresh ``ssl.SSLContext`` and loads the whole certifi bundle each time
it is created (about a megabyte of OpenSSL allocations and several milliseconds of CPU). Services that
open a client per call (a revalidation purge per saved page, a Slack or Jira call, an email, a push)
churned that on every call, which fragments the C heap; that memory is rarely handed back to the OS
(prod OOM, 2026-11-09). Pass ``verify=shared_ssl()`` instead: the context is built once and shared
(an SSLContext is safe to share between clients and threads).
"""

from __future__ import annotations

import functools
import ssl

import httpx


@functools.lru_cache(maxsize=1)
def shared_ssl() -> ssl.SSLContext:
    return httpx.create_ssl_context()
