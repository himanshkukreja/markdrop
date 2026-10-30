---
title: Members and roles
description: Docs Studio's own roles (Admin, Reviewer, Editor, Viewer, No access), who gets which by default, per-site roles, and the history of changes.
updated: 2026-10-31
prerequisites: [/docs-studio/overview, /workspaces/members-and-roles]
keywords: [roles, permissions, members, admin, reviewer, editor, viewer, no access, site roles, override, team, access]
---

Docs Studio sites in a workspace are shared with the workspace's people, but Docs Studio has **its own roles**, separate from the [workspace roles](/workspaces/members-and-roles) that decide who can see documents and files. Being a workspace member doesn't, on its own, give anyone access to its docs sites.

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

**No access** means the workspace's docs sites don't show up for that person at all.

Admins can also take over a page someone else is editing, and create new sites in the workspace. When a site [requires reviews](/docs-studio/reviews), editors and reviewers submit their changes; admins can always publish.

![The Who can do what grid on the Members page: Admin, Reviewer, Editor and Viewer against the seven capabilities, and what No access means.](/docs-assets/docs-studio/members-and-roles/roles-matrix.webp)

## Who gets which role

- The **workspace owner** and **workspace admins** are always Docs Studio admins. That can't be lowered, on the workspace or on any site. To change it, change their workspace role.
- **Everyone else** in the workspace starts with **No access**, until a Docs Studio admin gives them a role.
- Changing someone's workspace role doesn't change their Docs Studio role, except that **removing someone from the workspace** removes all their Docs Studio access, on every site.
- A **personal site** has only its owner, who is its admin.

You can only give roles to people in the workspace. To add someone new, [invite them to the workspace](/workspaces/members-and-roles) first, then give them a Docs Studio role.

## Give someone a role

Docs Studio admins manage roles on the **Members** page: choose **Members** next to the workspace's name on the Docs Studio home, or **Members of** the workspace in the site menu.

::::steps
### Find the person
Everyone in the workspace is listed, with their workspace role. Filter with **All**, **With access** or **No access**, or **Search people**.

### Pick their role
Choose **Admin**, **Reviewer**, **Editor**, **Viewer** or **No access** from the menu beside them. It applies at once, on every site of the workspace that doesn't [give them a different role](#a-different-role-on-one-site).
::::

![The Members page for Acme: seven people, Riya Sharma and Maya Patel locked as Admin as workspace owner and admin, Alex Chen Editor (Viewer on Acme Developers), Sam Lee Viewer, Noah Kim Reviewer, Priya Nair No access (Editor on Acme Help Center) and Omar Haddad No access.](/docs-assets/docs-studio/members-and-roles/studio-members.webp)

Under each name you see who gave the role and when, and badges for any site where the person has a different role. You can't change your own role: ask another admin. **Invite to the workspace** opens the workspace's People settings.

## A different role on one site

A site can give someone a different role from their workspace-wide one, higher or lower. For example: an editor for the Help Center only, or **No access** to an internal site. The site's role wins.

Open the site's **Settings** and find **People**:

1. Choose **Add person**, pick someone from the workspace, and pick their **Role on this site**. Choose **Save**.
2. To change it, pick another role beside their name. To remove it, choose **×**: they're back to their workspace role.

::clip{src="/docs-assets/docs-studio/members-and-roles/site-role-override" alt="In Acme's settings under People, choosing Add person, picking Omar Haddad and the role Editor, and saving: Omar appears under Different on this site."}

**Everyone's role on this site** lists each person's role here and where it comes from: workspace owner, workspace admin, their Docs Studio role, or this site only.

![The People card of Acme Help Center: Different on this site · 1 with Priya Nair as Editor (workspace-wide: No access, set by Maya), and the collapsed Everyone's role on this site and History.](/docs-assets/docs-studio/members-and-roles/site-people.webp)

Only Docs Studio admins see **People**. Everyone else sees **Your role** there instead.

## History

Every change is recorded: who gave whom which role, when, and on which site. See it under **Recent changes** on the Members page, and under **History** in a site's People settings. Changes Docs Studio makes on its own, like removing someone who left the workspace, are marked "automatically".

## Your own role

Your role on the open site is shown as a badge in the header, beside the site's name. On the home page, each workspace shows your role there, and a site card shows **on this site** when your role on that site is different.
