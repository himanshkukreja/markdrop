---
title: Passwords and expiry
description: Ask readers for a password before a document or file opens, and have its link stop working after a day, a week, a month or on a date.
updated: 2026-10-30
keywords: [password, expiry, expire, ttl, self-destruct, X-Read-Password]
---

A password makes readers type something before a link opens. An expiry makes the link stop working at a time you choose. Both work on documents and files, and you can set them when you publish or change them later.

::video{id="password-and-expiry" title="Add a password and an expiry" duration="0:40"}

## Add a password

When you publish, choose the **Password** chip (or the **Password** field on the upload page) and type it. Passwords can be up to 100 characters.

Readers then see "This document is password protected" and a password box before anything loads. The page title and link preview don't show the title or the text either. See [Link previews](/documents/link-previews).

### Who the password applies to

The password is for strangers holding the link. People who already have access skip it:

- you, signed in as the owner;
- anyone holding the [edit secret](/documents/edit-key);
- people you added by email, and your workspace team when the document is open to them.

A password only matters when **Who can open it** is **Anyone with the link**. A document set to **Only people added** or to a workspace team stays closed to strangers whatever the password. See [Who can open what](/sharing/who-can-open).

### Wrong guesses

After 10 wrong passwords in a minute, or 50 in an hour, from the same IP address, Markdrop stops checking passwords for a while, and the password box shows an error even for the right one. Wait a few minutes and try again.

## Set an expiry

When you publish, choose the **Expires** chip and pick **In 1 day**, **In 7 days**, **In 30 days** or **On a date…** to choose an exact day and time. The hint underneath says when that is, in your time zone.

When the time comes, the link stops working for everyone and Markdrop deletes the document. For a file, that includes the file and its old versions. An expiry has to be at least a minute in the future.

:::danger[Expiry deletes]
An expired document is gone, not hidden. You can't extend it afterwards or get it back. If you might need it later, keep your own copy.
:::

## Change them later

You need to be the owner, or hold the edit secret. The share dialog and file settings are for the signed-in owner; with only the edit secret, use the document editor.

::::tabs
:::tab[Share dialog]
Open the document, press :kbd[Esc] or choose **Show details** to leave full screen, and choose **Share**. Then choose **More options: password and expiry**.

- Type a new **Password** and choose **Save options**. Anyone without access now needs the new password.
- Choose **Remove password** to open it to anyone with the link again.
- Pick a new **Expires** value: **Never**, **In 1 hour**, **In 1 day**, **In 7 days**, **In 30 days** or **On a date…**, then **Save options**. The list starts on **Don't change**, which leaves the expiry as it is.
:::
:::tab[Document editor]
Choose **Edit**, then **Settings** to open **Document settings**. Under **Password**, type one in **Add a password**, or, if the document already has one, tick **Remove password**. Under **Expiry**, pick **Remove expiry**, a new period such as **Expire in 7 days**, or **On a date…** from **Expires**. Settings are saved when you choose **Save changes**.
:::
:::tab[File settings]
Open the file, press :kbd[Esc] or choose **Show details** to leave full screen, and choose **More artifact actions › Settings**. Change **Password** (or **Remove the password**) and **Expires**, then choose **Save changes**.
:::
::::

Changing the password takes effect at once. Readers who opened it with the old password are asked again, and links to a protected file's bytes that were already handed out stop working.

## Open a protected document from code

Send the password in the `X-Read-Password` header:

```bash title="Read a password-protected document"
curl https://api.markdrop.in/api/v1/documents/q3-plan \
  -H "X-Read-Password: correct horse battery staple"
```

## Related

- [Who can open what](/sharing/who-can-open)
- [End-to-end encryption](/sharing/end-to-end-encryption)
- [Edit with your edit secret](/documents/edit-key)
