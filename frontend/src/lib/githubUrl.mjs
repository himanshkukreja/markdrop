/**
 * What someone pastes as "a GitHub repository" → owner, name, and the branch and folder when the
 * address carries them. Plain JavaScript without path aliases, so node:test runs it directly
 * (docsGithub.test.mjs); lib/docsGithub.ts re-exports it with types (githubUrl.d.mts).
 *
 * Takes:  https://github.com/acme/docs
 *         github.com/acme/docs.git
 *         https://github.com/acme/docs/tree/main/website/docs
 *         https://github.com/acme/docs/blob/main/docs/intro.md   (→ the file's folder)
 *         git@github.com:acme/docs.git
 *         ssh://git@github.com/acme/docs.git
 *         acme/docs
 * Anything else (another host, a user page, a gist) → null.
 */

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
/** github.com paths that aren't repositories. */
const NOT_OWNERS = new Set(["orgs", "settings", "marketplace", "apps", "topics", "explore", "sponsors", "login", "features", "about", "pricing", "notifications", "new", "search"]);

function clean(name) {
  return name.replace(/\.git$/i, "");
}

function validPair(owner, name) {
  return OWNER.test(owner) && REPO.test(name) && name !== "." && name !== ".." && !NOT_OWNERS.has(owner.toLowerCase());
}

function decode(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * @param {unknown} text
 * @returns {{ owner: string, name: string, branch?: string, path?: string } | null}
 */
export function parseGithubUrl(text) {
  if (typeof text !== "string") return null;
  let s = text.trim();
  if (!s || s.length > 2000 || /\s/.test(s)) return null;

  // git@github.com:owner/name(.git)
  const scp = /^git@github\.com:([^/]+)\/([^/]+?)\/?$/i.exec(s);
  if (scp) {
    const owner = scp[1], name = clean(scp[2]);
    return validPair(owner, name) ? { owner, name } : null;
  }

  // owner/name on its own
  const bare = /^([^/:.]+)\/([^/:]+?)\/?$/.exec(s);
  if (bare && !/^(www\.)?github\.com$/i.test(bare[1])) {
    const owner = bare[1], name = clean(bare[2]);
    return validPair(owner, name) ? { owner, name } : null;
  }

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) return null;
  if (!/^(www\.)?github\.com$/i.test(url.hostname)) return null;

  const parts = url.pathname.split("/").filter(Boolean).map(decode);
  if (parts.length < 2) return null;
  const owner = parts[0], name = clean(parts[1]);
  if (!validPair(owner, name)) return null;
  const out = { owner, name };

  // /tree/<branch>/<folder…> or /blob/<branch>/<file…> (the branch is taken as one segment: a
  // branch with a slash in it can be picked from the list afterwards).
  const kind = parts[2];
  if ((kind === "tree" || kind === "blob") && parts[3]) {
    out.branch = parts[3];
    let rest = parts.slice(4);
    if (kind === "blob") rest = rest.slice(0, -1);
    const path = rest.join("/").replace(/^\/+|\/+$/g, "");
    if (path && !rest.some((x) => x === "." || x === "..")) out.path = path;
  }
  return out;
}

/** "acme/docs" from what parseGithubUrl returned. */
export function repoLabel(repo) {
  return repo ? `${repo.owner}/${repo.name}` : "";
}
