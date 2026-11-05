---
title: What readers get
description: "What a published guide gives readers and their AI tools: search, Ask AI, feedback, light and dark, embeds, private pages, Markdown, llms.txt and MCP."
updated: 2026-11-02
prerequisites: [/guides/publishing]
keywords: [readers, published guide, published site, search, llms.txt, markdown, mcp, ai tools, copy page, dark mode, seo, sitemap, link previews, feedback, privacy, cookies]
---

A published guide is a fast, static website at its address, built by the same engine as docs.markdrop.in. You don't set any of this up: every guide has it.

![Acme's published Quickstart page in the Clean theme with Acme's teal brand: the header with the Docs and What's new tabs, search, Ask Acme and the light/dark switch; the sidebar, the page with a note and tabs, and on the right On this page, the page actions and Ask about this page.](/docs-assets/guides/what-readers-get/reader-page.webp)

## For people

- **Search.** Press ⌘ K (Ctrl K on Windows and Linux), or `/`, from any page. Results show as you type.
- **Ask AI**, when you turn it on: answers from your pages with links to their sources. See [Ask AI on your guide](/guides/ask-ai).
- **Did this page help?** at the end of every page: a yes or no, and an optional comment. Their answers reach you in [Insights](/guides/insights#page-feedback).
- **Light and dark**, following the [colour mode](/guides/brand-and-style#fonts-colour-mode-and-corners) you chose; with both, readers switch with the button in the header. Images with a dark version switch with the theme.
- **Contents and links to sections.** Every heading has a link readers can copy, and long pages have **On this page**.
- **Link previews.** Every page has its own preview card in your brand's colours for Slack, LinkedIn and the like.
- **Phones and tablets.** The layout works on small screens, with the sidebar in a menu, links and buttons sized for a finger, and wide tables and code scrolling on their own. Ask AI opens as a sheet that stays above the on-screen keyboard.
- **A changelog**, when you write entries: a `/changelog` page with every release, a page per entry, filters by kind, area, product and version, and RSS and JSON feeds to subscribe to. See [Add a changelog to your guide](/guides/changelog).
- **Live demos, PDFs and video** in the page, when you [embed Markdrop files](/guides/embed-files): an interactive HTML page runs in a sandbox, a PDF has page controls and zoom, and a video plays in the docs player with chapters and captions.
- **Private pages and sections**, when you have some: readers who may open them sign in with their email, with Markdrop or with a password, and everyone else sees a lock with the way in. See [Private pages and sections](/guides/private-pages).
- **An API reference**, when you add an OpenAPI file: a page for every endpoint with code samples, and **Try it** to send real requests from the page. See [API reference from an OpenAPI file](/guides/api-reference).

![Acme's guide with search open: typing "postgres" lists Connect Postgres and the sections that mention it.](/docs-assets/guides/what-readers-get/reader-search.webp)

## For AI tools

Readers increasingly ask an assistant instead of reading. Every guide serves your pages in forms those tools read well: every page as Markdown (its address plus `.md`), `llms.txt` and `llms-full.txt`, `skill.md`, and an MCP server at `/mcp`. The **Copy page** menu on every page copies the page as Markdown, opens it in Claude, ChatGPT or Perplexity, or adds the guide to Cursor or VS Code. See [llms.txt, MCP and agents](/guides/ai-ready).

| Address | What it is |
| --- | --- |
| `/<page>.md` | Every page as Markdown. |
| `/llms.txt`, `/llms-full.txt` | The list of pages, and the whole guide in one file. |
| `/mcp` | An MCP server to search the guide and read a page. |
| `/changelog.md`, `/changelog.rss`, `/changelog.json` | The changelog, when the guide has one. |
| `/sitemap.xml` | Every page, for search engines (empty when you turn [search indexing](/guides/site-settings#who-can-read-it) off). |

![The Copy page menu on Acme's Connect Postgres page, listing Copy page, View as Markdown, Open in Claude, Open in ChatGPT, Open in Perplexity, Add docs to Cursor, Add docs to VS Code and Ask Acme about this page.](/docs-assets/guides/what-readers-get/reader-copy-page.webp)

## Privacy

A published guide sets no cookies and stores nothing in readers' browsers, and Markdrop's own analytics never run on it. The one exception is a reader who signs in to [private pages](/guides/private-pages): their browser keeps a sign-in cookie for that guide, for 7 days. [Insights](/guides/insights) counts page views, searches and feedback for you without personal data, and respects Do Not Track and Global Privacy Control. An admin can [turn it off](/guides/insights#turn-it-off).

## Who can read it

A published guide is public unless you make some of it [private](/guides/private-pages). Password-protected and members-only guides, where the whole guide needs a sign-in, are set under [Who can read it](/guides/site-settings#who-can-read-it) where your Markdrop server has them switched on.

## Related

- [llms.txt, MCP and agents](/guides/ai-ready): what AI tools get.
- [Private pages and sections](/guides/private-pages): what signed-in readers see.
- [Insights](/guides/insights): how readers use it.
