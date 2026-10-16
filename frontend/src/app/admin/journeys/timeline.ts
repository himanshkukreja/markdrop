import type { JourneyDoc, JourneyEvent } from "./api";

/** How one PostHog event reads in a person's timeline. */
export type Described = {
  icon: string;
  title: string;
  detail?: string;
  doc?: JourneyDoc & { ref: string; access?: string };
  tone?: "danger" | "warning" | "accent";
};

const PRODUCT_EVENTS: Record<string, { icon: string; title: string }> = {
  logged_in: { icon: "user", title: "Signed in" },
  doc_published: { icon: "send", title: "Published a document" },
  artifact_uploaded: { icon: "upload", title: "Uploaded a file" },
  builder_published: { icon: "builder", title: "Published from the README builder" },
  share_download: { icon: "download", title: "Downloaded shared files" },
  doc_copy_link: { icon: "link", title: "Copied a document link" },
  doc_export_pdf: { icon: "printer", title: "Exported a document as PDF" },
  google_docs_export: { icon: "google", title: "Exported to Google Docs" },
  workspace_created: { icon: "users", title: "Created a workspace" },
  vscode_connected: { icon: "code", title: "Connected VS Code" },
  landing_cta: { icon: "arrowRight", title: "Clicked a landing call to action" },
  hero_play: { icon: "play", title: "Played the hero" },
  hero_found: { icon: "sparkle", title: "Found a hero secret" },
  hero_finale: { icon: "sparkle", title: "Finished the hero" },
  toy_play: { icon: "play", title: "Played a landing demo" },
  toy_done: { icon: "check", title: "Finished a landing demo" },
  document_read: { icon: "doc", title: "Read a document" },
};

const PAGE_NAMES: Record<string, string> = {
  "/": "the home page",
  "/new": "the editor (/new)",
  "/upload": "the upload page",
  "/builder": "the README builder",
  "/share": "Share",
  "/share/[id]": "a share link",
  "/dashboard": "their dashboard",
  "/login": "sign-in",
  "/enterprise": "Enterprise",
  "/privacy": "Privacy",
  "/invite/[token]": "a workspace invite",
};

export function pageName(path: string | undefined | null): string {
  if (!path) return "a page";
  if (PAGE_NAMES[path]) return PAGE_NAMES[path];
  if (path === "/[slug]") return "a document";
  if (path.startsWith("/settings")) return `settings (${path})`;
  return path;
}

function docOf(e: JourneyEvent, docs: Record<string, JourneyDoc>): Described["doc"] | undefined {
  const ref = e.props.doc_ref;
  if (typeof ref !== "string" || !ref) return undefined;
  const d = docs[ref];
  const access = typeof e.props.doc_access === "string" ? e.props.doc_access : undefined;
  if (!d) return { ref, slug: "", title: null, kind: String(e.props.doc_kind ?? "document"), encrypted: access === "encrypted", access };
  return { ...d, ref, access };
}

const secs = (v: unknown) => (typeof v === "number" ? `${Math.round(v)}s` : null);

