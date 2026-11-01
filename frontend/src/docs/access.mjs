/**
 * Private pages and sections (pure: no fs, no React; the engine, the builder and the tests share it).
 *
 * A guide stays public; parts of it can be for some readers only. Who may open them is an access
 * *rule* in site.json `access.rules` ({id: {kind, name, nav}}): `members` (the guide's team),
 * `people` (listed emails and email domains), `password` (a shared password), and later
 * `encrypted` (kept in the model, not built: an unknown kind locks). The rule's *list* (emails,
 * domains, the password) is never in the content: it lives in the edge's access policy only.
 *
 *   page:     frontmatter `access: <rule>` (or `public`, which undoes a group's rule)
 *   group:    site.json nav group `access: <rule>`: every page in it, unless the page says otherwise
 *   section:  `:::private{access="<rule>"}` … `:::` inside any page (no access: the team only)
 *
 * The engine never puts protected text where an unauthorised reader can fetch it:
 * - a protected page is its own route (HTML, RSC payload, .md twin, OG card), which the edge serves
 *   only to readers its rule lets in; it is left out of every aggregate (search index, llms*.txt,
 *   sitemap, skill.md, MCP, feeds, prev/next, home cards) and from the nav, or listed there with a
 *   lock when its rule says `nav: "show"`;
 * - a private section is cut out of the page's body at load time (splitPrivate): the public route
 *   has a locked placeholder there, and the full text is only in *variant* routes
 *   (VARIANT_SEGMENT/<rules>/<page>), one per combination of the page's section rules, which the
 *   edge never serves directly: it serves the matching variant at the page's own address to a
 *   reader those rules let in.
 */

export const RULE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const KINDS = ["members", "people", "password", "encrypted"];
/** The team's rule: exists on every guide, even when site.json doesn't define it. */
export const MEMBERS = "members";
export const PUBLIC = "public";
/** First path segment of a variant route (a page with private sections, revealed for some rules). */
export const VARIANT_SEGMENT = "x-access";
/** The leaf directive a hidden private section becomes. */
export const LOCKED = "private-locked";
export const PRIVATE = "private";
/** Most distinct section rules one page gets variants for (2^n − 1 variants). */
export const MAX_SECTION_RULES = 3;

const DEFAULT_NAMES = { members: "Team members", people: "Specific people", password: "Password", encrypted: "End-to-end encrypted" };

/** site.json `access` → {rules: Map<id, {kind, name, nav}>}. Bad entries are dropped (a page naming one then locks). */
export function readAccess(site) {
  const raw = site && typeof site === "object" ? site.access : null;
  const rules = new Map();
  const src = raw && typeof raw === "object" && raw.rules && typeof raw.rules === "object" ? raw.rules : {};
  for (const [id, r] of Object.entries(src)) {
    if (!RULE_ID.test(id) || id === PUBLIC || !r || typeof r !== "object") continue;
    const kind = KINDS.includes(r.kind) ? r.kind : null;
    if (!kind) continue;
    const name = typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 60) : DEFAULT_NAMES[kind];
    rules.set(id, { id, kind, name, nav: r.nav === "hide" ? "hide" : "show" });
  }
  if (!rules.has(MEMBERS)) rules.set(MEMBERS, { id: MEMBERS, kind: "members", name: DEFAULT_NAMES.members, nav: "show" });
  return { rules };
}

/** A rule as the engine shows it: a known one, else a locked stand-in (never public). */
export function ruleOf(access, id) {
  return access.rules.get(id) || { id, kind: "unknown", name: "Restricted", nav: "hide" };
}

/** A frontmatter / group `access` value → a rule id, "public", or undefined (inherit). Junk locks. */
export function accessValue(v) {
  if (v === undefined || v === null || v === "") return undefined;
  const s = String(v).trim().toLowerCase();
  if (s === "" || s === "inherit") return undefined;
  if (s === PUBLIC) return PUBLIC;
  return RULE_ID.test(s) ? s : "invalid";
}

/** The rule a page ends up with: its own, else its group's; "public" and nothing both mean none. */
export function effectiveRule(pageValue, groupValue) {
  const p = accessValue(pageValue);
  if (p === PUBLIC) return undefined;
  if (p) return p;
  const g = accessValue(groupValue);
  return g && g !== PUBLIC ? g : undefined;
}

