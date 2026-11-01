/** Types for githubUrl.mjs. */
export interface ParsedGithubRepo {
  owner: string;
  name: string;
  /** From a /tree/<branch>/… or /blob/<branch>/… address. */
  branch?: string;
  /** The folder (repo-relative, no leading or trailing slash) from the same address. */
  path?: string;
}
export declare function parseGithubUrl(text: unknown): ParsedGithubRepo | null;
export declare function repoLabel(repo: { owner: string; name: string } | null | undefined): string;
