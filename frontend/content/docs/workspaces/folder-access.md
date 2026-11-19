---
title: Folder access
description: Restrict a folder to people and teams. Everything inside follows, including subfolders and anything added later, and every item says why you can open it.
updated: 2026-11-19
prerequisites: [/workspaces/folders, /workspaces/members-and-roles, /teams/overview]
keywords: [folder access, restrict folder, restricted folder, who can access, folder permissions, groups, teams, share folder, share_folder, set_folder_access, get_folder_access, inherited access, inherit, override, open beyond folder, default access, new items start as, why can I see this, access_why]
---

A folder can say who opens what's inside it. Name **people** (by email) and **teams**, each with **Can view** or **Can edit**, and turn on **Restrict** to keep everyone else out. Everything in the folder follows: its pages, documents and files, its subfolders, and anything created, uploaded or moved into it later.

Groups of people are [teams](/teams/overview). Add a team to a folder once; adding someone to the team later gives them everything shared with it.

## Open the folder's access

Open the folder, then **⋯ › Who can access…**. A folder with access of its own also shows **Restricted** or **Shared** next to its name; select it to open the same dialog.

Everyone in the workspace can see who has access. Workspace admins, the person who created the folder, and the folder's editors can change it.

## Restrict a folder

Turn on **Restrict to the people and teams below** and select **Save**. From then on:

| Who | What they open in the folder |
| --- | --- |
| The folder's people and teams | Every item that isn't private (**Only people added**), with their role |
| Workspace admins and the owner | Everything, as before. Admins see every restricted folder. |
| An item's owner | Their own item |
| People an item was shared with by name | That item |
| Everyone else in the workspace | Nothing. The folder's items don't show in lists, search or Ask. |
| Anyone with a link | Nothing. Public links inside stop working, and files stop being served without a sign-in. |

An item can't be more open than its folder: an item set to **Anyone with the link** inside a restricted folder reaches only the folder's people. An item's editor can still [open one item beyond its folder](#open-one-item-beyond-its-folder).

Restricting a folder never changes an item's own setting. Turn the restriction off and every item is open exactly as it was.

## Subfolders

A subfolder inherits from every folder above it:

- People and teams named on a folder above reach the subfolder too. The dialog lists them with **from sales/**.
- A restriction above applies below, and can't be turned off in the subfolder.
- A subfolder can add its own people and teams. They open the subfolder, not the folder above.

## Share a folder with people or teams

In **Who can access…**, add teams from the list and people by email, pick **Can view** or **Can edit**, and keep **Tell people I add** on. Each person newly given access gets **one** email and one notification for the whole folder, never one per item. A team's members are told too.

People without a Markdrop account sign in with the address you used. People outside the workspace can open the items, but can't browse the workspace.

::clip{src="/docs-assets/workspaces/folder-access/share-folder" alt="In the Playbooks folder, Riya opens More folder actions and chooses Who can access…. She types maya@acme.com under People, sets Can edit and chooses Add, then Save with Tell people I add on. A message says who can access Playbooks was saved and 1 person was told."}

## What new items start as

**New items here start as** sets the access of anything created or uploaded into the folder when nobody chooses:

| Option | New items start as |
| --- | --- |
| People with access to this folder | Open to the folder's people and teams (the default in a restricted folder) |
| Only people added | Private to the person who adds it |
| {Workspace} team | Everyone in the workspace (only the folder's people while it's restricted) |
| Anyone with the link | A public link (only the folder's people while it's restricted) |

## Why you can open something

Every item says why you can open it. Open **Share** on the item: below the folder line it reads, for example, **Why you can open it: Inherited from sales/ · Sales team**. Other reasons are **You own it**, **Shared with you directly**, **Member of Acme** and **Anyone with the link**.

The same explanation is in the API (`access_why` on a document, `why` on its access) and in the MCP tools `get_page`, `get_document` and `get_file_info`.

## Open one item beyond its folder

An item's editor can let one item in a restricted folder use its own setting again, for example to keep a press kit public. Open **Share** on the item and select **Open it beyond its folder…**. Every change is logged with who made it, in the folder's **Recent changes** and, for a page, in its version history. Select **Follow the folder's restriction again** to undo it.

## Moving items in and out

Moving an item into a restricted folder narrows it at once. Moving it out gives it back its own setting. Moving a whole folder under a restricted one restricts everything in it.

## With an AI assistant

| Tool | What it does |
| --- | --- |
| `get_folder_access` | The folder's people, teams, restriction and default for new items |
| `set_folder_access` | Restrict a folder, set or change its people and teams, and the default for new items |
| `share_folder` | Share a folder with people and teams, one message each |
| `share_with_people` | With `folder`, the same as `share_folder` for people; with `documents`, shares a list of items with one message per person |

See [Tools](/ai/tools#workspaces-and-folders) for every input.
