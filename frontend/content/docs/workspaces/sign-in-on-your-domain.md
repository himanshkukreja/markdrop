---
title: Sign-in on your domain
description: How readers sign in on a workspace's own domain, what they can read and edit there, what the domain's owner can see, and how long the sign-in lasts.
updated: 2026-11-04
prerequisites: [/workspaces/custom-domain, /workspaces/privacy]
keywords: [sign in, login, sso, custom domain, handoff, consent, locked, edit on your domain, request edit access]
---

Readers sign in to Markdrop on markdrop.in. A browser keeps sign-ins separate for each site, so on `docs.acme.com` a reader looks signed out, however recently they signed in on markdrop.in. Markdrop carries the sign-in across for them, with their say-so.

Readers only need to sign in for things that aren't open to anyone: items for the team, items shared with them by name, and everything in a [Locked](/workspaces/privacy#the-three-presets) workspace.

## Already signed in on markdrop.in

When someone opens a page on your domain that needs sign-in, Markdrop first checks markdrop.in in the background. The page shows **Opening…** for a moment and then opens. It doesn't show **Sign in to read Acme** when the reader is signed in on markdrop.in and either:

- is a member of the workspace, or
- chose **Don't ask again** for your domain before.

Everyone else sees the sign-in steps below. That includes readers who are signed out on markdrop.in, and readers who haven't confirmed your site yet. Markdrop checks at most once every two minutes for each page, so a reader who isn't signed in never gets stuck in a loop.

## What readers see

::::steps
### Choose Sign in
On your domain, the header shows **Sign in to read Acme**, with your workspace's site name, or the domain if it has none (on a phone, **Sign in**). In a Locked workspace, signed-out visitors see **Sign in to read Acme** in the middle of the page instead.

![The header on docs.acme.com: Acme's logo and name on the left, Sign in to read Acme on the right.](/docs-assets/workspaces/sign-in-on-your-domain/tenant-sign-in.webp)

### Sign in on markdrop.in
The reader goes to markdrop.in and signs in there, if they aren't already.

### Confirm the site
Readers who aren't members of the workspace are asked once, with their full display name: **Continue to docs.acme.com as Dana Park?** The page says that the site can see their display name, never their email address, and can't change anything in their account. **Don't ask again for docs.acme.com** is ticked by default. They choose **Continue**.

![The screen asking "Continue to docs.acme.com as Dana Park?": the site can see her display name, never her email address, and can't change anything in her account; Don't ask again for docs.acme.com is ticked, with Continue and Cancel.](/docs-assets/workspaces/sign-in-on-your-domain/handoff-consent.webp)

### Back on your domain
They land back on the page they started from, signed in, and can read what's been shared with them.
::::

Members of the workspace skip the question: it's their own site.

## What the sign-in on your domain can do

The sign-in Markdrop hands to your domain is deliberately small:

- It works only on that one domain, and only for that workspace's documents.
- It reads, and it edits pages the person may edit (see [Edit on your domain](#edit-on-your-domain)). It can't delete anything, change who can open a page or its link, change workspace settings, or touch the reader's own documents, other workspaces or account.
- It lasts 12 hours. After that, Markdrop renews it in the background the next time the reader opens a page that needs it, in the cases described in [Already signed in on markdrop.in](#already-signed-in-on-markdropin). Otherwise the reader chooses **Sign in** again.
- It doesn't contain the reader's email address.

Every document still runs its normal access check for that person. Signing in on a domain never opens anything the reader couldn't already open on markdrop.in.

To sign out on your domain, a reader opens the avatar menu in the header and chooses **Sign out**.

## Edit on your domain

Anyone who may edit a page can edit it right on your domain, exactly as on markdrop.in. That's a member of the workspace (on a page that isn't private), someone the page is shared with as **Can edit**, the page's owner, and anyone with the page's edit link. Signed in on `docs.acme.com`, they open the page and it's already in the editor.

On your domain they can:

- write the page and its title (**Saving…** then **Saved** in the top bar, and the other people on the page see the change)
- add images, add sub-pages, and set the page's properties (icon, cover, width, font)
- use the AI writing tools, and see and restore **Version history**
- see who else is on the page, and who is editing it

Some things stay on markdrop.in. In the page's **⋯** menu on your domain, the owner sees them as links that open the same page on markdrop.in:

- **Manage access on markdrop.in ↗**: sharing, who can open it, the password and expiry
- **Change link on markdrop.in ↗**
- **Delete on markdrop.in ↗**

Moving a page, duplicating it, using it as a template and translating it are on markdrop.in too, as are workspace settings, API tokens and your account.

Someone who can read a page but not edit it sees **Request edit access** in its **⋯** menu, on your domain and on markdrop.in. See [Request edit access](/sharing/request-access#request-edit-access).

:::note[If the domain changes hands]
A reader's "Don't ask again" answer belongs to the workspace that owned the domain when they gave it. If the domain is removed, or another workspace verifies it later, readers are asked again.
:::

## Related

::::cards
:::card[Workspace privacy]{href="/workspaces/privacy" icon="lock"}
Make a workspace Locked so every visitor signs in.
:::
:::card[Share with people]{href="/sharing/share-with-people" icon="user"}
Add people by email to a single item.
:::
::::
