"use client";

import { useRef, type ChangeEvent, type FocusEvent } from "react";
import { Alert, Badge, Button, Field, IconButton, Input, Select, Switch, Textarea } from "@/components/ui";
import {
  emptyBlock, newBlockId, type Block, type BlockType, type BlocksDoc, type Draft, type MergeTagInfo, type Problem,
  type RawDoc, type Sender, type TemplateInfo, type TemplatesResponse,
} from "./api";
import { CheckBadge, Section } from "./bits";

/**
 * Compose: name, sender, subject (+ a subject for people without a name), preheader, tracking, and
 * the body: a block editor for block documents, HTML + plain-text editors for full templates. The
 * tag picker inserts `{{tag}}` at the caret of the last focused field without stealing focus.
 * Problems come from the server renderer (the same check that blocks tests and sends).
 */

type FieldEl = HTMLInputElement | HTMLTextAreaElement;
type Target = { el: FieldEl; set: (v: string) => void };
export type Update = (fn: (d: Draft) => Draft) => void;

const BLOCK_TYPES: BlockType[] = ["hero", "text", "button", "feature", "callout", "image", "divider", "html"];
const FIELD_LABEL: Record<string, string> = {
  eyebrow: "Eyebrow", title: "Title", md: "Text · markdown", label: "Label", url: "Link", tag: "Tag",
  src: "Image URL (https)", alt: "Alt text", href: "Link (optional)", html: "HTML",
};
const MONO = new Set(["url", "src", "href", "html"]);
const AREA: Record<string, number> = { md: 5, html: 6 };

