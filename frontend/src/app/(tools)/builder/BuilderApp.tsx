"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  ConfirmDialog,
  Drawer,
  Dropdown,
  EmptyState,
  Icon,
  IconButton,
  Input,
  Tabs,
  Tag,
  VisuallyHidden,
  announce,
  copyText,
  cx,
  useToast,
  type MenuItem,
} from "@/components/ui";
import { EditorFrame } from "@/components/kit/EditorFrame";
import {
  DEFAULT_PUBLISH_SETTINGS,
  publishSummary,
  useIsClient,
  useMediaQuery,
  type PublishSettingsValue,
} from "@/components/kit/publish-utils";
import MarkdownPreview from "@/components/MarkdownPreview";
import MarkdownToolbar from "@/components/MarkdownToolbar";
import { TEMPLATES_BY_ID, type SectionTemplate } from "@/lib/readmeSections";
import { SectionIcon } from "@/lib/readmeSectionIcons";
import Catalog from "./Catalog";
import PublishDialog from "./PublishDialog";
import SectionList, { sectionName } from "./SectionList";
import {
  TITLE_TEMPLATE,
  assemble,
  clearDraft,
  generateToc,
  newSection,
  readDraft,
  syncTitle,
  writeDraft,
  type SectionInstance,
} from "./model";
import styles from "./builder.module.css";

type Pane = "sections" | "edit" | "preview";
type Scope = "full" | "section";

const DESKTOP_QUERY = "(min-width: 1024px)";

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** One rendered section of the preview. Memoised on its markdown so typing re-renders one block. */
const PreviewSection = memo(function PreviewSection({ uid, content }: { uid: string; content: string }) {
  return (
    <div className={styles.section} data-section={uid}>
      <MarkdownPreview content={content} />
    </div>
  );
});

