---
title: What readers get
description: What a published guide gives your readers and their AI tools. Search, Ask AI, light and dark, Markdown pages, llms.txt and an MCP server.
updated: 2026-10-31
prerequisites: [/guides/publishing]
keywords: [readers, published guide, published site, search, llms.txt, markdown, mcp, ai tools, copy page, dark mode, seo, sitemap, link previews]
---

A published guide is a fast, static website at its address, built by the same engine as docs.markdrop.in. You don't set any of this up: every guide has it.

![Acme's published Quickstart page in the Clean theme with Acme's teal brand: the sidebar, the page with a note and tabs, and on the right On this page, Copy page and Ask Acme.](/docs-assets/guides/what-readers-get/reader-page.webp)

## For people

- **Search.** Press ⌘ K (Ctrl K on Windows and Linux), or `/`, from any page. Results show as you type.
- **Ask AI**, when you turn it on: answers from your pages with links to their sources. See [Ask AI on your guide](/guides/ask-ai).
- **Light and dark**, following the [colour mode](/guides/brand-and-style#fonts-colour-mode-and-corners) you chose. Images with a dark version switch with the theme.
- **Contents and links to sections.** Every heading has a link readers can copy, and long pages have **On this page**.
- **Link previews.** Every page has its own preview card in your brand's colours for Slack, LinkedIn and the like.
- **Phones.** The layout works on small screens, with the sidebar in a menu.
- **An API reference**, when you add an OpenAPI file: a page for every endpoint with code samples, and **Try it** to send real requests from the page. See [API reference from an OpenAPI file](/guides/api-reference).

![Acme's guide with search open: typing "postgres" lists Connect Postgres and the sections that mention it.](/docs-assets/guides/what-readers-get/reader-search.webp)

## For AI tools

Readers increasingly ask an assistant instead of reading. Every guide serves your pages in forms those tools read well:

| Address | What it is |
| --- | --- |
| `/<page>.md` | Every page as Markdown: add `.md` to its address. Tools that ask for Markdown (`Accept: text/markdown`) get it at the normal address too. |
| `/llms.txt` | A list of every page with its description, the standard way to point an AI tool at a site. |
| `/llms-full.txt` | The whole guide's text in one file. |
| `/mcp` | An MCP server with tools to search the guide and read a page, for assistants like Claude, Cursor or VS Code. |
| `/sitemap.xml` | Every page, for search engines (empty when you turn [search indexing](/guides/site-settings#who-can-read-it) off). |

The **Copy page** menu on every page gives readers the same: copy the page as Markdown, view it as Markdown, open it in Claude, ChatGPT or Perplexity, or add the guide to Cursor or VS Code as an MCP server.

![The Copy page menu on Acme's Connect Postgres page, listing Copy page, View as Markdown, Open in Claude, Open in ChatGPT, Open in Perplexity, Add docs to Cursor, Add docs to VS Code and Ask Acme about this page.](/docs-assets/guides/what-readers-get/reader-copy-page.webp)

## Not yet

- **Password-protected and members-only guides** are [coming soon](/guides/site-settings#who-can-read-it). Today every published guide is public.
- **Your own domain** is [coming soon](/guides/site-settings#your-own-domain).
