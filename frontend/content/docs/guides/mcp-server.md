---
title: "Give AI tools your docs: the MCP server"
nav: MCP server
description: Every published guide has its own MCP server. Readers connect Claude, Cursor, VS Code or ChatGPT, and their assistant searches and reads your guide.
updated: 2026-11-02
prerequisites: [/guides/publishing]
keywords: [mcp, mcp server, model context protocol, connect to ai, claude, cursor, vs code, copilot, chatgpt, claude code, ai tools, llms.txt, docs for ai, remote mcp]
---

Every published guide has its own **MCP server** at its address plus `/mcp`, like `https://acme.guides.markdrop.in/mcp`. MCP (the Model Context Protocol) is how AI apps such as Claude, Cursor, VS Code and ChatGPT use outside tools. Once a reader connects your guide, their assistant can search it and read its pages while it helps them, instead of guessing or relying on what it learned months ago.

There is nothing to set up: the server comes with every public guide, and it answers from what you last published.

## What AI tools can do with it

The server has these tools. All of them only read, apart from reporting a problem.

| Tool | What it does |
|---|---|
| `search_docs` | Searches the guide and returns the best-matching sections, each with its page, a link straight to the section and a short snippet. |
| `read_page` | Reads one page as Markdown, with its title, address and last update. It can also return the pages that page builds on, first. |
| `whats_changed` | Lists recent [changelog](/guides/changelog) entries, newest first, or those since a date. Only on a guide with changelog entries. |
| `report_problem` | Sends you a note that a page is wrong, unclear or missing something. Only while [Insights](/guides/insights) is on: reports land in your [Fix list](/guides/fix-list). |

The assistant links people to the exact sections it used, so readers can check the answer. While Insights is on, searches that find nothing show up in your Fix list too, so you can see what AI tools ask for and your guide doesn't answer yet.

## Connect your AI tools

On every page of a published guide, the **Copy page** menu (the arrow beside **Copy page**) has a **Connect to AI** part. On a phone it's behind **More** in the bar at the bottom of the page; on a wide screen, **Connect to AI** is also under the page's contents on the right.

- **Copy MCP server URL** copies the address, for any app that takes an MCP server.
- **Add to Cursor** opens Cursor and asks to install the guide as an MCP server.
- **Add to VS Code** opens VS Code and asks to install it for GitHub Copilot Chat.
- **Connect Claude, ChatGPT and more** shows the steps for each app below, with the URL and a copy button.

The server needs no sign-in and no API key.

### Claude

In Claude on the web or the desktop app, open **Settings** › **Connectors**, choose **Add custom connector**, give it a name and paste the URL. Claude's Free plan allows one custom connector; paid plans allow more.

In **Claude Code**, run:

```bash
claude mcp add --transport http acme-docs https://acme.guides.markdrop.in/mcp
```

### Cursor and VS Code

Use **Add to Cursor** or **Add to VS Code** in the menu. To add it by hand, put the URL in the app's MCP settings as a remote (HTTP) server:

```json
{
  "mcpServers": {
    "acme-docs": { "url": "https://acme.guides.markdrop.in/mcp" }
  }
}
```

VS Code's own `mcp.json` uses `"servers"` and `"type": "http"` instead.

### ChatGPT

ChatGPT connects to MCP servers in **developer mode**, on the web, on the Plus, Pro, Business, Enterprise and Edu plans. Turn it on under **Settings** › **Apps** › **Advanced settings**, then create an app with the URL and no authentication. OpenAI changes where these settings live from time to time; its help pages have the current steps.

### Other apps

Any app that connects to remote MCP servers over Streamable HTTP can use the URL as it is.

## Turn the menu on or off

Guides admins choose whether pages show **Connect to AI**:

::::steps
### Open the setting
Open the guide's **Settings** › **Ask AI** and find **Your guide's MCP server**.

### Switch it
**Shown on pages** offers Connect to AI to readers. It's on for every new guide. Switch it to **Hidden on pages** to take it off.

### Publish
Pages change with the next [publish](/guides/publishing).
::::

Hiding the menu doesn't turn the server off: anyone who has the URL can still connect, the same way anyone can read a public page.

The same card shows the server's URL (your own domain when the guide has one), copy and install buttons, and **Test it**, which asks the live server for its tools the way an AI app does and lists them. The **Publish** screen shows the URL too once your guide is live.

## What it never shares

- **Only published pages.** Drafts never reach it.
- **Never private pages.** [Private pages and sections](/guides/private-pages) are left out of the server completely, for everyone, signed in or not. An AI tool can't search them or read them.
- **Guides that ask readers to sign in** (password-protected or members-only) have no reachable MCP server, because AI tools can't sign in, and their pages don't offer Connect to AI.
- **Nothing about the reader.** The server keeps no session and sets no cookies. While [Insights](/guides/insights) is on, it counts how often AI tools use your guide, not who.
- **The build checks it.** Every publish of a guide with private pages checks that none of their text reached the server, and stops if it did.

## llms.txt, Markdown and the server

The MCP server sits alongside the other ways AI tools read a guide (see [What readers get](/guides/what-readers-get)):

- `/llms.txt` lists every page with its description, and `/llms-full.txt` has the whole guide's text in one file.
- Every page has a Markdown version: add `.md` to its address, or use **Copy page** or **View as Markdown**.
- **Open in Claude** and **Open in ChatGPT** in the same menu start a chat about the page you're on.

The MCP server is the best of these for an assistant: it searches instead of loading everything, and it always has your latest publish.
