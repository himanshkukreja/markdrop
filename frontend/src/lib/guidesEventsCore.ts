/**
 * The pure half of lib/guidesEvents: which Guides events a request stands for, and their props
 * (enums, counts and booleans only). No imports, so node's type stripping can test it
 * (guidesEventsCore.test.mjs).
 */

export type Props = Record<string, string | number | boolean>;

/** The API's source kinds as the events name them ("gitbook" is an import). */
const SOURCE: Record<string, string> = { blank: "blank", template: "template", gitbook: "import", github: "github" };
const TEMPLATES = new Set(["product", "api", "helpcenter"]);
const PRESETS = new Set(["clean", "editorial", "technical", "minimal", "playful", "helpcenter"]);
const MODES = new Set(["both", "light", "dark"]);
const ACCESS = new Set(["public", "password", "members"]);
export const ROLES = new Set(["admin", "reviewer", "editor", "viewer", "none"]);

export const pick = (v: unknown, allowed: Set<string>): string | undefined => (typeof v === "string" && allowed.has(v) ? v : undefined);

/** Drop undefined values (track() wants flat, defined props). */
function clean(p: Record<string, string | number | boolean | undefined>): Props {
  const out: Props = {};
  for (const [k, v] of Object.entries(p)) if (v !== undefined) out[k] = v;
  return out;
}

export interface SitePatchLike {
  name?: unknown;
  slug?: unknown;
  settings?: {
    theme?: { preset?: unknown; mode?: unknown; brand?: { enabled?: unknown } | null; custom_css?: unknown } | null;
    ai?: { enabled?: unknown; name?: unknown; suggestions?: unknown } | null;
    access?: { level?: unknown } | null;
    seo?: { index?: unknown } | null;
    review?: { required?: unknown } | null;
    insights?: { enabled?: unknown } | null;
    redirects?: unknown;
  } | null;
}

/** The events one site PATCH stands for (pure: tested in guidesEventsCore.test.mjs). */
export function sitePatchEvents(patch: SitePatchLike): [string, Props][] {
  const out: [string, Props][] = [];
  if (patch.name !== undefined) out.push(["guide_renamed", {}]);
  if (patch.slug !== undefined) out.push(["guide_address_changed", {}]);
  const s = patch.settings;
  if (!s) return out;
  if (s.theme) {
    out.push(["guide_design_saved", clean({
      preset: pick(s.theme.preset, PRESETS),
      mode: pick(s.theme.mode, MODES),
      brand: s.theme.brand ? s.theme.brand.enabled === true : undefined,
      css: "custom_css" in s.theme ? typeof s.theme.custom_css === "string" && s.theme.custom_css.trim().length > 0 : undefined,
    })]);
  }
  if (s.ai) {
    if (typeof s.ai.enabled === "boolean") out.push(["guide_ask_ai_toggled", { enabled: s.ai.enabled }]);
    if ("name" in s.ai) out.push(["guide_ask_ai_renamed", {}]);
    if (Array.isArray(s.ai.suggestions)) out.push(["guide_ask_ai_questions", { n: s.ai.suggestions.length }]);
  }
  if (s.access && pick(s.access.level, ACCESS)) out.push(["guide_access_changed", { access: s.access.level as string }]);
  if (s.seo && typeof s.seo.index === "boolean") out.push(["guide_indexing_changed", { enabled: s.seo.index }]);
  if (s.review && typeof s.review.required === "boolean") out.push(["guide_reviews_required", { enabled: s.review.required }]);
  if (s.insights && typeof s.insights.enabled === "boolean") out.push(["guide_insights_toggled", { enabled: s.insights.enabled }]);
  if (Array.isArray(s.redirects)) out.push(["guide_redirects_saved", { n: s.redirects.length }]);
  return out;
}

/** guide_created's props (and whether an import started), from the create request. */
export function createdEvents(input: { workspace_id?: string | null; source: { kind?: unknown; template?: unknown } }): [string, Props][] {
  const kind = typeof input.source.kind === "string" ? input.source.kind : "";
  const source = SOURCE[kind] ?? "other";
  const out: [string, Props][] = [["guide_created", clean({
    source,
    template: kind === "template" ? pick(input.source.template, TEMPLATES) : undefined,
    workspace: !!input.workspace_id,
  })]];
  if (kind === "gitbook") out.push(["guide_import_started", { source: "gitbook" }]);
  return out;
}
