/** The bits of node:path (POSIX) the docs engine uses, so its bundle runs anywhere. */
export const sep = "/";

export function normalize(p) {
  const abs = p.startsWith("/");
  const out = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!abs) out.push("..");
    } else out.push(part);
  }
  return (abs ? "/" : "") + out.join("/") || (abs ? "/" : ".");
}

export function join(...parts) {
  return normalize(parts.filter((x) => x !== "").join("/"));
}

export function resolve(...parts) {
  let p = "";
  for (let i = parts.length - 1; i >= 0 && !p.startsWith("/"); i--) p = parts[i] + (p ? `/${p}` : "");
  return normalize(p.startsWith("/") ? p : `/${p}`);
}

export function dirname(p) {
  const n = normalize(p);
  const i = n.lastIndexOf("/");
  return i <= 0 ? (n.startsWith("/") ? "/" : ".") : n.slice(0, i);
}

export function basename(p, ext) {
  const b = normalize(p).split("/").pop() || "";
  return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b;
}

export function extname(p) {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(i) : "";
}

export function relative(from, to) {
  const a = resolve(from).split("/").filter(Boolean);
  const b = resolve(to).split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}

const path = { sep, normalize, join, resolve, dirname, basename, extname, relative };
path.posix = path;
export const posix = path;
export default path;
