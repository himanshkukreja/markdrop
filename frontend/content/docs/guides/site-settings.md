---
title: Guide settings
description: A guide's settings. Its address, Ask AI, who can read it, search indexing, reviews, people, redirects, and unpublishing or deleting it.
updated: 2026-10-31
prerequisites: [/guides/create-a-site]
keywords: [settings, address, slug, custom domain, own domain, ask ai, password, members only, search engines, noindex, unpublish, delete guide, delete site]
---

Open a guide and choose **Settings**. Only Guides admins can change them; everyone else sees how the guide is set up. Each setting saves as soon as you change it, and reaches readers at the next [publish](/guides/publishing).

## Address

The guide's free address, `<address>.guides.markdrop.in`, with **Copy link**. It always works, even once you can add your own domain.

To change it, choose **Change**, type the new address and choose **Save address**. The same [rules](/guides/create-a-site#the-address) apply as when you created the guide. The new address goes live at the next publish, and the **old one stops working**, so change it before you share the link.

![The Address card with acme.guides.markdrop.in and Copy link, and the Your own domain card marked Coming soon with a disabled Add a domain button.](/docs-assets/guides/site-settings/settings-address.webp)

## Your own domain

:::note[Coming soon]
Serving a guide from your own domain, like `help.acme.com`, isn't available yet. **Add a domain** is disabled. The plan, as the app describes it: one CNAME record pointing to Markdrop, with the certificate handled for you, and a single rewrite rule if you want the guide at a path like `acme.com/help`.
:::

This is separate from a Markdrop workspace's [own domain](/workspaces/custom-domain), which serves the workspace's documents and files, not its guides.

## Ask AI

Turn the assistant on or off, name it, and suggest questions. See [Ask AI on your guide](/guides/ask-ai).

## API reference

The OpenAPI file your guide's API reference is generated from: upload it or fetch it from a URL, see what it found, preview the sidebar it makes, and choose where it appears and whether readers get Try it. See [API reference from an OpenAPI file](/guides/api-reference).

## Who can read it

:::note[Coming soon]
For now every published guide is public: **Anyone** can read it. **Anyone with the password** (for a beta or a partner preview) and **Workspace members only** (readers sign in with Markdrop) are listed but aren't available yet; choosing one says so and keeps the guide public.
:::

**Let search engines index the guide** is on by default. Turn it off to keep the guide out of search results, for example while it's a work in progress: after the next publish, every page asks search engines not to index it (a `noindex` tag and header), `robots.txt` disallows crawling, and the sitemap is empty. Readers with the link can still open the site.

## Reviews

Require changes to be approved before they're published. See [Reviews](/guides/reviews).

## People

Give someone a different role on this guide. See [Members and roles](/guides/members-and-roles#a-different-role-on-one-guide). If you aren't an admin, this card shows **Your role**.

## GitHub sync

Marked **Coming soon**. See [GitHub sync](/guides/github-sync).

## Imported from GitBook

For an imported guide: where it came from, and **Open the import report**. See [Import from GitBook](/guides/import-from-gitbook#check-the-report). Other guides show **Started from** (a template, or blank) here.

## Redirects

Send old addresses to their new pages. See [Redirects](/guides/pages-and-navigation#redirects).

## Unpublish or delete

**Take the guide down** has two buttons:

- **Unpublish** takes the guide offline: its address stops showing it. Your pages, drafts and publish history stay, and publishing again puts it back.
- **Delete guide** removes every page, version and publish, and the address stops working. To confirm, you type the guide's name. This can't be undone, and its address is free for someone else to use.

![The Take the guide down card with Unpublish and Delete guide, and the note "Unpublish keeps your pages and history; delete removes everything."](/docs-assets/guides/site-settings/settings-danger.webp)

Deleting a guide also makes room for a new one in the workspace.
