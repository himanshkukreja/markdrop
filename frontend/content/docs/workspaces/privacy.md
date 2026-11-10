---
title: Workspace privacy
description: Choose Open, Team or Locked for a workspace, and check what someone else would see with Preview as.
updated: 2026-11-04
prerequisites: [/workspaces/create, /sharing/who-can-open]
keywords: [privacy, open, team, locked, custom, sign in, require sign-in, default access, preview as, applying, progress]
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

What each one does:

- **Open**: new items start as **Anyone with the link**, so a link you share works for whoever has it. Each item can still be narrowed to the team or to people added by name. Nobody is asked to sign in unless an item needs it.
- **Team**: new items start as **Acme team**, so only signed-in members can open them. An item can still be opened to anyone with the link, one at a time, by whoever can change it.
- **Locked**: new items start as **Acme team**, and visitors must sign in to open *anything*, whatever its own setting. Items set to **Anyone with the link** need sign-in too, so the only people who can open an item are members (for team items) and people added to it by name. There are no public links.

![The Privacy section at the top of the People tab in Acme's settings, with three presets: Open, Team (selected) and Locked, each with a one-line description.](/docs-assets/workspaces/privacy/privacy-presets.webp)

Changing the preset never changes items that are already in the workspace, with one exception: Locked. When visitors must sign in, that applies to every item at once, including ones set to "Anyone with the link".

:::warning[Locked applies everywhere]
In a Locked workspace, sign-in is enforced on every address an item has, including its markdrop.in link, not only on your own domain. Someone who isn't a member and wasn't added by name can't open anything, even with the link.
:::

## Switching to Locked and back

Locked takes effect the moment you choose it. From then on every item in the workspace asks for sign-in, on every address: a link someone already has stops opening the item unless they sign in and can open it.

Markdrop then brings everything stored for those items in line: the files themselves (so a direct link to a file or a video stops working too), the images on pages and the copies of pages kept for speed. In a small workspace that's done before the switch finishes. In a big one it takes a few seconds, and the **Privacy** section shows **Applying to 300 items…** with a bar that counts down. You don't have to wait for it: the rest of the settings work as usual, and you can leave the page. It carries on until every item is done.

Switching back to **Team** or **Open**, even while Locked is still applying, is fine: Markdrop applies whichever you chose last. Items set to **Anyone with the link** then open for anyone with the link again, at the same links. Everything else keeps its own setting.

## What each item setting means

- **Only people added**: the person who owns it, and people they added by name. Workspace roles don't open it, not even Admin.
- **Acme team**: everyone in the workspace, after signing in. Can view members read it; Can edit members, admins and the owner can also change it.
- **Anyone with the link**: anyone who has the link, unless the workspace is Locked. A password, if the item has one, still applies.

To change one item, choose the who-can-open button on its row in the workspace, the one that shows its current setting, like **Acme team**. On a phone, open the item's menu and choose **Who can open it**.

This short explainer shows the three choices, what passwords and named people add, and how a Locked workspace asks for sign-in on every address an item has:

::video{id="who-can-open" title="Who can open what" duration="0:50"}

## The switches behind the presets

The **Advanced** tab has the individual settings behind the presets. Most workspaces never need them.

- **New items start as**: a list with **Only people added**, **Acme team** and **Anyone with the link**. A starting point only; each item keeps its own setting.
- **Members can share folders with a link**: on by default. Admins always can. See [Share a folder](/workspaces/share-a-folder).
- **Let people share onward**: on by default. People an item is shared with can add others, including people outside the workspace, never with more access than they have. Items whose owner made their own choice keep it. See [Let people share it on](/sharing/share-with-people#let-people-share-it-on).
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
