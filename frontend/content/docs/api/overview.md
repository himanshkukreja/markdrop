---
title: API overview
nav: Overview
description: Base URL, authentication with API tokens and edit secrets, the X-Read-Password and X-Edit-Secret headers, errors and rate limits of the Markdrop REST API.
updated: 2026-10-30
checked: 2026-10-30
keywords: [api, rest, http, curl, authentication, bearer, mdk, edit secret, X-Edit-Secret, X-Read-Password, errors, rate limits, openapi]
---

Everything you can do on markdrop.in goes through a JSON API at `https://api.markdrop.in`. Use it to publish from your own scripts and services. For publishing files from a terminal, the [CLI](/cli/install) is usually simpler; for AI apps, use the [MCP server](/ai/overview).

Every endpoint has its own page in this section, grouped in the sidebar: what it does, the token it needs, its rate limit, parameters, request body, responses, and samples in curl, JavaScript and Python. The pages are generated from the API's own description. The machine-readable OpenAPI description is at [`https://api.markdrop.in/openapi.json`](https://api.markdrop.in/openapi.json).

Endpoints that only markdrop.in's own pages use, such as sign-in, Google Docs export and the VS Code extension's sync, are left out.

## Base URL

```text
https://api.markdrop.in/api/v1
```

All requests and responses use JSON (`Content-Type: application/json`) unless an endpoint says otherwise. Times are ISO 8601 in UTC.

## Your first request

Publish a Markdown document. No account is needed:

```bash
curl -X POST https://api.markdrop.in/api/v1/documents \
  -H "Content-Type: application/json" \
  -d '{"title": "Hello", "content": "# Hello\n\nPublished from curl."}'
```

```json
{
  "slug": "k3x9q2m",
  "url": "https://markdrop.in/k3x9q2m",
  "title": "Hello",
  "edit_secret": "sk_••••",
  "expires_at": null,
  "views": 0,
  "kind": "markdown"
}
```

The response is longer than shown. Keep `edit_secret`: it is returned only once, and it is the only way to change or delete a document published without an account. See [Edit key](/documents/edit-key).

Read it back:

```bash
curl https://api.markdrop.in/api/v1/documents/k3x9q2m
```

## Authentication

Requests can be anonymous, or carry one or more of these:

| Credential | How to send it | What it proves |
|---|---|---|
| API token | `Authorization: Bearer mdk_••••` | You are the account that created the token. Documents you publish are owned by that account. |
| Edit secret | `X-Edit-Secret: sk_••••` | You may change or delete this one document. |
| Read password | `X-Read-Password: ••••••••` | You know the password of a password-protected document. |

### API tokens

Create a token at [markdrop.in/settings/tokens](https://markdrop.in/settings/tokens). It starts with `mdk_`, is shown once, and works until you revoke it. A token acts as your whole account, so treat it like a password and make one per script or device. More in [API tokens](/account/api-tokens).

```bash
curl https://api.markdrop.in/api/v1/me/documents \
  -H "Authorization: Bearer $MARKDROP_TOKEN"
```

A revoked or mistyped API token gets `401` with `"detail": "Invalid API token"`. It is never treated as anonymous.

The sign-in token markdrop.in uses in your browser is also accepted as a bearer token, but it expires. Use an API token for anything that runs unattended.

The MCP endpoint, `https://api.markdrop.in/mcp`, is the exception: it accepts only the tokens AI apps get through Markdrop's approval screen, and refuses `mdk_` tokens. See [Connect an AI app](/ai/hosted-mcp#for-developers).

### Edit secrets

Every new document comes with an edit secret (`sk_…`) in the create response. Send it as `X-Edit-Secret` to update (`PUT /documents/{slug}`), delete (`DELETE /documents/{slug}`), or change the password and expiry (`PATCH /documents/{slug}/settings`) without signing in. If an edit secret leaks, the document's owner can replace it with `POST /documents/{slug}/edit-secret/rotate`; the old one stops working at once.

To attach an anonymous document to your account, call `POST /documents/{slug}/claim` with both your API token and its `X-Edit-Secret`.

### Password-protected documents

Send the password as `X-Read-Password` when you read:

```bash
curl https://api.markdrop.in/api/v1/documents/q3-report \
  -H "X-Read-Password: ••••••••"
```

Without it, the API answers `401` with the header `X-Markdrop-Gate: password`. A wrong password gets `403` `"Incorrect password"`. After repeated wrong passwords from one address, the API answers `429` for a few minutes.

## Errors

Errors use HTTP status codes and a JSON body with a `detail` message you can show to a person:

```json
{ "detail": "Document not found" }
```

| Status | Meaning |
|---|---|
| `400` | The request can't be carried out as sent. |
| `401` | Sign-in or a password is needed, or the token is invalid. Check `X-Markdrop-Gate`: `password` or `signin`. |
| `403` | You're signed in but not allowed to do this, or the password is wrong. |
| `404` | Nothing there, or nothing you're allowed to know about. A private document answers `404` to people who can't open it. |
| `409` | A conflict, such as a custom address that is already taken. |
| `413` | The content or file is over its size limit. The `detail` says the limit. |
| `422` | The body failed validation. `detail` is a list of problems, each with a `loc` (where) and `msg` (what). Long values are replaced by their length. |
| `429` | Too many requests. See [Rate limits](#rate-limits). |
| `5xx` | A problem on Markdrop's side. Retry after a short wait. |

A `422` looks like this:

```json
{
  "detail": [
    { "type": "string_too_short", "loc": ["body", "custom_slug"], "msg": "String should have at least 3 characters", "input": "ab" }
  ]
}
```

### Renamed documents

When a document's address was renamed, reading the old slug answers `200` with `{"moved": true, "slug": "<new slug>", "url": "…"}` and the header `X-Markdrop-Moved: <new slug>`, but only to someone allowed to read the document. Follow it to the new slug.

## Rate limits

Limits are counted per client IP address, per minute unless shown otherwise. Some of the most used:

| Requests | Limit |
|---|---|
| Create a document (`POST /documents`), or update, delete, rename, claim, copy or change the settings of one | 10 per minute |
| Read a document (`GET /documents/{slug}`) | 60 per minute |
| Start a file upload (`POST /files/uploads`) | 30 per minute |
| Create an API token | 20 per hour |

Over the limit, the API answers `429` with a `Retry-After` header giving the seconds to wait, and this body:

```json
{ "error": "Rate limit exceeded: 10 per 1 minute" }
```

Note that this one error uses `error` rather than `detail`. Browsers can read `Retry-After` from cross-origin requests.

## Where to go next

::::cards
:::card[Publish files from the terminal]{href="/cli/upload-and-replace" icon="upload"}
Uploads of large files in parts, with verification and resume, already built.
:::
:::card[Connect an AI app]{href="/ai/hosted-mcp" icon="zap"}
Let Claude or ChatGPT call Markdrop for you.
:::
:::card[Passwords and expiry]{href="/documents/passwords-and-expiry" icon="lock"}
What each protection does for the people you send a link to.
:::
::::
