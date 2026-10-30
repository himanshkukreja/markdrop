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
| **Owner** | Everything an admin can do, plus manage admins, hand the workspace on and delete it. Each workspace has one owner. At first it's the person who created it. |

A few things only the owner can do:

- Invite someone as **Admin**, or withdraw an invitation sent as Admin.
- Change an admin's role, or remove an admin.
- Make someone else the owner.
- Delete the workspace.

:::note
A role never opens items set to "Only people added". Those stay with their owner and the people they added by name, even for admins. See [Who can open a link](/sharing/who-can-open).
:::

## Invite people

Only admins can invite people.

::::steps
### Open People
Open the workspace's settings and go to the **People** tab. Choose **Invite people**. A dialog opens: **Invite people to Acme**.

### Add their addresses
Type one or more addresses in **Email addresses**. Separate several with commas.

### Choose their access
Under **Their access**, choose **Can view**, **Can edit** or **Admin**, then choose **Send invitation**.
::::

![The Invite people to Acme dialog with two addresses in Email addresses, Can edit chosen under Their access, and a Send invitation button.](/docs-assets/workspaces/members-and-roles/invite-dialog.webp)

Each person gets an email with a link. Once they accept, they can open everything the team can open. You can also invite from a folder: choose **Share**, then the **Invite people** tab. Type the addresses, pick **Can view**, **Can edit** or **Admin** from the list beside them, and choose **Invite**. They still join the whole workspace, not only that folder.

### How invitations work

- **Nobody joins without saying yes.** The person accepts or declines from the link in the email.
- **The link only works for the address it was sent to.** They sign in to Markdrop as that address to accept. Signed in as someone else, they see which address the invitation was for.
- **Invitations expire after 7 days.** Choose **Resend**, next to the date under a pending invitation, to send a fresh one.
- **You can take an invitation back.** Open the row's menu and choose **Revoke invitation**. The link in their email stops working, and you can invite them again later.

A workspace can have up to 200 members and up to 100 invitations waiting for a reply at once.

## Change a role or remove someone

On the **People** tab, admins change a person's role from the select next to their name. To remove someone, open the menu on their row and choose **Remove from workspace**.

![The People list in Acme's settings: Riya Sharma (you) as Owner, Maya Patel as Admin, Alex Chen as Can edit and Sam Lee as Can view, each with a role select and a row menu, and a pending invitation for lee@contractors.io with Resend.](/docs-assets/workspaces/members-and-roles/people-tab.webp)

When someone is removed, they lose access to the workspace right away. Files they added stay in the workspace, and they still own them. People they shared things with through the workspace lose that access too.

You can't change your own role or remove yourself from this list. To leave, choose **Leave Acme…** (with your workspace's name) under **Leave workspace** on the **Advanced** tab. The owner can't leave. To go, the owner first makes someone else the owner, or deletes the workspace.

## Transfer ownership

The owner can hand the workspace to anyone already in it, whatever their role.

::::steps
### Open their menu
On the **People** tab, open the menu on the person's row and choose **Make owner…**.

### Confirm
Read the dialog and choose **Transfer ownership**.
::::

They become the owner right away, and you become an admin. Files, links, grants and domains don't change. Only the new owner can hand it back.

## Who sees what in settings

Everyone in the workspace can open its settings, but only admins change them. Controls that need the Admin role, such as **Privacy**, **Invite people**, **New items start as**, the workspace's names and **Add a domain**, don't respond, and pointing at one or tabbing to it shows "Admins only". Row menus with admin actions, like the one on a person or a domain, don't show at all. Members see which domains the workspace has and whether each one is live, but not the DNS records behind them.

## Related

::::cards
:::card[Workspace privacy]{href="/workspaces/privacy" icon="lock"}
Decide what new items start as, and whether visitors must sign in.
:::
:::card[Share a folder]{href="/workspaces/share-a-folder" icon="link"}
Give people a link to a folder page.
:::
::::
