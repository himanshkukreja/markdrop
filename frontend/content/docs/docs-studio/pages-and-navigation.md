---
title: Pages and navigation
description: Add pages, group and order them in the sidebar, hide pages, choose their addresses, and redirect old addresses in a Docs Studio site.
updated: 2026-10-31
prerequisites: [/docs-studio/editor]
keywords: [page tree, sidebar, navigation, groups, new page, hidden pages, page address, url, path, redirects, move page, delete page]
---

The page tree on the left of the editor is the site's sidebar: its groups and pages in the order readers see them.

## Add a page

Choose **+** (**New page**) at the top of the tree.

::::steps
### Title
Type the page's **Title**.

### Group
Pick its **Group in the sidebar**, or **New group…** and type a **Group name**. A new page goes after the page you have open when it's in the same group, else at the end of the group.

### Address
The **Address** fills in from the group and title, like `/guides/slack-notifications`. Change it if you like.

### Create it
Choose **Create page**. It starts as a draft: readers see it after the next publish.
::::

![The New page dialog with Title "Slack notifications", Group in the sidebar "Guides" and the Address /guides/slack-notifications.](/docs-assets/docs-studio/pages-and-navigation/new-page-dialog.webp)

## Move, reorder and delete

Each page in the tree has a menu (**…**) with **Move up**, **Move down**, **Move to** another group, and **Delete page**. The new order is saved straight away and reaches readers at the next publish.

![The page tree with the menu of Alert rules open: Move up, Move down, Move to Getting started, Move to Reference, Move to Help and Delete page.](/docs-assets/docs-studio/pages-and-navigation/page-tree.webp)

Deleting a page asks first. If it's on the published site, it disappears at the next publish and old links to it stop working, so [add a redirect](#redirects) if people link to it. You can't delete the home page, or a page someone else is editing.

## Page settings

The panel on the right of the editor (**Page settings** on smaller screens) has:

- **Address**: where the page lives on the site.
- **Show in the sidebar**: turn it off to [hide the page](#hidden-pages).
- **Icon**: shown beside the page in the sidebar, or **No icon**.
- **History**: the page's last saves, and **See all versions**. See [History and versions](/docs-studio/history).

![The page settings panel of Quickstart: Address /getting-started/quickstart, Show in the sidebar on, Icon zap, and History with three saves by Alex, Maya and Riya.](/docs-assets/docs-studio/pages-and-navigation/page-settings.webp)

## Page addresses

An address starts with `/` and has up to 6 parts, like `/guides/connect-postgres`. Each part uses lowercase letters, numbers and hyphens. The editor tells you what's wrong as you type:

- it can't end with `/` or contain `//`
- it can be at most 200 characters
- two pages can't have the same address
- it can't start with a part the docs site uses itself: `docs-assets`, `mcp`, `md`, `og`, `changelog`, `public`, `api-reference`, `api-reference-json` or `video-scenes`, and `video-scenes` can't be any other part either

When you name a page in a group whose name can't start an address (a group called "API reference", say), the suggested address leaves the group out: `/payments`, not `/api-reference/payments`.

The home page is always `/`. Its address can't change, it can't be hidden, and it can't be deleted.

:::note[Changing an address]
When you change the address of a page that's on the published site, Docs Studio adds a redirect from the old address to the new one in [Redirects](#redirects), so links people saved keep working after the next publish. Change it again and that redirect follows the page: there's never a chain. Redirects that pointed at the old address are moved to the new one too. A page that was never published gets no redirect, since nobody has a link to it.
:::

## Hidden pages

Turn off **Show in the sidebar** to hide a page. It moves to **Hidden pages** at the bottom of the tree. A hidden page is still published and opens at its address: it's only left out of the sidebar. Use it for pages you link to from elsewhere, or for old pages you keep for existing links. Turn it back on to put the page at the end of the last group.

## Redirects

Moved or renamed a page? Send its old address to the new one in the site's **Settings › Redirects**, so links people saved keep working. Admins edit redirects.

::::steps
### Add a row
Choose **Add a redirect**.

### Fill it in
Type the **Old address**, like `/guides/postgres`, and where it **Goes to**: a page of the site (`/guides/connect-postgres`, optionally with a `#section`) or any `https://` address.

### Save
Choose **Save** (it says how many). Redirects go live at the next publish.
::::

![The Redirects card with two rows: /guides/postgres to /guides/connect-postgres, and /setup to /getting-started/install marked in red with "There's no page /getting-started/install." and the note "Fix the rows marked in red to save."](/docs-assets/docs-studio/pages-and-navigation/redirects.webp)

A row is refused when it would break something: an old address that's still a page of the site, the home page, one of the site's own addresses like `/llms.txt`, a page that doesn't exist, a redirect to itself, the same old address twice, or a chain (an address that redirects again). Readers get a permanent redirect, and only when no page or file of the site is at that address.

Pages imported from GitBook keep their old addresses working without rows here, alongside the ones you add. See [Import from GitBook](/docs-studio/import-from-gitbook#what-comes-across).
