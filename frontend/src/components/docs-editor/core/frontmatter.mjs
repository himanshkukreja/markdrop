/**
 * The page header (icon, title, description) lives in the frontmatter. These helpers read it and
 * change single keys in place, leaving every other line (comments, key order, quoting, keys the
 * editor doesn't know) exactly as written.
 */
import { parse as parseYaml } from "yaml";

const FRONT = /^(﻿?)---[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*(\r?\n|$)/;

/** Splits a page into its frontmatter block ("" when none) and the body after it. */
export function splitFrontmatter(markdown) {
  const src = String(markdown ?? "");
  const m = /^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  return m ? { front: m[0], body: src.slice(m[0].length) } : { front: "", body: src };
}

/** `{ key: value }` of a frontmatter block (strict YAML, else line by line). */
export function readFrontmatter(front) {
  const m = FRONT.exec(front ?? "");
  if (!m) return {};
  try {
    const v = parseYaml(m[2]);
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch {
    /* fall through */
  }
  const out = {};
  for (const line of m[2].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

/** The header fields the editor shows. */
export function readMeta(front) {
  const d = readFrontmatter(front);
  const s = (v) => (v === undefined || v === null ? "" : String(v));
  return { title: s(d.title), description: s(d.description), icon: s(d.icon) };
}

const RESERVED = /^(?:true|false|yes|no|on|off|null|~|[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?|0x[0-9a-f]+|\.inf|\.nan)$/i;

/** A YAML scalar for `value`: plain when that reads back as the same string, else double-quoted. */
export function yamlScalar(value) {
  const v = String(value);
  const plain =
    v !== "" &&
    v === v.trim() &&
    !/[\n\r\t]/.test(v) &&
    !/^[-?:,[\]{}#&*!|>'"%@`]/.test(v) &&
    !/: |:$| #/.test(v) &&
    !RESERVED.test(v);
  return plain ? v : JSON.stringify(v);
}

/**
 * Sets (or, with "" / null, removes) top-level keys in a frontmatter block. A key's line is
 * rewritten in place (with its indented continuation lines, for multi-line values); a new key goes
 * before the closing `---`. With no frontmatter yet, one is created.
 */
export function writeFrontmatter(front, patch) {
  const eol = /\r\n/.test(front) ? "\r\n" : "\n";
  let lines;
  let trailer = "";
  if (front) {
    const m = /^(﻿?---[ \t]*)\r?\n([\s\S]*?)\r?\n?(---[ \t]*)(\r?\n|$)/.exec(front);
    if (!m) return front;
    lines = m[2] ? m[2].split(/\r?\n/) : [];
    lines.unshift(m[1]);
    lines.push(m[3]);
    trailer = m[4];
  } else {
    lines = ["---", "---"];
    trailer = eol;
  }
  for (const [key, value] of Object.entries(patch)) {
    const at = lines.findIndex((l, i) => i > 0 && i < lines.length - 1 && new RegExp(`^${key}\\s*:`).test(l));
    const remove = value === null || value === undefined || value === "";
    if (at >= 0) {
      let endAt = at + 1;
      while (endAt < lines.length - 1 && /^(?:[ \t]+\S|- )/.test(lines[endAt])) endAt++;
      lines.splice(at, endAt - at, ...(remove ? [] : [`${key}: ${yamlScalar(value)}`]));
    } else if (!remove) {
      lines.splice(lines.length - 1, 0, `${key}: ${yamlScalar(value)}`);
    }
  }
  if (lines.length === 2 && !front) return "";
  return lines.join(eol) + trailer;
}
