---
title: API reference from an OpenAPI file
nav: API reference
description: Generate a page for every endpoint of your API from an OpenAPI 3.0 or 3.1 file, with code samples and Try it. Upload it or fetch it from a URL.
updated: 2026-10-31
prerequisites: [/guides/publishing]
keywords: [api reference, openapi, swagger, openapi 3.1, yaml, json, try it, api playground, cors, endpoints, code samples, curl, rest api docs]
---

Give your guide an OpenAPI file and every publish turns it into an API reference: a page for each endpoint with its parameters, request body, responses and code samples in curl, JavaScript and Python, plus **Try it**, which sends real requests from the reader's browser. The pages live under `/api-reference` on your guide, next to the pages you write.

## Add your OpenAPI file

::::steps
### Open the setting
Open the guide's **Settings** and find **API reference**. Editors and admins can add or replace the file.

### Upload it or give its address
Choose **Upload a file** and pick your OpenAPI file, or **From a URL** and paste the address of the raw JSON or YAML, then choose **Fetch**.

### Check what it found
The card shows the API's name and version, how many endpoints and servers it has, and anything worth a look, like endpoints without an `operationId` or a file with no server address. **Preview the sidebar** shows the pages a publish makes.

### Publish
The reference reaches readers at the next [publish](/guides/publishing), like any other change.
::::

The **API reference** template starts with a small sample file for a made-up Northwind API, so you can see the result before you add yours. Replace it with your own file the same way.

## What a reference page shows

Pages follow your file:

- **Groups** come from your tags, in the order your `tags` list gives them, then the order endpoints use them. A tag's `x-displayName` names its group. Endpoints without a tag go under **Endpoints**.
- **Titles** come from each endpoint's `summary`, then its `operationId` ("listOrders" becomes "List orders"), then its method and path.
- **Descriptions, parameters, request bodies and responses** come from the file, with types, limits, allowed values and defaults. Nested objects open under their field.
- **Code samples** use the first server and the `example` values in your file where it has them, with credentials read from environment variables (`$API_TOKEN`, `$API_KEY`).
- **An overview page** at `/api-reference` lists the base URLs, how to authenticate and every endpoint by group.

Search, Ask AI, the `.md` copy of every page, `llms.txt` and the guide's MCP server cover the reference too. See [What readers get](/guides/what-readers-get).

To link an endpoint from a page you write, use the editor's **API endpoint** block: it offers the endpoints in your file and shows as a card that links to the endpoint's page.

## Where it appears

Guides admins choose in the same card:

| Option | What it does |
| --- | --- |
| **Its own tab in the header** | The reference gets a tab. Your own pages go under a **Docs** tab. |
| **In the sidebar, after your pages** | One sidebar for everything, with the reference's groups at the end. |
| **Tab name** or **Sidebar group name** | What the tab or the group is called. Default **API reference**. |

The `/api-reference` part of the address is fixed, so no page you write can use it.

## Try it and CORS

**Try it** sits beside the code samples on every endpoint page. Readers pick a server (when your file lists more than one), fill in the parameters and their credentials, and send the request. It handles what your file's `securitySchemes` describe: a bearer token, an API key in a header or the query string, a username and password (basic auth), and OAuth 2.0 or OpenID Connect access tokens, sent as a bearer token. An API key in a cookie can't be set by a browser, so Try it leaves it out and the copied command includes it.

What readers type is kept in memory on the page only: it isn't saved anywhere, and it's gone when they reload. Requests go from their browser straight to your API, never through Markdrop.

:::warning[Your API has to allow the guide's address]
Browsers only let a page call another site's API when that API allows it (CORS). For Try it to work, your API has to answer your guide's address, like `https://acme.guides.markdrop.in`, with `Access-Control-Allow-Origin`, and allow the headers the request sends, such as `Authorization`. When it doesn't, Try it says the browser blocked the request and offers the same request as a `curl` command to run in a terminal, where CORS doesn't apply.
:::

To turn Try it off, switch off **Try it on endpoint pages** and publish. The code samples stay.

## Files from a URL

Markdrop fetches the address from its own servers, once, when you choose **Fetch**:

- It must be a public `https://` address on the standard port. Addresses on private networks, `localhost` and IP addresses are refused, and so is a redirect to one of them.
- The file has to arrive within 15 seconds.
- A relative server address in the file, like `/v1`, is read relative to the file's address.

Admins can switch on **Fetch it again at every publish**, so the reference follows your API without uploading anything. If the fetch fails at a publish, the guide publishes with the last version that worked, and the publish says so.

## Versions

Every file you upload or fetch is kept. **Earlier versions** in the card lists them, and **Use this version** brings one back. **Remove** takes the reference off the guide at the next publish; the file stays in Earlier versions.

## Limits

- **OpenAPI 3.0 or 3.1**, in JSON or YAML. A Swagger 2.0 file has to be converted first (for example with editor.swagger.io).
- **Up to 5 MB** and **1,000 endpoints**.
- **One file.** References to other files (`$ref: other.yaml#/…`) aren't followed: bundle the description into one file first.
- GET, POST, PUT, PATCH and DELETE endpoints get pages; HEAD, OPTIONS and TRACE don't.
