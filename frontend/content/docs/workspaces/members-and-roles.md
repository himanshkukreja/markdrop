---
title: Members and roles
description: "Invite people to a workspace by email and choose what each person can do: Can view, Can edit, Admin or Owner."
updated: 2026-10-30
prerequisites: [/workspaces/create]
keywords: [invite, member, role, admin, owner, viewer, editor, team]
---

Everyone in a workspace has one role. The role decides what they can open and change across the whole workspace. You can change a person's role at any time.

## The roles

| Role | What they can do |
| --- | --- |
| **Can view** | Open everything the team can open. |
| **Can edit** | Also add files, change files the team can open, and make folders. |
| **Admin** | Also invite people, manage folders, and change the workspace's privacy, domains and branding. |
| **Owner** | Everything an admin can do, plus manage admins and delete the workspace. Each workspace has one owner: the person who created it. |

A few things only the owner can do:

- Invite someone as **Admin**, or withdraw an invitation sent as Admin.
- Change an admin's role, or remove an admin.
- Delete the workspace.

:::note
A role never opens items set to "Only people added". Those stay with their owner and the people they added by name, even for admins. See [Who can open a link](/sharing/who-can-open).
:::

## Invite people

Only admins can invite people.

::::steps
### Open People
Open the workspace's settings and go to the **People** tab. Choose **Invite people**.

### Add their addresses
Type one or more email addresses. Separate several with commas.

### Choose their access
Pick **Can view**, **Can edit** or **Admin**, then choose **Send invitation**.
::::

Each person gets an email with a link. Once they accept, they can open everything the team can open. If you invite someone from a folder's **Share** dialog, they still join the whole workspace, not only that folder.

### How invitations work

- **Nobody joins without saying yes.** The person accepts or declines from the link in the email.
- **The link only works for the address it was sent to.** They sign in to Markdrop as that address to accept. Signed in as someone else, they see which address the invitation was for.
- **Invitations expire after 7 days.** Choose **Resend** next to a pending invitation to send a fresh one.
- **You can take an invitation back.** Open the row's menu and choose **Revoke invitation**. The link in their email stops working, and you can invite them again later.

A workspace can have up to 200 members and up to 100 invitations waiting for a reply at once.

## Change a role or remove someone

On the **People** tab, admins change a person's role from the select next to their name. To remove someone, open the menu on their row and choose **Remove from workspace**.

When someone is removed, they lose access to the workspace right away. Files they added stay in the workspace, and they still own them. People they shared things with through the workspace lose that access too.

You can't change your own role or remove yourself from this list. To leave, use **Leave workspace** on the **Advanced** tab. The owner can't leave; the owner can delete the workspace instead.

## Who sees what in settings

Everyone in the workspace can open its settings, but only admins change them. Controls that need the Admin role show "Admins only". Members see which domains the workspace has and whether each one is live, but not the DNS records behind them.

## Related

::::cards
:::card[Workspace privacy]{href="/workspaces/privacy" icon="lock"}
Decide what new items start as, and whether visitors must sign in.
:::
:::card[Share a folder]{href="/workspaces/share-a-folder" icon="link"}
Give people a link to a folder page.
:::
::::
