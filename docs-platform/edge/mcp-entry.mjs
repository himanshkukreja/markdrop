/**
 * The docs MCP server, as built into the edge: the frontend's own route handler
 * (src/app/docs-site/mcp/route.ts → src/docs/mcp.ts → content.ts) bundled with fs/path/next-server
 * shims, so /mcp answers from the build's content snapshot with the same code docs.markdrop.in runs.
 */
export * as route from "@/app/docs-site/mcp/route";
