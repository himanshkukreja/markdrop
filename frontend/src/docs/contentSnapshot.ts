/**
 * The docs content as a module, for hosts without a disk. Empty here: Vercel and `next dev` read the files
 * (src/docs/contentFs.ts). The Cloudflare build swaps this module for scripts/cf/docs-snapshot.mjs's output
 * (next.config.ts): { "<path relative to the frontend folder>": "<file text>" }.
 */
const files: Record<string, string> | null = null;
export default files;
