---
title: API reference from an OpenAPI file
nav: API reference
description: Generate a page for every endpoint of your API from an OpenAPI 3.0 or 3.1 file, with code samples and Try it. Upload it or fetch it from a URL.
updated: 2026-11-01
prerequisites: [/guides/publishing]
keywords: [api reference, openapi, swagger, openapi 3.1, yaml, json, try it, api playground, cors, endpoints, code samples, curl, rest api docs]
---

Give your guide an OpenAPI file and every publish turns it into an API reference: a page for each endpoint with its parameters, request body, responses and code samples in curl, JavaScript and Python, plus **Try it**, which sends real requests from the reader's browser. The pages live under `/api-reference` on your guide, next to the pages you write.

## Add your OpenAPI file

::::steps
### Open the setting
Open the guide's **Settings** and choose **API reference**. Editors and admins can add or replace the file.

### Upload it or give its address
On **Upload a file**, drop your `openapi.yaml` or `openapi.json` on the box, or click it to choose the file. Or choose **From a URL**, paste the address of the raw JSON or YAML and choose **Fetch and check**.

### Check what it found
Markdrop checks the file before anything changes on your guide. The result shows the API's name and version, the OpenAPI version, how many endpoints, groups and servers it has, and the sign-in types its `securitySchemes` describe. Anything worth fixing is listed with what to do about it, like endpoints without a summary or a file with no server address. **What readers will get** lists the endpoint pages a publish makes, by group, with their methods.

### Publish
Choose **Publish the reference**. It publishes the whole guide, with any other changes waiting, like the [Publish](/guides/publishing) screen does. When your guide requires reviews, editors choose **Send for review** instead.
::::

![The checked file on Acme Developers: "acme-openapi.yaml works, with 1 thing to look at": Acme API 2.4.0, OpenAPI 3.1.0, 13 endpoints in 4 groups, 2 servers, sign-in Bearer, with Replace and Versions, and 1 thing to fix (optional): 1 endpoint has no summary, with what to do about it.](/docs-assets/guides/api-reference/api-reference-checked.webp)

No file yet? Choose **Northwind sample** under the box to start from a small sample file for a made-up API, and see the result before you add yours. The **API reference** template starts with it too. Replace it with your own file the same way.

Once the guide is published, **Preview the reference** opens `/api-reference` on your guide in a new tab.

## Export an OpenAPI file

Most API frameworks write the file for you:

- **FastAPI**: it's served at `/openapi.json` on your API (for example `https://api.example.com/openapi.json`). Give Markdrop that address, or save it and upload it.
- **Express or NestJS**: with `swagger-jsdoc` or `@nestjs/swagger`, write the generated document to a file (`JSON.stringify(spec)`), or serve it and use the address.
- **Spring Boot**: with springdoc-openapi it's at `/v3/api-docs` (JSON) or `/v3/api-docs.yaml`.
- **Postman**: convert a collection with `postman-to-openapi` or an online converter, then upload the result.
- **Swagger 2.0**: convert it to OpenAPI 3 first, for example in editor.swagger.io (**Edit › Convert to OpenAPI 3**).

If the file is split across several files (`$ref: ./paths/orders.yaml`), bundle it into one first, for example with `npx @redocly/cli bundle openapi.yaml -o bundled.yaml`.

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

Guides admins choose under **How it appears**:

| Option | What it does |
| --- | --- |
| **Its own tab** | The reference gets a tab in the header. Your own pages go under a **Docs** tab. |
| **In the sidebar** | One sidebar for everything, with the reference's groups after your pages. |
| **Tab name** or **Sidebar group name** | What the tab or the group is called. Default **API reference**. |

The `/api-reference` part of the address is fixed, so no page you write can use it.

![What readers will get: 13 endpoint pages under API reference, grouped Projects, Sources, Dashboards and Alerts with their methods and paths, and Preview the reference (off until the guide is published). Beside it, How it appears: Tab name API reference, Its own tab selected, Try it on, Fetch again on every publish off, and Publish the reference.](/docs-assets/guides/api-reference/api-reference-endpoints.webp)

## Try it and CORS

**Try it** sits beside the code samples on every endpoint page. Readers pick a server (when your file lists more than one), fill in the parameters and their credentials, and send the request. It handles what your file's `securitySchemes` describe: a bearer token, an API key in a header or the query string, a username and password (basic auth), and OAuth 2.0 or OpenID Connect access tokens, sent as a bearer token. An API key in a cookie can't be set by a browser, so Try it leaves it out and the copied command includes it.

What readers type is kept in memory on the page only: it isn't saved anywhere, and it's gone when they reload. Requests go from their browser straight to your API, never through Markdrop.

:::warning[Your API has to allow the guide's address]
Browsers only let a page call another site's API when that API allows it (CORS). For Try it to work, your API has to answer your guide's address, like `https://acme.guides.markdrop.in`, with `Access-Control-Allow-Origin`, and allow the headers the request sends, such as `Authorization`. When it doesn't, Try it says the browser blocked the request and offers the same request as a `curl` command to run in a terminal, where CORS doesn't apply.
:::

To turn Try it off, switch off **Try it** under **How it appears** and publish. The code samples stay.

## Files from a URL

Markdrop fetches the address from its own servers, once, when you choose **Fetch and check**:

- It must be a public `https://` address on the standard port. Addresses on private networks, `localhost` and IP addresses are refused, and so is a redirect to one of them.
- The file has to arrive within 15 seconds.
- A relative server address in the file, like `/v1`, is read relative to the file's address.

Admins can switch on **Fetch again on every publish**, so the reference follows your API without uploading anything. If the fetch fails at a publish, the guide publishes with the last version that worked, and the publish says so.

## Versions

Every file you upload or fetch is kept. **Versions** lists them, and **Restore** makes one current again; it goes live at the next publish. **Remove the API reference**, at the bottom of Versions, takes it off the guide at the next publish; the file stays in Versions.

## Limits

- **OpenAPI 3.0 or 3.1**, in JSON or YAML. A Swagger 2.0 file has to be converted first (for example with editor.swagger.io).
- **Up to 5 MB** and **1,000 endpoints**.
- **One file.** References to other files (`$ref: other.yaml#/…`) aren't followed: bundle the description into one file first.
- GET, POST, PUT, PATCH and DELETE endpoints get pages; HEAD, OPTIONS and TRACE don't.
