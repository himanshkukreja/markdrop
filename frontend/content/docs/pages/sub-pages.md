---
title: Sub-pages and access inheritance
description: Nest pages inside pages. A sub-page lives with its parent and follows who can read it, until you set its own access.
updated: 2026-11-03
prerequisites: [/pages/overview]
keywords: [sub-page, subpage, child page, nested, parent, breadcrumbs, inherit, access, move, delete]
---

A page can hold other pages. Sub-pages show at the bottom of their parent under **Pages inside**, in the page tree beside the page, and under the folder in your workspace's sidebar.

## Add a sub-page

- At the bottom of a page, choose **Add a sub-page**, pick a template and choose **Create page**.
- While editing, type `/page`: Markdrop makes an empty sub-page and puts a link to it where you typed.

You need to be signed in and able to edit the parent.

A sub-page lives in its parent's workspace and folder. Breadcrumbs at the top of the page lead back up through its parents.

## Who can read a sub-page

A new sub-page **inherits** its parent's access: whoever can read the parent can read the sub-page, and nobody else. That includes the parent's password, its workspace, the people it's shared with and its sign-in requirement. When you change the parent's access, its sub-pages follow at once, and anyone who loses access loses it on the sub-pages too.

Set a sub-page's own access from its **Share** dialog. From then on it keeps that access whatever happens to the parent. In **Pages inside** such a page is marked **Own access**.

Breadcrumbs only show the parents a reader can open.

## On your own domain

On a workspace's [custom domain](/workspaces/custom-domain), a sub-page's address includes its parents: `docs.acme.com/<folders>/<parent>/<sub-page>`. The markdrop.in link stays `markdrop.in/<sub-page>`.

## Move a sub-page

AI apps can move a page under another page, or back to the top, with `move_page`. When the move changes who can read the page, Markdrop asks to confirm first.

## Delete a page with sub-pages

When you delete a page that has sub-pages, Markdrop asks what to do with them:

- **Keep them: move them up a level**. Each sub-page takes the deleted page's place under its parent.
- **Delete the sub-pages too**.

## Related

- [Who can open what](/sharing/who-can-open)
- [Folders](/workspaces/folders)
