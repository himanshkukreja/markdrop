"use client";

/**
 * Use as template (a page's ⋯ menu; "Save as template" before): a copy of the page, and if asked the sub-pages you can open,
 * becomes a template in the page's workspace (members and up) or one of your own. Name,
 * description and an emoji; then it's in the New page gallery. Opening the template edits it.
 */
import { useEffect, useId, useState } from "react";
import { Alert, Button, Dialog, Input, SegmentedControl, Switch, Textarea, useToast } from "@/components/ui";
import { listTemplates, saveAsTemplate, TEMPLATE_EMOJI, type TemplateScope, type UserTemplate } from "./api";
import "./templates.css";

export interface SaveTemplateDialogProps {
  open: boolean;
  onClose: () => void;
  slug: string;
  title: string | null;
  /** The page's workspace (its templates are offered there), if any. */
  workspaceId?: string | null;
  workspaceName?: string | null;
  /** Sub-pages the page has (offers "Include sub-pages"). */
  childrenCount?: number;
  /** The page's own icon, when it's an emoji. */
  pageIcon?: string | null;
}

export function SaveTemplateDialog({ open, onClose, slug, title, workspaceId, workspaceName, childrenCount = 0, pageIcon }: SaveTemplateDialogProps) {
  const toast = useToast();
  const id = useId();
  const [name, setName] = useState(title?.trim() || "");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState(pageIcon && !pageIcon.startsWith("asset:") ? pageIcon : "📝");
  const [subpages, setSubpages] = useState(childrenCount > 0);
  const [canWs, setCanWs] = useState<boolean | null>(workspaceId ? null : false);
  const [wsLabel, setWsLabel] = useState(workspaceName || "Workspace");
  const [scope, setScope] = useState<TemplateScope>(workspaceId ? "workspace" : "personal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<UserTemplate | null>(null);

  // Whether this person may add to the workspace's templates (members and up).
  useEffect(() => {
    if (!open || !workspaceId) return;
    let live = true;
    listTemplates(workspaceId)
      .then((l) => {
        if (!live) return;
        setCanWs(l.can_save_workspace);
        if (!l.can_save_workspace) setScope("personal");
      })
      .catch(() => live && (setCanWs(false), setScope("personal")));
    if (!workspaceName) {
      import("@/lib/workspaces")
        .then((m) => m.getWorkspace(workspaceId))
        .then((w) => live && w?.name && setWsLabel(w.name))
        .catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [open, workspaceId, workspaceName]);

  async function save(e?: React.FormEvent) {
    e?.preventDefault();
    e?.stopPropagation();
    setBusy(true);
    setError("");
    try {
      const t = await saveAsTemplate(slug, {
        name: name.trim() || undefined,
        description: description.trim() || undefined,
        icon: icon.trim() || null,
        include_subpages: subpages && childrenCount > 0,
        scope,
        workspace: scope === "workspace" ? workspaceId : null,
      });
      setSaved(t);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the template. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (saved) {
    const where = saved.scope === "workspace" ? `everyone in ${wsLabel}` : "you";
    return (
      <Dialog
        open={open}
        onClose={onClose}
        size="sm"
        title="Template saved"
        footer={
          <>
            <Button variant="ghost" href={`/${encodeURIComponent(saved.slug)}?edit=1`} iconLeft="edit">
              Edit template
            </Button>
            <Button variant="primary" onClick={() => { toast.success(`“${saved.name}” is in the New page gallery`); onClose(); }}>
              Done
            </Button>
          </>
        }
      >
        <div className="tpl-done" data-testid="tpl-saved">
          <span className="tpl-done__badge" aria-hidden>{saved.icon || "📝"}</span>
          <span className="tpl-done__title ph-mask">{saved.name}</span>
          <span className="tpl-done__body">
            It&rsquo;s in the New page gallery for {where}
            {saved.subpages ? `, with ${saved.subpages} sub-page${saved.subpages === 1 ? "" : "s"}` : ""}. Changing this page later doesn&rsquo;t change the template: edit the template itself.
          </span>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      dismissible={!busy}
      size="md"
      title="Use as template"
      description="Saves a copy of this page that new pages start from, in New page and Add a sub-page."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} loading={busy} disabled={canWs === null && scope === "workspace"} iconLeft="layers">
            Save template
          </Button>
        </>
      }
    >
      <form onSubmit={save} className="flex flex-col gap-4">
        {error && <Alert tone="danger">{error}</Alert>}
        {workspaceId && canWs !== false && (
          <div className="flex flex-col gap-1.5">
            <span className="text-caption-strong text-text" id={`${id}-s`}>Who can use it</span>
            <SegmentedControl<TemplateScope>
              aria-labelledby={`${id}-s`}
              value={scope}
              onChange={setScope}
              block
              disabled={canWs === null}
              options={[
                { value: "workspace", label: `Everyone in ${wsLabel}`, icon: "users" },
                { value: "personal", label: "Just me", icon: "user" },
              ]}
            />
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-n`} className="text-caption-strong text-text">Name</label>
          <Input id={`${id}-n`} value={name} onChange={(e) => setName(e.target.value)} placeholder={title?.trim() || "Untitled template"} maxLength={120} autoFocus className="ph-mask" />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-d`} className="text-caption-strong text-text">
            Description <span className="font-normal text-text-secondary">(optional)</span>
          </label>
          <Textarea id={`${id}-d`} value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={300} placeholder="What it's for, when to use it" className="ph-mask" />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-caption-strong text-text" id={`${id}-i`}>Icon</span>
          <div className="tpl-emoji" role="group" aria-labelledby={`${id}-i`}>
            {TEMPLATE_EMOJI.map((e) => (
              <button key={e} type="button" className="tpl-emoji__btn md-focus" aria-pressed={icon === e} aria-label={e} onClick={() => setIcon(e)}>
                {e}
              </button>
            ))}
            <Input aria-label="Another emoji" value={TEMPLATE_EMOJI.includes(icon) ? "" : icon} onChange={(e) => setIcon(e.target.value)} placeholder="Other" maxLength={8} className="tpl-emoji__custom" />
          </div>
        </div>
        {childrenCount > 0 && (
          <Switch
            label={`Include its ${childrenCount} sub-page${childrenCount === 1 ? "" : "s"} (the ones you can open)`}
            checked={subpages}
            onChange={() => setSubpages(!subpages)}
          />
        )}
        <p className="tpl-hint">
          Write <code>{"{{title}}"}</code>, <code>{"{{date}}"}</code>, <code>{"{{author}}"}</code> or <code>{"{{folder}}"}</code> in the page: each new page gets its title, the day it was made, who made it and its folder there. Images are copied with it.
        </p>
      </form>
    </Dialog>
  );
}

export default SaveTemplateDialog;
