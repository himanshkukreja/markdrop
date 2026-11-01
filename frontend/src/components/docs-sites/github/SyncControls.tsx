"use client";

import { useId } from "react";
import { RadioGroup, Spinner, Switch, cx } from "@/components/ui";
import { MODE_COPY, type GithubSyncMode } from "@/lib/docsGithub";

/**
 * "Keep in sync" and what a push does (Update drafts / Publish automatically). Used when choosing a
 * repository (new guide, Settings › GitHub › Connect) and on a connected guide's settings.
 * `unavailable`: why syncing can't be switched on (a public repository read without the app…):
 * the switch is off and disabled, with the reason under it.
 */
export function SyncControls({ sync, mode, onSync, onMode, branch, unavailable, disabled, saving, className }: {
  sync: boolean;
  mode: GithubSyncMode;
  onSync: (on: boolean) => void;
  onMode: (mode: GithubSyncMode) => void;
  /** The branch pushes come from, for the hint. */
  branch?: string | null;
  unavailable?: React.ReactNode;
  disabled?: boolean;
  /** What is being saved right now ("sync" / "mode"), for a spinner beside it. */
  saving?: "" | "sync" | "mode";
  className?: string;
}) {
  const uid = useId();
  const on = sync && !unavailable;
  return (
    <div className={cx("flex min-w-0 flex-col gap-3", className)}>
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <div id={`${uid}-t`} className="text-body-strong text-text">Keep in sync</div>
          <div id={`${uid}-h`} className="text-caption text-text-muted">
            {unavailable ?? (
              <>Each push to {branch ? <code className="ph-sensitive ph-mask font-mono">{branch}</code> : "the branch"} updates the guide. Pages you add in the studio are never touched.</>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          {saving === "sync" && <Spinner size={14} label="Saving" />}
          <Switch
            checked={on}
            disabled={disabled || !!unavailable}
            aria-labelledby={`${uid}-t`}
            aria-describedby={`${uid}-h`}
            onChange={(e) => onSync(e.target.checked)}
          />
        </div>
      </div>
      {on && (
        <div className="flex min-w-0 flex-col gap-2 border-t border-border pt-3">
          <div className="flex items-center gap-2">
            <span id={`${uid}-m`} className="text-body-strong text-text">When you push</span>
            {saving === "mode" && <Spinner size={14} label="Saving" />}
          </div>
          <RadioGroup
            name={`${uid}-mode`}
            aria-labelledby={`${uid}-m`}
            value={mode}
            onChange={(v) => onMode(v as GithubSyncMode)}
            options={(Object.keys(MODE_COPY) as GithubSyncMode[]).map((m) => ({ value: m, label: MODE_COPY[m].label, description: MODE_COPY[m].body, disabled }))}
          />
        </div>
      )}
    </div>
  );
}

export default SyncControls;
