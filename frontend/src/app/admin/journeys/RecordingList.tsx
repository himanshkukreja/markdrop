"use client";

import { useState } from "react";
import { Badge, EmptyState, Icon, cx } from "@/components/ui";
import type { Recording } from "./api";
import { ReplayPlayer } from "./ReplayPlayer";
import { Who, clock, fmtDate, pageName, plural } from "./bits";

/**
 * Session recordings, newest first. ▶ opens the replay inline under its row (one at a time).
 * Shared by the Recordings tab and the person page (`showWho={false}` there).
 */
export function RecordingList({ token, recordings, showWho = true, empty, emptyHint }: {
  token: string; recordings: Recording[]; showWho?: boolean; empty?: string; emptyHint?: string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  if (!recordings.length) {
    return (
      <EmptyState
        icon="film"
        title={empty || "No recordings"}
        description={emptyHint ?? "Replays appear here a minute or two after a session starts. They run only with consent, and never on document pages, invites or share links."}
      />
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {recordings.map((r) => {
        const on = open === r.id;
        const trail = r.pages.map((p) => pageName(p)).join(" → ") + (r.more_pages ? ` → +${r.more_pages}` : "");
        const startTitle = r.start_page ? pageName(r.start_page) : null;
        return (
          <li key={r.id} className={cx("min-w-0 rounded-xl border bg-surface transition-colors", on ? "border-accent" : "border-border")}>
            <div className="flex min-w-0 items-center gap-3 p-2.5 sm:p-3">
              <button
                type="button"
                onClick={() => setOpen(on ? null : r.id)}
                aria-expanded={on}
                aria-label={on ? "Close replay" : `Play recording from ${fmtDate(r.start, true)}`}
                className={cx(
                  "md-focus grid size-11 shrink-0 place-items-center rounded-lg border transition-colors",
                  on ? "border-accent bg-accent text-on-accent" : "border-border-strong bg-surface-inset text-text hover:border-accent hover:text-accent-text",
                )}
              >
                <Icon name={on ? "stop" : "play"} size={16} />
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-caption text-text">{fmtDate(r.start, true)}</span>
                  {r.ongoing && <Badge size="sm" tone="success" live>live</Badge>}
                  {!r.viewed && <Badge size="sm" tone="info">new</Badge>}
                  {r.rage > 0 && <Badge size="sm" tone="danger">{r.rage} rage</Badge>}
                  {r.dead > 0 && <Badge size="sm" tone="danger">{r.dead} dead</Badge>}
                  {r.errors > 0 && <Badge size="sm" tone="danger">{plural(r.errors, "error")}</Badge>}
                  {r.expires_soon && <Badge size="sm" tone="warning">expires soon</Badge>}
                </div>
                <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-micro text-text-secondary">
                  {showWho && <Who who={r.who} identified={r.identified} personId={r.person_id} className="max-w-56 text-micro" />}
                  {showWho && <span aria-hidden className="text-text-muted">·</span>}
                  <span>{plural(r.pageviews || r.pages.length, "page")}</span>
                  <span aria-hidden className="text-text-muted">·</span>
                  <span>{plural(r.clicks, "click")}</span>
                </div>
                <p className="mt-0.5 truncate font-mono text-micro text-text-muted" title={trail}>{trail || "—"}</p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-h3 font-bold tabular-nums text-text">{clock(r.duration)}</p>
                <p className="font-mono text-micro tabular-nums text-text-muted">{clock(r.active)} active</p>
              </div>
            </div>
            {on && (
              <div className="border-t border-border p-2">
                <ReplayPlayer token={token} id={r.id} title={startTitle} appUrl={r.app_url} onClose={() => setOpen(null)} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