function TagPicker({ tags, onInsert }: { tags: MergeTagInfo[]; onInsert: (tag: string) => void }) {
  return (
    <div className="sticky top-14 z-(--z-sticky) -mx-1 rounded-xl border border-border bg-surface/95 px-3 py-2 backdrop-blur lg:top-0" role="toolbar" aria-label="Insert a merge tag at the cursor">
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-eyebrow uppercase text-text-muted">Insert tag</span>
        <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto pb-0.5">
          {tags.map((t) => (
            <button
              key={t.tag}
              type="button"
              title={`${t.label} · ${t.hint}`}
              aria-label={`Insert {{${t.tag}}}: ${t.label}, ${t.hint}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onInsert(t.tag)}
              className="md-focus shrink-0 whitespace-nowrap rounded-md border border-border bg-surface-inset px-2 py-1 font-mono text-micro text-text-secondary hover:border-border-strong hover:text-text"
            >
              {`{{${t.tag}}}`}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-1 hidden text-micro text-text-muted sm:block">
        Fallback: <code className="font-mono">{"{{first_name|there}}"}</code> · conditional:{" "}
        <code className="font-mono">{"{{#if first_name}}Hi {{first_name}}{{else}}Hi{{/if}}"}</code>
      </p>
    </div>
  );
}

export function Problems({ problems }: { problems: Problem[] }) {
  if (!problems.length) return null;
  return (
    <Alert tone="danger" title={`${problems.length} problem${problems.length === 1 ? "" : "s"} · fix before testing or sending`}>
      <ul className="flex flex-col gap-0.5">
        {problems.slice(0, 8).map((p, i) => (
          <li key={i} className="break-words"><span className="font-mono text-micro opacity-80">{p.where}</span> · {p.message}</li>
        ))}
        {problems.length > 8 && <li>…and {problems.length - 8} more</li>}
      </ul>
    </Alert>
  );
}

export default function Composer({
  draft, update, senders, problems, readOnly, template, meta, site,
}: {
  draft: Draft; update: Update; senders: Sender[]; problems: Problem[]; readOnly?: boolean;
  template?: TemplateInfo | null; meta: TemplatesResponse; site: string;
}) {
  const target = useRef<Target | null>(null);
  const sender = senders.find((s) => s.id === draft.sender_id) || senders.find((s) => s.is_default) || senders[0];
  const raw = draft.doc.layout === "raw";
  const byWhere = new Map<string, string>();
  for (const p of problems) if (!byWhere.has(p.where)) byWhere.set(p.where, p.message);

  /** value/onChange/onFocus for a field the tag picker can insert into. */
  const bind = (value: string, set: (v: string) => void) => ({
    value,
    readOnly,
    onChange: (e: ChangeEvent<FieldEl>) => set(e.target.value),
    onFocus: (e: FocusEvent<FieldEl>) => { target.current = { el: e.currentTarget, set }; },
  });

  const insert = (tag: string) => {
    if (readOnly) return;
    const token = `{{${tag}}}`;
    const t = target.current;
    if (!t || !t.el.isConnected) {
      update((d) => ({ ...d, subject: `${d.subject}${!d.subject || d.subject.endsWith(" ") ? "" : " "}${token}` }));
      return;
    }
    const el = t.el;
    const s = el.selectionStart ?? el.value.length;
    const e = el.selectionEnd ?? s;
    t.set(el.value.slice(0, s) + token + el.value.slice(e));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(s + token.length, s + token.length);
    });
  };

  const setDoc = (fn: (doc: Draft["doc"]) => Draft["doc"]) => update((d) => ({ ...d, doc: fn(d.doc) }));
  const setBlocks = (fn: (doc: BlocksDoc) => BlocksDoc) => setDoc((doc) => (doc.layout === "blocks" ? fn(doc) : doc));
  const setRaw = (fn: (doc: RawDoc) => RawDoc) => setDoc((doc) => (doc.layout === "raw" ? fn(doc) : doc));

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Section id="email-envelope" label="1 · Envelope" title="Sender, subject, preheader">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
          <Field label="Campaign name (internal)">
            <Input value={draft.name} readOnly={readOnly} maxLength={120} onChange={(e) => { const v = e.target.value; update((d) => ({ ...d, name: v })); }} />
          </Field>
          <Field label="Send from" hint={sender ? <span className="flex flex-col items-start gap-1"><CheckBadge check={sender.check} /><span>{sender.check.message}</span></span> : "No sender configured"}>
            <Select value={sender?.id ?? ""} disabled={readOnly} onChange={(e) => { const v = e.target.value; update((d) => ({ ...d, sender_id: v })); }}
              options={senders.map((s) => ({ value: s.id, label: `${s.from_name ? `${s.from_name} <${s.from_email}>` : s.from_email}${s.is_default ? " · default" : ""}` }))} />
          </Field>
          <Field label="Subject" className="md:col-span-2 xl:col-span-1 2xl:col-span-2" error={byWhere.get("Subject")}
            hint="Use {{first_name}} for a personal subject; the fallback below is used when a tag has no value.">
            <Input maxLength={300} {...bind(draft.subject, (v) => update((d) => ({ ...d, subject: v })))} />
          </Field>
          <Field label="Subject when the name is unknown" error={byWhere.get("Subject fallback")}>
            <Input maxLength={300} placeholder="(optional)" {...bind(draft.subject_fallback ?? "", (v) => update((d) => ({ ...d, subject_fallback: v })))} />
          </Field>
          <Field label="Preheader (inbox preview text)" error={byWhere.get("Preheader")}
            hint={raw ? "Full templates carry their own preheader inside the HTML." : "The grey line after the subject in most inboxes."}>
            <Input maxLength={300} disabled={raw} {...bind(draft.preheader ?? "", (v) => update((d) => ({ ...d, preheader: v })))} />
          </Field>
          <div className="flex flex-wrap gap-x-8 gap-y-3 md:col-span-2 xl:col-span-1 2xl:col-span-2">
            <div className="flex flex-col gap-0.5">
              <Switch checked={draft.track_opens} disabled={readOnly} onChange={(e) => { const v = e.target.checked; update((d) => ({ ...d, track_opens: v })); }} label="Track opens" />
              <span className="pl-12 text-micro text-text-muted">A 1×1 image per recipient</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <Switch checked={draft.track_clicks} disabled={readOnly} onChange={(e) => { const v = e.target.checked; update((d) => ({ ...d, track_clicks: v })); }} label="Track clicks" />
              <span className="pl-12 text-micro text-text-muted">Wraps links to markdrop.in and allow-listed sites</span>
            </div>
          </div>
        </div>
      </Section>

      {!readOnly && <TagPicker tags={meta.tags} onInsert={insert} />}

      <Problems problems={problems} />

      {raw ? (
        <RawEditor doc={draft.doc as RawDoc} setRaw={setRaw} bind={bind} readOnly={readOnly} template={template} byWhere={byWhere} />
      ) : (
        <BlocksEditor doc={draft.doc as BlocksDoc} setBlocks={setBlocks} bind={bind} readOnly={readOnly} meta={meta} byWhere={byWhere} site={site} />
      )}
    </div>
  );
}

type Bind = (value: string, set: (v: string) => void) => {
  value: string; readOnly?: boolean; onChange: (e: ChangeEvent<FieldEl>) => void; onFocus: (e: FocusEvent<FieldEl>) => void;
};

function RawEditor({ doc, setRaw, bind, readOnly, template, byWhere }: {
  doc: RawDoc; setRaw: (fn: (d: RawDoc) => RawDoc) => void; bind: Bind; readOnly?: boolean; template?: TemplateInfo | null; byWhere: Map<string, string>;
}) {
  const tdoc = template?.doc.layout === "raw" ? template.doc : null;
  const matches = !!tdoc && tdoc.html === doc.html && tdoc.text === doc.text;
  const kb = (new Blob([doc.html]).size / 1024).toFixed(1);
  return (
    <Section
      id="email-body"
      label="2 · Body · full template"
      title={doc.source ? `From ${doc.source}` : "Custom HTML"}
      actions={readOnly ? undefined : tdoc ? (matches
        ? <Badge size="sm" tone="success" icon="check">Matches template</Badge>
        : <Button size="sm" variant="secondary" iconLeft="rotate" onClick={() => setRaw(() => ({ ...tdoc }))}>Reset to template</Button>) : undefined}
      bodyClassName="flex flex-col gap-4"
    >
      <p className="text-body text-text-secondary">
        The approved design, with merge tags ({"{{first_name}}"}, {"{{email}}"}, {"{{unsubscribe_url}}"}). Edit with care: the preview updates as
        you type, and it must keep an {"{{unsubscribe_url}}"} link.
      </p>
      <Field label={`HTML · ${kb} KB`} error={byWhere.get("HTML")}>
        <Textarea mono rows={18} spellCheck={false} className="text-caption" {...bind(doc.html, (v) => setRaw((d) => ({ ...d, html: v })))} />
      </Field>
      <Field label="Plain-text version" error={byWhere.get("Plain text")} hint="Sent alongside the HTML for clients that show text only. Left empty, it's derived from the HTML.">
        <Textarea mono rows={12} spellCheck={false} className="text-caption" {...bind(doc.text, (v) => setRaw((d) => ({ ...d, text: v })))} />
      </Field>
    </Section>
  );
}

function BlocksEditor({ doc, setBlocks, bind, readOnly, meta, byWhere, site }: {
  doc: BlocksDoc; setBlocks: (fn: (d: BlocksDoc) => BlocksDoc) => void; bind: Bind; readOnly?: boolean;
  meta: TemplatesResponse; byWhere: Map<string, string>; site: string;
}) {
  const labels = meta.blocks.labels;
  const fields = meta.blocks.fields;
  const setBlock = (id: string, patch: Partial<Block>) =>
    setBlocks((d) => ({ ...d, blocks: d.blocks.map((b) => (b.id === id ? ({ ...b, ...patch } as Block) : b)) }));
  const move = (i: number, by: -1 | 1) => setBlocks((d) => {
    const j = i + by;
    if (j < 0 || j >= d.blocks.length) return d;
    const blocks = [...d.blocks];
    [blocks[i], blocks[j]] = [blocks[j]!, blocks[i]!];
    return { ...d, blocks };
  });
  const dup = (i: number) => setBlocks((d) => {
    const blocks = [...d.blocks];
    blocks.splice(i + 1, 0, { ...d.blocks[i]!, id: newBlockId() });
    return { ...d, blocks };
  });
  const del = (i: number) => setBlocks((d) => ({ ...d, blocks: d.blocks.filter((_, k) => k !== i) }));
  const add = (t: BlockType) => setBlocks((d) => ({ ...d, blocks: [...d.blocks, emptyBlock(t, site)] }));

  return (
    <Section id="email-body" label="2 · Body · blocks" title="Content blocks" bodyClassName="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Top bar label" hint="Small label opposite the wordmark, e.g. Product update." error={byWhere.get("Top bar label")}>
          <Input maxLength={60} {...bind(doc.top_label, (v) => setBlocks((d) => ({ ...d, top_label: v })))} />
        </Field>
        <Field label="Footer (an Unsubscribe link is always added)" error={byWhere.get("Footer")}>
          <Textarea rows={2} maxLength={2000} {...bind(doc.footer, (v) => setBlocks((d) => ({ ...d, footer: v })))} />
        </Field>
      </div>
      <ol className="flex flex-col gap-3" aria-label="Blocks">
        {doc.blocks.map((b, i) => {
          const at = `Block ${i + 1} · ${labels[b.type] ?? b.type}`;
          const keys = fields[b.type] ?? [];
          return (
            <li key={b.id} className="min-w-0 rounded-lg border border-border bg-surface-inset">
              <div className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-1.5">
                <span className="min-w-0 flex-1 truncate text-caption">
                  <span className="font-mono text-accent-text">{String(i + 1).padStart(2, "0")}</span>
                  <span className="text-text"> · {labels[b.type] ?? b.type}</span>
                </span>
                {!readOnly && (
                  <span className="flex shrink-0 items-center">
                    <IconButton icon="arrowUp" label={`Move block ${i + 1} up`} size="sm" disabled={i === 0} onClick={() => move(i, -1)} />
                    <IconButton icon="arrowDown" label={`Move block ${i + 1} down`} size="sm" disabled={i === doc.blocks.length - 1} onClick={() => move(i, 1)} />
                    <IconButton icon="copy" label={`Duplicate block ${i + 1}`} size="sm" onClick={() => dup(i)} />
                    <IconButton icon="trash" label={`Delete block ${i + 1}`} size="sm" onClick={() => del(i)} />
                  </span>
                )}
              </div>
              {keys.length > 0 ? (
                <div className="grid gap-3 p-3 sm:grid-cols-2">
                  {keys.map((k) => {
                    const wide = k === "md" || k === "html" || (b.type === "hero" && k === "title");
                    const error = byWhere.get(`${at} · ${k}`);
                    const props = bind(b[k] ?? "", (v) => setBlock(b.id, { [k]: v }));
                    return (
                      <Field key={k} label={FIELD_LABEL[k] ?? k} error={error} className={wide ? "sm:col-span-2" : undefined}>
                        {AREA[k] ? (
                          <Textarea rows={Math.min(16, Math.max(AREA[k]!, (b[k] ?? "").split("\n").length + 1))} mono={MONO.has(k)} spellCheck={!MONO.has(k)} className={MONO.has(k) ? "text-caption" : undefined} {...props} />
                        ) : (
                          <Input mono={MONO.has(k)} spellCheck={!MONO.has(k)} {...props} />
                        )}
                      </Field>
                    );
                  })}
                </div>
              ) : (
                <p className="px-3 py-2 text-caption text-text-muted">A thin rule between sections.</p>
              )}
            </li>
          );
        })}
      </ol>
      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Add a block">
          <span className="text-eyebrow uppercase text-text-muted">Add block</span>
          {BLOCK_TYPES.map((t) => (
            <Button key={t} size="sm" variant="secondary" iconLeft="plus" onClick={() => add(t)}>{labels[t] ?? t}</Button>
          ))}
        </div>
      )}
    </Section>
  );
}
