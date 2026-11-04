"use client";

/**
 * A page's typed properties, Notion-style, under its title: one row per property of the page's
 * folder (services/page_db.py), each value editable in place by people who can edit the page;
 * read only otherwise (readers see only the rows that have a value). "Add a property" (workspace
 * members and admins) adds to the folder's schema, so every page there gets it.
 *
 * Self-contained: the caller passes the server's view (`info`, the document read's
 * `page_properties`), the values (`values`: the editor parses its own Markdown) and, to edit,
 * `onChange` (the editor writes the patch into the page's front matter; it saves like any edit).
 * `extra` renders after the rows (another feature's state, e.g. sign-off).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon, cx } from "@/components/ui";
import { putFolderProperties, type LinkInfo, type PagePropertiesInfo } from "./api";
import { nextColor, type Person, type PropDef, type PropValue } from "./model.mjs";
import { Pop } from "./Pop";
import { AddProperty, PropertyMenu } from "./SchemaMenus";
import { PropsCtx, TYPE_ICONS, ValueEditor, ValueView, isEmptyValue, type PropsContext } from "./Values";
import "./props.css";

export interface PropertiesPanelProps {
  info: PagePropertiesInfo;
  /** The page's values (defaults to `info.values`). */
  values?: Record<string, PropValue>;
  /** Editing: set some values (null clears one). Absent: read only. */
  onChange?: ((patch: Record<string, PropValue | null>) => void) | null;
  readOnly?: boolean;
  workspaceId: string | null;
  pageHref?: (slug: string) => string;
  /** After the rows: other page state (sign-off). */
  extra?: React.ReactNode;
  className?: string;
}

export function PropertiesPanel({ info, values: given, onChange, readOnly, workspaceId, pageHref, extra, className }: PropertiesPanelProps) {
  const [schema, setSchema] = useState<PropDef[]>(info.properties);
  const [rev, setRev] = useState(info.rev);
  const [people, setPeople] = useState<Record<string, Person>>(info.people ?? {});
  const [links, setLinks] = useState<Record<string, LinkInfo>>(info.links ?? {});
  // A fresh read of the page (someone else changed the schema, or the values resolved again).
  useEffect(() => { setSchema(info.properties); setRev(info.rev); }, [info.properties, info.rev]);
  useEffect(() => { setPeople((p) => ({ ...p, ...info.people })); setLinks((l) => ({ ...l, ...info.links })); }, [info.people, info.links]);

  const values = given ?? info.values ?? {};
  const editable = !!onChange && !readOnly;
  const canSchema = editable && info.can_edit_schema && !!info.folder && !!workspaceId;

  const saveSchema = useCallback(async (next: PropDef[]) => {
    if (!info.folder || !workspaceId) return null;
    const r = await putFolderProperties(workspaceId, info.folder.id, next, rev);
    setSchema(r.properties);
    setRev(r.rev);
    return r.properties;
  }, [info.folder, workspaceId, rev]);

  const ctx: PropsContext = useMemo(() => ({
    workspaceId,
    people,
    links,
    peopleHidden: info.people_hidden,
    canEditSchema: canSchema,
    pageHref,
    remember: (p, l) => { if (Object.keys(p).length) setPeople((x) => ({ ...x, ...p })); if (Object.keys(l).length) setLinks((x) => ({ ...x, ...l })); },
    addOption: async (prop, name) => {
      const saved = await saveSchema(schema.map((p) => (p.key === prop.key ? { ...p, options: [...(p.options ?? []), { name, color: nextColor(p.options) }] } : p)));
      return saved?.find((p) => p.key === prop.key) ?? null;
    },
  }), [workspaceId, people, links, info.people_hidden, canSchema, pageHref, schema, saveSchema]);

  const rows = schema.filter((p) => editable || !isEmptyValue(values[p.key]) || p.type === "checkbox" && values[p.key] === true);
  if (!rows.length && !canSchema && !extra) return null;

  return (
    <PropsCtx.Provider value={ctx}>
      <section className={cx("pp-panel pp-scope no-print-break", !rows.length && !extra && "pp-panel--empty", className)} aria-label="Properties">
        {info.mode === "template" && editable && rows.length > 0 && (
          <p className="pp-note"><Icon name="info" size={13} />Defaults for new pages made from this template{info.folder ? <> in <strong className="ph-sensitive">{info.folder.name}</strong></> : null}.</p>
        )}
        {rows.map((p) => (
          <PropertyRow key={p.key} prop={p} value={values[p.key]} editable={editable} canSchema={canSchema} schema={schema}
            onChange={(v) => onChange?.({ [p.key]: v })}
            onSaveProp={async (next) => { await saveSchema(schema.map((x) => (x.key === p.key ? next : x))); }}
            onRemoveProp={async () => { await saveSchema(schema.filter((x) => x.key !== p.key)); }} />
        ))}
        {canSchema && schema.length < 30 && <AddPropertyButton schema={schema} onAdd={async (def) => { await saveSchema([...schema, def]); }} />}
        {extra}
      </section>
    </PropsCtx.Provider>
  );
}

