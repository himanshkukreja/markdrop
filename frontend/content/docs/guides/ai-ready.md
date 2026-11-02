---
title: "Ready for AI: Markdown, llms.txt and MCP"
nav: llms.txt, MCP and agents
description: What every published guide serves AI tools (Markdown pages, llms.txt, skill.md and an MCP server) and how to see which agents read your docs.
updated: 2026-11-02
prerequisites: [/guides/publishing]
keywords: [ai, llms.txt, llms-full.txt, skill.md, markdown, mcp, mcp server, agents, ai agents, claude, chatgpt, perplexity, cursor, vs code, copy page, agent analytics, geo, ai search]
---

Readers increasingly ask an assistant instead of reading. Every published guide serves its pages in the forms AI tools read well, with nothing to set up, and the [Fix list](/guides/fix-list#ai-agents) shows which assistants read your docs and where they get stuck.

## What every guide serves

| Address | What it is |
| --- | --- |
| `/<page>.md` | Every page as Markdown: add `.md` to its address. Tools that ask for Markdown (`Accept: text/markdown`) get it at the normal address too. |
| `/llms.txt` | A list of every page with its description, the standard way to point an AI tool at a site. |
| `/llms-full.txt` | The whole guide's text in one file. |
| `/skill.md` | An agent skill: how an assistant should use the guide (start from `llms.txt`, read pages as Markdown, link to the exact section) and the list of pages. |
| `/mcp` | An MCP server for assistants like Claude, Cursor or VS Code (see below). |
| `/changelog.md` | The [changelog](/guides/changelog) as Markdown, newest first, when the guide has one. Its RSS (`/changelog.rss`) and JSON Feed (`/changelog.json`) are beside it. |

Embedded files reach agents as text too: each [Markdrop file block](/guides/embed-files#the-text-version) has a text version (your summary, a PDF's text, a video's chapters and transcript) in the page's Markdown and in `llms-full.txt`.

[Private pages and sections](/guides/private-pages#what-stays-private) are left out of all of these.

## The MCP server

Each guide's `/mcp` address is a [Model Context Protocol](https://modelcontextprotocol.io) server with these tools:

| Tool | What it does |
| --- | --- |
| `search_docs` | Searches the guide and returns the matching sections with links. |
| `read_page` | Reads a page as Markdown, optionally with the pages it builds on. |
| `whats_changed` | Lists changelog entries since a date, when the guide has a changelog. |
| `report_problem` | Tells you a page is wrong or missing something, while [Insights](/guides/insights) is on. Reports show in Reader feedback as **via an AI app (MCP)**. |

Readers add it from the **Copy page** menu on any page (**Add docs to Cursor**, **Add docs to VS Code**), or by giving their assistant the address, like `https://acme.guides.markdrop.in/mcp`.

## The Copy page menu

Every page has **Copy page** beside its title: copy the page as Markdown, view it as Markdown, open it in Claude, ChatGPT or Perplexity with the page attached, or add the guide to Cursor or VS Code as an MCP server.

![The Copy page menu on Acme's Connect Postgres page, listing Copy page, View as Markdown, Open in Claude, Open in ChatGPT, Open in Perplexity, Add docs to Cursor, Add docs to VS Code and Ask Acme about this page.](/docs-assets/guides/what-readers-get/reader-copy-page.webp)

## See which agents read your docs

Under **AI agents**, the [Fix list](/guides/fix-list#ai-agents) counts agent reads apart from readers: how many, from which assistants (Claude, ChatGPT, Perplexity, Gemini and others) and how (pages, Markdown, `llms.txt`, MCP). Two kinds of item come from them:

- **Agents find nothing**: what assistants searched for through the MCP server and found nothing.
- **Hard for agents**: a page agents read a lot that is hard for them to use, like a long page without headings, a page that's mostly images or video, or one hidden from `llms.txt`.

Agent reads keep the page, how it was read and the assistant's family, never the agent's address or full user agent. See [What it collects](/guides/fix-list#what-it-collects).

## Make pages easy for agents

- Give every page a **description**: it's the line agents see in `llms.txt` and search results.
- Use headings: agents (and [Ask AI](/guides/ask-ai)) cite sections, so one topic per section works best.
- Give images alt text and files a summary: an agent can't see a screenshot or watch a video.
- Keep pages that agents should find in the sidebar, or link to them: [hidden pages](/guides/pages-and-navigation#hidden-pages) still open, but aren't listed.

## Related

- [Ask AI on your guide](/guides/ask-ai): an assistant for your readers, on the guide itself.
- [What readers get](/guides/what-readers-get): everything a published guide gives people.
- [Fix list](/guides/fix-list): what readers and agents run into, ranked.
