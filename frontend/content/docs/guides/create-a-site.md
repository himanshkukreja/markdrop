---
title: Create your first guide
nav: Create a guide
description: Start a guide blank or from a template, choose where it lives, and pick its free address.
updated: 2026-10-31
prerequisites: [/guides/overview]
keywords: [new guide, create guide, create site, template, product guide, api reference, help center, blank guide, address, slug, guides.markdrop.in]
---

A new guide starts as drafts that only you and your team can see. Nothing is public until you publish.

## Create the guide

::::steps
### Open New guide
In [Markdrop Guides](https://markdrop.in/guides), choose **New guide**. Under a workspace's name, **New guide here** starts one in that workspace.

### Choose where it lives
Under **Where it lives**, pick a **Workspace**, or **Personal (only you)**. Workspaces you aren't a Guides admin of are listed with "(Guides admins only)" and can't be picked.

### Choose how to start
Under **How do you want to start?**, pick **Blank guide** or **From a template**. **Import from GitBook** has [its own page](/guides/import-from-gitbook). **Connect a GitHub repo** is [coming soon](/guides/github-sync).

### Name it and pick its address
Type the **Guide name**. It's shown in the guide's header and in link previews. The **Address** fills in from the name and is checked as you type.

### Create it
Choose **Create guide**. Markdrop Guides opens **Design** so you can [pick a theme](/guides/themes). Choose **Skip to the editor** to do that later.
::::

![The New guide form: Where it lives set to the Northwind workspace, From a template and Product guide selected, Guide name "Northwind Help" and the address northwind-help.guides.markdrop.in marked Available.](/docs-assets/guides/create-a-site/new-site-template.webp)

## Templates

| Template | What you get |
| --- | --- |
| **Product guide** | A home page, Getting started (Introduction, Quickstart), Guides (The basics) and Help (FAQ, Release notes), in the Clean theme. |
| **API reference** | A home page, Overview (Authentication, Errors) and Endpoints (List items), in the Technical theme. |
| **Help center** | A home page and articles grouped into Account and billing and Troubleshooting, in the Help center theme. |

The pages are examples to replace. Edit, rename or delete any of them.

:::note[API reference pages]
The API reference template gives you hand-written pages to fill in. Markdrop Guides can't generate reference pages from an OpenAPI file yet.
:::

A **Blank guide** has one page, the home page, in a group called Getting started.

## The address

Every guide gets a free address: `<address>.guides.markdrop.in`. It must be:

- 3 to 40 characters
- lowercase letters, numbers and hyphens, starting and ending with a letter or number
- not taken by another guide, and not a reserved word like `www`, `api`, `docs` or `help`

When the address you want is taken, Markdrop Guides says so and offers another one.

![The Name and address section with Guide name "Acme" and the address acme marked "That address is taken." with a "Use acme-help" link.](/docs-assets/guides/create-a-site/new-site-address-taken.webp)

You can change the address later in [Guide settings](/guides/site-settings#address). Do it before you share the link: the old address stops working.

## Who can create a guide

- **In a workspace:** Guides admins of that workspace. Workspace owners and admins always are. See [Members and roles](/guides/members-and-roles).
- **Personal:** anyone. A personal guide is yours alone: no one else can open or edit it.

While Markdrop Guides is in beta, a workspace can have a limited number of guides. When it has its most, the form says so: delete a guide in its [settings](/guides/site-settings#unpublish-or-delete) to make room, or choose another workspace.

## Next

- [Write in the editor](/guides/editor)
- [Pick a theme](/guides/themes)
- [Publish](/guides/publishing)
