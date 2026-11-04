/**
 * Markdrop's MCP server, as the /mcp page describes it. Tool names and scopes are the backend's
 * (spec "Tools"); keep them in step when a tool is added or renamed. No imports: the page is static.
 */

/** The canonical resource URI people paste into their AI app (no trailing slash). */
export const MCP_SERVER_URL = "https://api.markdrop.in/mcp";

export type McpScope = "documents:read" | "documents:write";

/** A tool, by name, with the permission it needs ("read" is documents:read, "write" documents:write). */
export interface McpToolName {
  name: string;
  scope: "read" | "write";
}

/**
 * The hosted server's 63 tools, grouped as the docs group them (docs: ai/tools "Hosted server
 * tools"). Keep in step with the backend's tool list and that page.
 */
export const MCP_TOOL_GROUPS: Array<{ title: string; icon: string; tools: McpToolName[] }> = [
  {
    title: "Publish and edit",
    icon: "upload",
    tools: [
      { name: "publish_document", scope: "write" },
      { name: "publish_page", scope: "write" },
      { name: "update_document", scope: "write" },
      { name: "set_slug", scope: "write" },
      { name: "delete_document", scope: "write" },
      { name: "restore_document", scope: "write" },
      { name: "list_trash", scope: "read" },
    ],
  },
  {
    title: "Read and find",
    icon: "search",
    tools: [
      { name: "get_document", scope: "read" },
      { name: "list_documents", scope: "read" },
      { name: "search", scope: "read" },
      { name: "fetch", scope: "read" },
    ],
  },
  {
    title: "Pages",
    icon: "doc",
    tools: [
      { name: "create_page", scope: "write" },
      { name: "get_page", scope: "read" },
      { name: "update_page", scope: "write" },
      { name: "append_blocks", scope: "write" },
      { name: "replace_section", scope: "write" },
      { name: "insert_embed", scope: "write" },
      { name: "set_page_properties", scope: "write" },
      { name: "upload_page_image", scope: "write" },
      { name: "create_page_image_upload", scope: "write" },
      { name: "complete_page_image_upload", scope: "write" },
      { name: "copy_page_asset", scope: "write" },
      { name: "list_page_templates", scope: "read" },
      { name: "save_page_as_template", scope: "write" },
      { name: "set_folder_default_template", scope: "write" },
      { name: "set_folder_properties", scope: "write" },
      { name: "list_folder_pages", scope: "read" },
      { name: "list_subpages", scope: "read" },
      { name: "move_page", scope: "write" },
      { name: "translate_page", scope: "write" },
      { name: "summarize_page", scope: "write" },
      { name: "suggest_page_meta", scope: "write" },
      { name: "list_page_versions", scope: "read" },
      { name: "get_page_version", scope: "read" },
      { name: "restore_page_version", scope: "write" },
      { name: "export_page", scope: "read" },
      { name: "duplicate_page", scope: "write" },
      { name: "list_signoffs", scope: "read" },
      { name: "sign_off", scope: "write" },
    ],
  },
  {
    title: "Access",
    icon: "lock",
    tools: [
      { name: "set_access", scope: "write" },
      { name: "share_with_people", scope: "write" },
    ],
  },
  {
    title: "Notifications",
    icon: "bell",
    tools: [
      { name: "list_notifications", scope: "read" },
      { name: "mark_notifications_read", scope: "write" },
    ],
  },
  {
    title: "Files and uploads",
    icon: "film",
    tools: [
      { name: "create_upload", scope: "write" },
      { name: "complete_upload", scope: "write" },
      { name: "get_upload_status", scope: "read" },
      { name: "get_file_info", scope: "read" },
      { name: "list_file_versions", scope: "read" },
      { name: "restore_file_version", scope: "write" },
    ],
  },
  {
    title: "Analytics",
    icon: "chart",
    tools: [
      { name: "get_document_stats", scope: "read" },
      { name: "get_document_analytics", scope: "read" },
    ],
  },
  {
    title: "Workspaces and folders",
    icon: "folder",
    tools: [
      { name: "list_workspaces", scope: "read" },
      { name: "list_folders", scope: "read" },
      { name: "list_workspace_items", scope: "read" },
      { name: "list_workspace_members", scope: "read" },
      { name: "add_to_workspace", scope: "write" },
      { name: "remove_from_workspace", scope: "write" },
      { name: "create_folder", scope: "write" },
      { name: "move_to_folder", scope: "write" },
    ],
  },
  {
    title: "Who's viewing",
    icon: "users",
    tools: [
      { name: "get_viewers", scope: "read" },
      { name: "set_presence", scope: "write" },
    ],
  },
  {
    title: "Peer-to-peer shares",
    icon: "send",
    tools: [
      { name: "list_shares", scope: "read" },
      { name: "get_share_status", scope: "read" },
    ],
  },
];

export const MCP_TOOL_COUNT = MCP_TOOL_GROUPS.reduce((n, g) => n + g.tools.length, 0);

/**
 * The local server for peer-to-peer sharing and files on disk (docs: ai/local-mcp). It runs inside
 * the markdrop CLI on the user's computer, over stdio, because P2P file bytes leave from the
 * sender's own device: an AI app in the cloud holds none of the user's files. Names are the CLI's.
 */
export const MCP_LOCAL_SERVER = "markdrop-p2p";
export const MCP_LOCAL_COMMAND = "markdrop mcp";
/** The first CLI release with every local tool (0.3.0 sharing, 0.4.0 files, 0.5.0 workspaces). */
export const MCP_LOCAL_MIN_CLI = "0.5.0";

/** The local server's 11 tools (docs: ai/tools "Local server tools"). */
export const MCP_LOCAL_TOOL_GROUPS: Array<{ title: string; tools: string[] }> = [
  { title: "Publish files from disk", tools: ["upload_file", "replace_file", "list_file_versions", "restore_file_version", "get_file_info"] },
  { title: "Workspaces", tools: ["list_workspaces", "list_folders"] },
  { title: "Share peer to peer", tools: ["share_files", "share_status", "stop_share", "receive_share"] },
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
