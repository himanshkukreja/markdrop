import { DOCS_HOST } from "@/docs/host";

/** Real URLs only: the header and footer never carry #anchors (fragments hold #k=, #mdt=, #token=). */
export const VSCODE_URL = "https://marketplace.visualstudio.com/items?itemName=HimanshuKukreja.markdrop";
export const GITHUB_URL = "https://github.com/himanshkukreja/markdrop";
export const CLI_URL = "https://github.com/himanshkukreja/markdrop/tree/main/cli#readme";

/** The docs site (docs.markdrop.in). Our own site, so it opens in the same tab. */
export const DOCS_URL = `${DOCS_HOST.endsWith(".localhost") ? "http" : "https"}://${DOCS_HOST}`;
/** One docs page, e.g. `docsUrl("/cli/install")`. */
export const docsUrl = (path: string) => `${DOCS_URL}${path}`;

export interface NavLink { label: string; href: string; external?: boolean }

/** Marketing header nav (D37) and the mobile menu. */
export const NAV_LINKS: NavLink[] = [
  { label: "Docs", href: DOCS_URL },
  { label: "MCP", href: "/mcp" },
  { label: "Enterprise", href: "/enterprise" },
  { label: "VS Code extension", href: VSCODE_URL, external: true },
  { label: "GitHub", href: GITHUB_URL, external: true },
];

/** SiteFooter columns (REVAMP_PLAN 7.1). */
export const FOOTER_COLUMNS: Array<{ title: string; links: NavLink[] }> = [
  {
    title: "Product",
    links: [
      { label: "Publish a document", href: "/new" },
      { label: "Send a file", href: "/share" },
      { label: "Upload a file", href: "/upload" },
      { label: "README builder", href: "/builder" },
      { label: "Dashboard", href: "/dashboard" },
    ],
  },
  {
    title: "Teams",
    links: [
      { label: "Custom domains", href: "/enterprise" },
      { label: "Workspaces", href: "/settings/workspaces" },
    ],
  },
  {
    title: "Developers",
    links: [
      { label: "AI assistants (MCP)", href: "/mcp" },
      { label: "VS Code extension", href: VSCODE_URL, external: true },
      { label: "GitHub", href: GITHUB_URL, external: true },
    ],
  },
  {
    title: "Docs",
    links: [
      { label: "Documentation", href: DOCS_URL },
      { label: "Get started", href: docsUrl("/get-started/what-is-markdrop") },
      { label: "API reference", href: docsUrl("/api/overview") },
      { label: "CLI", href: docsUrl("/cli/install") },
      { label: "Changelog", href: docsUrl("/changelog") },
    ],
  },
];
