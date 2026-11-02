---
title: Private pages and sections
description: Keep a guide public and make some pages or sections private, for your team, a customer's people or partners with a password. Free on every guide.
updated: 2026-11-02
prerequisites: [/guides/pages-and-navigation]
keywords: [private pages, private section, restricted, per-customer docs, customer portal, email domain, magic link, password page, members only page, access request, authenticated docs, gated docs, adaptive content]
---

A guide can stay public while some of its pages, a whole group, or a section inside a page are for some readers only: your own team, the people at one customer (by email address or email domain), or partners with a password. Everyone else sees a lock with the way in. Private pages are free on every guide, with no plan to upgrade.

![Acme Docs as a signed-out reader sees it: two private pages listed with a lock in the navigation, and two locked sections on the Single sign-on page, one for Northwind (Sign in with email) and one for the team (Sign in).](/docs-assets/guides/private-pages/reader-locked-sections.webp)

## Who can open what

Each private page or section names a **rule**. A guide has these kinds:

| Rule | Who opens it | How they sign in |
|---|---|---|
| **Team members** (built in) | Everyone with a Guides role on this guide | **Sign in with Markdrop** |
| **Specific people or email domains** | The email addresses you list, and anyone at a domain you list (`@northwind.com`) | Their email: we send a one-time sign-in link. No Markdrop account needed |
| **Password** | Anyone who types the password | The password, on the page |

Team members open every private page and section, whatever its rule. A rule's name is what readers see on the lock ("Only people at Northwind can open it"), so name a customer rule after the customer.

## Add a rule

Rules live in the guide's **Settings › Private pages**. Only Guides admins add and change them.

