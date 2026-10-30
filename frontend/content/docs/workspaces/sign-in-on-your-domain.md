---
title: Sign-in on your domain
description: How readers sign in on a workspace's own domain, what the domain's owner can see, and how long the sign-in lasts.
updated: 2026-10-30
prerequisites: [/workspaces/custom-domain, /workspaces/privacy]
keywords: [sign in, login, sso, custom domain, handoff, consent, locked]
---

Readers sign in to Markdrop on markdrop.in. A browser keeps sign-ins separate for each site, so on `docs.acme.com` a reader looks signed out, however recently they signed in on markdrop.in. Markdrop carries the sign-in across for them, with their say-so.

Readers only need to sign in for things that aren't open to anyone: items for the team, items shared with them by name, and everything in a [Locked](/workspaces/privacy#the-three-presets) workspace.

## What readers see

::::steps
### Choose Sign in
On your domain, the header shows **Sign in to read Acme Docs** (on a phone, **Sign in**). In a Locked workspace, signed-out visitors see **Sign in to read Acme Docs** in the middle of the page instead.

### Sign in on markdrop.in
The reader goes to markdrop.in and signs in there, if they aren't already.

### Confirm the site
Readers who aren't members of the workspace are asked once: **Continue to docs.acme.com as Dana?** The page says that the site can see their display name, never their email address, and can't change anything in their account. **Don't ask again for docs.acme.com** is ticked by default. They choose **Continue**.

### Back on your domain
They land back on the page they started from, signed in, and can read what's been shared with them.
::::

Members of the workspace skip the question: it's their own site.

## What the sign-in on your domain can do

The sign-in Markdrop hands to your domain is deliberately small:

- It works only on that one domain, and only for that workspace's documents.
- It can only read. It can't edit, share or delete anything, or touch the reader's own documents, other workspaces or account.
- It lasts 12 hours. After that, the reader chooses **Sign in** again.
- It doesn't contain the reader's email address.

Every document still runs its normal access check for that person. Signing in on a domain never opens anything the reader couldn't already open on markdrop.in.

To sign out on your domain, a reader opens the avatar menu in the header and chooses **Sign out**.

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
