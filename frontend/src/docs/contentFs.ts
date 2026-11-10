/**
 * The few `fs` calls the docs loader makes (src/docs/content.ts, media.ts), answered from the disk or, on a
 * Cloudflare Worker (no disk), from the build-time snapshot (src/docs/contentSnapshot.ts). Same shapes and the
 * same errors as node:fs, so the loader's fallbacks (a missing file reads as empty) behave the same.
 */
import fs from "node:fs";
import path from "node:path";
import snapshot from "./contentSnapshot";

/** A snapshot key: the path relative to the frontend folder (process.cwd() at build time, "/" on a Worker). */
function keyOf(p: string): string {
  return path.relative(process.cwd(), path.resolve(p)).split(path.sep).join("/");
}

function enoent(p: string): NodeJS.ErrnoException {
  const e: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, open '${p}'`);
  e.code = "ENOENT";
  return e;
}

export interface DirEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

export function readFileSync(p: string, _encoding: "utf8"): string {
  if (!snapshot) return fs.readFileSync(p, "utf8");
  const v = snapshot[keyOf(p)];
  if (v === undefined) throw enoent(p);
  return v;
}

export function readdirSync(dir: string, _opts: { withFileTypes: true }): DirEntry[] {
  if (!snapshot) return fs.readdirSync(dir, { withFileTypes: true });
  const prefix = `${keyOf(dir)}/`;
  const seen = new Map<string, boolean>();
  for (const k of Object.keys(snapshot)) {
    if (!k.startsWith(prefix)) continue;
    const rest = k.slice(prefix.length);
    const slash = rest.indexOf("/");
    const name = slash < 0 ? rest : rest.slice(0, slash);
    if (!seen.has(name) || slash >= 0) seen.set(name, slash >= 0);
  }
  if (!seen.size) throw enoent(dir);
  return [...seen].map(([name, isDir]) => ({ name, isDirectory: () => isDir, isFile: () => !isDir }));
}
