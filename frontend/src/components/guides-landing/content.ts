/**
 * The Markdrop Guides landing page's copy that carries facts: the comparison with GitBook and
 * Mintlify (every competitor cell links to the page that says it), the beta and planned pricing,
 * and the FAQ. Kept apart from the markup so a price change is one edit, with its source beside it.
 *
 * Competitor facts were checked on their own pricing and docs pages on COMPARED_ON. Re-check them
 * (and move the date) before changing any of them; never state one without its source.
 */

export const COMPARED_ON = "2026-11-02";
export const COMPARED_LABEL = "as of November 2026";

/** Private pages (page, group and section access) are live: the section and the table say so. */
export const PRIVATE_PAGES_LIVE = true;

/** The beta's Ask AI allowance per guide (StudioHome FREE_AI; docs: guides/ask-ai "Answers each month"). */
export const BETA_AI_ANSWERS = "1,000";

export const SRC = {
  gitbookPricing: "https://www.gitbook.com/pricing",
  gitbookPlans: "https://gitbook.com/docs/account-and-billing/plans",
  gitbookEmbeds: "https://gitbook.com/docs/create-content/blocks/embed-a-url",
  gitbookQuality: "https://www.gitbook.com/blog/new-quality-monitoring-layer",
  mintlifyPricing: "https://www.mintlify.com/pricing",
  mintlifyAuth: "https://www.mintlify.com/docs/deploy/authentication-setup",
  mintlifyAnalytics: "https://www.mintlify.com/docs/optimize/analytics",
  mintlifyEmbeds: "https://www.mintlify.com/docs/create/image-embeds",
  gitbookMcp: "https://gitbook.com/docs/ai-for-your-readers/mcp-servers-for-published-docs",
  mintlifyMcp: "https://www.mintlify.com/docs/ai/model-context-protocol",
} as const;

export type Cell = { text: string; href?: string; tone?: "yes" | "no" | "part" };
export type Row = { label: string; guides: Cell; gitbook: Cell; mintlify: Cell };

