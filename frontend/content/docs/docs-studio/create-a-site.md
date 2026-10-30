---
title: Create your first docs site
nav: Create a site
description: Start a Docs Studio site blank or from a template, choose where it lives, and pick its free address.
updated: 2026-10-31
prerequisites: [/docs-studio/overview]
keywords: [new docs site, create site, template, product docs, api reference, help center, blank site, address, slug, docs.markdrop.in]
---

A new site starts as drafts that only you and your team can see. Nothing is public until you publish.

## Create the site

::::steps
### Open New docs site
In [Docs Studio](https://markdrop.in/docs-studio), choose **New docs site**. Under a workspace's name, **New site here** starts one in that workspace.

### Choose where it lives
Under **Where it lives**, pick a **Workspace**, or **Personal (only you)**. Workspaces you aren't a Docs Studio admin of are listed with "(Docs Studio admins only)" and can't be picked.

### Choose how to start
Under **How do you want to start?**, pick **Blank site** or **From a template**. **Import from GitBook** has [its own page](/docs-studio/import-from-gitbook). **Connect a GitHub repo** is [coming soon](/docs-studio/github-sync).

### Name it and pick its address
Type the **Site name**. It's shown in the site's header and in link previews. The **Address** fills in from the name and is checked as you type.

### Create it
Choose **Create site**. Docs Studio opens **Design** so you can [pick a theme](/docs-studio/themes). Choose **Skip to the editor** to do that later.
::::

![The New docs site form: Where it lives set to the Northwind workspace, From a template and Product docs selected, Site name "Northwind Docs" and the address northwind-docs.docs.markdrop.in marked Available.](/docs-assets/docs-studio/create-a-site/new-site-template.webp)

## Templates

| Template | What you get |
| --- | --- |
| **Product docs** | A home page, Getting started (Introduction, Quickstart), Guides (The basics) and Help (FAQ, Release notes), in the Clean theme. |
| **API reference** | A home page, Overview (Authentication, Errors) and Endpoints (List items), in the Technical theme. |
| **Help center** | A home page and articles grouped into Account and billing and Troubleshooting, in the Help center theme. |

The pages are examples to replace. Edit, rename or delete any of them.

:::note[API reference pages]
The API reference template gives you hand-written pages to fill in. Docs Studio can't generate reference pages from an OpenAPI file yet.
:::

A **Blank site** has one page, the home page, in a group called Getting started.

## The address

Every site gets a free address: `<address>.docs.markdrop.in`. It must be:

- 3 to 40 characters
- lowercase letters, numbers and hyphens, starting and ending with a letter or number
- not taken by another site, and not a reserved word like `www`, `api`, `docs` or `help`

When the address you want is taken, Docs Studio says so and offers another one.

![The Name and address section with Site name "Acme" and the address acme marked "That address is taken." with a "Use acme-docs" link.](/docs-assets/docs-studio/create-a-site/new-site-address-taken.webp)

You can change the address later in [Site settings](/docs-studio/site-settings#address). Do it before you share the link: the old address stops working.

## Who can create a site

- **In a workspace:** Docs Studio admins of that workspace. Workspace owners and admins always are. See [Members and roles](/docs-studio/members-and-roles).
- **Personal:** anyone. A personal site is yours alone: no one else can open or edit it.

While Docs Studio is in beta, a workspace can have a limited number of sites. When it has its most, the form says so: delete a site in its [settings](/docs-studio/site-settings#unpublish-or-delete) to make room, or choose another workspace.

## Next

- [Write in the editor](/docs-studio/editor)
- [Pick a theme](/docs-studio/themes)
- [Publish](/docs-studio/publishing)
