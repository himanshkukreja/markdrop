---
title: Workspace privacy
description: Choose Open, Team or Locked for a workspace, and check what someone else would see with Preview as.
updated: 2026-10-30
prerequisites: [/workspaces/create, /sharing/who-can-open]
keywords: [privacy, open, team, locked, custom, sign in, require sign-in, default access, preview as]
---

Every item in a workspace has its own "Who can open it" setting: **Only people added**, **Acme team** or **Anyone with the link**. ("Acme" stands for your workspace's site name, or its name if it has none.) Workspace privacy sets two things on top of that: what new items start as, and whether visitors must sign in to open anything at all.

Admins choose privacy on the **People** tab of the workspace's settings.

## The three presets

| Preset | New items start as | Visitors must sign in | In short |
| --- | --- | --- | --- |
| **Open** | Anyone with the link | No | Links work for anyone. Each item still chooses who can open it. |
| **Team** | Acme team | No | New items are for the team. Public links stay possible, one by one. |
| **Locked** | Acme team | Yes | Only members and people added by name. No public links. |

A new workspace starts as **Team**.

Changing the preset never changes items that are already in the workspace, with one exception: Locked. When visitors must sign in, that applies to every item at once, including ones set to "Anyone with the link".

:::warning[Locked applies everywhere]
In a Locked workspace, sign-in is enforced on every address an item has, including its markdrop.in link, not only on your own domain. Someone who isn't a member and wasn't added by name can't open anything, even with the link.
:::

## What each item setting means

- **Only people added**: the person who owns it, and people they added by name. Workspace roles don't open it, not even Admin.
- **Acme team**: everyone in the workspace, after signing in. Can view members read it; Can edit members, admins and the owner can also change it.
- **Anyone with the link**: anyone who has the link, unless the workspace is Locked. A password, if the item has one, still applies.

To change one item, open its menu in the workspace and choose **Who can open it**.

## The switches behind the presets

The **Advanced** tab has the individual switches. Most workspaces never need them.

- **New items start as**: Only people added, Acme team, or Anyone with the link. A starting point only; each item keeps its own setting.
- **Members can share folders with a link**: on by default. Admins always can. See [Share a folder](/workspaces/share-a-folder).
- **Visitors must sign in to open anything**: the Locked switch. Enforced everywhere, including markdrop.in links.

If the switches don't match a preset, the People tab shows **Custom**. Pick a preset to replace them.

A folder can have its own starting point too. An admin opens the folder, chooses **More folder actions**, then **New items start as…**. Items filed into that folder start with the folder's choice instead of the workspace's.

## Check what someone else sees

Before you share, open the workspace or a folder and choose **Preview as**. It's there for Can edit members, admins and the owner. Pick who to preview as:

- **Anyone with the link**
- **An Acme member**
- **Someone by email…** (admins only)

Markdrop shows the folder as that person would see it, and how many of its items and folders they'd see. Items they can't open are listed with the reason, like **People added**, **Password** or **Sign-in needed**.

## Related

::::cards
:::card[Members and roles]{href="/workspaces/members-and-roles" icon="user"}
What Can view, Can edit, Admin and Owner can do.
:::
:::card[Sign-in on your domain]{href="/workspaces/sign-in-on-your-domain" icon="lock"}
How readers sign in on docs.acme.com.
:::
::::
