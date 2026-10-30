---
title: Markdrop Docs
description: Publish documents and files, share them safely, run workspaces on your own domain, and use Markdrop from your editor, terminal and AI assistant.
updated: 2026-10-30
---

Markdrop turns what you drop into a link that renders in any browser: Markdown documents, and files like PDFs, videos, spreadsheets, Word documents, HTML and zipped websites. These docs cover every part of it.

## Start here

- [What is Markdrop](/get-started/what-is-markdrop): what it does, and the two kinds of things you can publish.
- [Publish your first document](/get-started/first-document): paste Markdown and get a link. No account needed.
- [Share your first file](/get-started/first-file): upload a file that opens in the browser.
- [Connect an AI assistant](/ai/overview): let Claude, ChatGPT or Cursor publish and update links for you.

## Browse by area

- Documents: [Writing](/documents/writing), [Addresses](/documents/addresses), [Edit key](/documents/edit-key), [Passwords and expiry](/documents/passwords-and-expiry)
- Files: [Supported types](/files/supported-types), [Limits](/files/limits), [Replace and versions](/files/replace-and-versions)
- Sharing and access: [Who can open a link](/sharing/who-can-open), [Share with people](/sharing/share-with-people), [End-to-end encryption](/sharing/end-to-end-encryption)
- Workspaces and domains: [Create a workspace](/workspaces/create), [Folders](/workspaces/folders), [Your own domain](/workspaces/custom-domain)
- Analytics: [Overview](/analytics/overview), [What gets counted](/analytics/what-gets-counted)
- CLI: [Install](/cli/install), [Upload and replace](/cli/upload-and-replace), [Send and receive](/cli/send-and-receive)
- VS Code: [Sync a file](/vscode/sync), [Conflicts](/vscode/conflicts)
- AI and MCP: [Hosted MCP server](/ai/hosted-mcp), [Local MCP server](/ai/local-mcp), [Tools](/ai/tools)

## Install the CLI

```bash title="macOS"
brew install himanshkukreja/tap/markdrop
```

```bash title="Linux"
curl -fsSL https://github.com/himanshkukreja/markdrop/releases/latest/download/install.sh | sh
```

```powershell title="Windows"
irm https://github.com/himanshkukreja/markdrop/releases/latest/download/install.ps1 | iex
```

Then run `markdrop login`, and `markdrop upload deck.pdf` to publish a file.

## For AI assistants

Every page has a Markdown version: add `.md` to its address, or request it with `Accept: text/markdown`. The full list of pages is at [/llms.txt](/llms.txt), every page in one file is at [/llms-full.txt](/llms-full.txt), and recent changes are at [/changelog.md](/changelog.md).