export const COMPARISON: Row[] = [
  {
    label: "Start free",
    guides: { text: "Free while in beta, with every feature", tone: "yes" },
    gitbook: { text: "Free plan: 1 user, no custom domain", href: SRC.gitbookPricing, tone: "part" },
    mintlify: { text: "Starter plan: free, up to 5 editors", href: SRC.mintlifyPricing, tone: "yes" },
  },
  {
    label: "Your own domain",
    guides: { text: "Free, with one-click DNS for supported providers", tone: "yes" },
    gitbook: { text: "From Essential, $65/site/month + $12/user", href: SRC.gitbookPricing, tone: "part" },
    mintlify: { text: "Included on Starter", href: SRC.mintlifyPricing, tone: "yes" },
  },
  {
    label: "Reader analytics",
    guides: { text: "Free: Insights, cookieless", tone: "yes" },
    gitbook: { text: "Page views on Free; search and feedback from Essential; AI insights on Ultimate", href: SRC.gitbookPricing, tone: "part" },
    mintlify: { text: "Pro or Enterprise only", href: SRC.mintlifyAnalytics, tone: "no" },
  },
  {
    label: "What to fix next",
    guides: { text: "Free: one ranked Fix list with an AI-drafted fix for each item", tone: "yes" },
    gitbook: { text: "Content gaps and Broken links: Ultimate, $249/site/month + $12/user (beta)", href: SRC.gitbookQuality, tone: "part" },
    mintlify: { text: "Analytics and assistant insights need Pro, $450/month billed yearly", href: SRC.mintlifyAnalytics, tone: "part" },
  },
  {
    label: "AI answers for readers",
    guides: { text: `Free: Ask AI with citations, ${BETA_AI_ANSWERS} answers a month per guide in beta`, tone: "yes" },
    gitbook: { text: "Short answers from Essential; AI chat on Ultimate; credit-limited", href: SRC.gitbookPricing, tone: "part" },
    mintlify: { text: "Pro: 10,000 credits a month (25 per answer), then $0.01 a credit", href: SRC.mintlifyPricing, tone: "part" },
  },
  {
    // Parity, stated plainly: all three serve one on every published site.
    label: "MCP server for AI tools",
    guides: { text: "Free on every guide, with Connect to AI on each page (Cursor, VS Code, Claude, ChatGPT)", tone: "yes" },
    gitbook: { text: "Yes, on every published site (page actions on)", href: SRC.gitbookMcp, tone: "yes" },
    mintlify: { text: "Yes, generated for every site, with Cursor and VS Code in the page menu", href: SRC.mintlifyMcp, tone: "yes" },
  },
  {
    label: "Private pages for readers",
    guides: PRIVATE_PAGES_LIVE
      ? { text: "Free: people, email domains or a password, per page or section", tone: "yes" }
      : { text: "Coming in November, free: people, email domains or a password, per page or section", tone: "part" },
    gitbook: { text: "Authenticated access and adaptive content: Ultimate; share links from Essential", href: SRC.gitbookPricing, tone: "part" },
    mintlify: { text: "Password: Pro; sign-in and per-group pages: Enterprise", href: SRC.mintlifyAuth, tone: "part" },
  },
  {
    label: "Interactive HTML demos in pages",
    guides: { text: "Yes, sandboxed on a separate file domain", tone: "yes" },
    gitbook: { text: "No raw iframes (content security policy); supported embed providers only", href: SRC.gitbookEmbeds, tone: "no" },
    mintlify: { text: "Yes: iframes and React components", href: SRC.mintlifyEmbeds, tone: "yes" },
  },
  {
    label: "Uploaded video plays in the page",
    guides: { text: "Yes, with chapters, captions and where viewers stop", tone: "yes" },
    gitbook: { text: "No: uploaded MP4s show as a link to open or download", href: SRC.gitbookEmbeds, tone: "no" },
    mintlify: { text: "Yes, with the HTML video element", href: SRC.mintlifyEmbeds, tone: "yes" },
  },
  {
    label: "Paid plans",
    guides: { text: "Planned: Pro from $39/site/month, flat, never per editor", tone: "yes" },
    gitbook: { text: "Essential $65, Ultimate $249 per site/month, + $12 per user (billed yearly)", href: SRC.gitbookPlans, tone: "part" },
    mintlify: { text: "Pro $450/month billed yearly ($540 monthly), unlimited editors", href: SRC.mintlifyPricing, tone: "part" },
  },
];

export const COMPARISON_NOTES: Array<{ text: string; href: string; label: string }> = [
  { text: "GitBook prices are per site per month on yearly billing; monthly billing is $79 / $299 per site and $15 per user.", href: SRC.gitbookPlans, label: "GitBook plans" },
  { text: "GitBook's AI and Mintlify's AI both run on monthly credits; GitBook pauses at the limit, Mintlify bills overage.", href: SRC.mintlifyPricing, label: "Mintlify pricing" },
  { text: "Mintlify's Starter \"authentication\" signs in your own team, not your readers; reader passwords need Pro.", href: SRC.mintlifyAuth, label: "Mintlify authentication" },
];

export type Plan = {
  id: string;
  name: string;
  price: string;
  unit: string;
  note: string;
  points: string[];
  current?: boolean;
};

export const BETA_PLAN: Plan = {
  id: "beta",
  name: "Free while in beta",
  price: "$0",
  unit: "today",
  note: "Everything on this page that's live, for every guide you make. No card.",
  current: true,
  points: [
    "Your own domain, with the certificate handled",
    "The Fix list and Insights",
    `Ask AI: ${BETA_AI_ANSWERS} answers a month per guide`,
    "Live demos, video and PDFs in your pages",
    "API reference with Try it, changelog, themes",
    "Import from GitBook, Mintlify or GitHub",
    "Your whole team, with roles and reviews",
  ],
};

