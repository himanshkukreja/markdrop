---
title: Edit with your edit secret
description: Every document gets an edit secret starting with sk_. Use it to edit or delete a document you published without an account.
updated: 2026-10-30
keywords: [edit secret, sk_, anonymous, claim, save to my account, X-Edit-Secret]
---

When you publish a document, Markdrop gives you an **edit secret**: a code that starts with `sk_`. Whoever holds it can edit and delete the document, with or without an account. It's how documents published without signing in stay yours.

## Find your secret

Right after you publish, the **Published** panel shows the **Edit secret** with a **Copy secret** button. If you're signed in and own the document, it's folded away behind **Show edit secret**, because your account already lets you edit.

:::warning[Keep a copy]
The secret stays in the browser tab you published from, and nowhere else. Markdrop stores only a one-way hash of it, so nobody, Markdrop included, can show it to you again. If you lose it and you aren't signed in as the owner, you can't edit or delete the document.
:::

A password manager or a private note is a good place for it. Treat it like a password: anyone who has it can change or delete the document.

## Edit with the secret

::::steps
### Open the document
Go to its link, for example `markdrop.in/q3-plan`.

### Choose Edit
Choose **More actions › Edit**. Markdrop asks you to **Enter your edit secret**.

### Paste the secret
Paste the `sk_…` code and choose **Unlock editor**.

### Make your changes
Edit the text, then choose **Save changes**. **Settings** in the editor holds the password, expiry and **Delete document**.
::::

## What the secret can and can't do

| With the edit secret you can | Only the signed-in owner can |
| --- | --- |
| Edit the title and text | Choose who can open it |
| Add, change or remove the password | Add people by email |
| Set or remove the expiry | Change the link from **My files** |
| Delete the document | Rotate the edit secret |
| Open it past its password | See its analytics |

## Save it to your account

Attach an anonymous document to your account and you won't need the secret again. It then shows in **My files** with its analytics, and you can choose who can open it.

In the tab you published from, sign in and choose **Save to my account** on the document. Markdrop uses the secret held in that tab to prove the document is yours.

If that tab is gone but you still have the secret, you can claim it through the API with your [API token](/account/api-tokens):

```bash title="Claim a document"
curl -X POST https://api.markdrop.in/api/v1/documents/q3-plan/claim \
  -H "Authorization: Bearer mdk_••••" \
  -H "X-Edit-Secret: sk_••••"
```

A document that already belongs to another account can't be claimed.

## Use the secret from scripts

The API takes the secret in the `X-Edit-Secret` header. For example, to replace a document's text:

```bash title="Update a document"
curl -X PUT https://api.markdrop.in/api/v1/documents/q3-plan \
  -H "Content-Type: application/json" \
  -H "X-Edit-Secret: sk_••••" \
  -d '{"title": "Q3 plan", "content": "# Q3 plan\n\nUpdated."}'
```

`DELETE` on the same address deletes the document, and `PATCH …/slug` with `{"new_slug": "q3-plan-final"}` changes its link.

## If the secret leaks

If you own the document, you can replace its secret. The old one stops working at once, and the new one is returned once:

```bash title="Rotate the edit secret"
curl -X POST https://api.markdrop.in/api/v1/documents/q3-plan/edit-secret/rotate \
  -H "Authorization: Bearer mdk_••••"
```

Rotating needs the owner's account; the secret alone can't rotate itself. If an anonymous document's secret leaks, delete the document and publish it again.

## Related

- [Publish your first document](/get-started/first-document)
- [Do you need an account?](/get-started/accounts)
- [Passwords and expiry](/documents/passwords-and-expiry)
