---
title: Markdrop Guides FAQ and troubleshooting
nav: FAQ and troubleshooting
description: Markdrop Guides pricing, the studio address, private pages, embeds, GitHub sync and Fix list privacy, and what to do when a publish or import fails.
updated: 2026-11-02
keywords: [faq, pricing, cost, free, beta, plans, troubleshooting, publish failed, build failed, import failed, not public, can't edit, read only, no access, guides.markdrop.in, markdrop guides help]
---

## Pricing

Markdrop Guides is **free while it's in beta**: everything that's live, for every guide you make, with no card. That includes your own domain with the certificate handled, the Fix list and Insights, Ask AI (1,000 answers a month per guide), live demos, video and PDFs in your pages, the API reference with Try it, the changelog and themes, imports from GitBook, Mintlify or GitHub, and your whole team with roles and reviews. There are [limits](/guides/limits) to keep the beta fair.

After the beta, the plans planned are:

- **Free**, $0 per guide, for small teams and side projects: your own domain, 3 editors, Insights and the Fix list, Ask AI with a monthly cap, basic private pages.
- **Pro**, $39–49 per site a month, a flat price whatever the size of your team: everything in Free, unlimited editors, more Ask AI and AI-drafted fixes with a cap you set, private pages for email domains and each customer.
- **Business**, about $199 per site a month, for companies with more guides and stricter sign-in: everything in Pro, single sign-on for readers and editors, higher AI limits, priority support.

How pricing works:

- AI is the only thing metered, always with a hard cap: no surprise bills.
- Never priced per editor or per reader.
- Join during the beta and your price won't change for 12 months after paid plans start. You'll be told in the app and by email before anything changes.

The current details and the comparison with GitBook and Mintlify are on [markdrop.in/guides](https://markdrop.in/guides).

## About Markdrop Guides

:::details[What's the difference between Markdrop Guides and the Markdrop docs?]
Markdrop Guides, at [guides.markdrop.in](https://guides.markdrop.in), is where you build guides for your own product ([markdrop.in/guides](https://markdrop.in/guides) says what it does). The Markdrop docs, at docs.markdrop.in, are Markdrop's own documentation: the site you're reading. The pages in its Markdrop Guides tab explain the product; everything else here is about Markdrop's documents, files, sharing and workspaces.
:::

:::details[Where is Markdrop Guides? What happened to markdrop.in/guides?]
The studio, where you make and manage guides, is at [guides.markdrop.in](https://guides.markdrop.in). [markdrop.in/guides](https://markdrop.in/guides) is the page about it: what it does, how it compares with GitBook and Mintlify, and pricing. Old links to markdrop.in/guides/… screens still work and open the same screen on guides.markdrop.in. You sign in once: your Markdrop sign-in carries over. See [Open Markdrop Guides](/guides/overview#open-markdrop-guides).

Your published guides live at their own addresses, `<address>.guides.markdrop.in` or [your own domain](/guides/custom-domain).
:::

:::details[Do my readers need an account?]
No. A published guide is public and opens in any browser, unless you make some of it private. [Private pages and sections](/guides/private-pages) are for your team (they sign in with Markdrop), for listed people or everyone at an email domain (they get a one-time sign-in link by email, no account needed), or for anyone with a password. Password and members-only **guides** (the whole guide) are set under [Who can read it](/guides/site-settings#who-can-read-it), where your Markdrop server has them switched on.
:::

:::details[Are private pages really private?]
Yes. A private page or section is left out of everything a signed-out reader or a machine can fetch: the page and its Markdown, search, `llms.txt` and `llms-full.txt`, the sitemap, the MCP server, feeds and link previews, and Ask AI's answers for readers who can't open it. Every publish checks this and stops if private text would leak. A page's address and its rule's name aren't secret, and a page listed in the navigation shows its title: hide it from the navigation when the title is private too. See [What stays private](/guides/private-pages#what-stays-private).
:::

:::details[Is it safe to put interactive HTML in my docs?]
Yes. An [embedded Markdrop file](/guides/embed-files) never runs on your guide's address or on markdrop.in. It renders on Markdrop's separate file domain, in a sandbox with no access to cookies, storage, your page or any other customer's files, and it can't navigate your readers away. The file server repeats the sandbox as a security header, so it holds even when the file is opened on its own. A guide only shows a file to readers who could open its link anyway. See [Security](/guides/embed-files#security).
:::

:::details[Can I keep my pages in Git?]
Yes. [Import from GitHub](/guides/import-from-github) brings a repository's docs into a guide (Markdown, GitBook, Mintlify, Docusaurus or MkDocs), and with **Keep in sync** on, every push updates the guide's drafts, or publishes it. GitHub stays the source of truth for those pages, and Markdrop only reads the repository: the GitHub app has read-only access and never commits. Pages you add in the editor stay yours.
:::

:::details[What does the Fix list collect about my readers?]
Nothing that identifies them. It keeps how far down a page readers got, which parts of a video they played, which code block they copied, addresses that don't exist, and AI agents' reads (the page, how, and which assistant), never cookies, anything stored in the browser, a visitor code, or where readers came from outside your guide. Nothing at all is sent when a browser asks not to be tracked (Do Not Track or Global Privacy Control). Turn Insights off and the Fix list stops too. See [What it collects](/guides/fix-list#what-it-collects).
:::

:::details[Can I keep my guide out of search engines?]
Yes. Turn off **Show in search engines** in [Settings › Readers and access](/guides/site-settings#who-can-read-it) and publish. The guide stays public for anyone with the link, but asks search engines not to index it.
:::

:::details[Can readers ask questions about my guide?]
Yes, with [Ask AI](/guides/ask-ai). Turn it on in Settings and publish: readers get answers from your published pages, with links to the sections they came from. Each guide has 1,000 AI answers a month during the beta; at the limit readers get links to ask Claude or ChatGPT instead, and nobody is billed.
:::

:::details[Can I generate an API reference from an OpenAPI file?]
Yes. Upload an OpenAPI 3.0 or 3.1 file, or give its address, in **Settings › API reference** and publish: every endpoint gets a page with code samples and Try it. See [API reference from an OpenAPI file](/guides/api-reference).
:::

:::details[Can I use my own domain?]
Yes, free. Add a subdomain such as `help.acme.com` under **Settings › Domains** and one `CNAME` record at your DNS provider; with Cloudflare and other supported providers, **Connect** adds the record in one click. The certificate is handled for you, and the free `<address>.guides.markdrop.in` address keeps working. See [Put your guide on your own domain](/guides/custom-domain).
:::

:::details[Can I get my content out?]
Yes. Every published page is plain Markdown at its address plus `.md`, and the whole guide is in `/llms-full.txt`. In the editor, Markdown mode shows each page's source. With GitHub sync your repository stays the source of truth, and the engine that builds guides is open source, so you can [host it yourself](/guides/self-hosting).
:::

## Troubleshooting

### My guide isn't public yet

- **It hasn't been published.** New guides are drafts: the home page card says **Draft** and the Publish tab says **Nothing is public until the first publish**. [Publish](/guides/publishing) it.
- **The publish is still running or failed.** Check its row in **Publish history** on the **Publish** tab.
- **It's waiting for a review.** The card says **In review**. A reviewer or admin has to [approve it](/guides/reviews#approve-or-request-changes).
- **It was unpublished.** The card says **Unpublished**. Publish again to put it back.
- **You changed the address.** The new address goes live with the next publish, and the old one stops working.

### My own domain isn't working

See [When a domain doesn't go live](/guides/custom-domain#when-a-domain-doesnt-go-live). Most often the `CNAME` record has a typo, its name was doubled by the DNS provider, or another record already uses that name.

### My changes aren't on the guide

Saved drafts aren't public until you publish. The page tree marks pages with unpublished changes with a dot, the **Publish** tab shows how many changes are waiting, and the tab lists every change since the last publish. Theme, Ask AI, redirect and sidebar changes also need a publish.

### A publish failed

The publish is marked **Failed** with the reason, and readers keep the last live version. Common causes:

- **"Add a page before publishing."** The guide has no pages.
- **The day's publishes are used up.** Try again tomorrow (UTC), or [restore](/guides/publishing#restore-an-earlier-publish) an earlier publish, which doesn't count.
- **"Password and members-only guides are coming soon."** Your Markdrop server doesn't take them yet. Set **Who can read it** back to **Anyone** in Settings, and use [private pages](/guides/private-pages) for what only some readers should see.
- **"This guide is too large to publish in one snapshot."** Split very long pages.
- **Protected content would be public.** Text from a private page or section would have reached something a signed-out reader can fetch, so nothing was published. The reason lists where. Check it with **Preview as** in [Settings › Private pages](/guides/private-pages#check-before-you-publish).

If it fails again with the same reason, contact Markdrop using the address in the [privacy policy](https://markdrop.in/privacy), with the guide's address.

### Try it says the browser blocked the request

Your API doesn't allow requests from the guide's address (CORS), or it couldn't be reached. Allow your guide's address, like `https://acme.guides.markdrop.in`, in your API's `Access-Control-Allow-Origin`, along with the headers the request sends. Until then, readers can copy the request as a `curl` command. See [Try it and CORS](/guides/api-reference#try-it-and-cors).

### An OpenAPI file isn't accepted

The card says why. The usual reasons: it's Swagger 2.0 (convert it to OpenAPI 3 first), it's larger than 5 MB or has more than 1,000 endpoints, or the address isn't a public `https://` address. See [the limits](/guides/api-reference#limits).

### An import failed

The import screen says **The import stopped** with the reason. For GitBook, check that the address is the GitBook site's public address (`https://…`), that it opens in a private browser window, and that it's a GitBook site; then choose **Start again**. A private GitBook space can't be imported. For GitHub, see [Import from GitHub › Troubleshooting](/guides/import-from-github#troubleshooting).

### Some imported pages need fixing

That's what the report is for: [check the report](/guides/import-from-gitbook#check-the-report) before you publish. Its rows link to each page.

### The page is Read only

Someone else has it open: the banner and the page tree show who. It opens for editing when they're done, or two minutes after they close their browser. A Guides admin can **Take over**. If the bar says **View only**, your role is Viewer: ask an admin for the Editor role.

### I can't see a workspace's guides

Your Guides role there is **No access**, or a guide gives you **No access**. Workspace membership alone doesn't give access: a Guides admin of the workspace has to [give you a role](/guides/members-and-roles#give-someone-a-role).

### I can't create a guide

In a workspace, only Guides admins create guides. The workspace may also have its most guides for the beta (3): delete one to make room, or create a personal guide. See [Limits](/guides/limits).

### The design didn't change on the guide

**Save design**, then publish. Custom CSS that has a problem can't be saved: the box says what's wrong. See [Custom CSS](/guides/brand-and-style#custom-css).
