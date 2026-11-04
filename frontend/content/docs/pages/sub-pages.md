---
title: Sub-pages and access inheritance
description: Nest pages inside pages. A sub-page lives with its parent and follows who can read it, until you set its own access.
updated: 2026-11-04
prerequisites: [/pages/overview]
keywords: [sub-page, subpage, child page, nested, parent, breadcrumbs, inherit, access, move, move to, drag, reorder, page tree, delete]
---

A page can hold other pages. Sub-pages show at the bottom of their parent under **Pages inside**, in the page tree beside the page, and under the folder in your workspace's sidebar.

## Add a sub-page

- At the bottom of a page, choose **Add a sub-page**, pick a template and choose **Create page**.
- In the page, type `/page`: Markdrop makes an empty sub-page and puts a link to it where you typed.
- In the page tree beside the page, or in your workspace's sidebar, point at a page and choose **+**.

You need to be signed in and able to edit the parent.

A sub-page lives in its parent's workspace and folder. Breadcrumbs at the top of the page lead back up through its parents.

## Who can read a sub-page

A new sub-page **inherits** its parent's access: whoever can read the parent can read the sub-page, and nobody else. That includes the parent's password, its workspace, the people it's shared with and its sign-in requirement. When you change the parent's access, its sub-pages follow at once, and anyone who loses access loses it on the sub-pages too.

Set a sub-page's own access from its **Share** dialog. From then on it keeps that access whatever happens to the parent. In **Pages inside** such a page is marked **Own access**.

Breadcrumbs only show the parents a reader can open.

## On your own domain

On a workspace's [custom domain](/workspaces/custom-domain), a sub-page's address includes its parents: `docs.acme.com/<folders>/<parent>/<sub-page>`. The markdrop.in link stays `markdrop.in/<sub-page>`.

## Move a page

You need to be signed in and able to edit both the page and the page you move it into. Its sub-pages move with it.

### Drag it in the page tree

The page tree beside a page lists the pages around it. Drag a page:

- **onto another page** (the row lights up) to put it inside, as that page's last sub-page;
- **between two pages** (a line shows where) to put it there, beside them;
- **below the last page in a branch**: move the pointer left to go up a level, as far as the top level.

Rest the pointer on a closed page for a moment and it opens, so you can drop into its sub-pages. A page can't go inside itself or one of its own sub-pages. Press **Esc** to cancel a drag.

The page shows in its new place at once. If Markdrop can't move it, it goes back and a message says why. **Undo** in the message moves it back.

In your workspace's sidebar, drag a page onto another page to put it inside, or onto a folder to move it to the top level of that folder.

### Move to

Without dragging (or from the keyboard), choose **Move to…** from the page's **⋯** menu, or from the **⋯** next to a page in the page tree. Search, then pick:

- **Top level of** its folder (for a sub-page): it leaves its parent.
- A **folder** of the workspace, or the workspace's top level.
- A **page** you can edit in the same workspace. Personal pages list your own documents outside workspaces.

Use the arrow keys and **Enter** to choose. The breadcrumbs and the page tree follow the move.

Pages move within their workspace (or among your personal pages). To file a page in another workspace, move its top page.

### When a move changes who can read it

A sub-page follows its parent's access, so moving a page can change who can read it. Markdrop asks first, for example: "Moving “Benefits” changes who can read it: now members of Acme; after the move, only its owner." Choose **Move anyway** or **Cancel**. Only the page's owner can make a move that changes who can read it. A page with its own access keeps it wherever it goes.

AI apps move pages with `move_page`, and confirm the same way.

## Delete a page with sub-pages

When you delete a page that has sub-pages, Markdrop says how many there are and asks what to do with them:

- **Keep them: move them up a level**. Each sub-page takes the deleted page's place under its parent. Only the page goes to Trash.
- **Delete the sub-pages too**. They go to [Trash](/documents/trash) with the page, and restoring the page brings them all back in place.

Either way, the page waits in Trash for 30 days before it's deleted for good.

## Related

- [Who can open what](/sharing/who-can-open)
- [Folders](/workspaces/folders)