export const PLANNED_PLANS: Plan[] = [
  {
    id: "free",
    name: "Free",
    price: "$0",
    unit: "per guide",
    note: "For small teams and side projects.",
    points: [
      "Your own domain",
      "3 editors",
      "Insights and the Fix list",
      "Ask AI with a monthly cap",
      "Basic private pages",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    price: "$39–49",
    unit: "per site / month",
    note: "Flat price, whatever the size of your team.",
    points: [
      "Unlimited editors",
      "More Ask AI and AI-drafted fixes, with a cap you set",
      "Private pages for email domains and each customer",
      "Everything in Free",
    ],
  },
  {
    id: "business",
    name: "Business",
    price: "about $199",
    unit: "per site / month",
    note: "For companies with more guides and stricter sign-in.",
    points: [
      "Single sign-on for readers and editors",
      "Higher AI limits",
      "Priority support",
      "Everything in Pro",
    ],
  },
];

export const PRICING_RULES = [
  "AI is the only thing metered, always with a hard cap: no surprise bills.",
  "Never priced per editor or per reader.",
  "Join during the beta and your price won't change for 12 months after paid plans start.",
];

export type Faq = { q: string; a: string; links?: Array<{ label: string; href: string }> };

const DOCS = "https://docs.markdrop.in";

export const FAQS: Faq[] = [
  {
    q: "Is it really free? What happens after the beta?",
    a: "Markdrop Guides is free while it's in beta, with a monthly number of Ask AI answers per guide. After the beta there will be a Free plan and paid plans like the ones above. If you join during the beta, your price won't change for 12 months after paid plans start, and we'll tell you in the app and by email before anything changes.",
  },
  {
    q: "Can I take my docs with me?",
    a: "Yes. Every published page is plain Markdown at its address plus .md, and the whole guide is in /llms-full.txt. With GitHub sync your repository stays the source of truth. The engine that builds guides is open source (MIT), so you can even host it yourself.",
    links: [
      { label: "Import from GitHub", href: `${DOCS}/guides/import-from-github` },
      { label: "Self-hosting", href: `${DOCS}/guides/self-hosting` },
    ],
  },
  {
    q: "Is it safe to put interactive HTML in my docs?",
    a: "Embedded HTML never runs on your guide's address or on markdrop.in. It renders on Markdrop's separate file domain, in a sandbox with no access to cookies, storage, your page or any other customer's files, and it can't navigate your readers away. The file server repeats the sandbox as a security header, so it holds even when the file is opened on its own.",
    links: [{ label: "How embeds are isolated", href: `${DOCS}/guides/embed-files#security` }],
  },
  {
    q: "Will AI costs surprise me?",
    a: "No. In the beta each guide has a fixed number of Ask AI answers a month; at the limit readers get links to ask Claude or ChatGPT with the page attached instead, and nobody is billed. Paid plans will meter AI only, always with a hard cap you set.",
    links: [{ label: "Ask AI", href: `${DOCS}/guides/ask-ai` }],
  },
  {
    q: "Do I have to write Markdown or use Git?",
    a: "Neither. Write in a visual editor with a slash menu for callouts, steps, tabs and code, or switch a page to Markdown. If your docs already live in a GitHub repository, connect it and every push updates the guide.",
    links: [{ label: "The editor", href: `${DOCS}/guides/editor` }],
  },
  {
    q: "Can I use my own domain?",
    a: "Yes, free. Add a subdomain like help.yourcompany.com and one CNAME record; with Cloudflare and other supported providers, Connect adds the record in one click. The certificate is handled for you, and the free yourname.guides.markdrop.in address keeps working.",
    links: [{ label: "Use your own domain", href: `${DOCS}/guides/site-settings#your-own-domain` }],
  },
  {
    q: "Is a guide good for SEO, and can AI assistants read it?",
    a: "Guides are fast static sites with a sitemap, a preview card for every page and a switch to keep a guide out of search engines. For AI tools every guide serves Markdown versions of its pages, llms.txt and an MCP server, and the Fix list shows which assistants read your docs and where they get stuck.",
    links: [{ label: "What readers get", href: `${DOCS}/guides/what-readers-get` }],
  },
  {
    q: "Do you track my readers?",
    a: "Not as people. A published guide sets no cookies and stores nothing in readers' browsers. Insights and the Fix list count sections read, searches, votes and video progress without personal data, and send nothing at all when a browser asks not to be tracked.",
    links: [{ label: "What the Fix list collects", href: `${DOCS}/guides/fix-list#what-it-collects` }],
  },
];
