"use client";

/**
 * Changing a folder's property schema: "Add a property" (a name and a type) and a property's own
 * menu (rename, change type, its options with colours, hide it from the folder). Only workspace
 * members and admins get these (the server checks too). Taking a property out never deletes a
 * page's value: the value stays in the page, hidden, and comes back with the property.
 */
import { useState } from "react";
import { Icon } from "@/components/ui";
import { COLORS, TYPE_LABELS, TYPES, keyFromName, nextColor, type PropColor, type PropDef, type PropType } from "./model.mjs";
import { OptionChip, TYPE_ICONS } from "./Values";

export function AddProperty({ taken, onAdd, onClose, presetType }: { taken: PropDef[]; onAdd: (p: PropDef) => void | Promise<void>; onClose: () => void; presetType?: PropType }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const add = async (type: PropType) => {
    const label = name.trim() || TYPE_LABELS[type];
    let n = label;
    let i = 2;
    while (taken.some((p) => p.name.toLowerCase() === n.toLowerCase())) n = `${label} ${i++}`;
    if (n.toLowerCase() === "title" || n.toLowerCase() === "name") n = `${n} 2`;
    const def: PropDef = { key: keyFromName(n, new Set(taken.map((p) => p.key))), name: n, type };
    if (type === "select" || type === "multi_select") def.options = type === "select" && /status/i.test(n)
      ? [{ name: "Not started", color: "gray" }, { name: "In progress", color: "blue" }, { name: "Done", color: "green" }]
      : [];
    setBusy(true);
    setErr("");
    try {
      await onAdd(def);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't add it");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="pp-field">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Property name" aria-label="Property name" maxLength={60} disabled={busy}
          onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) { e.preventDefault(); void add(presetType ?? "text"); } }} />
      </div>
      <div className="pp-label">Type</div>
      <div className="pp-pop__body pp-types" style={{ paddingTop: 2 }}>
        {TYPES.map((t) => (
          <button key={t} type="button" className="pp-opt" disabled={busy} onClick={() => void add(t)} data-active={presetType === t || undefined}>
            <Icon name={TYPE_ICONS[t]!} size={15} className="text-text-muted" />
            {TYPE_LABELS[t]}
          </button>
        ))}
      </div>
      {err && <div className="pp-pop__hint pp-err">{err}</div>}
    </>
  );
}

