"use client";

/**
 * The changelog's settings, in a drawer: the page's title and description (the hub's heading, the
 * feeds' title; a short title is the header tab's label too), the products entries can name
 * (with a version each), and "Coming next" (what readers see above the releases). Saved together;
 * readers see them after the next publish.
 */
import { useEffect, useId, useState } from "react";
import { Alert, Button, Drawer, Field, Icon, IconButton, Input, Textarea } from "@/components/ui";
import { saveChangelogSettings, type ChangelogNextItem, type ChangelogProduct, type ChangelogSettings } from "@/lib/docsChangelog";
import { docsErrorMessage } from "@/lib/docsSites";
import { slugFromTitle } from "./model";

export type SettingsSection = "page" | "products" | "next";

const productId = (label: string) => slugFromTitle(label).slice(0, 24).replace(/-+$/g, "");

export function SettingsDrawer({ open, onClose, siteId, settings, focus, canEdit, onSaved, inUse }: {
  open: boolean;
  onClose: () => void;
  siteId: string;
  settings: ChangelogSettings;
  focus: SettingsSection;
  canEdit: boolean;
  onSaved: (s: ChangelogSettings, entriesChanged: number) => void;
  /** Product id → how many entries name it (removing one takes it off them). */
  inUse: Record<string, number>;
}) {
  const uid = useId();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [products, setProducts] = useState<ChangelogProduct[]>([]);
  const [next, setNext] = useState<ChangelogNextItem[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(settings.title);
    setDescription(settings.description);
    setProducts(settings.products.map((p) => ({ ...p })));
    setNext(settings.next.map((n) => ({ ...n })));
    setError("");
    const t = window.setTimeout(() => document.getElementById(`${uid}-${focus}`)?.scrollIntoView({ block: "start" }), 120);
    return () => window.clearTimeout(t);
  }, [open, settings, focus, uid]);

  const removedInUse = settings.products.filter((p) => !products.some((x) => x.id === p.id) && (inUse[p.id] ?? 0) > 0);

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const clean: ChangelogSettings = {
        title: title.trim(),
        description: description.trim(),
        products: products.filter((p) => p.label.trim()).map((p) => ({ id: p.id || productId(p.label), label: p.label.trim() })),
        next: next.filter((n) => n.title.trim()).map((n) => ({ title: n.title.trim(), ...(n.area?.trim() ? { area: n.area.trim() } : {}), ...(n.body?.trim() ? { body: n.body.trim() } : {}) })),
      };
      const r = await saveChangelogSettings(siteId, clean);
      onSaved(r.settings, r.entries_changed);
      onClose();
    } catch (e) {
      setError(docsErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const move = <T,>(list: T[], i: number, d: number): T[] => {
    const j = i + d;
    if (j < 0 || j >= list.length) return list;
    const out = [...list];
    [out[i], out[j]] = [out[j]!, out[i]!];
    return out;
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={520}
      title="Changelog settings"
      description="Readers see these after the next publish."
      footer={canEdit ? (
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>Save settings</Button>
        </>
      ) : undefined}
    >
      <div className="flex flex-col gap-7">
        {error && <Alert tone="danger" onDismiss={() => setError("")}>{error}</Alert>}

        <section id={`${uid}-page`} aria-labelledby={`${uid}-page-h`} className="flex scroll-mt-4 flex-col gap-3.5">
          <h3 id={`${uid}-page-h`} className="text-[15px] font-semibold text-text">The changelog page</h3>
          <Field label="Title" htmlFor={`${uid}-t`} hint="The page's heading and the feeds' name. A short one (up to 24 characters) labels the header tab too.">
            <Input id={`${uid}-t`} value={title} maxLength={60} placeholder="Changelog" disabled={!canEdit} onChange={(e) => setTitle(e.target.value)} className="ph-sensitive ph-mask" />
          </Field>
          <Field label={<>Description <span className="font-normal text-text-muted">(optional)</span></>} htmlFor={`${uid}-d`} hint="Under the heading, and in link previews.">
            <Textarea id={`${uid}-d`} rows={2} value={description} maxLength={300} placeholder="New features, improvements and fixes, newest first." disabled={!canEdit} onChange={(e) => setDescription(e.target.value)} className="ph-sensitive ph-mask" />
          </Field>
        </section>

        <section id={`${uid}-products`} aria-labelledby={`${uid}-p-h`} className="flex scroll-mt-4 flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h3 id={`${uid}-p-h`} className="text-[15px] font-semibold text-text">Products</h3>
            <p className="text-[13px] text-text-secondary">If you ship more than one thing (a web app, a mobile app, an API), name them: an entry says which it changed and the version it needs, and readers filter by product.</p>
          </div>
          {products.length > 0 && (
            <ul className="flex flex-col gap-2">
              {products.map((p, i) => (
                <li key={i} className="flex items-center gap-2">
                  <Input
                    aria-label={`Product ${i + 1} name`}
                    value={p.label}
                    maxLength={40}
                    disabled={!canEdit}
                    placeholder="Web app"
                    onChange={(e) => setProducts((ps) => ps.map((x, k) => (k === i ? { ...x, label: e.target.value, id: settings.products.some((s) => s.id === x.id) ? x.id : productId(e.target.value) } : x)))}
                    className="ph-sensitive ph-mask"
                    wrapClassName="min-w-0 flex-1"
                    textSuffix={p.id || productId(p.label) || undefined}
                  />
                  {canEdit && <IconButton icon="trash" label={`Remove ${p.label || "this product"}`} size="sm" onClick={() => setProducts((ps) => ps.filter((_, k) => k !== i))} />}
                </li>
              ))}
            </ul>
          )}
          {removedInUse.length > 0 && (
            <Alert tone="warning">
              {removedInUse.map((p) => `${p.label} (${inUse[p.id]} ${inUse[p.id] === 1 ? "entry" : "entries"})`).join(", ")}: saving takes {removedInUse.length === 1 ? "it" : "them"} off those entries, versions included.
            </Alert>
          )}
          {canEdit && products.length < 12 && (
            <div><Button variant="secondary" size="sm" iconLeft="plus" onClick={() => setProducts((ps) => [...ps, { id: "", label: "" }])}>Add a product</Button></div>
          )}
        </section>

        <section id={`${uid}-next`} aria-labelledby={`${uid}-n-h`} className="flex scroll-mt-4 flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h3 id={`${uid}-n-h`} className="flex items-center gap-2 text-[15px] font-semibold text-text"><Icon name="clock" size={15} /> Coming next</h3>
            <p className="text-[13px] text-text-secondary">What you&apos;re working on, shown above the releases. Promise only what you&apos;ll ship; take an item off once it&apos;s out.</p>
          </div>
          {next.length > 0 && (
            <ol className="flex flex-col gap-3">
              {next.map((n, i) => (
                <li key={i} className="flex flex-col gap-2 rounded-lg border border-border bg-surface-inset p-3">
                  <div className="flex items-center gap-2">
                    <span className="grid size-6 shrink-0 place-items-center rounded-full bg-surface text-[12px] font-semibold text-text-secondary" aria-hidden>{i + 1}</span>
                    <Input aria-label={`Item ${i + 1} title`} value={n.title} maxLength={120} placeholder="Offline mode" disabled={!canEdit}
                      onChange={(e) => setNext((xs) => xs.map((x, k) => (k === i ? { ...x, title: e.target.value } : x)))} className="ph-sensitive ph-mask" wrapClassName="min-w-0 flex-1" />
                    {canEdit && (
                      <span className="flex shrink-0">
                        <IconButton icon="arrowUp" label={`Move item ${i + 1} up`} size="sm" disabled={i === 0} onClick={() => setNext((xs) => move(xs, i, -1))} />
                        <IconButton icon="arrowDown" label={`Move item ${i + 1} down`} size="sm" disabled={i === next.length - 1} onClick={() => setNext((xs) => move(xs, i, 1))} />
                        <IconButton icon="trash" label={`Remove item ${i + 1}`} size="sm" onClick={() => setNext((xs) => xs.filter((_, k) => k !== i))} />
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-1 gap-2 pl-8 sm:grid-cols-[140px_minmax(0,1fr)]">
                    <Input aria-label={`Item ${i + 1} area`} value={n.area ?? ""} maxLength={40} placeholder="Area (optional)" size="sm" disabled={!canEdit}
                      onChange={(e) => setNext((xs) => xs.map((x, k) => (k === i ? { ...x, area: e.target.value } : x)))} className="ph-sensitive ph-mask" />
                    <Input aria-label={`Item ${i + 1} note`} value={n.body ?? ""} maxLength={400} placeholder="One line about it (optional)" size="sm" disabled={!canEdit}
                      onChange={(e) => setNext((xs) => xs.map((x, k) => (k === i ? { ...x, body: e.target.value } : x)))} className="ph-sensitive ph-mask" />
                  </div>
                </li>
              ))}
            </ol>
          )}
          {canEdit && next.length < 12 && (
            <div><Button variant="secondary" size="sm" iconLeft="plus" onClick={() => setNext((xs) => [...xs, { title: "" }])}>Add an item</Button></div>
          )}
        </section>
      </div>
    </Drawer>
  );
}

export default SettingsDrawer;
