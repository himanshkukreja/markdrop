/**
 * Markdrop's MCP server, as the /mcp page describes it. Tool names and scopes are the backend's
 * (spec "Tools"); keep them in step when a tool is added or renamed. No imports: the page is static.
 */

/** The canonical resource URI people paste into their AI app (no trailing slash). */
export const MCP_SERVER_URL = "https://api.markdrop.in/mcp";

export type McpScope = "documents:read" | "documents:write";

export interface McpTool {
  name: string;
  title: string;
  description: string;
  scope: McpScope;
  icon: string;
}

export const MCP_TOOLS: McpTool[] = [
  {
    name: "publish_document",
    title: "Publish a document",
    description: "Turns markdown into a link that renders, diagrams and math included. Adds a password or an expiry when you ask.",
    scope: "documents:write",
    icon: "upload",
  },
  {
    name: "publish_page",
    title: "Publish a page or file",
    description: "Publishes a complete HTML page, or a CSV, JSON, SVG or text file, as a link that opens rendered.",
    scope: "documents:write",
    icon: "globe",
  },
  {
    name: "update_document",
    title: "Update a document",
    description: "Replaces the content of a document or text file you own. The link stays the same.",
    scope: "documents:write",
    icon: "edit",
  },
  {
    name: "set_access",
    title: "Change who can open it",
    description: "Makes a link private, password-protected or open to anyone with it, and sets when it expires.",
    scope: "documents:write",
    icon: "lock",
  },
  {
    name: "delete_document",
    title: "Delete a document",
    description: "Deletes a document or file you own. It's marked as destructive, so apps that honour that ask you first.",
    scope: "documents:write",
    icon: "trash",
  },
  {
    name: "list_documents",
    title: "List your documents",
    description: "Lists your documents and files, newest first, filtered by a search or by kind.",
    scope: "documents:read",
    icon: "list",
  },
  {
    name: "get_document",
    title: "Read a document",
    description: "Reads one of your documents, or one anyone with the link can open. It never gets past a password or private access.",
    scope: "documents:read",
    icon: "doc",
  },
  {
    name: "get_document_stats",
    title: "See how it's read",
    description: "Views and top referrers for a document you own, plus readers and read depth where Markdrop has them.",
    scope: "documents:read",
    icon: "chart",
  },
  {
    name: "search",
    title: "Search your documents",
    description: "Finds your own documents that match a query. ChatGPT's deep research uses it.",
    scope: "documents:read",
    icon: "search",
  },
  {
    name: "fetch",
    title: "Fetch a search result",
    description: "Opens the text of a search result, under the same rules as reading a document.",
    scope: "documents:read",
    icon: "download",
  },
];

/** The two permissions, in the words the consent screen uses (spec "Scopes"). */
export const MCP_SCOPES: Array<{ name: McpScope; title: string; description: string; icon: string }> = [
  {
    name: "documents:read",
    title: "See your documents and files",
    description: "Titles, contents, links and view counts.",
    icon: "eye",
  },
  {
    name: "documents:write",
    title: "Publish and manage documents for you",
    description: "Publish, update, change access to and delete documents and files.",
    icon: "edit",
  },
];
