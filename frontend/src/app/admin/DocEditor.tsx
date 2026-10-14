"use client";

import { useEffect, useState } from "react";
import MarkdownPreview from "@/components/MarkdownPreview";
import { Alert, Breadcrumb, Button, EmptyState, Field, Input, Skeleton, Tabs, Textarea, useToast } from "@/components/ui";
import { adminGetDocument, adminUpdateDocument } from "@/lib/api";
import { isUnauthorized, useOnUnauthorized } from "./shared";

type Mode = "edit" | "split" | "preview";

/** Below 640px there's no room for two panes, so Split is disabled there. */
function useNarrow() {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

export function DocEditor({ token, slug, onBack }: { token: string; slug: string; onBack: () => void }) {
  const onUnauthorized = useOnUnauthorized();
  const toast = useToast();
  const narrow = useNarrow();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "missing" | "encrypted">("loading");
  const [mode, setMode] = useState<Mode>("split");
  const [saving, setSaving] = useState(false);
  const view: Mode = narrow && mode === "split" ? "edit" : mode;

  useEffect(() => {
    let live = true;
    adminGetDocument(token, slug)
      .then((d) => {
        if (!live) return;
        if (d.encrypted) { setState("encrypted"); return; }
        setTitle(d.title ?? "");
        setContent(d.content);
        setState("ready");
      })
      .catch((e) => { if (!live) return; if (isUnauthorized(e)) onUnauthorized(); else setState("missing"); });
    return () => { live = false; };
  }, [token, slug, onUnauthorized]);

  const save = async () => {
    setSaving(true);
    try {
      await adminUpdateDocument(token, slug, title, content);
      toast.success("Saved");
    } catch (e) {
      if (isUnauthorized(e)) { onUnauthorized(); return; }
      toast.error("Couldn't save. Your text is still here — try again.");
    } finally {
      setSaving(false);
    }
  };

  const crumbs = (
    <Breadcrumb items={[
      { label: <button type="button" onClick={onBack} className="md-focus cursor-pointer rounded-sm text-text-secondary hover:text-text">Documents</button> },
      { label: <span className="font-mono">/{slug}</span> },
    ]} />
  );

  if (state !== "ready") {
    return (
      <div className="flex flex-col gap-6">
        {crumbs}
        <h1 className="text-h1 text-text">Edit document</h1>
        {state === "loading" ? (
          <div className="flex flex-col gap-3" aria-busy="true"><span className="md-visually-hidden">Loading document</span><Skeleton variant="rect" height={40} /><Skeleton variant="rect" height={320} /></div>
        ) : (
          <EmptyState
            icon={state === "encrypted" ? "key" : "alertCircle"}
            title={state === "encrypted" ? "This document is encrypted" : "Couldn't open this document"}
            description={state === "encrypted"
              ? "Markdrop stores ciphertext it has no key for, so it can't be edited here. Delete and expiry still work from the list."
              : "It may have been deleted or expired. Go back to the list and refresh."}
            actions={<Button variant="secondary" iconLeft="arrowLeft" onClick={onBack}>Back to documents</Button>}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {crumbs}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="min-w-0 text-h1 text-text">Edit document</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Tabs
            variant="pill"
            aria-label="Editor layout"
            value={view}
            onChange={(v) => setMode(v as Mode)}
            items={[
              { value: "edit", label: "Edit" },
              { value: "split", label: "Split", disabled: narrow },
              { value: "preview", label: "Preview" },
            ]}
          />
          <Button variant="secondary" iconLeft="external" href={`/${slug}`} target="_blank" rel="noopener noreferrer">Open</Button>
          <Button variant="primary" loading={saving} onClick={save}>Save changes</Button>
        </div>
      </div>
      <Alert tone="info">Admin edits don&apos;t notify open readers. They see the change on their next load.</Alert>
      <Field label="Title">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Untitled" dir="auto" />
      </Field>
      <div className={`grid min-w-0 gap-3 ${view === "split" ? "grid-cols-2" : "grid-cols-1"}`}>
        {view !== "preview" && (
          <Textarea
            mono
            aria-label="Markdown"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
            className="min-h-[60vh] min-w-0 resize-y"
          />
        )}
        {view !== "edit" && (
          <div className="min-h-[60vh] min-w-0 rounded-xl border border-border bg-surface p-4" aria-label="Preview" role="region">
            <MarkdownPreview content={content} />
          </div>
        )}
      </div>
    </div>
  );
}