/** A property's menu: rename, type, options; plus `extra` entries (sort, filter, hide in a view). */
export function PropertyMenu({ prop, all, canEdit, onSave, onRemove, extra, onClose }: {
  prop: PropDef;
  all: PropDef[];
  canEdit: boolean;
  onSave: (next: PropDef) => Promise<void>;
  onRemove: () => Promise<void>;
  extra?: Array<{ label: string; icon: string; onClick: () => void; on?: boolean }>;
  onClose: () => void;
}) {
  const [name, setName] = useState(prop.name);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [newOpt, setNewOpt] = useState("");
  const [colorFor, setColorFor] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr("");
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't save it");
    } finally {
      setBusy(false);
    }
  };
  const rename = () => {
    const n = name.trim();
    if (!n || n === prop.name) return setName(prop.name);
    if (all.some((p) => p.key !== prop.key && p.name.toLowerCase() === n.toLowerCase())) {
      setErr(`Another property is called “${n}”.`);
      return;
    }
    void run(() => onSave({ ...prop, name: n }));
  };
  const opts = prop.options ?? [];
  const setOpts = (options: PropDef["options"]) => void run(() => onSave({ ...prop, options }));
  const select = prop.type === "select" || prop.type === "multi_select";
  return (
    <div className="pp-pop__body" style={{ padding: 6 }}>
      {canEdit ? (
        <div className="pp-field" style={{ paddingTop: 2 }}>
          <input value={name} onChange={(e) => setName(e.target.value)} onBlur={rename} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); rename(); } }} aria-label="Property name" maxLength={60} disabled={busy} />
        </div>
      ) : (
        <div className="pp-label" style={{ paddingBottom: 6 }}>{prop.name}</div>
      )}
      {extra?.map((x) => (
        <button key={x.label} type="button" className="pp-opt" onClick={() => { x.onClick(); onClose(); }}>
          <Icon name={x.icon} size={15} className="text-text-muted" />
          {x.label}
          {x.on && <span className="pp-opt__trail"><Icon name="check" size={14} /></span>}
        </button>
      ))}
      {canEdit && (
        <>
          {extra?.length ? <div className="pp-sep" /> : null}
          <label className="pp-field" style={{ paddingTop: 2 }}>
            <span className="pp-label" style={{ padding: 0 }}>Type</span>
            <select value={prop.type} disabled={busy} onChange={(e) => {
              const type = e.target.value as PropType;
              void run(() => onSave({ key: prop.key, name: prop.name, type, ...(type === "select" || type === "multi_select" ? { options: opts } : {}) }));
            }}>
              {TYPES.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
            </select>
          </label>
          {select && (
            <>
              <div className="pp-label">Options</div>
              {opts.map((o) => (
                <div key={o.name}>
                  <div className="pp-opt" style={{ cursor: "default" }}>
                    <OptionChip name={o.name} color={o.color} />
                    <span className="pp-opt__trail">
                      <button type="button" className="pp-chip__x" aria-label={`Colour of ${o.name}`} aria-expanded={colorFor === o.name} onClick={() => setColorFor(colorFor === o.name ? null : o.name)}>
                        <Icon name="palette" size={13} />
                      </button>
                      <button type="button" className="pp-chip__x" aria-label={`Remove the option ${o.name}`} disabled={busy} onClick={() => setOpts(opts.filter((x) => x.name !== o.name))}>
                        <Icon name="trash" size={13} />
                      </button>
                    </span>
                  </div>
                  {colorFor === o.name && (
                    <div className="pp-swatches" role="group" aria-label={`Colour of ${o.name}`}>
                      {COLORS.map((c) => (
                        <button key={c} type="button" className="pp-swatch" data-pp-color={c} aria-label={c} aria-pressed={o.color === c} title={c}
                          onClick={() => { setColorFor(null); setOpts(opts.map((x) => (x.name === o.name ? { ...x, color: c as PropColor } : x))); }} />
                      ))}
                    </div>
                  )}
                </div>
              ))}
              <div className="pp-field">
                <input value={newOpt} onChange={(e) => setNewOpt(e.target.value)} placeholder="Add an option…" aria-label="Add an option" maxLength={60} disabled={busy || opts.length >= 50}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    const n = newOpt.trim();
                    if (!n) return;
                    if (opts.some((o) => o.name.toLowerCase() === n.toLowerCase())) { setErr(`“${n}” is already an option.`); return; }
                    setNewOpt("");
                    setOpts([...opts, { name: n, color: nextColor(opts) }]);
                  }} />
              </div>
              {opts.length > 0 && <div className="pp-pop__hint" style={{ paddingTop: 0 }}>Removing an option leaves pages that use it as they are.</div>}
            </>
          )}
          <div className="pp-sep" />
          {confirm ? (
            <div className="pp-field">
              <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>Hide “{prop.name}” from this folder? Pages keep their values; add the property again to see them.</span>
              <div style={{ display: "flex", gap: 6 }}>
                <button type="button" className="pp-opt pp-opt--danger" style={{ width: "auto" }} disabled={busy} onClick={() => void run(async () => { await onRemove(); onClose(); })}>
                  <Icon name="trash" size={14} /> Remove property
                </button>
                <button type="button" className="pp-opt" style={{ width: "auto" }} onClick={() => setConfirm(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <button type="button" className="pp-opt pp-opt--danger" onClick={() => setConfirm(true)}>
              <Icon name="trash" size={15} /> Remove property
            </button>
          )}
        </>
      )}
      {err && <div className="pp-pop__hint pp-err">{err}</div>}
    </div>
  );
}