function AddPropertyButton({ schema, onAdd }: { schema: PropDef[]; onAdd: (p: PropDef) => Promise<void> }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={ref} type="button" className="pp-add" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}>
        <Icon name="plus" size={15} /> Add a property
      </button>
      {open && (
        <Pop anchor={ref.current} onClose={() => setOpen(false)} title="Add a property" width={300}>
          <AddProperty taken={schema} onAdd={onAdd} onClose={() => setOpen(false)} />
        </Pop>
      )}
    </>
  );
}

function PropertyRow({ prop, value, editable, canSchema, schema, onChange, onSaveProp, onRemoveProp }: {
  prop: PropDef;
  value: PropValue | undefined;
  editable: boolean;
  canSchema: boolean;
  schema: PropDef[];
  onChange: (v: PropValue | null) => void;
  onSaveProp: (p: PropDef) => Promise<void>;
  onRemoveProp: () => Promise<void>;
}) {
  const labelRef = useRef<HTMLButtonElement>(null);
  const valueRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const [edit, setEdit] = useState(false);
  const label = (
    <>
      <Icon name={TYPE_ICONS[prop.type] ?? "type"} size={15} aria-hidden />
      <span>{prop.name}</span>
    </>
  );
  return (
    <div className="pp-row">
      {canSchema ? (
        <button ref={labelRef} type="button" className="pp-row__label" aria-haspopup="dialog" aria-expanded={menu} onClick={() => setMenu((m) => !m)} title={`${prop.name}: change this property`}>
          {label}
        </button>
      ) : (
        <div className="pp-row__label">{label}</div>
      )}
      {editable && prop.type === "checkbox" ? (
        <div className="pp-row__value">
          <button type="button" className={cx("pp-check", value === true && "pp-check--on")} role="checkbox" aria-checked={value === true} aria-label={prop.name} onClick={() => onChange(value === true ? null : true)}>
            <Icon name="check" size={11} />
          </button>
        </div>
      ) : editable ? (
        <button ref={valueRef} type="button" className="pp-row__value" aria-haspopup="dialog" aria-expanded={edit} aria-label={`${prop.name}: ${isEmptyValue(value) ? "empty" : "change"}`} onClick={() => setEdit(true)}>
          <ValueView prop={prop} value={value} />
        </button>
      ) : (
        <div className="pp-row__value pp-row__value--ro"><ValueView prop={prop} value={value} /></div>
      )}
      {menu && (
        <Pop anchor={labelRef.current} onClose={() => setMenu(false)} title={prop.name} width={280}>
          <PropertyMenu prop={prop} all={schema} canEdit onSave={onSaveProp} onRemove={onRemoveProp} onClose={() => setMenu(false)} />
        </Pop>
      )}
      {edit && (
        <Pop anchor={valueRef.current} onClose={() => setEdit(false)} title={prop.name} width={prop.type === "date" ? 288 : 320}>
          <ValueEditor prop={prop} value={value} onChange={onChange} onClose={() => setEdit(false)} />
        </Pop>
      )}
    </div>
  );
}

export default PropertiesPanel;
