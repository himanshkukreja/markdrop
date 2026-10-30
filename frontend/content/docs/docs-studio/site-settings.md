---
title: Site settings
description: A Docs Studio site's settings. Its address, Ask AI, who can read it, search indexing, reviews, people, redirects, and unpublishing or deleting it.
updated: 2026-10-31
prerequisites: [/docs-studio/create-a-site]
keywords: [settings, address, slug, custom domain, own domain, ask ai, password, members only, search engines, noindex, unpublish, delete site]
---

Open a site and choose **Settings**. Only Docs Studio admins can change them; everyone else sees how the site is set up. Each setting saves as soon as you change it, and reaches readers at the next [publish](/docs-studio/publishing).

## Address

The site's free address, `<address>.docs.markdrop.in`, with **Copy link**. It always works, even once you can add your own domain.

To change it, choose **Change**, type the new address and choose **Save address**. The same [rules](/docs-studio/create-a-site#the-address) apply as when you created the site. The new address goes live at the next publish, and the **old one stops working**, so change it before you share the link.

![The Address card with acme.docs.markdrop.in and Copy link, and the Your own domain card marked Coming soon with a disabled Add a domain button.](/docs-assets/docs-studio/site-settings/settings-address.webp)

## Your own domain

:::note[Coming soon]
Serving a site from your own domain, like `docs.acme.com`, isn't available yet. **Add a domain** is disabled. The plan, as the app describes it: one CNAME record pointing to Markdrop, with the certificate handled for you, and a single rewrite rule if you want the docs at a path like `acme.com/docs`.
:::

This is separate from a Markdrop workspace's [own domain](/workspaces/custom-domain), which serves the workspace's documents and files, not its docs sites.

## Ask AI

Turn the assistant on or off, name it, and suggest questions. See [Ask AI on your site](/docs-studio/ask-ai).

## Who can read it

:::note[Coming soon]
For now every published docs site is public: **Anyone** can read it. **Anyone with the password** (for a beta or a partner preview) and **Workspace members only** (readers sign in with Markdrop) are listed but aren't available yet; choosing one says so and keeps the site public.
:::

**Let search engines index the site** is on by default. You can turn it off, but published sites don't apply it yet: they always allow search engines for now.

## Reviews

Require changes to be approved before they're published. See [Reviews](/docs-studio/reviews).

## People

Give someone a different role on this site. See [Members and roles](/docs-studio/members-and-roles#a-different-role-on-one-site). If you aren't an admin, this card shows **Your role**.

## GitHub sync

Marked **Coming soon**. See [GitHub sync](/docs-studio/github-sync).

## Imported from GitBook

For an imported site: where it came from, and **Open the import report**. See [Import from GitBook](/docs-studio/import-from-gitbook#check-the-report). Other sites show **Started from** (a template, or blank) here.

## Redirects

Send old addresses to their new pages. See [Redirects](/docs-studio/pages-and-navigation#redirects).

## Unpublish or delete

**Take the site down** has two buttons:

- **Unpublish** takes the site offline: its address stops showing the docs. Your pages, drafts and publish history stay, and publishing again puts it back.
- **Delete site** removes every page, version and publish, and the address stops working. To confirm, you type the site's name. This can't be undone, and its address is free for someone else to use.

![The Take the site down card with Unpublish and Delete site, and the note "Unpublish keeps your pages and history; delete removes everything."](/docs-assets/docs-studio/site-settings/settings-danger.webp)

Deleting a site also makes room for a new one in the workspace.