export default function BuilderApp() {
  const toast = useToast();
  const isClient = useIsClient();
  const desktop = useMediaQuery(DESKTOP_QUERY);

  const [title, setTitle] = useState("");
  const titleRef = useRef("");
  const [sections, setSections] = useState<SectionInstance[]>([]);
  const [selectedUid, setSelectedUid] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>("full");
  const [pane, setPane] = useState<Pane>("sections");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishMounted, setPublishMounted] = useState(false);
  const [settings, setSettings] = useState<PublishSettingsValue>(DEFAULT_PUBLISH_SETTINGS);

  const editorRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [flashUid, setFlashUid] = useState<string | null>(null);

  // ── Load the draft (or seed with a title section) ─────────────────────
  useEffect(() => {
    const draft = readDraft();
    if (draft?.sections?.length) {
      const t = draft.title ?? "";
      titleRef.current = t;
      setTitle(t);
      // A draft from before the title drove the H1 still says "Project Title": bring it in step.
      setSections(syncTitle(draft.sections, "", t));
      setSelectedUid(draft.sections[0].uid);
    } else {
      const seed = newSection(TITLE_TEMPLATE);
      setSections([seed]);
      setSelectedUid(seed.uid);
    }
    setLoaded(true);
  }, []);

  // ── Autosave (same key and shape as ever: { title, sections }) ────────
  useEffect(() => {
    if (loaded) writeDraft(title, sections);
  }, [title, sections, loaded]);

  const selected = useMemo(() => sections.find((s) => s.uid === selectedUid) ?? null, [sections, selectedUid]);
  const selectedTemplate = selected ? TEMPLATES_BY_ID[selected.templateId] : undefined;
  const assembled = useMemo(() => assemble(sections), [sections]);
  const hasContent = assembled.trim().length > 0;
  const usedCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of sections) m[s.templateId] = (m[s.templateId] ?? 0) + 1;
    return m;
  }, [sections]);

  const changeTitle = useCallback((next: string) => {
    const prev = titleRef.current;
    titleRef.current = next;
    setTitle(next);
    setSections((s) => syncTitle(s, prev, next));
  }, []);

  const addSection = useCallback((tpl: SectionTemplate) => {
    const inst = newSection(tpl.id, titleRef.current);
    setSections((prev) => [...prev, inst]);
    setSelectedUid(inst.uid);
    setFlashUid(inst.uid);
    setSheetOpen(false);
    setPane("edit");
    announce(`Added ${tpl.name}.`);
  }, []);

  const updateSelected = useCallback(
    (content: string) => {
      if (!selectedUid) return;
      setSections((prev) => prev.map((s) => (s.uid === selectedUid ? { ...s, content } : s)));
    },
    [selectedUid],
  );

  const focusRow = (uid: string | null) => {
    requestAnimationFrame(() => {
      const target = uid
        ? document.querySelector<HTMLElement>(`[data-select-uid="${uid}"]`)
        : Array.from(document.querySelectorAll<HTMLElement>("[data-builder-add]")).find((el) => el.offsetParent !== null);
      target?.focus();
    });
  };

  const moveSection = useCallback(
    (from: number, to: number, via: "drag" | "menu") => {
      if (to < 0 || to >= sections.length || from === to) return;
      const next = sections.slice();
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      setSections(next);
      if (via === "menu") announce(`Moved ${sectionName(item)} to position ${to + 1} of ${next.length}.`);
    },
    [sections],
  );

  const duplicateSection = useCallback(
    (uid: string) => {
      const i = sections.findIndex((s) => s.uid === uid);
      if (i < 0) return;
      const copy = { ...newSection(sections[i].templateId), content: sections[i].content };
      setSections([...sections.slice(0, i + 1), copy, ...sections.slice(i + 1)]);
      setSelectedUid(copy.uid);
      setFlashUid(copy.uid);
      announce(`Duplicated ${sectionName(sections[i])}.`);
    },
    [sections],
  );

  const removeSection = useCallback(
    (uid: string) => {
      const i = sections.findIndex((s) => s.uid === uid);
      if (i < 0) return;
      const removed = sections[i];
      const next = sections.filter((s) => s.uid !== uid);
      const fallback = next[i] ?? next[i - 1] ?? null;
      setSections(next);
      if (selectedUid === uid) setSelectedUid(fallback?.uid ?? null);
      focusRow(fallback?.uid ?? null);
      toast.info(`Removed ${sectionName(removed)}`, {
        action: {
          label: "Undo",
          onClick: () => {
            setSections((cur) => (cur.some((s) => s.uid === removed.uid) ? cur : [...cur.slice(0, i), removed, ...cur.slice(i)]));
            setSelectedUid(removed.uid);
            focusRow(removed.uid);
          },
        },
      });
    },
    [sections, selectedUid, toast],
  );

  const resetAll = useCallback(() => {
    clearDraft();
    const seed = newSection(TITLE_TEMPLATE);
    titleRef.current = "";
    setTitle("");
    setSections([seed]);
    setSelectedUid(seed.uid);
    setQuery("");
    setScope("full");
    setSettings(DEFAULT_PUBLISH_SETTINGS);
    setResetOpen(false);
    setPane("sections");
    announce("Builder reset.");
  }, []);

  function download() {
    const blob = new Blob([assembled], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "README.md";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function copyMarkdown() {
    if (await copyText(assembled)) toast.success("Copied the README markdown");
    else toast.error("Couldn't copy. Select the text in an editor and copy it from there.");
  }

  function openPublish() {
    setPublishMounted(true);
    setPublishOpen(true);
  }

  // ── A new section: scroll the preview to it and highlight it once. ─────
  useEffect(() => {
    if (!flashUid) return;
    const box = previewRef.current;
    const el = box?.querySelector<HTMLElement>(`[data-section="${flashUid}"]`);
    setFlashUid(null);
    if (!box || !el || el.offsetParent === null) return;
    const top = box.scrollTop + (el.getBoundingClientRect().top - box.getBoundingClientRect().top) - 16;
    box.scrollTo({ top: Math.max(0, top), behavior: reducedMotion() ? "auto" : "smooth" });
    el.classList.remove(styles.flash);
    void el.offsetWidth; // restart the animation
    el.classList.add(styles.flash);
    // Not cleared by this effect's cleanup: clearing `flashUid` re-runs it straight away.
    window.setTimeout(() => el.classList.remove(styles.flash), 1000);
  }, [flashUid, sections]);

  const builderMenu: MenuItem[] = [
    { label: "Copy markdown", icon: "copy", disabled: !hasContent, onClick: copyMarkdown },
    { label: "Download README.md", icon: "download", disabled: !hasContent, onClick: download },
    { label: "Reset builder…", icon: "trash", danger: true, separated: true, onClick: () => setResetOpen(true) },
  ];

  const summary = publishSummary(settings, { isClient });
  const count = sections.length;
  const countLabel = `${count} ${count === 1 ? "section" : "sections"}`;
  const paneClass = (p: Pane) => (pane === p ? "flex" : "hidden");
  // On phones the three columns are tab panels; on desktop they're all visible, so no tab roles.
  const panelProps = (p: Pane) =>
    isClient && !desktop ? { role: "tabpanel" as const, id: `builder-panel-${p}`, "aria-labelledby": `builder-tab-${p}` } : {};

  const previewSections = scope === "full" ? sections : selected ? [selected] : [];
  const previewEmpty = !previewSections.some((s) => s.content.trim());
  const lineCount = selected ? selected.content.split("\n").length : 0;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 lg:h-[calc(100dvh-5.5rem)] lg:flex-none lg:gap-4">
      <VisuallyHidden as="h1">README builder</VisuallyHidden>

      {/* ── Top bar ─────────────────────────────────────────────────── */}
      <div className="no-print flex min-w-0 shrink-0 items-center gap-2 lg:gap-3">
        <Input
          value={title}
          onChange={(e) => changeTitle(e.target.value)}
          placeholder="README title (optional)"
          aria-label="README title (optional)"
          maxLength={200}
          dir="auto"
          wrapClassName="min-w-0 flex-1"
          className="h-11 min-w-0 text-body-strong lg:h-10"
        />
        <Dropdown
          align="right"
          aria-label="Builder actions"
          trigger={<IconButton icon="more" label="Builder actions" variant="secondary" className="h-11 w-11 lg:h-10 lg:w-10" />}
          items={builderMenu}
        />
        <Button variant="primary" className="h-10 max-lg:hidden" iconLeft="globe" onClick={openPublish} aria-haspopup="dialog">
          Publish…
        </Button>
      </div>

      {/* ── Phone: Sections / Edit / Preview ─────────────────────────── */}
      <Tabs
        variant="pill"
        className="no-print w-full shrink-0 lg:hidden [&>*]:min-h-11 [&>*]:flex-1 [&>*]:justify-center"
        items={[
          { value: "sections", label: "Sections", count },
          { value: "edit", label: "Edit", disabled: !selected },
          { value: "preview", label: "Preview" },
        ]}
        value={pane}
        onChange={(v) => setPane(v as Pane)}
        idPrefix="builder"
        aria-label="Builder view"
      />

      <div className="grid min-h-0 min-w-0 flex-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)_minmax(0,1fr)] lg:gap-6">
        {/* ── Left: Your README + Add a section ─────────────────────── */}
        <section {...panelProps("sections")} aria-label={isClient && !desktop ? undefined : "Sections"} className={cx(paneClass("sections"), "no-print min-h-0 min-w-0 flex-col lg:flex")}>
          <div className="flex shrink-0 items-center justify-between gap-3">
            <h2 className="text-eyebrow text-text-muted">Your README</h2>
            <Tag>{countLabel}</Tag>
          </div>
          <div className="mt-2 min-h-0 shrink-0 lg:max-h-[55%] lg:overflow-y-auto lg:p-0.5">
            {count === 0 ? (
              <p className="rounded-lg border border-dashed border-border-strong px-4 py-6 text-center text-body text-text-muted">
                No sections yet. Add one to start.
              </p>
            ) : (
              <SectionList
                sections={sections}
                selectedUid={selectedUid}
                onSelect={(uid) => {
                  setSelectedUid(uid);
                  setPane("edit");
                }}
                onMove={moveSection}
                onDuplicate={duplicateSection}
                onRemove={removeSection}
              />
            )}
          </div>
          <Button variant="secondary" size="lg" block iconLeft="plus" className="mt-3 lg:hidden" onClick={() => setSheetOpen(true)} aria-haspopup="dialog" data-builder-add="">
            Add a section
          </Button>
          <div className="mt-4 hidden min-h-0 flex-1 flex-col border-t border-border pt-4 lg:flex">
            <h2 className="mb-2 shrink-0 text-eyebrow text-text-muted">Add a section</h2>
            <Catalog usedCounts={usedCounts} onAdd={addSection} query={query} onQueryChange={setQuery} className="flex-1" />
          </div>
        </section>

        {/* ── Centre: the selected section's editor ──────────────────── */}
        <section {...panelProps("edit")} aria-label={isClient && !desktop ? undefined : "Editor"} className={cx(paneClass("edit"), "no-print min-h-0 min-w-0 flex-col lg:flex")}>
          {selected ? (
            <>
              <div className="mb-3 flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className={styles.tile} aria-hidden="true">
                    <SectionIcon id={selected.templateId} size={16} />
                  </span>
                  <h2 className="min-w-0 truncate text-h4 text-text">{selectedTemplate?.name ?? "Section"}</h2>
                </div>
                {selectedTemplate?.autoToc && (
                  <Button
                    variant="ghost"
                    size="sm"
                    iconLeft="refresh"
                    className="max-lg:h-11"
                    onClick={() => {
                      updateSelected(generateToc(sections, selected.uid));
                      announce("Table of contents rebuilt from your other sections' headings.");
                    }}
                    title="Rebuild the list from your other sections' headings"
                  >
                    Generate from headings
                  </Button>
                )}
              </div>
              <EditorFrame
                className="min-h-0 flex-1 max-lg:min-h-[60dvh]"
                tab={<span className="max-lg:hidden">README.md</span>}
                icon={null}
                toolbar={<MarkdownToolbar textareaRef={editorRef} onChange={updateSelected} bare large={isClient && !desktop} className="overflow-x-auto [scrollbar-width:none]" />}
                status={
                  <>
                    <span className="inline-flex items-center gap-1.5">
                      <Icon name="check" size={12} />
                      Saved in this browser
                    </span>
                    <span className="ml-auto tabular-nums">
                      {lineCount} {lineCount === 1 ? "line" : "lines"}
                    </span>
                  </>
                }
              >
                <textarea
                  ref={editorRef}
                  value={selected.content}
                  onChange={(e) => updateSelected(e.target.value)}
                  className={styles.textarea}
                  spellCheck={false}
                  aria-label={`${selectedTemplate?.name ?? "Section"} markdown`}
                />
              </EditorFrame>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <EmptyState
                icon="builder"
                title="Pick a section to edit"
                description="Sections you add appear in Your README. Drag to reorder."
                actions={
                  <Button variant="primary" iconLeft="plus" onClick={() => addSection(TEMPLATES_BY_ID[TITLE_TEMPLATE])}>
                    Add title and description
                  </Button>
                }
              />
            </div>
          )}
        </section>

        {/* ── Right: preview ─────────────────────────────────────────── */}
        <section {...panelProps("preview")} aria-label={isClient && !desktop ? undefined : "Preview"} className={cx(paneClass("preview"), "min-h-0 min-w-0 flex-col lg:flex")}>
          <div className="no-print mb-3 flex min-h-10 shrink-0 items-center justify-between gap-3">
            <VisuallyHidden as="h2">Preview</VisuallyHidden>
            <Tabs
              variant="pill"
              size="sm"
              items={[
                { value: "full", label: "Full README" },
                { value: "section", label: "This section", disabled: !selected },
              ]}
              value={scope}
              onChange={(v) => setScope(v as Scope)}
              aria-label="Preview scope"
              className="max-lg:[&>*]:min-h-11"
            />
            <span className="hidden text-caption text-text-muted xl:inline">What readers will see</span>
          </div>
          <div
            ref={previewRef}
            className="min-h-0 flex-1 rounded-xl border border-border bg-surface p-5 lg:overflow-y-auto lg:p-6"
            aria-live="off"
          >
            {previewEmpty ? (
              <p className="text-body text-text-muted">Nothing to preview yet.</p>
            ) : (
              previewSections.map((s) => (s.content.trim() ? <PreviewSection key={s.uid} uid={s.uid} content={s.content} /> : null))
            )}
          </div>
        </section>
      </div>

      {/* ── Phone: the sticky publish bar ──────────────────────────────── */}
      <div className={cx(styles.dock, "no-print lg:hidden")}>
        <p className="mb-2 flex min-w-0 items-center gap-1.5 text-caption text-text-secondary">
          <Icon name={settings.access === "private" ? "lock" : settings.access === "workspace" ? "users" : "globe"} size={14} />
          <span className="truncate">{summary.text}</span>
        </p>
        <Button variant="primary" size="lg" block onClick={openPublish} aria-haspopup="dialog">
          Publish…
        </Button>
      </div>

      {/* ── Overlays ────────────────────────────────────────────────── */}
      <Drawer open={sheetOpen} onClose={() => setSheetOpen(false)} side="bottom" title="Add a section" bodyClassName="px-0 pt-0">
        <Catalog usedCounts={usedCounts} onAdd={addSection} query={query} onQueryChange={setQuery} variant="sheet" />
      </Drawer>

      <ConfirmDialog
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        onConfirm={resetAll}
        title="Reset builder?"
        body={
          <>
            This clears your title and all <strong className="text-text">{count}</strong> {count === 1 ? "section" : "sections"}, and can&apos;t be undone.
            You&apos;ll start fresh with a single title section.
          </>
        }
        confirmLabel="Reset everything"
        tone="danger"
      />

      {publishMounted && (
        <PublishDialog
          open={publishOpen}
          onClose={() => setPublishOpen(false)}
          title={title}
          onTitleChange={changeTitle}
          settings={settings}
          onSettingsChange={setSettings}
          markdown={assembled}
          sectionCount={count}
        />
      )}
    </div>
  );
}
