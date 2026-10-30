---
title: Share a folder
description: Send one link that lists a folder's contents. A folder link never opens anything by itself; each visitor sees only what they could already open.
updated: 2026-10-30
prerequisites: [/workspaces/folders, /workspaces/privacy]
keywords: [folder link, share folder, f link, public folder, team link]
---

A folder link is one address, like `markdrop.in/f/…`, that opens a page listing a folder's contents and its subfolders. It's handy for a set of handouts, a release's files, or a team's guides.

A folder link never opens anything by itself. Each visitor sees only the items they could already open on their own. Sharing a folder doesn't change any item's setting.

## Share it

::::steps
### Open the folder
Open the folder in the workspace and choose **Share**, then the **Folder link** tab.

### Choose who can open the folder's page
- **Not shared**: only people in the workspace see this folder, inside Markdrop.
- **Acme team**: a link for teammates. They sign in to open it. People outside the workspace get a sign-in page, then nothing.
- **Anyone with the link**: no sign-in. Visitors see only the items open to anyone.

### Copy the link
Choose **Copy link** and send it.
::::

Admins can always share folders. Members with **Can edit** can too, unless an admin turned off **Members can share folders with a link** on the **Advanced** tab of the workspace's settings.

## When some items won't show

If you choose **Anyone with the link** and some items are team-only or private, Markdrop tells you, for example "3 of 12 items won't show for visitors". Those items stay hidden from people who can't open them.

To show them, change each item's **Who can open it** to **Anyone with the link**. To check the result first, choose **See it as a visitor →** in the same dialog, or **Preview as** on the folder.

:::note
In a [Locked](/workspaces/privacy#the-three-presets) workspace, nothing is open to anyone, so a folder link only works for members and people added by name.
:::

## Change or stop sharing

Open **Share › Folder link** again and pick another option. Switching between **Acme team** and **Anyone with the link** keeps the same link.

Choose **Not shared** to turn the link off. If you share the folder again later, it gets a new link, and the old one stays off.

## Folder pages on your own domain

With [your own domain](/workspaces/custom-domain), every folder also has an address on it, like `docs.acme.com/guides`. That page follows the same rule: a visitor sees a folder only when it holds at least one item they can open, and sees only those items.
