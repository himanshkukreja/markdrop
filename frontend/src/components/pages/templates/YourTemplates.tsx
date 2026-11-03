"use client";

/**
 * The New page gallery's own templates (TemplateGallery renders this above the built-ins): the
 * workspace's ("Acme") for its members, then yours. Hovering or focusing a card fetches its
 * Markdown, so choosing it shows the preview at once; "Manage" opens Manage templates.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Icon, Select, Skeleton, Spinner, useToast } from "@/components/ui";
import { useAuth } from "@/contexts/AuthContext";
import type { AssetUrl, PageTemplate } from "@/lib/pages";
import { fillAuthor, getTemplate, listTemplates, setFolderDefault, type TemplateListing, type UserTemplate } from "./api";
import { ManageTemplatesDialog } from "./ManageTemplatesDialog";
import { TemplateEmoji } from "./TemplateEmoji";
import "./templates.css";

/** A chosen template, in the gallery's shape (its preview needs the template's own images). */
export type ChosenTemplate = PageTemplate & { assets?: Record<string, AssetUrl> };

export interface YourTemplatesProps {
  open: boolean;
  workspace?: string | null;
  /** The folder the new page goes in (id): its default template is chosen at first. */
  folder?: string | null;
  workspaceName?: string | null;
  chosen: string;
  onChoose: (t: ChosenTemplate | null) => void;
  /** Double-click: choose and create at once (with that template). */
  onCreate?: (t: ChosenTemplate) => void;
}

