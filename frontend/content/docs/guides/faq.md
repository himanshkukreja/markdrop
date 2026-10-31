---
title: Markdrop Guides FAQ and troubleshooting
nav: FAQ and troubleshooting
description: Answers about Markdrop Guides, and what to do when a publish or import fails, a guide isn't public yet, or you can't edit or see a guide.
updated: 2026-10-31
keywords: [faq, troubleshooting, publish failed, build failed, import failed, not public, can't edit, read only, no access, markdrop guides help]
---

## About Markdrop Guides

:::details[What's the difference between Markdrop Guides and the Markdrop docs?]
Markdrop Guides, at [markdrop.in/guides](https://markdrop.in/guides), is where you build guides for your own product. The Markdrop docs, at docs.markdrop.in, are Markdrop's own documentation: the site you're reading. The pages in its Markdrop Guides tab explain the product; everything else here is about Markdrop's documents, files, sharing and workspaces.
:::

:::details[What does it cost?]
Markdrop Guides is free while it's in beta. During the beta there are limits on how many guides a workspace can have and how much each guide can do; when you reach one, the app tells you.
:::

:::details[Do my readers need an account?]
No. Every published guide is public and opens in any browser. Password-protected and members-only guides are [coming soon](/guides/site-settings#who-can-read-it).
:::

:::details[Can I keep my guide out of search engines?]
Yes. Turn off **Let search engines index the guide** in [Settings](/guides/site-settings#who-can-read-it) and publish. The guide stays public for anyone with the link, but asks search engines not to index it.
:::

:::details[Can readers ask questions about my guide?]
Yes, with [Ask AI](/guides/ask-ai). Turn it on in Settings and publish: readers get answers from your published pages, with links to the sections they came from. Each guide has a monthly number of answers during the beta.
:::

:::details[Can I use my own domain?]
Not yet: it's [coming soon](/guides/site-settings#your-own-domain). Every guide is served at its free `<address>.guides.markdrop.in` address.
:::

:::details[Can I keep my pages in Git?]
[GitHub sync](/guides/github-sync) is coming soon. Until then the editor's Markdown mode shows each page as a file, and the engine can be [self-hosted](/guides/self-hosting) from a folder.
:::

:::details[Can I get my content out?]
Every published page is available as Markdown at its address plus `.md`, and the whole guide is in `/llms-full.txt`. In the editor, Markdown mode shows each page's source.
:::

## Troubleshooting

### My guide isn't public yet

- **It hasn't been published.** New guides are drafts: the home page card says **Draft** and the Publishes tab says **Nothing is public until the first publish**. [Publish](/guides/publishing) it.
- **The publish is still running or failed.** Check its row on the **Publishes** tab.
- **It's waiting for a review.** The card says **In review**. A reviewer or admin has to [approve it](/guides/reviews#approve-or-request-changes).
- **It was unpublished.** The card says **Unpublished**. Publish again to put it back.
- **You changed the address.** The new address goes live with the next publish, and the old one stops working.

### My changes aren't on the guide

Saved drafts aren't public until you publish. The page tree marks pages with unpublished changes with a dot, and the Publishes tab lists every change since the last publish. Theme, Ask AI, redirect and sidebar changes also need a publish.

### A publish failed

The publish is marked **Failed** with the reason, and readers keep the last live version. Common causes:

- **"Add a page before publishing."** The guide has no pages.
- **The day's publishes are used up.** Try again tomorrow (UTC), or [restore](/guides/publishing#restore-an-earlier-publish) an earlier publish, which doesn't count.
- **"Password and members-only guides are coming soon."** Set **Who can read it** back to **Anyone** in Settings.
- **"This guide is too large to publish in one snapshot."** Split very long pages.

If it fails again with the same reason, contact Markdrop using the address in the [privacy policy](https://markdrop.in/privacy), with the guide's address.

### An import failed

The import screen says **The import stopped** with the reason. Check that the address is the GitBook site's public address (`https://…`), that it opens in a private browser window, and that it's a GitBook site. Then choose **Start again**. A private GitBook space can't be imported.

### Some imported pages need fixing

That's what the report is for: [check the report](/guides/import-from-gitbook#check-the-report) before you publish. Its rows link to each page.

### The page is Read only

Someone else has it open: the banner and the page tree show who. It opens for editing when they're done, or two minutes after they close their browser. A Guides admin can **Take over**. If the bar says **View only**, your role is Viewer: ask an admin for the Editor role.

### I can't see a workspace's guides

Your Guides role there is **No access**, or a guide gives you **No access**. Workspace membership alone doesn't give access: a Guides admin of the workspace has to [give you a role](/guides/members-and-roles#give-someone-a-role).

### I can't create a guide

In a workspace, only Guides admins create guides. The workspace may also have its most guides for the beta: delete one to make room, or create a personal guide.

### The design didn't change on the guide

**Save design**, then publish. Custom CSS that has a problem can't be saved: the box says what's wrong. See [Custom CSS](/guides/brand-and-style#custom-css).
