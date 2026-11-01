"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, ConfirmDialog, Dropdown, IconButton, Skeleton, useToast } from "@/components/ui";
import { docsErrorMessage, presetName, type SiteTheme } from "@/lib/docsSites";
import {
  createThemeTemplate, deleteThemeTemplate, duplicateThemeTemplate, isEmptyCustom, listThemeTemplates, parseTemplateFile,
  templateFile, templateTheme, updateThemeTemplate, type TemplateTheme, type ThemeTemplate,
} from "@/lib/guideThemes";
import { effectiveColors } from "./model";
import { SaveTemplateDialog } from "./ThemeBuilder";

/** A workspace's saved designs (or a person's, for a personal guide), with the calls that change them. */
export function useThemeTemplates(workspaceId: string | null) {
  const [list, setList] = useState<ThemeTemplate[] | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [limit, setLimit] = useState(50);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    try {
      const out = await listThemeTemplates(workspaceId);
      setList(out.templates);
      setCanEdit(out.can_edit);
      setLimit(out.limit);
      setError("");
    } catch (e) {
      setError(docsErrorMessage(e, "Your templates didn't load."));
      setList([]);
    }
  }, [workspaceId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const create = useCallback(async (name: string, theme: TemplateTheme) => {
    const made = await createThemeTemplate({ workspace_id: workspaceId, name, theme });
    setList((l) => [made, ...(l ?? [])]);
    return made;
  }, [workspaceId]);
  return { list, canEdit, limit, error, reload, create, setList };
}

