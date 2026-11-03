"use client";

/**
 * New page: a title, a template (the built-ins and Blank) with a preview, then POST /pages and the
 * editor. Used by the workspace and folder views ("New page"), a page ("Add a sub-page"), the
 * dashboard's Create menu (/pages/new) and the page editor.
 */
import { useEffect, useId, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, Dialog, Icon, Input, Skeleton } from "@/components/ui";
import { createPage, listPageTemplates, type CreatedPage, type PageTemplate } from "@/lib/pages";
import { fillTemplate } from "@/lib/pageBlocks.mjs";
import { track } from "@/lib/track";
import { PageRenderer } from "./PageRenderer";
import "./pages.css";

const BLANK: PageTemplate = { id: "blank", name: "Blank", description: "Start from an empty page", icon: "doc", category: "Basic", content: "" };

/** What the server knows how to draw as an icon; anything else is a document. */
const ICON_OK = new Set(["doc", "lines", "list", "checkSquare", "clipboard", "calendar", "zap", "megaphone", "users", "server", "terminal", "flag", "bulb", "sparkle", "layers", "message", "shield", "history", "key", "chart", "edit", "inbox"]);
const FALLBACK_ICON: Record<string, string> = { "feature-guide": "megaphone", "customer-howto": "bulb", "qa-test-plan": "checkSquare", prd: "clipboard", "meeting-notes": "calendar", runbook: "terminal", blank: "doc" };
const iconOf = (t: PageTemplate) => (ICON_OK.has(t.icon) ? t.icon : FALLBACK_ICON[t.id] ?? "doc");

/** Keep the edit secret of a page made here for this tab (the editor uses it, like /new does). */
export function rememberSecret(created: CreatedPage) {
  const s = created.edit_secret;
  if (!s) return;
  try {
    sessionStorage.setItem(`secret:${created.document.slug}`, s);
  } catch {
    /* storage blocked: the owner edits with their session anyway */
  }
}

export interface TemplateGalleryProps {
  open: boolean;
  onClose: () => void;
  /** File the page in a workspace (id) and folder (id). */
  workspace?: string | null;
  folder?: string | null;
  /** A sub-page of this page (slug): it lives with its parent and inherits its access. */
  parent?: string | null;
  parentTitle?: string | null;
  /** Where it goes, for the dialog's description ("In Acme › Guides"). */
  placeLabel?: React.ReactNode;
  /** Default: open the new page in the editor. */
  onCreated?: (created: CreatedPage) => void;
}

export function TemplateGallery({ open, onClose, workspace, folder, parent, parentTitle, placeLabel, onCreated }: TemplateGalleryProps) {
  const router = useRouter();
  const [templates, setTemplates] = useState<PageTemplate[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [chosen, setChosen] = useState<string>("blank");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    setError("");
    let live = true;
    listPageTemplates()
      .then((t) => live && setTemplates(t))
      .catch((e) => live && setLoadError(e instanceof Error ? e.message : "Couldn't load the templates."));
    return () => {
      live = false;
    };
  }, [open]);

  const all = useMemo(() => {
    const list = templates ?? [];
    return list.some((t) => t.id === "blank") ? [...list.filter((t) => t.id !== "blank"), list.find((t) => t.id === "blank")!] : [...list, BLANK];
  }, [templates]);
  const current = all.find((t) => t.id === chosen) ?? BLANK;
  const preview = useMemo(() => fillTemplate(current.content, { title: title.trim() || current.name }), [current, title]);

  async function create(e?: React.FormEvent) {
    e?.preventDefault();
    const name = title.trim() || (current.id === "blank" ? "Untitled" : current.name);
    setBusy(true);
    setError("");
    try {
      const created = await createPage({ title: name, workspace, folder, parent, template: current.id === "blank" ? null : current.id });
      rememberSecret(created);
      track("page_create", { template: current.id, sub_page: !!parent, workspace: !!workspace });
      if (onCreated) onCreated(created);
      else router.push(`/${encodeURIComponent(created.document.slug)}?edit=1`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the page. Try again.");
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      dismissible={!busy}
      size="xl"
      title={parent ? "New sub-page" : "New page"}
      description={
        parent ? (
          <>
            Inside <span className="ph-sensitive ph-mask">“{parentTitle || parent}”</span>. Who can read it follows that page until you change it.
          </>
        ) : (
          placeLabel ?? "A page you write with blocks: text, toggles, checklists, tables, images and your Markdrop files."
        )
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void create()} loading={busy} iconLeft="plus">
            Create page
          </Button>
        </>
      }
    >
      <form onSubmit={create} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={titleId} className="text-caption-strong text-text">
            Title
          </label>
          <Input id={titleId} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={current.id === "blank" ? "Untitled" : current.name} autoFocus className="ph-mask" maxLength={200} />
        </div>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex flex-col gap-2">
          <span className="text-caption-strong text-text" id={`${titleId}-t`}>
            Template
          </span>
          {loadError ? (
            <Alert tone="warning">{loadError} You can still start from a blank page.</Alert>
          ) : null}
          <div className="pb-templates" role="group" aria-labelledby={`${titleId}-t`}>
            {!templates && !loadError
              ? Array.from({ length: 6 }, (_, i) => <Skeleton key={i} variant="rect" height={96} />)
              : all.map((t) => (
                  <button key={t.id} type="button" className="pb-template md-focus" aria-pressed={t.id === chosen} onClick={() => setChosen(t.id)} onDoubleClick={() => { setChosen(t.id); void create(); }}>
                    <span className="pb-template__icon" aria-hidden>
                      <Icon name={iconOf(t)} />
                    </span>
                    <span className="pb-template__name">{t.name}</span>
                    <span className="pb-template__desc">{t.description}</span>
                  </button>
                ))}
          </div>
        </div>
        {current.content.trim() && (
          <div className="flex flex-col gap-2">
            <span className="text-caption-strong text-text">Preview</span>
            <div className="pb-template-preview" aria-label={`${current.name} preview`}>
              <PageRenderer slug="" content={preview} embeds={{}} />
            </div>
          </div>
        )}
      </form>
    </Dialog>
  );
}

export default TemplateGallery;
