"use client";

import { Badge } from "@/components/ui";
import type { GithubLink, GithubSync } from "@/lib/docsGithub";
import { num } from "../format";

/** The worker's steps for a GitHub import or sync, in order (progress.step names one; docs-platform/runner). */
export const GITHUB_STEPS: Array<{ id: string; running: string; done: string }> = [
  { id: "fetch", running: "Downloading the repository", done: "Downloaded the repository" },
  { id: "convert", running: "Converting pages", done: "Converted pages" },
  { id: "upload", running: "Copying images and files", done: "Copied images and files" },
  { id: "save", running: "Saving as drafts", done: "Saved as drafts" },
];

/** The running step's words, for a one-line progress ("Converting pages · 34 of 93"). */
export function stepWords(step: string | number | null | undefined): string {
  const s = GITHUB_STEPS.find((d) => d.id === step) ?? (typeof step === "number" ? GITHUB_STEPS[step - 1] : undefined);
  return s?.running ?? "Syncing";
}

/** The link's state: synced, waiting, syncing, failed (or off when syncing is turned off). */
export function LinkStatusBadge({ link }: { link: Pick<GithubLink, "status" | "sync" | "last_synced_at"> }) {
  if (link.status === "syncing") return <Badge tone="info" size="sm" live>Syncing</Badge>;
  if (link.status === "queued") return <Badge tone="neutral" size="sm" dot>Waiting to sync</Badge>;
  if (link.status === "error") return <Badge tone="danger" size="sm" dot>Sync failed</Badge>;
  if (!link.sync) return <Badge tone="neutral" size="sm">Sync off</Badge>;
  return <Badge tone="success" size="sm" dot>{link.last_synced_at ? "In sync" : "Connected"}</Badge>;
}

export function SyncStatusBadge({ s }: { s: Pick<GithubSync, "status"> }) {
  const map = {
    queued: { tone: "neutral" as const, text: "Waiting" },
    running: { tone: "info" as const, text: "Syncing" },
    done: { tone: "success" as const, text: "Synced" },
    failed: { tone: "danger" as const, text: "Failed" },
  }[s.status] ?? { tone: "neutral" as const, text: s.status };
  return <Badge tone={map.tone} size="sm" dot live={s.status === "running"}>{map.text}</Badge>;
}

/** What started a sync, in words. */
export function triggerWords(s: Pick<GithubSync, "trigger" | "pusher">): string {
  if (s.trigger === "push") return s.pusher ? `Push by ${s.pusher}` : "Push";
  if (s.trigger === "manual") return "Sync now";
  if (s.trigger === "connect") return "Connected";
  return "First import";
}

/** "3 new · 5 updated · 1 removed", or "No page changes". */
export function pagesWords(p: GithubSync["pages"]): string {
  if (!p) return "—";
  const parts = [p.created && `${num(p.created)} new`, p.updated && `${num(p.updated)} updated`, p.deleted && `${num(p.deleted)} removed`].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No page changes";
}