/** The template's own colours (light), for its card. */
function swatches(t: TemplateTheme) {
  const eff = effectiveColors({ ...t, brand: { enabled: false, colors: [] } } as SiteTheme);
  return { bg: eff.light.bg, card: eff.light.surface, accent: eff.light.accent, text: eff.light.text, line: eff.light.border, dark: eff.dark.bg, darkAccent: eff.dark.accent };
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "theme"}.markdrop-theme.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * "Your templates" in the Design panel, next to the presets: saved designs for every guide of the
 * workspace. Choosing one loads it into the draft (the guide's logo and brand colours stay); the
 * guide changes when the design is saved and published, as with any design change.
 */
export function TemplatesSection({ templates, theme, onApply, canApply, scopeLabel }: {
  templates: ReturnType<typeof useThemeTemplates>;
  theme: SiteTheme;
  onApply: (t: ThemeTemplate) => void;
  canApply: boolean;
  scopeLabel: string;
}) {
  const { list, canEdit, limit, error, setList, create } = templates;
  const toast = useToast();
  const [renaming, setRenaming] = useState<ThemeTemplate | null>(null);
  const [deleting, setDeleting] = useState<ThemeTemplate | null>(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const full = (list?.length ?? 0) >= limit;

  async function onImport(file: File | undefined) {
    if (!file) return;
    try {
      const { name, theme: t } = parseTemplateFile(await file.text());
      let n = name;
      for (let i = 2; list?.some((x) => x.name.toLowerCase() === n.toLowerCase()); i++) n = `${name} ${i}`;
      await create(n, t);
      toast.success(`Imported "${n}".`);
    } catch (e) {
      toast.error(e instanceof Error && !(e as { status?: number }).status ? e.message : docsErrorMessage(e, "That theme didn't import."));
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <section aria-labelledby="your-templates-h" className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <h2 id="your-templates-h" className="flex-1 text-[15px] font-semibold text-text">Your templates</h2>
        {canEdit && (
          <>
            <input ref={fileRef} type="file" accept="application/json,.json" className="md-visually-hidden" tabIndex={-1} aria-hidden onChange={(e) => void onImport(e.target.files?.[0])} />
            <Button variant="ghost" size="sm" iconLeft="upload" disabled={full} onClick={() => fileRef.current?.click()}>Import</Button>
            <Button
              variant="secondary"
              size="sm"
              iconLeft="plus"
              disabled={full || saving}
              loading={saving}
              onClick={() => setRenaming({ id: "", name: "", workspace_id: null, theme: templateTheme(theme) })}
            >
              Save current
            </Button>
          </>
        )}
      </div>
      <p className="text-[12.5px] text-text-muted">Designs saved for {scopeLabel}. Choose one to load it; the guide keeps its own logo and brand colours.</p>
      {error && <p className="text-[12.5px] text-danger">{error}</p>}
      {list === null ? (
        <div className="grid grid-cols-2 gap-2.5"><Skeleton variant="rect" height={112} /><Skeleton variant="rect" height={112} /></div>
      ) : list.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-strong px-4 py-5 text-center text-[13px] text-text-secondary">
          No templates yet. Make a design in <strong>Customize</strong>, then save it as a template to use it on other guides.
        </div>
      ) : (
        <ul className="grid grid-cols-2 gap-2.5">
          {list.map((t) => {
            const s = swatches(t.theme);
            const custom = !isEmptyCustom(t.theme.custom);
            return (
              <li key={t.id} className="group relative flex flex-col overflow-hidden rounded-lg border border-border bg-surface">
                <button
                  type="button"
                  className="md-focus flex flex-col text-left disabled:cursor-default"
                  disabled={!canApply}
                  onClick={() => onApply(t)}
                  aria-label={`Use the template ${t.name}`}
                >
                  <span aria-hidden className="flex h-[58px] gap-1.5 p-2" style={{ background: s.bg }}>
                    <span className="flex flex-1 flex-col gap-1 rounded-md border p-1.5" style={{ background: s.card, borderColor: s.line }}>
                      <span className="block h-1.5 w-10 rounded-full" style={{ background: s.text }} />
                      <span className="block h-1 w-14 rounded-full opacity-40" style={{ background: s.text }} />
                      <span className="mt-auto block h-2.5 w-8 rounded-[3px]" style={{ background: s.accent }} />
                    </span>
                    <span className="flex w-7 flex-col gap-1 rounded-md p-1" style={{ background: s.dark }}>
                      <span className="block h-1 w-full rounded-full opacity-60" style={{ background: s.darkAccent }} />
                      <span className="block h-1 w-3/4 rounded-full opacity-30" style={{ background: s.darkAccent }} />
                    </span>
                  </span>
                  <span className="flex flex-col gap-0.5 px-2.5 pb-2.5 pt-2 pr-9">
                    <span className="ph-sensitive truncate text-[13px] font-semibold text-text" title={t.name}>{t.name}</span>
                    <span className="flex items-center gap-1.5 text-[12px] text-text-muted">
                      {presetName(t.theme.preset)}
                      {custom && <Badge size="sm" tone="neutral">Custom</Badge>}
                    </span>
                  </span>
                </button>
                <span className="absolute bottom-2 right-1.5">
                  <Dropdown
                    portal
                    aria-label={`${t.name}: more`}
                    trigger={<IconButton icon="more" label={`More for ${t.name}`} size="sm" />}
                    items={[
                      { label: "Use this design", icon: "check", disabled: !canApply, onClick: () => onApply(t) },
                      { label: "Rename", icon: "edit", disabled: !canEdit, onClick: () => setRenaming(t), separated: true },
                      {
                        label: "Duplicate", icon: "copy", disabled: !canEdit || full, onClick: () => {
                          void duplicateThemeTemplate(t.id).then((d) => {
                            setList((l) => [d, ...(l ?? [])]);
                            toast.success(`Made "${d.name}".`);
                          }).catch((e) => toast.error(docsErrorMessage(e)));
                        },
                      },
                      { label: "Update with current design", icon: "refresh", disabled: !canEdit, onClick: () => {
                        void updateThemeTemplate(t.id, { theme: templateTheme(theme) }).then((u) => {
                          setList((l) => (l ?? []).map((x) => (x.id === u.id ? u : x)));
                          toast.success(`"${u.name}" now has this design.`);
                        }).catch((e) => toast.error(docsErrorMessage(e)));
                      } },
                      { label: "Export as JSON", icon: "download", onClick: () => download(t.name, templateFile(t.name, t.theme)) },
                      { label: "Delete", icon: "trash", danger: true, disabled: !canEdit, onClick: () => setDeleting(t), separated: true },
                    ]}
                  />
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {full && canEdit && <p className="text-[12px] text-text-muted">{limit} templates is the most. Delete one to save another.</p>}
      <SaveTemplateDialog
        open={!!renaming}
        onClose={() => setRenaming(null)}
        initial={renaming?.name ?? ""}
        title={renaming?.id ? "Rename template" : "Save as template"}
        onSave={async (name) => {
          if (!renaming) return;
          setSaving(true);
          try {
            if (renaming.id) {
              const u = await updateThemeTemplate(renaming.id, { name });
              setList((l) => (l ?? []).map((x) => (x.id === u.id ? u : x)));
            } else {
              await create(name, renaming.theme);
              toast.success(`Saved "${name}" to your templates.`);
            }
          } catch (e) {
            throw new Error(docsErrorMessage(e, "That didn't save. Try again."));
          } finally {
            setSaving(false);
          }
        }}
      />
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={`Delete "${deleting?.name ?? ""}"?`}
        body="Guides that use this design keep it; only the template goes. This can't be undone."
        confirmLabel="Delete template"
        onConfirm={async () => {
          if (!deleting) return;
          await deleteThemeTemplate(deleting.id);
          setList((l) => (l ?? []).filter((x) => x.id !== deleting.id));
          setDeleting(null);
        }}
      />
    </section>
  );
}

