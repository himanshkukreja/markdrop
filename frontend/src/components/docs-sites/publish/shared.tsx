"use client";

import { Badge, Button, CopyButton, Icon, type Tone } from "@/components/ui";
import { guideEvents } from "@/lib/guidesEvents";
import type { Build, ChangeSummary } from "@/lib/docsSites";
import { plural } from "../format";
import { liveUrl } from "../PublishState";

/** Settings a publish carries besides pages: the change list's rows and the summary badges. */
export const SETTING_LABEL: Record<string, { title: string; meta: string; badge: string; icon: string; href: string }> = {
  theme: { title: "Design", meta: "Theme, colours and fonts", badge: "Design", icon: "sun", href: "/design" },
  nav: { title: "Sidebar order", meta: "The order of pages and groups", badge: "Pages", icon: "listTree", href: "" },
  redirects: { title: "Redirects", meta: "Old addresses that send readers on", badge: "Redirects", icon: "link", href: "/settings#redirects" },
  api: { title: "API reference", meta: "Your OpenAPI file and its settings", badge: "API", icon: "code", href: "/settings#api" },
  changelog: { title: "Changelog settings", meta: "Title, products, Coming next", badge: "Changelog", icon: "megaphone", href: "/changelog" },
  ai: { title: "Ask AI", meta: "Guide settings", badge: "Settings", icon: "sparkle", href: "/settings#ai" },
  seo: { title: "Search indexing", meta: "Guide settings", badge: "Settings", icon: "search", href: "/settings#access" },
  access: { title: "Who can read it", meta: "Guide settings", badge: "Settings", icon: "lock", href: "/settings#access" },
  name: { title: "Guide name", meta: "Guide settings", badge: "Settings", icon: "settings", href: "/settings" },
  address: { title: "Address", meta: "Guide settings", badge: "Settings", icon: "globe", href: "/settings#address" },
};

/** "4 new pages", "1 edited", "1 removed", "New design", "Redirects", "API reference", "Settings". */
export function summaryBadges(s: ChangeSummary | null | undefined): Array<{ key: string; tone: Tone; icon?: string; label: string }> {
  if (!s) return [];
  const out: Array<{ key: string; tone: Tone; icon?: string; label: string }> = [];
  if (s.added) out.push({ key: "added", tone: "success", icon: "plus", label: plural(s.added, "new page") });
  if (s.edited) out.push({ key: "edited", tone: "info", icon: "edit", label: `${s.edited} edited` });
  if (s.removed) out.push({ key: "removed", tone: "danger", icon: "minus", label: `${s.removed} removed` });
  if (s.design) out.push({ key: "design", tone: "neutral", icon: "sun", label: "New design" });
  if (s.redirects) out.push({ key: "redirects", tone: "neutral", icon: "link", label: "Redirects" });
  if (s.api) out.push({ key: "api", tone: "neutral", icon: "code", label: "API reference" });
  if (s.changelog) out.push({ key: "changelog", tone: "neutral", icon: "megaphone", label: plural(s.changelog, "changelog entry", "changelog entries") });
  else if (s.settings.includes("changelog")) out.push({ key: "changelog", tone: "neutral", icon: "megaphone", label: "Changelog" });
  const other = s.settings.filter((k) => !["theme", "redirects", "api", "changelog"].includes(k));
  if (other.length) out.push({ key: "settings", tone: "neutral", icon: "settings", label: other.includes("nav") && other.length === 1 ? "Sidebar order" : "Settings" });
  return out;
}

export function SummaryBadges({ summary }: { summary: ChangeSummary | null | undefined }) {
  const items = summaryBadges(summary);
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((b) => <Badge key={b.key} tone={b.tone} icon={b.icon}>{b.label}</Badge>)}
    </div>
  );
}

/** "4 new pages, 1 edited page and a new design." */
export function summarySentence(s: ChangeSummary | null | undefined): string {
  if (!s) return "";
  const bits: string[] = [];
  if (s.added) bits.push(plural(s.added, "new page"));
  if (s.edited) bits.push(plural(s.edited, "edited page"));
  if (s.removed) bits.push(plural(s.removed, "removed page"));
  if (s.design) bits.push("a new design");
  if (s.redirects) bits.push("redirects");
  if (s.api) bits.push("the API reference");
  if (s.changelog) bits.push(plural(s.changelog, "changelog entry", "changelog entries"));
  else if (s.settings.includes("changelog")) bits.push("the changelog's settings");
  const other = s.settings.filter((k) => !["theme", "redirects", "api", "changelog"].includes(k));
  if (other.length) bits.push(other.length === 1 && other[0] === "nav" ? "the sidebar order" : "settings");
  if (!bits.length) return "";
  const text = bits.length === 1 ? bits[0]! : `${bits.slice(0, -1).join(", ")} and ${bits[bits.length - 1]}`;
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/** How many things a summary counts (pages + changelog entries + design + redirects + API + other settings). */
export const summaryCount = (s: ChangeSummary | null | undefined): number => (s ? s.added + s.edited + s.removed + (s.changelog ?? 0) + s.settings.length : 0);

/** A publish that went live once (it can be compared against and restored). */
export const wentLive = (b: Build) => !!b.manifest_hash && (b.status === "live" || b.status === "superseded");

/** "51 s" / "1 min 4 s" */
export function seconds(ms: number | null | undefined): string {
  const s = Math.max(1, Math.round((ms ?? 0) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
}

/**
 * One address readers use: the host (opens in a new tab), a note ("Your domain" / "Free address"),
 * Copy and Open. Every address the publishing screens show goes through this.
 */
export function AddressRow({ host, note, own, from = "publish" }: { host: string; note?: string; own: boolean; from?: "publish" | "banner" }) {
  const url = liveUrl(host);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-inset py-2 pl-3 pr-2">
      <Icon name="globe" size={15} className="shrink-0 text-text-muted" />
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => guideEvents.liveOpened(from)}
        className="ph-sensitive ph-mask min-w-0 flex-1 truncate font-mono text-[14px] font-semibold text-text no-underline hover:underline"
        title={host}
      >
        {host}<span className="md-visually-hidden"> (opens in a new tab)</span>
      </a>
      {note && <span className="text-[12px] text-text-muted max-sm:hidden">{note}</span>}
      <CopyButton text={url} label="Copy" size="sm" variant="ghost" announceText="Address copied" onCopy={() => guideEvents.addressCopied(own)} />
      <Button variant="secondary" size="sm" iconRight="external" href={url} target="_blank" rel="noopener noreferrer" onClick={() => guideEvents.liveOpened(from)}>
        Open<span className="md-visually-hidden"> {host} in a new tab</span>
      </Button>
    </div>
  );
}
