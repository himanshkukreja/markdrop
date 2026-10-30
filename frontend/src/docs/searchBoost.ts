/**
 * Search ranking shared by the ⌘K palette and the docs MCP server. API reference pages are many
 * and terse ("List domains"), so they would crowd the guides out of general questions; they rank a
 * little lower and still win when the query names an endpoint.
 */
export function apiBoost(_id: unknown, _term: string, stored?: Record<string, unknown>): number {
  return String(stored?.where ?? "").startsWith("API · ") ? 0.55 : 1;
}
