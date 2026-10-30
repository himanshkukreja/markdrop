"use client";

import { Avatar, AvatarGroup, Badge, Button, Icon, VSCodeIcon } from "@/components/ui";
import { ReadMore } from "@/components/ReadMore";
import { MetaList } from "@/components/kit/MetaList";
import { KeyAnatomy } from "@/components/kit/KeyAnatomy";
import { useIsClient } from "@/components/kit/publish-utils";
import type { AccessState } from "@/lib/access";

/** "Expires in 3 hours" / "Expires in 2 days", or null once it's past. Client-only (reader's clock). */
export function expiryLabel(expiresAt: string | null): string | null {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return null;
  const hours = Math.ceil(ms / 3_600_000);
  const days = Math.ceil(ms / 86_400_000);
  return hours <= 24
    ? hours === 1 ? "Expires in 1 hour" : `Expires in ${hours} hours`
    : days === 1 ? "Expires in 1 day" : `Expires in ${days} days`;
}

/** Reading time at ~230 words a minute, never "0 min". */
export function readingMinutes(text: string): number {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return Math.max(1, Math.round(words / 230));
}

const LEVEL_LINE: Record<string, { icon: string; text: string }> = {
  link: { icon: "globe", text: "Anyone with the link" },
  private: { icon: "lock", text: "Only people added" },
  workspace: { icon: "user", text: "The workspace team" },
};

export interface DetailsPanelProps {
  url: string;
  shareUrl: string;
  encrypted: boolean;
  readable: boolean;
  keyFragment: string | null;
  createdAt: string;
  expiresAt: string | null;
  views?: number;
  content: string;
  /** "Private" (sign-in gate) or "Password". */
  protection: "private" | "password" | null;
  vscodeSynced: boolean;
  live: boolean;
  access: AccessState | null;
  canShare: boolean;
  onShare: () => void;
  /** The Google Docs card (owner, connected, not encrypted). */
  google?: React.ReactNode;
  /** Shown when the reader may report (not a secret holder). */
  onReport?: () => void;
}

/**
 * The framed reader's Details (REVAMP_PLAN 7.6): status badges (word + mark), a MetaList, the
 * Access card for owners and resharers, the E2E card, the Google Docs card and "Report this
 * document". Rendered in the 280px rail at ≥1280, and inside the Details drawer/sheet below that.
 */
export function DetailsPanel(p: DetailsPanelProps) {
  const isClient = useIsClient();
  const expiry = isClient ? expiryLabel(p.expiresAt) : null;
  const published = isClient
    ? new Date(p.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    : "";
  const views = p.views ?? 0;
  const level = p.access ? LEVEL_LINE[p.access.level] : null;
  const grants = p.access?.grants ?? [];

  const items = [
    { k: "Published", v: published || "—" },
    { k: "Views", v: views.toLocaleString() },
    ...(p.readable && p.content.trim() ? [{ k: "Reading time", v: `${readingMinutes(p.content)} min` }] : []),
    { k: "Expires", v: p.expiresAt ? (expiry ?? "—") : "Never" },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap gap-1.5">
        {p.encrypted && <Badge tone="info" icon="key" size="sm">End-to-end encrypted</Badge>}
        {expiry && <Badge tone="warning" icon="clock" size="sm">{expiry}</Badge>}
        {p.protection && <Badge icon="lock" size="sm">{p.protection === "private" ? "Private" : "Password"}</Badge>}
        {p.vscodeSynced && (
          <Badge size="sm" title="Published and synced from the VS Code extension">
            <VSCodeIcon size={12} /> Synced with VS Code
          </Badge>
        )}
        {p.live && <Badge tone="success" live size="sm" title="Changes made elsewhere appear here as they happen">Live</Badge>}
      </div>

      <section aria-labelledby="md-details-meta">
        <h2 id="md-details-meta" className="mb-1 text-eyebrow text-text-muted">Details</h2>
        <MetaList items={items} size="sm" />
      </section>

      {p.canShare && (
        <section aria-labelledby="md-details-access" className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 id="md-details-access" className="text-eyebrow text-text-muted">Access</h2>
            {p.access && (
              <AvatarGroup>
                <Avatar name={p.access.owner_name || p.access.owner_email || "Owner"} size="sm" />
                {grants.slice(0, 2).map((g) => <Avatar key={g.email} name={g.email.split("@")[0] || g.email} size="sm" neutral />)}
              </AvatarGroup>
            )}
          </div>
          {level && (
            <p className="flex items-center gap-2 text-caption text-text-secondary">
              <Icon name={level.icon} aria-hidden /> {level.text}
            </p>
          )}
          {grants.length > 0 && (
            <p className="flex items-center gap-2 text-caption text-text-secondary">
              <Icon name="user" aria-hidden /> {grants.length === 1 ? "1 person added by email" : `${grants.length} people added by email`}
            </p>
          )}
          <Button variant="secondary" size="sm" block onClick={p.onShare} iconLeft="userPlus">
            Share
          </Button>
        </section>
      )}

      {p.encrypted && p.readable && (
        <section aria-labelledby="md-details-e2e" className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4">
          <h2 id="md-details-e2e" className="flex items-center gap-2 text-body-strong text-text">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-accent-soft text-accent-text" aria-hidden>
              <Icon name="key" />
            </span>
            End-to-end encrypted
          </h2>
          <p className="text-caption text-text-secondary">
            Markdrop stores ciphertext it has no key for. The key is the part after the #, and
            browsers never send it to a server. <ReadMore topic="encryption" />
          </p>
          <KeyAnatomy url={p.url} fragment={p.keyFragment ? `#k=${p.keyFragment}` : undefined} layout="compact" />
        </section>
      )}

      {p.google}

      {p.onReport && (
        <Button variant="ghost" size="sm" iconLeft="flag" onClick={p.onReport} className="self-start text-text-muted">
          Report this document
        </Button>
      )}
    </div>
  );
}