export function describe(e: JourneyEvent, docs: Record<string, JourneyDoc>): Described {
  const p = e.props;
  const path = typeof p.$pathname === "string" ? p.$pathname : undefined;
  const doc = docOf(e, docs);
  const el = e.element;
  const label = el?.text ? `“${el.text.slice(0, 80)}”` : el?.tag ? `a ${el.tag}` : "something";
  switch (e.event) {
    case "$pageview":
      return { icon: doc ? (doc.kind === "artifact" ? "image" : "doc") : "globe", title: doc ? "Opened a document" : `Viewed ${pageName(path)}`, detail: doc ? undefined : path, doc };
    case "$pageleave": {
      const parts = [secs(p.$prev_pageview_duration) && `after ${secs(p.$prev_pageview_duration)}`];
      const depth = p.$prev_pageview_max_scroll_percentage;
      if (typeof depth === "number") parts.push(`scrolled ${Math.round(depth * (depth <= 1 ? 100 : 1))}%`);
      return { icon: "arrowUpRight", title: `Left ${pageName(path)}`, detail: parts.filter(Boolean).join(", ") || undefined, doc };
    }
    case "$autocapture": {
      const kind = p.$event_type;
      if (kind === "submit") return { icon: "check", title: "Submitted a form", detail: pageName(path), doc };
      if (kind === "change") return { icon: "edit", title: `Changed ${el?.tag === "select" ? "a selection" : "a field"}`, detail: pageName(path), doc };
      if (kind === "copy" || kind === "cut") return { icon: "copy", title: "Copied text", detail: pageName(path), doc };
      return {
        icon: "arrowRight",
        title: `Clicked ${label}`,
        detail: [el?.href ? `→ ${el.href}` : null, `on ${pageName(path)}`].filter(Boolean).join(" "),
        doc,
      };
    }
    case "$rageclick":
      return { icon: "alertCircle", title: `Rage-clicked ${label}`, detail: `on ${pageName(path)}`, tone: "warning", doc };
    case "$dead_click":
      return { icon: "alertCircle", title: `Clicked ${label} and nothing happened`, detail: `on ${pageName(path)}`, tone: "warning", doc };
    case "$exception":
      return { icon: "bug", title: "Hit an error", detail: String(p.$exception_message ?? p.$exception_type ?? ""), tone: "danger", doc };
    case "document_read": {
      const c = e.custom as { depth?: number; seconds?: number };
      return { icon: "doc", title: "Read a document", detail: [c.seconds != null && `${c.seconds}s`, c.depth != null && `${c.depth}% of it`].filter(Boolean).join(" · "), doc, tone: "accent" };
    }
  }
  const known = PRODUCT_EVENTS[e.event];
  const extras = Object.entries(e.custom).map(([k, v]) => `${k}: ${String(v)}`).join(" · ");
  return { icon: known?.icon ?? "zap", title: known?.title ?? e.event.replace(/_/g, " "), detail: extras || undefined, doc, tone: "accent" };
}

export type Session = {
  id: string;
  events: JourneyEvent[];
  start: string;
  end: string;
  entry?: string;
  source?: string;
  device?: string;
};

/** Events (newest first) grouped into sessions, newest session first. */
export function sessions(events: JourneyEvent[]): Session[] {
  const out: Session[] = [];
  const byId = new Map<string, Session>();
  for (const e of events) {
    const id = typeof e.props.$session_id === "string" ? e.props.$session_id : "none";
    let s = byId.get(id);
    if (!s) {
      s = { id, events: [], start: e.timestamp, end: e.timestamp };
      byId.set(id, s);
      out.push(s);
    }
    s.events.push(e);
    if (e.timestamp < s.start) s.start = e.timestamp;
    if (e.timestamp > s.end) s.end = e.timestamp;
  }
  for (const s of out) {
    const first = [...s.events].reverse();
    const pv = first.find((e) => e.event === "$pageview");
    s.entry = pv ? (typeof pv.props.doc_ref === "string" ? "a document" : pageName(pv.props.$pathname as string)) : undefined;
    const ref = first.find((e) => e.props.$referring_domain && e.props.$referring_domain !== "$direct" && !String(e.props.$referring_domain).startsWith("localhost") && !String(e.props.$referring_domain).endsWith("markdrop.in"));
    s.source = (first.find((e) => e.props.utm_source)?.props.utm_source as string) || (ref?.props.$referring_domain as string) || "Direct";
    const d = first[0]?.props;
    s.device = [d?.$browser, d?.$os, d?.$device_type].filter(Boolean).join(" · ") || undefined;
  }
  return out;
}

export function flag(code: string | null | undefined): string {
  if (!code || code.length !== 2) return "";
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

export function ago(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function duration(fromIso: string, toIso: string): string {
  const s = Math.max(0, Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
