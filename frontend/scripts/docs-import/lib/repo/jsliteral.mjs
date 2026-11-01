/**
 * A static reader for JavaScript object literals (Docusaurus sidebars files): never evaluates
 * anything. Accepts comments, unquoted keys, single or double quotes, trailing commas, numbers,
 * true/false/null/undefined and template strings without `${}`. Anything else (functions, calls
 * like require(), spreads, variables, computed keys) throws JsLiteralError, so the caller can fall
 * back to the folders.
 */

export class JsLiteralError extends Error {
  constructor(message, at) {
    super(`${message} (at ${at})`);
    this.name = "JsLiteralError";
    this.at = at;
  }
}

const ID_START = /[A-Za-z_$]/;
const ID_PART = /[\w$]/;

class Reader {
  constructor(src, at = 0) {
    this.s = src;
    this.i = at;
    this.depth = 0;
  }
  fail(msg) {
    throw new JsLiteralError(msg, this.i);
  }
  ws() {
    const s = this.s;
    for (;;) {
      while (this.i < s.length && /\s/.test(s[this.i])) this.i++;
      if (s.startsWith("//", this.i)) {
        const e = s.indexOf("\n", this.i);
        this.i = e < 0 ? s.length : e + 1;
      } else if (s.startsWith("/*", this.i)) {
        const e = s.indexOf("*/", this.i + 2);
        if (e < 0) this.fail("unterminated comment");
        this.i = e + 2;
      } else return;
    }
  }
  peek() {
    this.ws();
    return this.s[this.i];
  }
  ident() {
    const s = this.s;
    if (!ID_START.test(s[this.i] ?? "")) this.fail("expected a name");
    const a = this.i;
    while (this.i < s.length && ID_PART.test(s[this.i])) this.i++;
    return s.slice(a, this.i);
  }
  string() {
    const s = this.s;
    const q = s[this.i++];
    let out = "";
    while (this.i < s.length) {
      const c = s[this.i++];
      if (c === q) return out;
      if (q === "`" && c === "$" && s[this.i] === "{") this.fail("template string with ${}");
      if (c === "\\") {
        const e = s[this.i++];
        const map = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" };
        if (e === "u") {
          const hex = s[this.i] === "{" ? s.slice(this.i + 1, s.indexOf("}", this.i)) : s.slice(this.i, this.i + 4);
          this.i += s[this.i] === "{" ? hex.length + 2 : 4;
          out += String.fromCodePoint(parseInt(hex, 16) || 0);
        } else if (e === "x") {
          out += String.fromCharCode(parseInt(s.slice(this.i, this.i + 2), 16) || 0);
          this.i += 2;
        } else if (e === "\n") {
          /* line continuation */
        } else out += map[e] ?? e;
        continue;
      }
      if (c === "\n" && q !== "`") this.fail("unterminated string");
      out += c;
    }
    this.fail("unterminated string");
  }
  number() {
    const m = /^-?(?:0[xX][0-9a-fA-F]+|(?:\d[\d_]*)?\.?\d[\d_]*(?:[eE][+-]?\d+)?)/.exec(this.s.slice(this.i, this.i + 64));
    if (!m) this.fail("bad number");
    this.i += m[0].length;
    return Number(m[0].replace(/_/g, ""));
  }
  value() {
    if (++this.depth > 200) this.fail("nested too deep");
    try {
      const c = this.peek();
      if (c === "{") return this.object();
      if (c === "[") return this.array();
      if (c === '"' || c === "'" || c === "`") return this.string();
      if (c === "-" || /\d/.test(c ?? "") || (c === "." && /\d/.test(this.s[this.i + 1] ?? ""))) return this.number();
      if (ID_START.test(c ?? "")) {
        const at = this.i;
        const id = this.ident();
        if (id === "true") return true;
        if (id === "false") return false;
        if (id === "null") return null;
        if (id === "undefined") return undefined;
        this.i = at;
        this.fail(`"${id}" is code, not a value`);
      }
      this.fail(c === undefined ? "unexpected end" : `unexpected "${c}"`);
    } finally {
      this.depth--;
    }
  }
  object() {
    this.i++; // {
    const out = {};
    for (;;) {
      const c = this.peek();
      if (c === "}") {
        this.i++;
        return out;
      }
      if (this.s.startsWith("...", this.i)) this.fail("spread");
      let key;
      if (c === '"' || c === "'" || c === "`") key = this.string();
      else if (/\d/.test(c ?? "")) key = String(this.number());
      else if (c === "[") this.fail("computed key");
      else key = this.ident();
      const n = this.peek();
      if (n === "(") this.fail("method");
      if (n !== ":") this.fail("shorthand property");
      this.i++;
      const v = this.value();
      Object.defineProperty(out, key, { value: v, enumerable: true, writable: true, configurable: true });
      const after = this.peek();
      if (after === ",") this.i++;
      else if (after !== "}") this.fail(`expected , or } (got ${after ?? "end"})`);
    }
  }
  array() {
    this.i++; // [
    const out = [];
    for (;;) {
      const c = this.peek();
      if (c === "]") {
        this.i++;
        return out;
      }
      if (this.s.startsWith("...", this.i)) this.fail("spread");
      out.push(this.value());
      const after = this.peek();
      if (after === ",") this.i++;
      else if (after !== "]") this.fail(`expected , or ] (got ${after ?? "end"})`);
    }
  }
}

/** Parses one literal starting at `at` → { value, end }. */
export function readJsLiteral(src, at = 0) {
  const r = new Reader(String(src ?? ""), at);
  const value = r.value();
  return { value, end: r.i };
}

/** Parses a whole literal (trailing `;`, `as const` and `satisfies X` allowed). */
export function parseJsLiteral(src) {
  const s = String(src ?? "");
  const { value, end } = readJsLiteral(s, 0);
  const rest = s.slice(end).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "").trim();
  if (rest && !/^(?:as\s+const|satisfies\s+[\w.<>[\]| ]+)?\s*;?$/.test(rest)) throw new JsLiteralError("text after the value", end);
  return value;
}

/**
 * The sidebars object of a Docusaurus sidebars file: the literal after `const sidebars =`,
 * `module.exports =` or `export default`. JSON files parse as JSON. Throws when there is none or it
 * isn't a plain literal.
 */
export function parseSidebarsFile(src, name = "sidebars.js") {
  const s = String(src ?? "");
  if (/\.json$/i.test(name)) return JSON.parse(s);
  const starts = [
    /\b(?:const|let|var)\s+sidebars\s*(?::\s*[\w.<>[\]| ]+)?\s*=\s*/,
    /\bmodule\.exports\s*=\s*/,
    /\bexport\s+default\s+/,
  ];
  let lastError = null;
  for (const re of starts) {
    const m = re.exec(s);
    if (!m) continue;
    const at = m.index + m[0].length;
    if (!/[{[]/.test(s[at] ?? "")) continue; // `module.exports = sidebars`: the const has it
    try {
      return readJsLiteral(s, at).value;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError ?? new JsLiteralError("no sidebars object found", 0);
}
