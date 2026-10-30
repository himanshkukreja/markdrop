---
title: Publish your first document
description: Write or paste Markdown at markdrop.in/new, choose Publish, and share the link. No account needed.
updated: 2026-10-30
keywords: [publish, new document, markdown, quickstart, edit secret]
---

You can publish a document in under a minute, without an account. You paste text, Markdrop gives you a link, and anyone who opens it sees a formatted page.

::video{id="publish-first-document" title="Publish your first document" duration="0:45"}

## Publish it

::::steps
### Open the editor
Go to [markdrop.in/new](https://markdrop.in/new), or choose **Create › Markdown document** from any page.

### Add your text
Paste or type Markdown in the editor. The **Title** field above it is optional: leave it empty and Markdrop uses the document's first `#` heading, or its first line.

Switch between **Write**, **Split** and **Preview** to see the result as readers will. Not sure what to try? Choose **Try the diagrams sample** in the empty editor.

### Check the settings (optional)
The chips above the editor say how the document is published. By default it's **Anyone with the link**, has **No password**, **Never expires** and gets a **Random link**. Choose a chip to change it. For example, set **Link** to `q3-plan` to publish at `markdrop.in/q3-plan`.

### Choose Publish
Choose **Publish**, or press :kbd[⌘ Enter] (:kbd[Ctrl Enter] on Windows and Linux).
::::

The document opens with a **Published** panel. Choose **Copy link** and share it anywhere: Slack, email, a ticket. Choose **Show QR code** to open it on a phone.

## Keep your edit secret

If you published without signing in, the panel also shows your **Edit secret**, a code that starts with `sk_`. It's the only way to edit or delete the document without an account.

:::warning[Copy it now]
The secret stays visible in this browser tab, but nowhere else. Choose **Copy secret** and keep it somewhere safe. Markdrop can't show it to you again.
:::

If you're signed in, the document is already in **My files** and you don't need the secret. Signed out, choose **Sign in to keep it in your account**, then **Save to my account** when you're back on the document. See [Edit with your edit secret](/documents/edit-key).

## What readers see

Readers get the rendered page: headings, tables, code with syntax highlighting, math and Mermaid diagrams. They don't need an account. They can copy the link, read full screen (press :kbd[F]), view the raw Markdown, or export a PDF from **More actions**.

If you change the text later, anyone with the page open sees the update appear.

## Things to know

- A document can be up to 500,000 characters. The meter above the editor counts down as you type.
- The editor keeps a draft on this device until you publish, so closing the tab doesn't lose your text. Turning on encryption stops drafts.
- If you publish many documents in a short time, Markdrop asks you to wait a minute and try again.

## Next steps

::::cards
:::card[Write and format]{href="/documents/writing" icon="edit"}
Everything the renderer supports, from tables to diagrams and math.
:::
:::card[Add a password or an expiry]{href="/documents/passwords-and-expiry" icon="lock"}
Ask readers for a password, or have the link stop working on a date.
:::
:::card[Encrypt it in your browser]{href="/sharing/end-to-end-encryption" icon="eyeOff"}
Publish so that Markdrop stores only ciphertext it has no key for.
:::
::::
