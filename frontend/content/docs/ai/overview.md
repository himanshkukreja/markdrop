---
title: Use Markdrop from an AI app
nav: Overview
description: Connect Claude, ChatGPT, Cursor or VS Code to Markdrop so your assistant can publish, read and update documents and files as links.
updated: 2026-10-30
keywords: [ai, mcp, model context protocol, claude, chatgpt, cursor, copilot, assistant, agent, connector]
---

Markdrop speaks the Model Context Protocol (MCP), the standard AI apps use to call outside tools. Once connected, you can say "turn these notes into a Markdrop doc and give me the link" and your assistant publishes it, or "make my Q3 report private" and it changes the access.

There are two Markdrop servers. Which one you add depends on where your AI app runs and what you want it to do.

| | Hosted server | Local server |
|---|---|---|
| Address | `https://api.markdrop.in/mcp` | `markdrop mcp`, part of the CLI |
| Runs | On Markdrop | On your computer, started by the AI app |
| Works with | claude.ai and the Claude apps, ChatGPT, Claude Code, Cursor, VS Code, Windsurf and other apps that add remote servers | Claude Code, Claude Desktop, Cursor, VS Code and other apps that start local servers |
| Signs in with | Markdrop's approval screen (OAuth). No key to paste. | An API token (`MARKDROP_TOKEN` or `markdrop login`) for publishing |
| Best for | Publishing what the assistant writes, reading and updating your documents, access, analytics, workspaces | Publishing and replacing files from your disk (videos up to 2 GB), sending and receiving files peer to peer |
| Tools | 26 | 11 |

You can add both to the same app: the hosted server for documents, the local one for files on your disk.

## What your assistant can do

- **Publish.** Markdown becomes a rendered document with diagrams and math; an HTML page, CSV, JSON, SVG or text file becomes a link that opens rendered. You can ask for a custom address, a password, an expiry or private access.
- **Read and update.** Read documents you can open, replace a document's content and keep its link, list and search your documents.
- **Control access.** Change who can open a document, delete one, file it in a workspace folder.
- **Work with big files.** Upload a video, PDF or other file and later replace it behind the same link, with the last five versions kept.
- **See how it's doing.** Views, readers, where people drop off in a video, how far they read.
- **Send files peer to peer.** From an app on your computer, share files as a markdrop.in/share link and download links people send you.

Every tool is listed in [MCP tools](/ai/tools).

## What it can't do

- It can't read or change end-to-end encrypted documents. Their key never reaches Markdrop.
- It can't get past a password. A password-protected document has to be opened in a browser.
- It only acts as you: it can open what you could open with the link yourself, and writes only to documents you own or can edit.
- Nothing is published unless the assistant calls a publish tool. New links open for anyone with the link, like everything on Markdrop, unless you ask for private access or a password.

## Get started

::::cards
:::card[Connect an AI app]{href="/ai/hosted-mcp" icon="zap"}
Add the hosted server to Claude, ChatGPT, Cursor or VS Code and approve it on Markdrop.
:::
:::card[Add the local server]{href="/ai/local-mcp" icon="code"}
Let an AI app on your computer publish files from disk and send them peer to peer.
:::
:::card[Tool reference]{href="/ai/tools" icon="list"}
Every tool of both servers, grouped by what it does, with the permission it needs.
:::
:::card[Ask these docs]{href="/ai/use-these-docs" icon="doc"}
Give your assistant this documentation as Markdown.
:::
::::