/* ── private sections ─────────────────────────────────────────────────────── */

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
const QUOTE = /^\s{0,3}(?:>\s?)+/;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+/;
const OPEN = /^(\s*)(:{3,})([A-Za-z][\w-]*)(?:\[([^\]]*)\])?(?:\{((?:[^}"']|"[^"]*"|'[^']*')*)\})?\s*$/;
const CLOSE = /^\s*(:{3,})\s*$/;

function attrsOf(src) {
  const out = {};
  if (!src) return out;
  const re = /([A-Za-z_][\w-]*)(?:=(?:"([^"]*)"|'([^']*)'|([^\s"']+)))?/g;
  let m;
  while ((m = re.exec(src))) out[m[1]] = m[2] ?? m[3] ?? m[4] ?? "";
  return out;
}

/** The rule a `:::private{…}` names (`access`, or the older `for`); none = the team. */
export function sectionRule(attrs) {
  const v = accessValue(attrs.access ?? attrs.for);
  if (!v) return MEMBERS;
  return v === PUBLIC ? MEMBERS : v;
}

const cleanLabel = (s) => String(s || "").replace(/[[\]{}\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);

/**
 * Cut private sections out of a page body. `reveal`: the rules whose sections stay (a Set), or
 * null for none. A hidden section becomes one `::private-locked[label]{access="rule"}` line (its
 * text, headings and code are gone); a revealed one stays as a `:::private` container that carries
 * `k=<key>` (the renderer shows a container's content only with this key, so a section this split
 * didn't recognise can never render open). Nested containers, fences, block quotes and list items
 * are followed the way the renderer reads them; an unclosed section runs to the end (hidden).
 * Returns {body, rules (every rule named, in order), hidden (count)}.
 */
export function splitPrivate(body, reveal = null, key = "") {
  const lines = String(body ?? "").split(/\r?\n/);
  const out = [];
  const rules = [];
  const stack = [];
  let skipAt = -1; // stack depth of the hidden section being skipped
  let hidden = 0;
  let fence = null;
  let math = false;
  for (const raw of lines) {
    const line = raw.replace(QUOTE, "");
    const skipping = skipAt >= 0;
    // Code and math: copied (or skipped) whole.
    if (fence) {
      const c = /^(`{3,}|~{3,})\s*$/.exec(line.trim());
      if (c && c[1][0] === fence.ch && c[1].length >= fence.len) fence = null;
      if (!skipping) out.push(raw);
      continue;
    }
    if (math) {
      if (/^\s{0,3}\$\$\s*$/.test(line)) math = false;
      if (!skipping) out.push(raw);
      continue;
    }
    const core = line.replace(BULLET, (m) => " ".repeat(m.length));
    const f = FENCE_OPEN.exec(core.trimStart());
    if (f && !(f[1][0] === "`" && f[2].includes("`"))) {
      fence = { ch: f[1][0], len: f[1].length };
      if (!skipping) out.push(raw);
      continue;
    }
    if (/^\s{0,3}\$\$(?!.*\$\$)/.test(core)) {
      math = true;
      if (!skipping) out.push(raw);
      continue;
    }
    const open = OPEN.exec(core);
    if (open) {
      const colons = open[2].length;
      const name = open[3];
      if (name === PRIVATE) {
        const rule = sectionRule(attrsOf(open[5]));
        if (!rules.includes(rule)) rules.push(rule);
        stack.push({ colons });
        if (skipping) continue;
        // The text before the colons (quote markers, a list bullet, indentation) stays.
        const at = raw.indexOf(open[2] + name);
        const prefix = at >= 0 ? raw.slice(0, at) : "";
        const label = cleanLabel(open[4]);
        if (reveal && reveal.has(rule)) {
          out.push(`${prefix}${open[2]}${PRIVATE}${label ? `[${label}]` : ""}{access="${rule}" k="${key}"}`);
        } else {
          out.push(`${prefix}::${LOCKED}${label ? `[${label}]` : ""}{access="${rule}"}`);
          skipAt = stack.length;
          hidden++;
        }
        continue;
      }
      stack.push({ colons });
      if (!skipping) out.push(raw);
      continue;
    }
    const close = CLOSE.exec(core);
    if (close && stack.length && stack[stack.length - 1].colons <= close[1].length) {
      stack.pop();
      if (skipping && stack.length < skipAt) {
        skipAt = -1;
        continue;
      }
      if (!skipping) out.push(raw);
      continue;
    }
    if (!skipping) out.push(raw);
  }
  return { body: out.join("\n"), rules, hidden };
}

/** Whether a body has a private section at all (cheap check before splitting). */
export function hasPrivate(body) {
  return /:{3,}private\b/.test(String(body ?? ""));
}

/** Every non-empty combination of a page's section rules (at most MAX_SECTION_RULES of them), each sorted. */
export function ruleSets(rules) {
  const list = [...new Set(rules)].slice(0, MAX_SECTION_RULES).sort();
  const out = [];
  for (let mask = 1; mask < 1 << list.length; mask++) out.push(list.filter((_, i) => mask & (1 << i)));
  return out;
}

/** The variant segment for a rule set: "members.northwind". */
export const ruleSetKey = (set) => [...set].sort().join(".");

/** "x-access/<rules>/<page segments>" → {rules, path}, or null when it isn't a variant path. */
export function parseVariant(segments) {
  if (!Array.isArray(segments) || segments.length < 3 || segments[0] !== VARIANT_SEGMENT) return null;
  const rules = String(segments[1]).split(".");
  if (!rules.length || !rules.every((r) => RULE_ID.test(r))) return null;
  return { rules, path: "/" + segments.slice(2).join("/") };
}

/** What a locked page or section says about who may open it. */
export function lockText(rule) {
  switch (rule.kind) {
    case "members":
      return { title: "For the team", body: "Only this guide's team members can open this." };
    case "people":
      return { title: `For ${rule.name}`, body: `Only people ${rule.name === "Specific people" ? "on this page's list" : `in ${rule.name}`} can open this. Sign in with your work email.` };
    case "password":
      return { title: "Password protected", body: "Enter the password you were given to open this." };
    default:
      return { title: "Restricted", body: "This isn't available to you." };
  }
}
