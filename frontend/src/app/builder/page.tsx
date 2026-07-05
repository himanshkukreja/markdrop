"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import MarkdownPreview from "@/components/MarkdownPreview";
import MarkdownToolbar from "@/components/MarkdownToolbar";
import Modal from "@/components/Modal";
import { createDocument } from "@/lib/api";
import {
  SECTION_TEMPLATES,
  TEMPLATES_BY_ID,
  GROUP_ORDER,
  headingSlug,
  type SectionTemplate,
} from "@/lib/readmeSections";

interface SectionInstance {
  uid: string;
  templateId: string;
  content: string;
}

const STORAGE_KEY = "markdrop:builder:v1";

let _uidSeq = 0;
function nextUid(): string {
  _uidSeq += 1;
  return `s${Date.now().toString(36)}${_uidSeq.toString(36)}`;
}

function assemble(sections: SectionInstance[]): string {
  return sections
    .map((s) => s.content.replace(/\s+$/, ""))
    .filter((c) => c.length > 0)
    .join("\n\n");
}

/** Build a nested TOC from the ## / ### headings of every OTHER section. */
function generateToc(sections: SectionInstance[], selfUid: string): string {
  const lines: string[] = [];
  for (const s of sections) {
    if (s.uid === selfUid) continue;
    for (const raw of s.content.split("\n")) {
      const m = /^(#{2,3})\s+(.+)$/.exec(raw.trim());
      if (!m) continue;
      const level = m[1].length;
      const text = m[2].replace(/[#*`]/g, "").trim();
      if (!text) continue;
      const indent = level === 3 ? "  " : "";
      lines.push(`${indent}- [${text}](#${headingSlug(text)})`);
    }
  }
  return "## Table of Contents\n\n" + (lines.join("\n") || "- [Section](#section)");
}

// ── Sortable row ────────────────────────────────────────────────────────────
function SectionRow({
  inst,
  template,
  selected,
  onSelect,
  onDelete,
}: {
  inst: SectionInstance;
  template: SectionTemplate | undefined;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: inst.uid });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group flex items-center gap-1 rounded-lg border text-sm transition-colors ${
        selected
          ? "border-blue-500/60 bg-blue-50 dark:bg-blue-950/30 vscode:bg-[#264f78]/30"
          : "border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] bg-white dark:bg-gray-900/40 vscode:bg-[#252526] hover:border-gray-300 dark:hover:border-gray-700"
      }`}
    >
      <button
        {...attributes}
        {...listeners}
        className="shrink-0 px-1.5 py-2 cursor-grab active:cursor-grabbing text-gray-300 dark:text-gray-600 hover:text-gray-500 dark:hover:text-gray-400"
        title="Drag to reorder"
        aria-label="Drag to reorder"
      >
        <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
          <circle cx="7" cy="4" r="1.4" /><circle cx="13" cy="4" r="1.4" />
          <circle cx="7" cy="10" r="1.4" /><circle cx="13" cy="10" r="1.4" />
          <circle cx="7" cy="16" r="1.4" /><circle cx="13" cy="16" r="1.4" />
        </svg>
      </button>
      <button onClick={onSelect} className="flex-1 min-w-0 flex items-center gap-2 py-2 text-left">
        <span className="shrink-0">{template?.icon ?? "📄"}</span>
        <span className="truncate text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4]">
          {template?.name ?? inst.templateId}
        </span>
      </button>
      <button
        onClick={onDelete}
        className="shrink-0 px-2 py-2 text-gray-300 dark:text-gray-600 hover:text-red-500 dark:hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
        title="Remove section"
        aria-label="Remove section"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

type Pane = "sections" | "edit" | "preview";

export default function BuilderPage() {
  const router = useRouter();

  const [title, setTitle] = useState("");
  const [sections, setSections] = useState<SectionInstance[]>([]);
  const [selectedUid, setSelectedUid] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const [showCatalog, setShowCatalog] = useState(false);
  const [catalogSearch, setCatalogSearch] = useState("");
  const [previewScope, setPreviewScope] = useState<"full" | "section">("full");
  const [pane, setPane] = useState<Pane>("sections");

  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const editorRef = useRef<HTMLTextAreaElement>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // ── Load draft (or seed with a Title section) ──────────────────────────────
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw) as { title?: string; sections?: SectionInstance[] };
        if (data.sections?.length) {
          setTitle(data.title ?? "");
          setSections(data.sections);
          setSelectedUid(data.sections[0].uid);
          setLoaded(true);
          return;
        }
      }
    } catch {
      /* ignore corrupt draft */
    }
    const seed: SectionInstance = {
      uid: nextUid(),
      templateId: "title-and-description",
      content: TEMPLATES_BY_ID["title-and-description"].markdown,
    };
    setSections([seed]);
    setSelectedUid(seed.uid);
    setLoaded(true);
  }, []);

  // ── Autosave ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ title, sections }));
    } catch {
      /* quota — ignore */
    }
  }, [title, sections, loaded]);

  const selected = useMemo(
    () => sections.find((s) => s.uid === selectedUid) ?? null,
    [sections, selectedUid]
  );
  const selectedTemplate = selected ? TEMPLATES_BY_ID[selected.templateId] : undefined;
  const assembled = useMemo(() => assemble(sections), [sections]);

  const addSection = useCallback((tpl: SectionTemplate) => {
    const inst: SectionInstance = { uid: nextUid(), templateId: tpl.id, content: tpl.markdown };
    setSections((prev) => [...prev, inst]);
    setSelectedUid(inst.uid);
    setShowCatalog(false);
    setCatalogSearch("");
    setPane("edit");
  }, []);

  const deleteSection = useCallback(
    (uid: string) => {
      setSections((prev) => {
        const idx = prev.findIndex((s) => s.uid === uid);
        const next = prev.filter((s) => s.uid !== uid);
        if (selectedUid === uid) {
          const fallback = next[idx] ?? next[idx - 1] ?? next[0] ?? null;
          setSelectedUid(fallback ? fallback.uid : null);
        }
        return next;
      });
    },
    [selectedUid]
  );

  const updateSelected = useCallback(
    (content: string) => {
      if (!selectedUid) return;
      setSections((prev) => prev.map((s) => (s.uid === selectedUid ? { ...s, content } : s)));
    },
    [selectedUid]
  );

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    setSections((prev) => {
      const from = prev.findIndex((s) => s.uid === active.id);
      const to = prev.findIndex((s) => s.uid === over.id);
      return from < 0 || to < 0 ? prev : arrayMove(prev, from, to);
    });
  }

  async function handlePublish() {
    if (!assembled.trim()) return;
    setPublishing(true);
    setError("");
    try {
      const doc = await createDocument(title, assembled);
      sessionStorage.setItem(`secret:${doc.slug}`, doc.edit_secret);
      router.push(`/${doc.slug}?new=1`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setPublishing(false);
    }
  }

  function handleDownload() {
    const blob = new Blob([assembled], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "README.md";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(assembled);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  const catalogGroups = useMemo(() => {
    const q = catalogSearch.trim().toLowerCase();
    return GROUP_ORDER.map((group) => ({
      group,
      items: SECTION_TEMPLATES.filter(
        (t) => t.group === group && (!q || t.name.toLowerCase().includes(q))
      ),
    })).filter((g) => g.items.length > 0);
  }, [catalogSearch]);

  const btnGhost =
    "px-3 py-1.5 text-xs rounded-lg border border-gray-300 dark:border-gray-600 vscode:border-[#3c3c3c] hover:bg-gray-100 dark:hover:bg-gray-800 vscode:hover:bg-[#2d2d2d] text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4] transition-colors disabled:opacity-40";

  const paneToggle = (p: Pane, label: string) => (
    <button
      onClick={() => setPane(p)}
      className={`flex-1 py-2 text-sm border-b-2 -mb-px transition-colors ${
        pane === p
          ? "border-blue-500 text-blue-500 dark:text-blue-400"
          : "border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-3">
      {/* Top bar */}
      <div className="no-print flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 shrink-0">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="README title (optional)"
          maxLength={200}
          className="flex-1 bg-transparent border-b border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] focus:border-blue-500 outline-none py-1 text-base sm:text-lg font-semibold text-gray-800 dark:text-gray-200 vscode:text-[#d4d4d4] placeholder-gray-400 transition-colors"
        />
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={handleCopy} disabled={!assembled.trim()} className={btnGhost}>
            {copied ? "Copied ✓" : "Copy"}
          </button>
          <button onClick={handleDownload} disabled={!assembled.trim()} className={btnGhost}>
            Download .md
          </button>
          <button
            onClick={handlePublish}
            disabled={publishing || !assembled.trim()}
            className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm font-medium text-white transition-colors"
          >
            {publishing ? "Publishing…" : "Publish"}
          </button>
        </div>
      </div>
      {error && <p className="no-print text-red-500 text-sm shrink-0">{error}</p>}

      {/* Mobile pane switcher */}
      <div className="no-print flex lg:hidden border-b border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] shrink-0">
        {paneToggle("sections", "Sections")}
        {paneToggle("edit", "Edit")}
        {paneToggle("preview", "Preview")}
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 grid gap-3 lg:grid-cols-[15rem_minmax(0,1fr)_minmax(0,1fr)]">
        {/* Left rail — sections */}
        <div className={`${pane === "sections" ? "flex" : "hidden"} lg:flex flex-col min-h-0`}>
          <div className="flex items-center justify-between mb-2 shrink-0">
            <span className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              Sections
            </span>
            <button
              onClick={() => setShowCatalog(true)}
              className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              Add
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto space-y-1.5 pr-1">
            {sections.length === 0 ? (
              <p className="text-xs text-gray-400 dark:text-gray-600 py-6 text-center">
                No sections yet. Click <span className="font-medium">Add</span> to start.
              </p>
            ) : (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                <SortableContext items={sections.map((s) => s.uid)} strategy={verticalListSortingStrategy}>
                  {sections.map((inst) => (
                    <SectionRow
                      key={inst.uid}
                      inst={inst}
                      template={TEMPLATES_BY_ID[inst.templateId]}
                      selected={inst.uid === selectedUid}
                      onSelect={() => {
                        setSelectedUid(inst.uid);
                        setPane("edit");
                      }}
                      onDelete={() => deleteSection(inst.uid)}
                    />
                  ))}
                </SortableContext>
              </DndContext>
            )}
            <button
              onClick={() => setShowCatalog(true)}
              className="w-full mt-1 py-2 rounded-lg border border-dashed border-gray-300 dark:border-gray-700 vscode:border-[#3c3c3c] text-xs text-gray-500 dark:text-gray-400 hover:border-blue-400 hover:text-blue-500 transition-colors"
            >
              + Add section
            </button>
          </div>
        </div>

        {/* Center — editor */}
        <div className={`${pane === "edit" ? "flex" : "hidden"} lg:flex flex-col min-h-0`}>
          {selected ? (
            <>
              <div className="flex items-center justify-between mb-2 shrink-0">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4] flex items-center gap-1.5">
                  <span>{selectedTemplate?.icon}</span>
                  {selectedTemplate?.name ?? "Section"}
                </span>
                {selectedTemplate?.autoToc && (
                  <button
                    onClick={() => updateSelected(generateToc(sections, selected.uid))}
                    className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
                    title="Rebuild the list from your other sections' headings"
                  >
                    ↻ Generate from headings
                  </button>
                )}
              </div>
              <div className="shrink-0 rounded-t-lg overflow-hidden border border-b-0 border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c]">
                <MarkdownToolbar textareaRef={editorRef} onChange={updateSelected} />
              </div>
              <textarea
                ref={editorRef}
                value={selected.content}
                onChange={(e) => updateSelected(e.target.value)}
                className="flex-1 min-h-0 w-full bg-gray-50 dark:bg-gray-900 vscode:bg-[#1e1e1e] border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] rounded-b-lg p-3 sm:p-4 font-mono text-sm text-gray-800 dark:text-gray-200 vscode:text-[#d4d4d4] resize-none focus:outline-none focus:border-blue-500 transition-colors"
                spellCheck={false}
              />
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-sm text-gray-400 dark:text-gray-600 border border-dashed border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] rounded-lg">
              Select a section to edit, or add one.
            </div>
          )}
        </div>

        {/* Right — preview */}
        <div className={`${pane === "preview" ? "flex" : "hidden"} lg:flex flex-col min-h-0`}>
          <div className="flex items-center justify-between mb-2 shrink-0">
            <span className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              Preview
            </span>
            <div className="flex rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] text-[11px]">
              {(["full", "section"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setPreviewScope(s)}
                  className={`px-2.5 py-1 transition-colors ${
                    previewScope === s
                      ? "bg-blue-600 text-white"
                      : "text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
                  }`}
                >
                  {s === "full" ? "Full README" : "This section"}
                </button>
              ))}
            </div>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto bg-gray-50/50 dark:bg-gray-900/50 vscode:bg-[#252526] border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] rounded-lg p-4 sm:p-6">
            {(() => {
              const md = previewScope === "full" ? assembled : selected?.content ?? "";
              return md.trim() ? (
                <MarkdownPreview content={md} />
              ) : (
                <p className="text-gray-400 dark:text-gray-600 text-sm">Nothing to preview yet.</p>
              );
            })()}
          </div>
        </div>
      </div>

      <p className="no-print shrink-0 text-xs text-gray-400 dark:text-gray-500">
        Drafts autosave in your browser. Publish to get a shareable markdrop.in link — Mermaid diagrams
        and math render live.
      </p>

      {/* Catalog modal */}
      {showCatalog && (
        <Modal title="Add a section" onClose={() => setShowCatalog(false)}>
          <div className="space-y-4">
            <input
              type="text"
              value={catalogSearch}
              onChange={(e) => setCatalogSearch(e.target.value)}
              placeholder="Search sections…"
              autoFocus
              className="w-full bg-gray-50 dark:bg-gray-900 vscode:bg-[#2d2d2d] border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500 transition-colors"
            />
            <div className="max-h-[55vh] overflow-y-auto space-y-4 pr-1">
              {catalogGroups.map(({ group, items }) => (
                <div key={group}>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1.5">
                    {group}
                  </p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {items.map((tpl) => (
                      <button
                        key={tpl.id}
                        onClick={() => addSection(tpl)}
                        className="flex items-center gap-2 px-2.5 py-2 rounded-lg border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] bg-white dark:bg-gray-900/40 vscode:bg-[#252526] hover:border-blue-400 hover:bg-blue-50/50 dark:hover:bg-blue-950/20 text-left text-sm text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4] transition-colors"
                      >
                        <span className="shrink-0">{tpl.icon}</span>
                        <span className="truncate">{tpl.name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {catalogGroups.length === 0 && (
                <p className="text-sm text-gray-400 py-6 text-center">No sections match “{catalogSearch}”.</p>
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
