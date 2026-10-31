---
title: Members and roles
description: Markdrop Guides' own roles (Admin, Reviewer, Editor, Viewer, No access), who gets which by default, per-guide roles, and the history of changes.
updated: 2026-10-31
prerequisites: [/guides/overview, /workspaces/members-and-roles]
keywords: [roles, permissions, members, admin, reviewer, editor, viewer, no access, guide roles, site roles, override, team, access]
---

guides in a workspace are shared with the workspace's people, but Markdrop Guides has **its own roles**, separate from the [workspace roles](/workspaces/members-and-roles) that decide who can see documents and files. Being a workspace member doesn't, on its own, give anyone access to its guides.

## The roles

| | Admin | Reviewer | Editor | Viewer |
| --- | --- | --- | --- | --- |
| Read drafts, preview, history | ✓ | ✓ | ✓ | ✓ |
| Edit pages, upload files | ✓ | ✓ | ✓ | |
| Publish, or submit for review | ✓ | ✓ | ✓ | |
| Approve others' changes | ✓ | ✓ | | |
| Settings, design, domains | ✓ | | | |
| Give people roles | ✓ | | | |
| Restore, unpublish, delete | ✓ | | | |

**No access** means the workspace's guides don't show up for that person at all.

Admins can also take over a page someone else is editing, and create new guides in the workspace. When a guide [requires reviews](/guides/reviews), editors and reviewers submit their changes; admins can always publish.

![The Who can do what grid on the Members page: Admin, Reviewer, Editor and Viewer against the seven capabilities, and what No access means.](/docs-assets/guides/members-and-roles/roles-matrix.webp)

## Who gets which role

- The **workspace owner** and **workspace admins** are always Guides admins. That can't be lowered, on the workspace or on any guide. To change it, change their workspace role.
- **Everyone else** in the workspace starts with **No access**, until a Guides admin gives them a role.
- Changing someone's workspace role doesn't change their Guides role, except that **removing someone from the workspace** removes all their Markdrop Guides access, on every guide.
- A **personal guide** has only its owner, who is its admin.

You can only give roles to people in the workspace. To add someone new, [invite them to the workspace](/workspaces/members-and-roles) first, then give them a Guides role.

## Give someone a role

Guides admins manage roles on the **Members** page: on the Markdrop Guides home, pick the workspace under **Workspace** and choose **Members**. A guide's **More** menu and the guide menu in the header (**Members of** the workspace) open it too.

::::steps
### Find the person
Everyone in the workspace is listed, with their workspace role. Filter with **All**, **With access** or **No access**, or **Search people**.

### Pick their role
Choose **Admin**, **Reviewer**, **Editor**, **Viewer** or **No access** from the menu beside them. It applies at once, on every guide of the workspace that doesn't [give them a different role](#a-different-role-on-one-guide).
::::

![The Members page for Acme: seven people, Riya Sharma and Maya Patel locked as Admin as workspace owner and admin, Alex Chen Editor (Viewer on Acme Developers), Sam Lee Viewer, Noah Kim Reviewer, Priya Nair No access (Editor on Acme Help Center) and Omar Haddad No access.](/docs-assets/guides/members-and-roles/studio-members.webp)

Under each name you see who gave the role and when, and badges for any guide where the person has a different role. You can't change your own role: ask another admin. **Invite to the workspace** opens the workspace's People settings.

## A different role on one guide

A guide can give someone a different role from their workspace-wide one, higher or lower. For example: an editor for the Help Center only, or **No access** to an internal handbook. The guide's role wins.

Open the guide's **Settings** and find **People**:

1. Choose **Add person**, pick someone from the workspace, and pick their **Role on this guide**. Choose **Save**.
2. To change it, pick another role beside their name. To remove it, choose **×**: they're back to their workspace role.

::clip{src="/docs-assets/guides/members-and-roles/site-role-override" alt="In Acme's settings under People, choosing Add person, picking Omar Haddad and the role Editor, and saving: Omar appears under Different on this guide."}

**Everyone's role on this guide** lists each person's role here and where it comes from: workspace owner, workspace admin, their Guides role, or this guide only.

![The People card of Acme Help Center: Different on this guide · 1 with Priya Nair as Editor (workspace-wide: No access, set by Maya), and the collapsed Everyone's role on this guide and History.](/docs-assets/guides/members-and-roles/site-people.webp)

Only Guides admins see **People**. Everyone else sees **Your role** there instead.

## History

Every change is recorded: who gave whom which role, when, and on which guide. See it under **Recent changes** on the Members page, and under **History** in a guide's People settings. Changes Markdrop Guides makes on its own, like removing someone who left the workspace, are marked "automatically".

## Your own role

Your role on the open guide is shown as a badge in the header, beside the guide's name. On the home page, each workspace shows your role there, and a guide's card shows **on this guide** when your role on that guide is different.
