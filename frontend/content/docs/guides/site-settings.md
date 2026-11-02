---
title: Guide settings
description: "A guide's settings: address and domains, who can read it, private pages, Ask AI, API reference, GitHub, redirects, people, and taking it down."
updated: 2026-11-02
prerequisites: [/guides/create-a-site]
anchors:
  use-your-own-domain: your-own-domain
  someone-else-runs-your-dns: your-own-domain
  where-to-add-the-record: your-own-domain
  root-domains: your-own-domain
  remove-a-domain: your-own-domain
  when-a-domain-doesnt-go-live: your-own-domain
keywords: [settings, export, self-host, download, address, slug, custom domain, own domain, ask ai, password, members only, private pages, search engines, noindex, github, redirects, reviews, unpublish, delete guide, delete site]
---

Open a guide and choose **Settings** in the bar at the top. The sections are listed on the left (a menu at the top on a phone): **General**, **Domains**, **Readers and access**, **Private pages**, **Ask AI**, **API reference**, **GitHub**, **Redirects**, **People and reviews**, **Export & self-host** and **Take it down**. Only Guides admins can change them; everyone else sees how the guide is set up. Each setting saves as soon as you change it, says so, and reaches readers at the next [publish](/guides/publishing) (the people a private-page rule lets in change within a minute, without one).

![Acme's Settings › General: the sections on the left (General, Domains, Readers and access, Private pages, Ask AI, API reference, GitHub, Redirects, People and reviews, Take it down), and the Name, Free address (acme.guides.markdrop.in with Copy, Open and Add your own domain), Logo and favicon, GitHub (Not connected, with Open GitHub settings) and Started from (Template) cards.](/docs-assets/guides/site-settings/settings-general.webp)

## General

The guide's **name**, its **free address**, its **logo and favicon** (set under [Design](/guides/brand-and-style)), where it started, and a summary of its [GitHub](#github) connection.

### Address

The guide's free address, `<address>.guides.markdrop.in`, with **Copy** and **Open**. It always works, even after you add your own domain.

To change it, choose **Change**, type the new address and choose **Save address**. The same [rules](/guides/create-a-site#the-address) apply as when you created the guide. The new address goes live at the next publish, and the **old one stops working**, so change it before you share the link.

![The Free address card: acme.guides.markdrop.in with Copy and Open, Change at the top, and a link to add your own domain.](/docs-assets/guides/site-settings/settings-address.webp)

## Your own domain

Serve the guide from a subdomain your company owns, like `help.acme.com`, beside the free address: one `CNAME` record, or one click with a supported DNS provider, and the HTTPS certificate is handled for you. **Settings › Domains** lists every address the guide answers at. See [Put your guide on your own domain](/guides/custom-domain) for the steps, where to add the record at each provider, and what to do when a domain doesn't go live.

## Ask AI

Turn the assistant on or off, name it, and suggest questions. See [Ask AI on your guide](/guides/ask-ai).

## API reference

The OpenAPI file your guide's API reference is generated from: drop it in or fetch it from a URL, see what the checks found, see the endpoint pages readers will get, choose where it appears and whether readers get Try it, and publish it. See [API reference from an OpenAPI file](/guides/api-reference).

## Who can read it

Under **Readers and access**, three choices: **Anyone** (a public guide), **Anyone with the password** (for a beta or a partner preview) and **Workspace members** (readers sign in with Markdrop, good for internal handbooks). Changes reach readers at the next publish.

![Readers and access: Who can read it with Anyone (A public guide) selected, and Anyone with the password and Acme members each marked Coming soon on a server where they aren't switched on; Show in search engines turned on.](/docs-assets/guides/site-settings/settings-access.webp)

:::note[Marked Coming soon?]
Password and members-only guides are switched on per Markdrop server. Where they aren't yet, both are marked **Coming soon** and can't be chosen, and every published guide is public. To keep **some** pages or sections for some readers in a public guide, use [private pages](/guides/private-pages): they work on every guide.
:::

**Show in search engines** is on by default. Turn it off to keep the guide out of search results, for example while it's a work in progress: after the next publish, every page asks search engines not to index it (a `noindex` tag and header), `robots.txt` disallows crawling, and the sitemap is empty. Readers with the link can still open the site. A password or members-only guide is never indexed.

## Private pages

Keep the guide public and make some pages, groups or sections private: for your team, a customer's people (by email address or `@domain`), or partners with a password. **Settings › Private pages** has the rules, which group each one covers, access requests, **Preview as** and the access history. See [Private pages and sections](/guides/private-pages).

## People and reviews

**Require a review before publishing** makes editors' changes wait for an approval. See [Reviews](/guides/reviews).

Under **People**, give someone a different role on this guide. See [Members and roles](/guides/members-and-roles#a-different-role-on-one-guide). If you aren't an admin, this card shows **Your role**.

## GitHub

**Settings › GitHub** connects the guide to a GitHub repository and keeps it in sync: the repository, branch and folder, what a push does (**Update drafts** or **Publish automatically**), **Sync now**, the sync history and **Disconnect**. See [Import from GitHub and keep in sync](/guides/import-from-github#the-github-settings).

## Imported from GitBook

For an imported guide: where it came from, and **Open the import report**. See [Import from GitBook](/guides/import-from-gitbook#check-the-report). Other guides show **Started from** (a template, or blank) here.

## Redirects

Send old addresses to their new pages. Each row says why it's there: **Page moved** (Markdrop added it when you moved a published page) or **Added in Settings**. An imported guide also lists the old GitBook addresses the import found, under **From the GitBook import**. See [Redirects](/guides/pages-and-navigation#redirects).

## Export and self-host

**Settings › Export & self-host** downloads the guide as a folder of Markdown and files (a `.zip`), the published version or the current drafts, ready to run on your own server with the open-source engine. Private pages are left out unless you choose to export them as public. See [Self-hosting](/guides/self-hosting#export-a-guide-from-the-studio).

## Unpublish or delete

**Take it down** has two buttons:

- **Unpublish** takes the guide offline: its address stops showing it. Your pages, drafts and publish history stay, and publishing again puts it back.
- **Delete guide** removes every page, version and publish, and the address stops working. To confirm, you type the guide's name. This can't be undone, and its address is free for someone else to use.

![The Take the guide down card with Unpublish and Delete guide, and the note "Unpublish keeps your pages and history; delete removes everything."](/docs-assets/guides/site-settings/settings-danger.webp)

Deleting a guide also makes room for a new one in the workspace.

## Related

- [Your own domain](/guides/custom-domain): add a domain.
- [Private pages and sections](/guides/private-pages): rules, requests and Preview as.
- [Limits](/guides/limits): what the beta allows.
