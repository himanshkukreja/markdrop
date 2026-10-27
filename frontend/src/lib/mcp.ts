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
    name: "create_upload",
    title: "Upload or replace a big file",
    description: "Starts an upload of up to 2 GB, new or in place of a file you own, and gives the assistant the exact commands to send it. The link stays the same on a replace.",
    scope: "documents:write",
    icon: "upload",
  },
  {
    name: "complete_upload",
    title: "Finish an upload",
    description: "Checks the uploaded file against its fingerprint and publishes it. Nothing changes if it doesn't match.",
    scope: "documents:write",
    icon: "checkCircle",
  },
  {
    name: "restore_file_version",
    title: "Restore an earlier version",
    description: "Puts an earlier version of a file back at the same link. The last five versions are kept.",
    scope: "documents:write",
    icon: "history",
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
  {
    name: "get_file_info",
    title: "Check a file",
    description: "Type, size, fingerprint, version and, for video, duration and resolution — so an assistant can confirm a replace took effect.",
    scope: "documents:read",
    icon: "info",
  },
  {
    name: "list_file_versions",
    title: "List a file's versions",
    description: "The kept versions of a file you own, newest first, with which one is live.",
    scope: "documents:read",
    icon: "listTree",
  },
  {
    name: "get_upload_status",
    title: "Follow an upload",
    description: "Whether an upload is still arriving, being checked, done or failed.",
    scope: "documents:read",
    icon: "refresh",
  },
  {
    name: "list_shares",
    title: "List your file shares",
    description: "Lists the peer-to-peer shares you started while signed in, once someone has opened the link: which are live, how many people are connected and how many downloads finished.",
    scope: "documents:read",
    icon: "share",
  },
  {
    name: "get_share_status",
    title: "Check a share link",
    description: "Says whether a markdrop.in/share link's sender is online and people can join. File details only for your own shares.",
    scope: "documents:read",
    icon: "wave",
  },
];

/**
 * The local server for peer-to-peer sharing (spec Part B). It runs inside the markdrop CLI on the
 * user's computer, over stdio, because P2P file bytes leave from the sender's own device: an AI app
 * in the cloud holds none of the user's files. Names here are the CLI's; keep them in step.
 */
export const MCP_LOCAL_SERVER = "markdrop-p2p";
export const MCP_LOCAL_COMMAND = "markdrop mcp";
/** The first CLI release with every tool below (file uploads arrived in 0.4.0). */
export const MCP_LOCAL_MIN_CLI = "0.4.0";

export interface McpLocalTool {
  name: string;
  title: string;
  description: string;
  icon: string;
}

export const MCP_LOCAL_TOOLS: McpLocalTool[] = [
  {
    name: "share_files",
    title: "Share files",
    description: "Shares files or folders from your computer as a markdrop.in/share link. Several files or a folder go as one zip.",
    icon: "send",
  },
  {
    name: "share_status",
    title: "Follow progress",
    description: "Shows each share and download in this session: waiting, transferring or done, with progress.",
    icon: "refresh",
  },
  {
    name: "stop_share",
    title: "Stop a share",
    description: "Ends a share. The link stops working and anyone still downloading is told.",
    icon: "wifiOff",
  },
  {
    name: "receive_share",
    title: "Receive a share",
    description: "Downloads a share link to Downloads/Markdrop, or a folder you name, without overwriting anything.",
    icon: "download",
  },
  {
    name: "upload_file",
    title: "Publish a file",
    description: "Uploads a file from your computer — a 4K video up to 2 GB — and returns its markdrop.in link. Needs your API token.",
    icon: "upload",
  },
  {
    name: "replace_file",
    title: "Replace a file, same link",
    description: "Swaps the file behind a link you own. Access, title and views stay; the old version is kept for restore.",
    icon: "rotate",
  },
  {
    name: "list_file_versions",
    title: "List versions",
    description: "The kept versions of one of your files, newest first.",
    icon: "listTree",
  },
  {
    name: "restore_file_version",
    title: "Restore a version",
    description: "Puts an earlier version back at the same link.",
    icon: "history",
  },
  {
    name: "get_file_info",
    title: "Check a file",
    description: "Size, fingerprint, version, duration and resolution, to confirm a replace took effect.",
    icon: "info",
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
