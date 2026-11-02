---
title: Pages and navigation
description: Add pages, drag them into groups and order in the sidebar, hide pages or make them private, choose their addresses, and redirect old addresses in a guide.
updated: 2026-11-02
prerequisites: [/guides/editor]
keywords: [page tree, sidebar, navigation, groups, new page, drag and drop, reorder pages, hidden pages, private pages, page address, url, path, redirects, move page, delete page]
---

The page tree on the left of the editor is the guide's sidebar: its groups and pages in the order readers see them.

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

![The New page dialog with Title "Slack notifications", Group in the sidebar "Guides" and the Address /guides/slack-notifications.](/docs-assets/guides/pages-and-navigation/new-page-dialog.webp)

## Move, reorder and delete

Drag a page by the grip beside it (it shows when you point at the page): up or down in its group, or into another group. A line shows where it lands, and a folded or empty group lights up when you're over it. Drag a group's header the same way to reorder the groups, or a [hidden page](#hidden-pages) into a group to put it back in the sidebar. A message says what moved, with **Undo**.

With the keyboard, focus a page's grip, press Space to pick it up, ↑ or ↓ to move it, and Space to drop it (Esc cancels).

Each page in the tree also has a menu (**…**) with **Move up**, **Move down**, **Move to** another group, and **Delete page**. The new order is saved straight away and reaches readers at the next publish. Pages that come from a connected GitHub repository take their place in the sidebar from the repository: see [Import from GitHub and keep in sync](/guides/import-from-github#keep-it-in-sync).

![The page tree with Alert rules pointed at, its drag grip on the left, and its menu open: Move up, Move down, Move to Getting started, Move to Reference, Move to Help and Delete page. Hidden pages, with Legacy connectors, at the bottom.](/docs-assets/guides/pages-and-navigation/page-tree.webp)

Deleting a page asks first. If it's on the published guide, it disappears at the next publish and old links to it stop working, so [add a redirect](#redirects) if people link to it. You can't delete the home page, or a page someone else is editing.

## Page settings

The **Page** tab of the panel on the right of the editor (**Page** in the bar on smaller screens) has:

- **Address**: where the page lives in the guide.
- **Icon**: shown beside the page in the sidebar. **Remove** takes it away.
- **Description**: one sentence under the title, in search results and link previews.
- **Show in the sidebar**: turn it off to [hide the page](#hidden-pages).
- **Who can open this page**: **Inherit** (its group's rule), **Public**, or one of the guide's private-page rules. See [Private pages and sections](/guides/private-pages#make-a-page-private).

The page's saves are in the **History** tab. See [History and versions](/guides/history).

![The Page tab of Quickstart: Address /getting-started/quickstart, Icon (a lightning bolt) with Remove, the Description with its length, Show in the sidebar on, and Who can open this page set to Inherit: anyone (public), with Preview as and Manage rules.](/docs-assets/guides/pages-and-navigation/page-settings.webp)

## Page addresses

An address starts with `/` and has up to 6 parts, like `/guides/connect-postgres`. Each part uses lowercase letters, numbers and hyphens. The editor tells you what's wrong as you type:

- it can't end with `/` or contain `//`
- it can be at most 200 characters
- two pages can't have the same address
- it can't start with a part the guide uses itself: `docs-assets`, `mcp`, `md`, `og`, `changelog`, `public`, `api-reference`, `api-reference-json` or `video-scenes`, and `video-scenes` can't be any other part either

When you name a page in a group whose name can't start an address (a group called "API reference", say), the suggested address leaves the group out: `/payments`, not `/api-reference/payments`.

The home page is always `/`. Its address can't change, it can't be hidden, and it can't be deleted.

:::note[Changing an address]
When you change the address of a page that's on the published guide, Markdrop Guides adds a redirect from the old address to the new one in [Redirects](#redirects), so links people saved keep working after the next publish. Change it again and that redirect follows the page: there's never a chain. Redirects that pointed at the old address are moved to the new one too. A page that was never published gets no redirect, since nobody has a link to it.
:::

## Hidden pages

Turn off **Show in the sidebar** to hide a page. It moves to **Hidden pages** at the bottom of the tree. A hidden page is still published and opens at its address: it's only left out of the sidebar. Use it for pages you link to from elsewhere, or for old pages you keep for existing links. Turn it back on to put the page at the end of the last group, or drag it into a group.

A hidden page isn't private: anyone with its address can open it. To keep a page for some readers only, make it [private](/guides/private-pages).

## Redirects

Moved or renamed a page? Send its old address to the new one in the guide's **Settings › Redirects**, so links people saved keep working. Admins edit redirects.

::::steps
### Add a row
Choose **Add a redirect**.

### Fill it in
Type the **Old address**, like `/guides/postgres`, and where it **Goes to**: a page of the guide (`/guides/connect-postgres`, optionally with a `#section`) or any `https://` address.

### Save
Choose **Save** (it says how many). Redirects go live at the next publish.
::::

![Settings › Redirects, Your redirects: /guides/postgres to /guides/connect-postgres (Page moved), /docs/alerts to /guides/alert-rules (Added in Settings), and a new row /setup to /getting-started/install marked in red with "There's no page /getting-started/install." and the note "Fix the rows marked in red to save."](/docs-assets/guides/pages-and-navigation/redirects.webp)

A row is refused when it would break something: an old address that's still a page of the guide, the home page, one of the guide's own addresses like `/llms.txt`, a page that doesn't exist, a redirect to itself, the same old address twice, or a chain (an address that redirects again). Readers get a permanent redirect, and only when no page or file of the site is at that address.

Pages imported from GitBook keep their old addresses working without rows here, alongside the ones you add. See [Import from GitBook](/guides/import-from-gitbook#what-comes-across).

## Related

- [Write in the editor](/guides/editor): the page itself.
- [Private pages and sections](/guides/private-pages): pages for some readers only.
- [History and versions](/guides/history): every save.
