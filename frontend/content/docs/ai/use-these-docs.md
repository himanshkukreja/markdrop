---
title: Use these docs with your AI
nav: Use these docs with AI
description: Copy any page as Markdown, open it in Claude, ChatGPT or Perplexity, point an agent at llms.txt, or connect the docs MCP server to your AI app.
updated: 2026-10-30
keywords: [llms.txt, llms-full.txt, markdown, copy page, agents, context, claude, chatgpt, perplexity, docs mcp, mcp server, cursor, vs code, search_docs, read_page]
---

Every page on docs.markdrop.in is also plain Markdown, so you can hand it to an AI assistant without copying text out of a web page. Use it to ask questions about a page, or to give a coding agent the exact steps it needs.

## Copy or open a page

Each page has a **Copy page** button next to its title. Its menu has:

![A docs page with the Copy page menu open: Copy page, Copy page with what it builds on, View as Markdown, Open in Claude, Open in ChatGPT, Open in Perplexity, Add docs to Cursor, Add docs to VS Code and Ask AI about this page.](/docs-assets/ai/use-these-docs/docs-copy-page-menu.webp)

| Item | What it does |
|---|---|
| Copy page | Copies the page's Markdown to your clipboard. |
| Copy page with what it builds on | Copies the page together with the pages it lists as prerequisites, so an assistant has everything it needs in one paste. Only on pages that have prerequisites. |
| View as Markdown | Opens the page's Markdown in the browser. |
| Open in Claude | Opens claude.ai with a prompt to read this page. |
| Open in ChatGPT | Opens ChatGPT with the same prompt. |
| Open in Perplexity | Opens Perplexity with the same prompt. |
| Add docs to Cursor | Installs the [docs MCP server](#connect-the-docs-to-your-ai-app) in Cursor. |
| Add docs to VS Code | Installs the docs MCP server in VS Code, for Copilot Chat. |
| Ask AI about this page | Opens [Ask AI](#ask-the-docs) with this page as the context. |

The prompt is "Read {page}.md and answer my questions about it." When you open an assistant, the page's Markdown is also copied to your clipboard, in case the assistant can't open the link: paste it into the chat.

To copy one section, hover over its heading and choose **Copy section**. The heading buttons need a mouse or trackpad, so they don't show on touch screens.

## Get any page as Markdown

Add `.md` to a page's address:

```text
https://docs.markdrop.in/cli/upload-and-replace.md
```

Tools that ask for Markdown get it at the normal address too. Send `Accept: text/markdown`:

```bash
curl -H "Accept: text/markdown" https://docs.markdrop.in/cli/upload-and-replace
```

## Give an agent all the docs

| File | What's in it |
|---|---|
| [`/llms.txt`](https://docs.markdrop.in/llms.txt) | An index of every page, with a one-line description and a link to its Markdown. Small enough to keep in an agent's context and follow links from. |
| [`/llms-full.txt`](https://docs.markdrop.in/llms-full.txt) | Every page in one Markdown file. Use it when the agent should have everything at once. |
| [`/changelog.md`](https://docs.markdrop.in/changelog.md) | The changelog as Markdown, newest first. |

For example, in Claude Code:

```text
Read https://docs.markdrop.in/llms.txt, then use the markdrop CLI to publish build/demo.mp4 into my Acme workspace's releases folder.
```

## Ask the docs

**Ask AI** answers questions from these docs, with a numbered link to the exact section each part of the answer came from. Choose **Ask AI** in the header, press :kbd[⌘I], use **Ask about this** next to any heading (when you hover over it), or press :kbd[⌘K] and then :kbd[Tab]. Selecting a source scrolls to that section and highlights it.

::clip{src="/docs-assets/ai/use-these-docs/docs-ask-ai" alt="Opening Ask AI on a docs page, asking how to put a workspace on docs.acme.com, the answer streaming in with numbered sources, and choosing source 1 to jump to the highlighted Add your domain section."}

- It only answers from these docs. When they don't cover something, it says so instead of guessing.
- It can't change anything in your account; it explains how to do things.
- What you type is sent to Ask AI only when you ask. Searching with :kbd[⌘K] never leaves your browser.
- There is a limit of 20 questions an hour per person. If Ask AI is busy or off, you get links to ask Claude or ChatGPT with the page attached instead.

## Connect the docs to your AI app

These docs have their own MCP server at `https://docs.markdrop.in/mcp`. Connect it, and your AI app can search and read the docs as tools whenever it needs them, without you pasting anything. It is public and read-only: no account and no sign-in.

::::tabs
:::tab[Cursor]
[Add to Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=markdrop-docs&config=eyJ1cmwiOiJodHRwczovL2RvY3MubWFya2Ryb3AuaW4vbWNwIn0=) opens Cursor and asks you to install it. Or add this to `~/.cursor/mcp.json`, or to `.cursor/mcp.json` in one project:

```json title="mcp.json"
{
  "mcpServers": {
    "markdrop-docs": {
      "url": "https://docs.markdrop.in/mcp"
    }
  }
}
```
:::

:::tab[VS Code]
[Add to VS Code](https://vscode.dev/redirect/mcp/install?name=markdrop-docs&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fdocs.markdrop.in%2Fmcp%22%7D) opens VS Code and asks you to install it. Or, for Copilot Chat in agent mode, add this to `.vscode/mcp.json` in your workspace:

```json title=".vscode/mcp.json"
{
  "servers": {
    "markdrop-docs": {
      "type": "http",
      "url": "https://docs.markdrop.in/mcp"
    }
  }
}
```
:::

:::tab[Claude Code]
In your terminal:

```bash
claude mcp add --transport http markdrop-docs https://docs.markdrop.in/mcp
```

Add `--scope user` to make it available in every project.
:::

:::tab[Claude]
On claude.ai and in Claude Desktop:

1. Open **Settings → Connectors**.
2. Choose **Add custom connector**, name it Markdrop docs and paste `https://docs.markdrop.in/mcp`.
3. Save it. There is nothing to sign in to.
:::

:::tab[Other apps]
Any app that connects to remote MCP servers over Streamable HTTP works. Add `https://docs.markdrop.in/mcp` with no authentication.
:::
::::

**Add docs to Cursor** and **Add docs to VS Code** are also in every page's **Copy page** menu.

### Tools

| Tool | What it does |
|---|---|
| `search_docs` | Takes `query` and an optional `limit` (1 to 20, 8 by default). Returns the best-matching sections and pages, each with its title, the page it is on, a link to the exact section and a short snippet. |
| `read_page` | Takes a page's `path`, like `/workspaces/custom-domain`, or its full address. Returns the page as Markdown. With `include_prerequisites`, the pages it builds on come first. |
| `whats_changed` | Takes `since_date` (`YYYY-MM-DD`) or `since_cli_version` (like `0.4.0`). Returns the changelog entries since then, newest first, with the pages each one changed. With neither, returns the latest 10. |
| `report_problem` | Takes a `page` and the `problem`. Tells the docs team a page is wrong, out of date or missing something. |

The [API reference](/api/overview) is included: `read_page` on `/api/documents/publish-a-document` returns that endpoint's parameters, request body, responses and code samples.

For example, in Cursor:

```text
Using the markdrop-docs tools, find out how to replace a published PDF without changing its link, then do it for build/report.pdf.
```

This is separate from Markdrop's own MCP server, which works with your documents and files. To connect that, see [Connect an AI app](/ai/hosted-mcp).
