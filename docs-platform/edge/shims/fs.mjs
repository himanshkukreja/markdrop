/**
 * node:fs for the MCP engine at the edge: the engine (frontend/src/docs/content.ts, media.ts) reads
 * the content folder synchronously; here it reads the build's content snapshot instead. Each engine
 * instance is wrapped in a function whose `__siteFiles` parameter is that site's snapshot
 * ({"/site/<rel>": text, "/public/<rel>": text}), so one isolate serves many sites.
 */
/* global __siteFiles */

function norm(p) {
  return String(p).replace(/\/+$/, "") || "/";
}

function enoent(p) {
  const e = new Error(`ENOENT: no such file or directory, open '${p}'`);
  e.code = "ENOENT";
  return e;
}

export function readFileSync(p, enc) {
  const v = __siteFiles[norm(p)];
  if (v === undefined) throw enoent(p);
  return enc ? v : new TextEncoder().encode(v);
}

export function existsSync(p) {
  const k = norm(p);
  if (__siteFiles[k] !== undefined) return true;
  const pre = k === "/" ? "/" : `${k}/`;
  return Object.keys(__siteFiles).some((f) => f.startsWith(pre));
}

class Dirent {
  constructor(name, dir) {
    this.name = name;
    this.dir = dir;
  }
  isDirectory() {
    return this.dir;
  }
  isFile() {
    return !this.dir;
  }
}

export function readdirSync(p, opts) {
  const k = norm(p);
  const pre = k === "/" ? "/" : `${k}/`;
  const seen = new Map();
  for (const f of Object.keys(__siteFiles)) {
    if (!f.startsWith(pre)) continue;
    const rest = f.slice(pre.length);
    const i = rest.indexOf("/");
    const name = i < 0 ? rest : rest.slice(0, i);
    if (!seen.has(name)) seen.set(name, i >= 0);
    else if (i >= 0) seen.set(name, true);
  }
  if (!seen.size && __siteFiles[k] === undefined) throw enoent(p);
  const names = [...seen.keys()].sort();
  return opts && opts.withFileTypes ? names.map((n) => new Dirent(n, seen.get(n))) : names;
}

export function statSync(p) {
  const k = norm(p);
  if (__siteFiles[k] !== undefined) return { isFile: () => true, isDirectory: () => false, size: __siteFiles[k].length, mtimeMs: 0 };
  if (existsSync(k)) return { isFile: () => false, isDirectory: () => true, size: 0, mtimeMs: 0 };
  throw enoent(p);
}

export default { readFileSync, existsSync, readdirSync, statSync };