1. Under **Who can open private pages**, choose **People or domains** or **Password**.
2. Give it the name readers will see, like `Northwind` or `Partners`.
3. For people: type their email addresses and `@domains`, one per line or separated by commas. For a password: type it (at least 6 characters).
4. Choose whether its pages are **listed in the navigation, with a lock** (everyone sees the titles, only allowed readers open them) or **hidden** (left out of the navigation; share the link with the people it's for). People rules start listed, password rules hidden.

![Settings › Private pages: 4 private pages, 2 private sections, 3 rules and 2 pending requests, then Who can open private pages with Team members (built in), Northwind (anyone at @northwind.test and 1 person) and Partners (password, hidden).](/docs-assets/guides/private-pages/private-settings.webp)

Who a rule lets in changes **within a minute**, without a publish: add someone and they can sign in; remove a person or a domain and their next page load is locked. A public email provider (`gmail.com`, `outlook.com` and the like) can't be a domain: list those people one by one.

![Editing the Northwind rule: the name readers see, People and email domains with @northwind.test and one address, and the switch to list its pages in the navigation with a lock.](/docs-assets/guides/private-pages/rule-people.webp)

## Make a page private

Open the page in the editor, choose the **Page** tab and pick **Who can open this page**:

- **Inherit**: its group's rule, if the group has one, else everyone who can read the guide.
- **Public**: anyone, even inside a private group.
- One of the guide's rules.

![The editor's Page tab for Enterprise SSO setup for Northwind: Who can open this page set to Inherit: Northwind, from the Enterprise group, with a lock badge, and Preview as and Manage rules links. The page tree marks private pages.](/docs-assets/guides/private-pages/editor-page-access.webp)

The page tree marks private pages so you can see them at a glance. In Markdown mode the same choice is the page's `access:` frontmatter key (`access: northwind`).

**A whole group:** in **Settings › Private pages › Groups**, pick a rule for a sidebar group. Every page in it gets that rule unless the page sets its own.

Which pages are private reaches readers when you [publish](/guides/publishing), like any other edit.

## A private section in a public page

Type `/` in the editor and choose **Private section**. Pick who can see it, add an optional title (readers without access see it on the lock), and write the section inside.

![A Private section in the editor: the lock, Who can see it set to Northwind, the title Northwind tenant values, and the section's heading and text inside.](/docs-assets/guides/private-pages/editor-private-section.webp)

In Markdown it is a directive, like the [other blocks](/guides/editor):

```md
:::private[Northwind tenant values]{access="northwind"}
## Northwind tenant values

Use the entity id `urn:acme:northwind-prod-4471`.
:::
```

Without `access`, the section is for the team. A page can have private sections for up to three different rules.

Readers who can open it see the section marked as private; everyone else sees a lock card in its place, with **Sign in with email**, **Sign in** or **Enter password**.

![The Single sign-on page for a reader signed in with a Northwind address: the Northwind tenant values section is shown, marked Only Northwind.](/docs-assets/guides/private-pages/reader-northwind-section.webp)

## What readers see

A reader who opens a private page they can't read gets the guide's lock page, in its colours and logo:

- **Specific people:** a work-email box. If the address may open the page, a sign-in link arrives by email; it works once, for 15 minutes, and can be opened on another device (a phone's mail app, say). The answer is the same for any address, so nobody learns who is on a list.
- **Team:** **Sign in with Markdrop**.
- **Password:** a password box.
- **Request access:** an email and a note for the team (see [Access requests](#access-requests)).

![The lock page for Enterprise SSO setup for Northwind: This page is private, Only people at Northwind can open it, a Work email box, Email me a sign-in link, and Request access.](/docs-assets/guides/private-pages/lock-page.webp)

![The lock page for a password page: This page is password protected, a Password box and Continue.](/docs-assets/guides/private-pages/lock-page-password.webp)

Readers stay signed in on that browser for 7 days. **Sign out every reader** (Settings › Private pages) signs everyone out at once, for when a link or a password was shared too widely. A new password locks out everyone who used the old one.

## Access requests

When a reader asks for access from a lock page, the guide's admins get an email and the request appears under **Settings › Private pages › Access requests**, with the reader's email, note and the page they were on.

- **Approve** adds their email to the rule (for a people rule) and emails them that they can sign in.
- **Decline** emails them that it wasn't approved.

For a team page, approving means inviting them under **People**; for a password page, sending them the password yourself.

![Access requests: lee@contoso.test and ola@contoso.test want Northwind, each with the page they asked from, the time, their note, and Approve and Decline.](/docs-assets/guides/private-pages/access-requests.webp)

**Access history** lists every change to who can read private pages: rules created and changed (with the addresses added and removed), requests answered, and sign-outs, with who did it and when.

## Check before you publish

**Preview as** shows every private page and section, and whether a reader opens it: a public reader, a team member, a specific email address, or someone who knows a password. It reads your drafts, so you can check before you publish.

![Preview as an email, ana@northwind.test: Single sign-on opens with 1 of 2 private sections shown, Enterprise SSO setup for Northwind and Northwind release notes open, On-call runbook and Partner pricing locked.](/docs-assets/guides/private-pages/preview-as.webp)

The same screen, and the **Publish** screen, warn you when:

- a public page links to a private one (readers who can't open it meet a lock);
- a page names a rule that doesn't exist (it stays locked for everyone until you pick another).

## What stays private

A private page or section is left out of everything readers and machines can get without signing in:

- the page itself, its Markdown version (`.md`), its preview card image, and the data the site loads when you click between pages;
- site search, `llms.txt`, `llms-full.txt`, `skill.md` and the sitemap;
- the guide's [MCP server](/guides/what-readers-get) and its changelog feeds;
- previous and next links and the home page's cards;
- images and files that only private content uses;
- [Ask AI](/guides/ask-ai): a signed-out reader's questions are answered from the public guide only; a signed-in reader's also from the private pages and sections they can open.

Every publish checks this: if any text of a private page or section would reach something a signed-out reader can fetch, the publish stops and says where.

A private page's address and its rule's name are not secret: a reader who guesses the address sees the lock and the rule's name, not the page. A page listed in the navigation shows its title to everyone. Hide it from the navigation when the title itself is private.

:::note
The Markdown version of a page with private sections (`.md`, Copy page) has a "Private section" line where each one is, for every reader.
:::

## A password or members-only guide

[Readers and access](/guides/site-settings#who-can-read-it) still decides who can read the guide at all. In a password or members-only guide, private pages add a second rule on top: a reader needs both. A page can't be made public in a private guide.

## Related

- [Who can read it](/guides/site-settings#who-can-read-it): password and members-only guides.
- [Embed files that render](/guides/embed-files#who-can-see-it): files embedded in private content stay private.
- [Ask AI](/guides/ask-ai#private-pages-and-private-guides): answers for signed-in readers.
- [Members and roles](/guides/members-and-roles): who counts as the team.
