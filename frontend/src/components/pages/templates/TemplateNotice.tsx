"use client";

/**
 * Above a template page (DocumentView's notices, loaded only for one): "This is a template" with
 * what its placeholders do, "New page from it" and "Manage templates". A template's sub-pages say
 * they belong to one.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, useToast } from "@/components/ui";
import { createPage } from "@/lib/pages";
import { listTemplates, type TemplateListing } from "./api";
import { ManageTemplatesDialog } from "./ManageTemplatesDialog";
import "./templates.css";

export interface PageTemplateInfo {
  id?: string;
  description?: string;
  icon?: string | null;
  scope?: "workspace" | "personal";
  part_of?: boolean;
}

export function TemplateNotice({ template, title, workspaceId }: { template: PageTemplateInfo; title?: string | null; workspaceId?: string | null }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [manage, setManage] = useState<TemplateListing | null>(null);

  if (template.part_of) {
    return (
      <div className="tpl-notice no-print" role="note">
        <span className="tpl-notice__icon" aria-hidden>🧩</span>
        <span className="tpl-notice__body">
          <span className="tpl-notice__title">Part of a template</span>
          Pages made from the template get a copy of this sub-page.
        </span>
      </div>
    );
  }

  async function makePage() {
    if (!template.id) return;
    setBusy(true);
    try {
      const made = await createPage({ title: title?.trim() || "Untitled", template: template.id, workspace: template.scope === "workspace" ? workspaceId : null });
      router.push(`/${encodeURIComponent(made.document.slug)}?edit=1`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't make the page.");
      setBusy(false);
    }
  }

  async function openManage() {
    try {
      setManage(await listTemplates(template.scope === "workspace" ? workspaceId : null));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't load the templates.");
    }
  }

  return (
    <>
      <div className="tpl-notice no-print" role="note" data-testid="tpl-notice">
        <span className="tpl-notice__icon" aria-hidden>{template.icon || "📝"}</span>
        <span className="tpl-notice__body">
          <span className="tpl-notice__title">
            {template.scope === "workspace" ? "A workspace template" : "Your template"}
          </span>
          New pages made from it start as a copy of this one, with {"{{date}}"}, {"{{author}}"} and {"{{title}}"} filled in. It never shows up in lists or search.
        </span>
        <span className="tpl-notice__actions">
          <Button size="sm" variant="secondary" iconLeft="plus" loading={busy} onClick={() => void makePage()}>
            New page from it
          </Button>
          <Button size="sm" variant="ghost" iconLeft="settings" onClick={() => void openManage()}>
            Manage templates
          </Button>
        </span>
      </div>
      {manage && (
        <ManageTemplatesDialog
          open
          listing={manage}
          onClose={() => setManage(null)}
          onChanged={(next) => {
            setManage(next);
            if (template.id && ![...next.workspace, ...next.personal].some((t) => t.id === template.id)) router.push("/dashboard");
          }}
        />
      )}
    </>
  );
}

export default TemplateNotice;
