---
title: Publish an HTML page
description: Turn HTML you have as text, like a page an AI assistant wrote, into a live link. Save it as a file, ask your assistant, or send it to the API.
updated: 2026-10-30
keywords: [html, paste html, ai generated page, claude artifact, publish html, single file]
---

AI assistants are good at writing whole web pages: a dashboard, a slide deck, a one-page report with charts. Markdrop turns that HTML into a link that opens the page, running, in anyone's browser.

There are three ways to publish HTML you have as text. All of them need a Markdrop account.

## Save it as a file and upload it

This works for any page, from any source.

::::steps
### Save the HTML
Paste it into a text editor and save it with an `.html` extension, for example `q3-dashboard.html`.

### Upload it
Go to [markdrop.in/upload](https://markdrop.in/upload) and drop the file in. The **Preview** shows the page running, in your browser, before anything uploads.

![The upload page with q3-dashboard.html chosen and its dashboard running in the Preview, beside the Publish panel with the Title q3 dashboard and the Link markdrop.in/q3-dashboard filled in from the file name.](/docs-assets/files/html-pages/html-upload-preview.webp)

### Publish
Check the **Title** and **Link** (both come from the file name), then choose **Publish**.
::::

The page can be up to 25 MB. A page with images or fonts inlined as data can get large; if it's over, move the big assets out and publish the page and its assets as a [zipped website](/files/websites).

## Ask your AI assistant

If your assistant is connected to Markdrop through MCP, ask it to publish the page. It uses the `publish_page` tool, which takes the page as text and returns the link. Pages can be up to 25 MB this way too.

> Publish this page to Markdrop as q3-dashboard and give me the link.

`publish_page` also takes `.txt`, `.csv`, `.json` and `.svg` content. See [Connect Claude to Markdrop](/ai/hosted-mcp) and [MCP tools](/ai/tools).

## Send it to the API

Scripts can post the HTML directly, signed in with an [API token](/account/api-tokens). This route takes pages up to 10 MB:

```bash title="Publish HTML from a script"
curl -X POST https://api.markdrop.in/api/v1/artifacts/paste \
  -H "Authorization: Bearer mdk_••••" \
  -H "Content-Type: application/json" \
  -d '{"title": "Q3 dashboard", "custom_slug": "q3-dashboard", "content": "<!doctype html><h1>Q3</h1>"}'
```

The response includes the `url` and an `edit_secret`. You can also set `read_password`, `expires_in` and `access_level` (`link` or `private`).

## Why not paste it into a document?

A Markdrop document is Markdown, and Markdrop drops HTML tags from documents, so pasted HTML wouldn't run there. A page published as a file runs as a page.

## What the page can do

The page runs with its scripts, styles and web fonts, and can load scripts and images from other sites, such as a charting library from a CDN. Forms, pop-ups and downloads work.

It runs inside a sandbox on a separate domain, never on markdrop.in. It can't read Markdrop's cookies or storage, or the reader's Markdrop session. See [How files are served](/security/how-files-are-served).

## Update the page

To change it, open the page, press :kbd[Esc] or choose **Show details** to leave full screen, and choose **More artifact actions › Settings**. Choose the **File** tile, pick the new `.html` and choose **Save changes**. The link stays the same and readers with the page open get the new version. Your assistant can also update it in place through MCP. See [Replace a file and restore versions](/files/replace-and-versions).

## Related

- [Supported file types](/files/supported-types)
- [Publish a zipped website](/files/websites)
