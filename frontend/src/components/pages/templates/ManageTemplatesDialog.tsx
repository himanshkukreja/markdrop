"use client";

/**
 * Manage templates: the workspace's (its admins reorder; admins and whoever saved one rename and
 * delete) and your own. Rename in place (name, description, emoji), Edit opens the template page
 * itself (it's a page, in the same editor), Delete asks first, and rows drag to reorder (pointer,
 * touch or keyboard: space, arrows, space).
 */
import { useEffect, useId, useMemo, useState } from "react";
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, TouchSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Alert, Button, ConfirmDialog, Dialog, EmptyState, Icon, IconButton, Input, SegmentedControl, Tooltip, useToast } from "@/components/ui";
import { deleteTemplate, reorderTemplates, updateTemplate, type TemplateListing, type UserTemplate } from "./api";
import { TemplateEmoji } from "./TemplateEmoji";
import "./templates.css";

export interface ManageTemplatesDialogProps {
  open: boolean;
  onClose: () => void;
  listing: TemplateListing;
  workspaceName?: string | null;
  onChanged: (next: TemplateListing) => void;
}

type Tab = "workspace" | "personal";

export function ManageTemplatesDialog({ open, onClose, listing, workspaceName, onChanged }: ManageTemplatesDialogProps) {
  const toast = useToast();
  const hasWs = !!listing.workspace_id && listing.workspace_role !== "viewer";
  const [tab, setTab] = useState<Tab>(hasWs && (listing.workspace.length > 0 || listing.personal.length === 0) ? "workspace" : "personal");
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<UserTemplate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const rows = tab === "workspace" ? listing.workspace : listing.personal;
  const canReorder = tab === "personal" || listing.can_reorder_workspace;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const replace = (scope: Tab, next: UserTemplate[]) => onChanged({ ...listing, [scope]: next });

  async function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = rows.findIndex((r) => r.id === active.id);
    const to = rows.findIndex((r) => r.id === over.id);
    if (from < 0 || to < 0) return;
    const before = rows;
    const next = arrayMove(rows, from, to);
    replace(tab, next); // at once; the server confirms
    setError("");
    try {
      const res = await reorderTemplates(tab === "workspace" ? listing.workspace_id : null, next.map((r) => r.id));
      replace(tab, res.templates);
    } catch (err) {
      replace(tab, before);
      setError(err instanceof Error ? err.message : "Couldn't save the new order.");
    }
  }

  async function save(t: UserTemplate, patch: { name: string; description: string; icon: string }) {
    setBusy(true);
    setError("");
    try {
      const out = await updateTemplate(t.id, patch);
      replace(tab, rows.map((r) => (r.id === t.id ? { ...r, ...out } : r)));
      setEditing(null);
      toast.success("Template updated");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the template.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!removing) return;
    setBusy(true);
    try {
      await deleteTemplate(removing.id);
      replace(tab, rows.filter((r) => r.id !== removing.id));
      toast.success(`Deleted “${removing.name}”`);
      setRemoving(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete the template.");
      setRemoving(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Dialog
        open={open && !removing}
        onClose={onClose}
        size="lg"
        title="Manage templates"
        description={canReorder ? "Drag to change the order they appear in. Edit opens the template as a page." : "Edit opens the template as a page. The workspace's admins choose the order."}
        footer={<Button variant="secondary" onClick={onClose}>Done</Button>}
      >
        <div className="flex flex-col gap-3">
          {hasWs && (
            <SegmentedControl<Tab>
              value={tab}
              onChange={(v) => { setTab(v); setEditing(null); }}
              block
              aria-label="Which templates"
              options={[
                { value: "workspace", label: `${workspaceName || "Workspace"} · ${listing.workspace.length}` },
                { value: "personal", label: `Just me · ${listing.personal.length}` },
              ]}
            />
          )}
          {error && <Alert tone="danger" onDismiss={() => setError("")}>{error}</Alert>}
          {rows.length === 0 ? (
            <EmptyState
              icon="layers"
              title={tab === "workspace" ? "No workspace templates yet" : "No templates of your own yet"}
              description="Open a page and choose Use as template from its ⋯ menu."
            />
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e) => void onDragEnd(e)}>
              <SortableContext items={rows.map((r) => r.id)} strategy={verticalListSortingStrategy}>
                <ul className="tpl-list" aria-label="Templates">
                  {rows.map((t) => (
                    <Row
                      key={t.id}
                      t={t}
                      draggable={canReorder && rows.length > 1 && editing === null}
                      editing={editing === t.id}
                      busy={busy}
                      onEdit={() => setEditing(t.id)}
                      onCancel={() => setEditing(null)}
                      onSave={(patch) => void save(t, patch)}
                      onDelete={() => setRemoving(t)}
                    />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
          )}
        </div>
      </Dialog>
      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={remove}
        busy={busy}
        title={`Delete “${removing?.name ?? ""}”?`}
        description={
          removing?.subpages
            ? `The template and its ${removing.subpages} sub-page${removing.subpages === 1 ? "" : "s"} go. Pages already made from it stay as they are.`
            : "The template goes. Pages already made from it stay as they are."
        }
        confirmLabel="Delete template"
      />
    </>
  );
}

function Row({ t, draggable, editing, busy, onEdit, onCancel, onSave, onDelete }: {
  t: UserTemplate;
  draggable: boolean;
  editing: boolean;
  busy: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (patch: { name: string; description: string; icon: string }) => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: t.id, disabled: !draggable });
  const style = { transform: CSS.Translate.toString(transform), transition: transition ?? undefined };
  const [name, setName] = useState(t.name);
  const [description, setDescription] = useState(t.description);
  const [icon, setIcon] = useState(t.icon ?? "");
  const id = useId();
  useEffect(() => {
    if (editing) {
      setName(t.name);
      setDescription(t.description);
      setIcon(t.icon ?? "");
    }
  }, [editing, t]);
  const meta = useMemo(() => {
    const bits = [t.description || null, t.subpages ? `${t.subpages} sub-page${t.subpages === 1 ? "" : "s"}` : null, t.scope === "workspace" && t.created_by ? `by ${t.created_by}` : null];
    return bits.filter(Boolean).join(" · ") || "No description";
  }, [t]);

  return (
    <li ref={setNodeRef} style={style} className={`tpl-row${isDragging ? " tpl-row--drag" : ""}`} data-testid="tpl-row">
      <button
        type="button"
        ref={setActivatorNodeRef}
        className="tpl-row__handle md-focus"
        aria-label={`Reorder ${t.name}`}
        disabled={!draggable}
        {...attributes}
        {...listeners}
      >
        <Icon name="grip" />
      </button>
      {editing ? (
        <form
          className="tpl-row__edit"
          onSubmit={(e) => {
            e.preventDefault();
            // The gallery's own form is an ancestor in the React tree (this dialog portals out of
            // it, but React events still bubble there): don't let Save create a page.
            e.stopPropagation();
            onSave({ name, description, icon });
          }}
        >
          <div className="tpl-row__edit-line">
            <Input aria-label="Emoji" value={icon} onChange={(e) => setIcon(e.target.value)} className="tpl-emoji__custom" maxLength={8} placeholder="📝" />
            <Input id={`${id}-n`} aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus className="ph-mask" />
          </div>
          <Input aria-label="Description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} placeholder="What it's for (optional)" className="ph-mask" />
          <div className="tpl-row__edit-line">
            <Button size="sm" variant="primary" type="submit" loading={busy} disabled={!name.trim()}>Save</Button>
            <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
          </div>
        </form>
      ) : (
        <>
          <TemplateEmoji t={t} className="tpl-row__emoji" />
          <span className="tpl-row__main">
            <span className="tpl-row__name ph-mask">{t.name}</span>
            <span className="tpl-row__meta ph-mask">{meta}</span>
          </span>
          <span className="tpl-row__actions">
            <Tooltip content="Edit the template page">
              <Button size="sm" variant="ghost" href={`/${encodeURIComponent(t.slug)}?edit=1`} iconLeft="edit">
                Edit
              </Button>
            </Tooltip>
            {t.can_manage && <IconButton icon="type" label={`Rename ${t.name}`} onClick={onEdit} />}
            {t.can_manage && <IconButton icon="trash" label={`Delete ${t.name}`} onClick={onDelete} />}
          </span>
        </>
      )}
    </li>
  );
}

export default ManageTemplatesDialog;
