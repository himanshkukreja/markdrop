---
title: Docs Studio
nav: Overview
description: Docs Studio builds and hosts documentation sites for your product. What it does, how it differs from Markdrop's own docs, and where to start.
updated: 2026-10-31
keywords: [docs studio, documentation site, docs site, help center, knowledge base, gitbook alternative, hosted docs, beta]
---

Docs Studio builds and hosts docs sites for your product; these pages explain how to use it. You write pages in the browser, pick a theme, and publish to an address like `acme.docs.markdrop.in`. Your readers get search, Ask AI and pages their AI tools can read.

:::note[Two kinds of docs]
The site you're reading, docs.markdrop.in, is Markdrop's own documentation. It's built with the same engine, but it isn't a Docs Studio site you manage. The pages in this **Docs Studio** tab are about the product at [markdrop.in/docs-studio](https://markdrop.in/docs-studio), where you make docs sites for *your* product. Everything else on this site is about Markdrop itself.
:::

Docs Studio is in beta, and free while it is.

![The Docs Studio home page with the Acme workspace's three docs sites: Acme (Live, Clean theme, 14 pages, published 5 hours ago by Riya), Acme Help Center (In review, Priya's changes waiting for review) and Acme Developers (Draft, not published yet).](/docs-assets/docs-studio/overview/studio-home.webp "Docs Studio's home lists every site you can open, grouped by workspace.")

## What you can do

::::cards
:::card[Create a site]{href="/docs-studio/create-a-site" icon="plus"}
Start blank or from a template: product docs, an API reference or a help center.
:::
:::card[Import from GitBook]{href="/docs-studio/import-from-gitbook" icon="download"}
Bring pages, images, navigation and old links across from a public GitBook site.
:::
:::card[Write in the editor]{href="/docs-studio/editor" icon="edit"}
A visual editor with a slash menu for callouts, steps, tabs and code, or plain Markdown.
:::
:::card[Pick a theme]{href="/docs-studio/themes" icon="image"}
Six themes, your logo and colours, fonts, corners and custom CSS.
:::
:::card[Publish and review]{href="/docs-studio/publishing" icon="send"}
Drafts stay private until you publish. Turn on reviews to have changes approved first.
:::
:::card[Give people roles]{href="/docs-studio/members-and-roles" icon="users"}
Admin, Reviewer, Editor or Viewer, for the whole workspace or one site.
:::
::::

## How it works

1. **A site lives in a workspace**, or is personal to you. Workspace sites are shared with the people who have a Docs Studio role there. Workspaces themselves are Markdrop's: see [Create a workspace](/workspaces/create).
2. **Every page is a draft** until you publish. Drafts save as you type, and every save is a version you can go back to.
3. **Publishing builds the site.** Readers keep seeing the last published version until the new one is live, a few seconds later. Every publish is numbered, and an admin can put an earlier one back.
4. **Readers get a fast static site** with search, an AI assistant that answers from your pages, a Markdown copy of every page and `llms.txt`. See [What readers get](/docs-studio/what-readers-get).

## Watch it once

::video{id="docs-studio-first-site" title="Create and publish your first docs site" duration="0:50"}

## Before you start

You need a free Markdrop account: Docs Studio uses the same sign-in as the rest of Markdrop. See [Accounts](/get-started/accounts).

To create a site in a workspace you need to be a Docs Studio admin there. Workspace owners and admins always are. Anyone can create a personal site.

## What isn't there yet

These are planned and marked **Coming soon** in the app:

- **Your own domain.** For now every site is served at its free `<name>.docs.markdrop.in` address. See [Site settings](/docs-studio/site-settings#your-own-domain).
- **Password-protected and members-only sites.** For now every published site is public. See [Site settings](/docs-studio/site-settings#who-can-read-it).
- **GitHub sync.** See [GitHub sync](/docs-studio/github-sync).

## Open Docs Studio

Go to [markdrop.in/docs-studio](https://markdrop.in/docs-studio). From inside Markdrop you can also get there from your account menu (**Docs Studio**), from a workspace's **Docs sites** link in the sidebar, or with **Docs site** in the create menu. Inside Docs Studio, the **Switch app** button in the header goes back to Markdrop.
