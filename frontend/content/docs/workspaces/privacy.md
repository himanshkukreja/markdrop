---
title: Workspace privacy
description: Choose Open, Team or Locked for a workspace, and check what someone else would see with Preview as.
updated: 2026-10-30
prerequisites: [/workspaces/create, /sharing/who-can-open]
keywords: [privacy, open, team, locked, custom, sign in, require sign-in, default access, preview as]
---

Every item in a workspace has its own "Who can open it" setting: **Only people added**, **Acme team** or **Anyone with the link**. (Here the workspace is called Acme and its site name is Acme. The team choice uses the site name, or the workspace's name if it has no site name.) Workspace privacy sets two things on top of that: what new items start as, and whether visitors must sign in to open anything at all.

Admins choose privacy on the **People** tab of the workspace's settings.

## The three presets

| Preset | New items start as | Visitors must sign in | In short |
| --- | --- | --- | --- |
| **Open** | Anyone with the link | No | Links work for anyone. Each item still chooses who can open it. |
| **Team** | Acme team | No | New items are for the team. Public links stay possible, one by one. |
| **Locked** | Acme team | Yes | Only members and people added by name. No public links. |

A new workspace starts as **Team**.

![The Privacy section at the top of the People tab in Acme's settings, with three presets: Open, Team (selected) and Locked, each with a one-line description.](/docs-assets/workspaces/privacy/privacy-presets.webp)

Changing the preset never changes items that are already in the workspace, with one exception: Locked. When visitors must sign in, that applies to every item at once, including ones set to "Anyone with the link".

:::warning[Locked applies everywhere]
In a Locked workspace, sign-in is enforced on every address an item has, including its markdrop.in link, not only on your own domain. Someone who isn't a member and wasn't added by name can't open anything, even with the link.
:::

## What each item setting means

- **Only people added**: the person who owns it, and people they added by name. Workspace roles don't open it, not even Admin.
- **Acme team**: everyone in the workspace, after signing in. Can view members read it; Can edit members, admins and the owner can also change it.
- **Anyone with the link**: anyone who has the link, unless the workspace is Locked. A password, if the item has one, still applies.

To change one item, choose the who-can-open button on its row in the workspace, the one that shows its current setting, like **Acme team**. On a phone, open the item's menu and choose **Who can open it**.

## The switches behind the presets

The **Advanced** tab has the individual settings behind the presets. Most workspaces never need them.

- **New items start as**: a list with **Only people added**, **Acme team** and **Anyone with the link**. A starting point only; each item keeps its own setting.
- **Members can share folders with a link**: on by default. Admins always can. See [Share a folder](/workspaces/share-a-folder).
- **Visitors must sign in to open anything**: the Locked switch. Enforced everywhere, including markdrop.in links.

If these settings don't match a preset, no preset is selected and **Privacy** on the People tab gets a **Custom** badge. Pick a preset to replace them.

A folder can have its own starting point too. An admin opens the folder, chooses **More folder actions**, then **New items start as…**. Items filed into that folder start with the folder's choice instead of the workspace's.

## Check what someone else sees

Before you share, open the workspace or a folder and choose **Preview as**. It's there for Can edit members, admins and the owner. Pick who to preview as:

- **Anyone with the link**
- **An Acme member**
- **Someone by email…** (admins only)

Markdrop shows the folder as that person would see it, and how many of its items and folders they'd see. Items they can't open are listed with the reason, like **People added**, **Password** or **Sign-in needed**.

::clip{src="/docs-assets/workspaces/privacy/preview-as" alt="Choosing Preview as on the Sales folder: as Anyone with the link they'd see 2 of 6 items, with the hidden ones listed under Hidden from them with reasons such as Acme team, Password and People added; as An Acme member they'd see 5 of 6; then Exit preview."}

## Related

::::cards
:::card[Members and roles]{href="/workspaces/members-and-roles" icon="user"}
What Can view, Can edit, Admin and Owner can do.
:::
:::card[Sign-in on your domain]{href="/workspaces/sign-in-on-your-domain" icon="lock"}
How readers sign in on docs.acme.com.
:::
::::
