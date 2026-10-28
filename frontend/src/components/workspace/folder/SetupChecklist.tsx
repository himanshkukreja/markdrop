"use client";

/**
 * A new workspace's first screen (NewWorkspace board): "Get set up" (Name ✓ · Invite your team · Add
 * your first file · Use your own domain, optional), dismissible and remembered per workspace on
 * this device, beside a big drop zone. Which workspaces count as new is `setupRule.ts`. Every step reads a fact the API already gives (member and
 * invitation counts, item counts, domains); nothing is tracked separately.
 */
import { useEffect, useState } from "react";
import { Button, Icon, Progress, cx } from "@/components/ui";
import { useUploads, type UploadTarget, hasFiles } from "@/components/workspace/uploads/UploadProvider";
import { accessLabel } from "./items";
import type { ItemAccess } from "@/lib/workspaces";

const KEY = (id: string) => `md_ws_setup_hidden:${id}`;

export function useChecklistHidden(workspaceId: string) {
  const [hidden, setHidden] = useState<boolean | null>(null);
  useEffect(() => {
    try { setHidden(localStorage.getItem(KEY(workspaceId)) === "1"); } catch { setHidden(false); }
  }, [workspaceId]);
  const hide = () => {
    setHidden(true);
    try { localStorage.setItem(KEY(workspaceId), "1"); } catch { /* storage unavailable: hidden for now */ }
  };
  return { hidden, hide };
}

export interface SetupStep {
  title: string;
  hint: string;
  done: boolean;
  cta?: string;
  onCta?: () => void;
}

export function SetupChecklist({ steps, onHide }: { steps: SetupStep[]; onHide: () => void }) {
  const done = steps.filter((s) => s.done).length;
  return (
    <section
      aria-labelledby="md-setup-h"
      className="flex min-w-0 flex-[1_1_340px] flex-col gap-3.5 rounded-xl border border-border bg-surface p-5 shadow-sm sm:max-w-[400px]"
    >
      <div className="flex items-center gap-2">
        <h2 id="md-setup-h" className="flex-1 text-h3 text-text">Get set up</h2>
        <span className="text-caption text-text-muted">{done} of {steps.length} done</span>
      </div>
      <Progress value={done} max={steps.length} size="sm" aria-label="Setup progress" valueText={`${done} of ${steps.length} done`} />
      <ol className="m-0 flex list-none flex-col p-0">
        {steps.map((s) => (
          <li key={s.title} className="flex items-start gap-3 border-t border-border py-2.5">
            <span
              aria-hidden
              className={cx(
                "mt-px grid size-5.5 shrink-0 place-items-center rounded-full border-[1.5px]",
                s.done ? "border-accent bg-accent text-on-accent" : "border-border-strong bg-transparent",
              )}
            >
              {s.done && <Icon name="check" size={12} />}
            </span>
            <div className="min-w-0 flex-1">
              <div className={cx("text-body-strong", s.done ? "text-text-muted line-through" : "text-text")}>
                {s.title}
                <span className="md-visually-hidden">{s.done ? " (done)" : " (to do)"}</span>
              </div>
              <div className="text-caption text-text-muted">{s.hint}</div>
            </div>
            {!s.done && s.cta && s.onCta && (
              <Button variant="secondary" size="sm" onClick={s.onCta}>{s.cta}</Button>
            )}
          </li>
        ))}
      </ol>
      <button type="button" onClick={onHide} className="md-focus cursor-pointer self-start rounded-sm bg-transparent p-0 text-caption text-text-muted hover:text-text">
        Hide this checklist
      </button>
    </section>
  );
}

/**
 * The big drop zone of an empty workspace or folder: drop files, or choose them, or write a
 * document, or make a folder. New items start as the folder's effective default (named here).
 */
export function DropArea({
  target, team, startsAs, newDocHref, onNewFolder, title = "Drop files here", className,
}: {
  target: UploadTarget | null;
  team: string;
  startsAs: ItemAccess;
  newDocHref: string;
  onNewFolder?: (() => void) | null;
  title?: string;
  className?: string;
}) {
  const uploads = useUploads();
  const [over, setOver] = useState(false);
  return (
    <section
      aria-label="Add files"
      onDragOver={(e) => { if (target && uploads && hasFiles(e)) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (!target || !uploads || !hasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        uploads.upload(Array.from(e.dataTransfer.files), target);
      }}
      className={cx(
        "flex min-h-90 min-w-0 flex-[999_1_420px] flex-col items-center justify-center gap-3.5 rounded-2xl border-2 border-dashed p-8 text-center transition-colors duration-(--duration-fast)",
        over ? "border-accent bg-accent-soft" : "border-border-strong bg-surface-inset",
        className,
      )}
    >
      <span aria-hidden className="grid size-14 place-items-center rounded-xl bg-accent-soft text-accent-text">
        <Icon name="upload" size={26} />
      </span>
      <h2 className="text-h3 text-text">{title}</h2>
      <p className="max-w-[380px] text-body text-text-secondary">
        Videos, PDFs, pages and documents. Each one gets a link right away, and new items start as{" "}
        <strong className="font-semibold text-text">{accessLabel(startsAs, team)}</strong>.
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        {target && uploads && (
          <Button variant="primary" iconLeft="upload" onClick={() => uploads.pick(target)}>Choose files</Button>
        )}
        <Button variant="secondary" iconLeft="edit" href={newDocHref}>Write a document</Button>
        {onNewFolder && <Button variant="ghost" iconLeft="folder" onClick={onNewFolder}>New folder</Button>}
      </div>
    </section>
  );
}
