---
title: Request access
description: Ask a document's owner for access from the page, or for edit access to a page you can read. The owner gets an email and approves or declines.
updated: 2026-11-04
prerequisites: [/get-started/accounts]
keywords: [request access, ask for access, request edit access, edit access, denied, permission, approve, decline]
---

Opened a link and got "You don't have access yet"? You can ask the owner from that page. They get an email with your note and decide with one click, and you get an email when they do. Nothing opens until they say yes.

::video{id="request-access" title="Request access" duration="0:37"}

## Ask for access

You need to be signed in.

::::steps
### Open the link
Signed in, you see "You don't have access yet" and the address you're signed in as.

### Check the account
If you were sent the link at another address, choose **Switch account** and sign in with that one first. It may open straight away.

### Add a note (optional)
Under **Message (optional)**, say who you are or why you need it, in up to 500 characters: "Hi, I need this for Thursday's review."

### Choose Request access
The page says "Request sent. You'll get an email when the owner decides."
::::

![The ‘You don’t have access yet’ screen: You’re signed in as dana@globex.com, a Message (optional) box with a note, a Request access button and Switch account.](/docs-assets/sharing/request-access/request-access-gate.webp)

If you've already asked, the page says "You've already asked for this" instead. You can have one open request per document.

### When Request access doesn't appear

| You see | Why |
| --- | --- |
| "This document is private" and **Sign in to open** | You aren't signed in. Sign in first. |
| "This document is password protected" | It's open to anyone with the link and the password. Ask whoever shared it for the password. |
| "You don't have access" with no button | The document can't take requests, for example because nobody owns it. |

On a workspace's own domain, like `docs.acme.com`, **Request access** takes you to the same document on markdrop.in, where you can send the request.

You can send up to 10 requests an hour.

## Request edit access

Can read a page but not edit it? For example you're a viewer in the workspace, or it was shared with you as **Can view**. Ask to edit it from the page, on markdrop.in or on the workspace's own domain.

::::steps
### Open the page's ⋯ menu
Signed in, choose **Request edit access**.

### Say what you'd change (optional)
Add a note of up to 500 characters.

### Choose Send request
You see "Request sent". The menu then says **Edit access requested** until it's answered.
::::

The request goes to the page's owner. If the page has no owner who can be reached (their account is gone, or they've left the workspace), it goes to the workspace's admins instead, and any of them can answer it.

They get an email with your note and two buttons, **Approve: let them edit** and **Decline**, and the request shows under **Access requests** in **Shared with me**. When they approve, you get an email and can edit the page straight away.

Approving lets you edit **that page only**. The pages inside it stay as they were for you.

If they decline, you can ask again after a day. You can have one open request per page.

## Answer a request

When someone asks, you get an email with their name, address and note, and three buttons: **Let them view**, **Let them edit** and **Decline**.

You can also answer in the app: open **Shared with me** in the sidebar. **Access requests** lists what's waiting; choose **Review** on one.

![The access request page: Dana asked to open “Q3 plan — internal notes”, with her address, her note, and the buttons Let them view, Let them edit and Decline.](/docs-assets/sharing/request-access/request-review.webp)

| Choose | What happens |
| --- | --- |
| **Let them view** | They're added to the document with **Can view**, as if you'd shared it with them. |
| **Let them edit** | They're added with **Can edit**. |
| **Decline** | Nothing is shared. |

Either way, they get an email with your answer. Only the document's owner can answer, and only while they own it. For an edit request that went to the admins because the owner can't be reached, a workspace admin can answer it too.

An edit request ("asked to edit") has two buttons: **Approve: let them edit** and **Decline**.

After you approve, the person shows in the document's **People with access** list like anyone you added. To undo it, remove them there. See [Share with specific people](/sharing/share-with-people).

:::note
Approving never lowers someone's access. If they already had **Can edit** and you choose **Let them view**, they keep **Can edit**.
:::

## Related

- [Edit on your domain](/workspaces/sign-in-on-your-domain#edit-on-your-domain)
- [Who can open what](/sharing/who-can-open)
- [Share with specific people](/sharing/share-with-people)