export function YourTemplates({ open, workspace, folder, workspaceName, chosen, onChoose, onCreate }: YourTemplatesProps) {
  const { user } = useAuth();
  const toast = useToast();
  const appliedDefault = useRef(false);
  const [list, setList] = useState<TemplateListing | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);
  const [manage, setManage] = useState(false);
  const author = user?.name?.trim() || user?.email?.split("@")[0] || "You";

  const reload = useCallback(() => {
    if (!user) return;
    listTemplates(workspace, folder)
      .then((l) => {
        setList(l);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [user, workspace, folder]);

  useEffect(() => {
    if (open) reload();
  }, [open, reload]);

  const folderName = list?.folder?.name ?? null;
  const choose = async (t: UserTemplate, thenCreate = false) => {
    setLoading(t.id);
    // Chosen at once (the title's placeholder, the Create button); the preview follows.
    onChoose({ id: t.id, name: t.name, description: t.description, icon: "layers", category: "", content: "" });
    try {
      const full = await getTemplate(t.id);
      const picked: ChosenTemplate = { id: t.id, name: t.name, description: t.description, icon: "layers", category: "", content: fillAuthor(full.content, author, folderName ?? ""), assets: full.assets };
      onChoose(picked);
      if (thenCreate) onCreate?.(picked);
    } catch {
      /* the preview stays empty; creating still works */
    } finally {
      setLoading(null);
    }
  };

  // New page in a folder with a default template starts from it (once; the person can pick another).
  useEffect(() => {
    const def = list?.folder?.default_template;
    if (!list || !def || appliedDefault.current || chosen !== "blank") return;
    appliedDefault.current = true;
    const builtin = list.builtin.find((b) => b.id === def);
    if (builtin) onChoose({ ...builtin, content: fillAuthor(builtin.content, author, folderName ?? "") });
    else {
      const t = [...list.workspace, ...list.personal].find((x) => x.id === def);
      if (t) void choose(t);
    }
  }, [list]); // eslint-disable-line react-hooks/exhaustive-deps

  async function changeDefault(value: string) {
    if (!list?.folder || !workspace) return;
    try {
      const out = await setFolderDefault(workspace, list.folder.id, value || null);
      setList({ ...list, folder: { ...list.folder, default_template: out.default_template } });
      toast.success(out.default_template ? `New pages in ${list.folder.name} start from it` : `New pages in ${list.folder.name} start blank`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't change the folder's default.");
    }
  }

  if (!user || failed) return null;
  if (!list) {
    return (
      <div className="tpl-sec" aria-hidden>
        <Skeleton variant="text" width={120} />
        <div className="pb-templates">
          <Skeleton variant="rect" height={96} />
          <Skeleton variant="rect" height={96} />
        </div>
      </div>
    );
  }

  const wsName = workspaceName || "Your workspace";
  const showWs = !!list.workspace_id && (list.workspace.length > 0 || list.can_save_workspace);
  const hasFolderLine = !!list.folder?.can_set_default || !!list.folder?.default_template;
  const canManageAny = [...list.workspace, ...list.personal].some((t) => t.can_manage) || list.can_reorder_workspace;
  if (!showWs && list.personal.length === 0 && !hasFolderLine) return null;

  const card = (t: UserTemplate) => (
    <button
      key={t.id}
      type="button"
      className="pb-template tpl-card md-focus"
      aria-pressed={t.id === chosen}
      onMouseEnter={() => void getTemplate(t.id).catch(() => {})}
      onFocus={() => void getTemplate(t.id).catch(() => {})}
      onClick={() => void choose(t)}
      onDoubleClick={() => void choose(t, true)}
    >
      <TemplateEmoji t={t} />
      <span className="pb-template__name ph-mask">{t.name}</span>
      {t.description ? <span className="pb-template__desc tpl-card__desc ph-mask">{t.description}</span> : null}
      <span className="tpl-card__foot">
        {t.subpages > 0 && (
          <>
            <Icon name="listTree" />
            {t.subpages} sub-page{t.subpages === 1 ? "" : "s"}
            {t.created_by ? " · " : ""}
          </>
        )}
        {t.created_by ? <span className="ph-mask">{t.scope === "personal" ? "Only you" : t.created_by}</span> : t.scope === "personal" ? "Only you" : null}
      </span>
      {loading === t.id && <span className="tpl-card__loading"><Spinner /></span>}
    </button>
  );

  return (
    <>
      {showWs && (
        <div className="tpl-sec" data-testid="tpl-workspace">
          <div className="tpl-sec__head">
            <span className="tpl-sec__title">
              <Icon name="users" />
              <span className="ph-mask">{wsName}</span>
              {list.workspace.length > 0 && <span className="tpl-sec__count">{list.workspace.length}</span>}
            </span>
            <span className="tpl-sec__spacer" />
            {canManageAny && (
              <Button size="sm" variant="ghost" iconLeft="settings" onClick={() => setManage(true)}>
                Manage
              </Button>
            )}
          </div>
          {list.workspace.length > 0 ? (
            <div className="pb-templates">{list.workspace.map(card)}</div>
          ) : (
            <div className="tpl-empty">
              <Icon name="layers" />
              <span>
                No templates in {wsName} yet. Open any page and choose <strong>Use as template</strong> from its ⋯ menu: everyone in {wsName} can then start from it here.
              </span>
            </div>
          )}
        </div>
      )}
      {list.personal.length > 0 && (
        <div className="tpl-sec" data-testid="tpl-personal">
          <div className="tpl-sec__head">
            <span className="tpl-sec__title">
              <Icon name="user" />
              Your templates
              <span className="tpl-sec__count">{list.personal.length}</span>
            </span>
            <span className="tpl-sec__spacer" />
            {!showWs && canManageAny && (
              <Button size="sm" variant="ghost" iconLeft="settings" onClick={() => setManage(true)}>
                Manage
              </Button>
            )}
          </div>
          <div className="pb-templates">{list.personal.map(card)}</div>
        </div>
      )}
      {list.folder?.can_set_default && (
        <div className="tpl-default" data-testid="tpl-folder-default">
          <Icon name="folder" />
          <label htmlFor="tpl-folder-default" className="tpl-default__label">
            New pages in <strong className="ph-mask">{list.folder.name}</strong> start from
          </label>
          <Select
            id="tpl-folder-default"
            value={list.folder.default_template ?? ""}
            onChange={(e) => void changeDefault(e.target.value)}
            className="tpl-default__select"
            options={[
              { value: "", label: "A blank page" },
              ...list.workspace.map((t) => ({ value: t.id, label: `${t.icon ? `${t.icon} ` : ""}${t.name}` })),
              ...list.builtin.filter((b) => b.id !== "blank").map((b) => ({ value: b.id, label: `${b.name} (built in)` })),
            ]}
          />
        </div>
      )}
      {!list.folder?.can_set_default && list.folder?.default_template && (
        <p className="tpl-default tpl-default--note">
          <Icon name="folder" />
          <span>
            <strong className="ph-mask">{list.folder.name}</strong> starts new pages from a template. Pick Blank or another one if you like.
          </span>
        </p>
      )}
      <div className="tpl-sec__head tpl-sec__builtin">
        <span className="tpl-sec__title">
          <Icon name="sparkle" />
          Built in
        </span>
      </div>
      {manage && (
        <ManageTemplatesDialog
          open
          listing={list}
          workspaceName={wsName}
          onClose={() => setManage(false)}
          onChanged={(next) => {
            setList(next);
            if (![...next.workspace, ...next.personal].some((t) => t.id === chosen) && /^[0-9a-f]{24}$/.test(chosen)) onChoose(null);
          }}
        />
      )}
    </>
  );
}

export default YourTemplates;
