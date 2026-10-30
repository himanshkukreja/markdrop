---
title: Use these docs with your AI
nav: Use these docs with AI
description: Copy any page as Markdown, open it in Claude, ChatGPT or Perplexity, or point an agent at llms.txt to give it all of Markdrop's documentation.
updated: 2026-10-30
keywords: [llms.txt, llms-full.txt, markdown, copy page, agents, context, claude, chatgpt, perplexity, docs mcp]
---

Every page on docs.markdrop.in is also plain Markdown, so you can hand it to an AI assistant without copying text out of a web page. Use it to ask questions about a page, or to give a coding agent the exact steps it needs.

## Copy or open a page

Each page has a **Copy page** button next to its title. Its menu has:

| Item | What it does |
|---|---|
| Copy page as Markdown | Copies the page's Markdown to your clipboard. |
| Copy page with prerequisites | Copies the page together with the pages it lists as prerequisites, so an assistant has everything it needs in one paste. |
| View as Markdown | Opens the page's Markdown in the browser. |
| Open in Claude | Opens claude.ai with a prompt to read this page. |
| Open in ChatGPT | Opens ChatGPT with the same prompt. |
| Open in Perplexity | Opens Perplexity with the same prompt. |

The prompt is "Read {page}.md and answer my questions about it." When you open an assistant, the page's Markdown is also copied to your clipboard, in case the assistant can't open the link: paste it into the chat.

To copy one section, hover over its heading and choose **Copy section**.

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

:::note[Coming soon]
**Ask AI** will answer questions from these docs. Until it ships, the ask box on the home page opens search, and :kbd[⌘K] searches every section of every page.
:::

## Connect the docs to your AI app

:::note[Coming soon]
A docs MCP server at `https://docs.markdrop.in/mcp` will let an AI app search and read these docs as tools, without you pasting anything. It isn't live yet.
:::

This is separate from Markdrop's own MCP server, which works with your documents and files. To connect that, see [Connect an AI app](/ai/hosted-mcp).
