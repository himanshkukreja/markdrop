"use client";

/**
 * The "Markdrop file" block (`::markdrop{src=…}`): a Markdrop file that renders in the page. Empty,
 * it offers the picker (your files, the guide's workspace, a pasted link, an upload); filled, it is
 * the live block as readers will see it (the engine's own MarkdropEmbed, without analytics), with
 * its settings under it: title, text version, display, size, version, and whether the guide's
 * readers can see the file at all (with "anyone with the link" one click away when that's yours to
 * change).
 *
 * The host provides the API (DocsEditorProps.markdrop); without it the block still previews
 * (production addresses) and its link can be typed.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { Alert, Badge, Button, Dialog, FileIcon, Icon, IconButton, Input, Progress, SegmentedControl, Select, Spinner, Tabs, Textarea, useToast } from "@/components/ui";
import { MarkdropEmbed, type MarkdropEmbedConfig } from "@/docs/client/MarkdropEmbed";
import { embedAttrs, formatBytes, parseMarkdropSrc } from "@/docs/embed.mjs";
import { uploadUrl, useHost } from "../host";
import type { MarkdropFileInfo, MarkdropFilesHost, MarkdropLibraryItem, MarkdropLibraryType } from "../types";
import { cx } from "./shared";

const FALLBACK_CONFIG: MarkdropEmbedConfig = {
  api: process.env.NEXT_PUBLIC_API_URL || "https://api.markdrop.in",
  app: "https://markdrop.in",
  files: null,
  site: "",
  guide: "",
  track: false,
};

/** One check per link per session (the picker and every block of a page share it). */
const infoCache = new Map<string, Promise<MarkdropFileInfo>>();
function checkOnce(host: MarkdropFilesHost, src: string, fresh = false): Promise<MarkdropFileInfo> {
  if (fresh) infoCache.delete(src);
  let p = infoCache.get(src);
  if (!p) {
    p = host.check(src);
    infoCache.set(src, p);
    p.catch(() => infoCache.delete(src));
  }
  return p;
}

const RENDERER_ICON: Record<string, string> = { bundle: "zip", doc: "text" };
function KindIcon({ renderer, size = 20 }: { renderer: string; size?: number }) {
  const r = RENDERER_ICON[renderer] ?? renderer;
  return <FileIcon renderer={(["pdf", "sheet", "docx", "pptx", "text", "video", "audio", "html", "image", "zip"].includes(r) ? r : null) as never} size={size} />;
}

const LIVE = new Set(["html", "bundle", "pdf", "video"]);
const KIND_LABEL: Record<string, string> = { html: "Interactive page", bundle: "Website", pdf: "PDF", video: "Video", doc: "Markdrop document" };

function ago(iso?: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d < 31 ? `${d} d ago` : new Date(t).toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" });
}

const REASON_SHORT: Record<string, string> = {
  private: "Private",
  signin: "Members only",
  password: "Password",
  encrypted: "Encrypted",
  unavailable: "Unavailable",
};

/* ── the picker ──────────────────────────────────────────────────────────── */

type PickTab = "mine" | "workspace" | "link" | "upload";
const TYPES: Array<{ value: MarkdropLibraryType; label: string }> = [
  { value: "all", label: "All" },
  { value: "html", label: "Interactive" },
  { value: "bundle", label: "Websites" },
  { value: "pdf", label: "PDFs" },
  { value: "video", label: "Videos" },
  { value: "doc", label: "Documents" },
];

export function MarkdropPicker({ open, onClose, onPick, host }: { open: boolean; onClose: () => void; onPick: (info: MarkdropFileInfo) => void; host: MarkdropFilesHost }) {
  const toast = useToast();
  const [tab, setTab] = useState<PickTab>("mine");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [type, setType] = useState<MarkdropLibraryType>("all");
  const [items, setItems] = useState<MarkdropLibraryItem[] | null>(null);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [gate, setGate] = useState<MarkdropFileInfo | null>(null);
  const [sharing, setSharing] = useState(false);
  const [link, setLink] = useState("");
  const [linkErr, setLinkErr] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const searchId = useId();

  useEffect(() => {
    const t = window.setTimeout(() => setQuery(q.trim()), 250);
    return () => window.clearTimeout(t);
  }, [q]);

  const scope = tab === "workspace" ? "workspace" : "mine";
  useEffect(() => {
    if (!open || (tab !== "mine" && tab !== "workspace")) return;
    let live = true;
    setLoading(true);
    setError("");
    host
      .library({ scope, q: query || undefined, type, page: 1 })
      .then((r) => {
        if (!live) return;
        setItems(r.items);
        setPage(1);
        setPages(r.pages);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : "Couldn't load your files."))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [open, tab, scope, query, type, host]);

  const more = async () => {
    setLoading(true);
    try {
      const r = await host.library({ scope, q: query || undefined, type, page: page + 1 });
      setItems((xs) => [...(xs ?? []), ...r.items]);
      setPage(r.page);
      setPages(r.pages);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't load more files.");
    } finally {
      setLoading(false);
    }
  };

  const choose = async (src: string) => {
    setBusy(src);
    try {
      const info = await checkOnce(host, src, true);
      if (!info.embeddable) {
        toast.error("That kind of file can't be shown in a guide. Pick an HTML page, a PDF, a video or a document.");
        return;
      }
      if (info.public) onPick(info);
      else setGate(info);
    } catch (e) {
      const m = e instanceof Error ? e.message : "Couldn't open that file.";
      if (tab === "link") setLinkErr(m);
      else toast.error(m);
    } finally {
      setBusy(null);
    }
  };

  const share = async () => {
    if (!gate) return;
    setSharing(true);
    try {
      const after = await host.share(gate.src);
      infoCache.set(after.src, Promise.resolve(after));
      host.onEvent?.("shared", { renderer: after.renderer });
      toast.success(<>Anyone with the link can now view “<span className="ph-sensitive ph-mask">{after.title}</span>”.</>);
      onPick(after);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't change who can view it.");
    } finally {
      setSharing(false);
    }
  };

  const upload = async (file: File) => {
    if (!host.upload) return;
    setProgress(0);
    try {
      const info = await host.upload(file, (pct) => setProgress(pct));
      infoCache.set(info.src, Promise.resolve(info));
      host.onEvent?.("uploaded", { renderer: info.renderer });
      onPick(info);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The upload failed. Try again.");
    } finally {
      setProgress(null);
    }
  };

  const tabs = [
    { value: "mine", label: "Your files", icon: "user" },
    ...(host.workspaceName ? [{ value: "workspace", label: <span className="ph-sensitive ph-mask">{host.workspaceName}</span>, icon: "users" }] : []),
    { value: "link", label: "Paste a link", icon: "link" },
    ...(host.upload ? [{ value: "upload", label: "Upload", icon: "upload" }] : []),
  ];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl"
      title={gate ? "Readers can't see this file yet" : "Embed a Markdrop file"}
      description={gate ? undefined : "Interactive HTML, websites, PDFs and videos render right in the page. Replace the file on Markdrop and every guide shows the new version."}
      bodyClassName="dxe-mdpick"
      dismissible={!sharing && progress === null}
    >
      {gate ? (
        <div className="dxe-mdpick__gate">
          <div className="dxe-mdpick__file">
            <KindIcon renderer={gate.renderer} size={22} />
            <span className="ph-sensitive ph-mask dxe-mdpick__filename">{gate.title}</span>
            <Badge tone="warning" size="sm" icon="lock">{REASON_SHORT[gate.reason ?? ""] ?? "Not public"}</Badge>
          </div>
          <Alert tone="warning" title="Your guide's readers will see a notice instead of the file">
            {gate.reason_text || "Only people who can open it on Markdrop can see it."} Nothing about the file (not even its name) is shown to them.
          </Alert>
          {gate.can_share ? (
            <p className="dxe-mdpick__hint">
              Make it viewable by <strong>anyone with the link</strong>: everyone who reads this guide can then see the file, and anyone you send its Markdrop link to can open it. You can change this back on Markdrop.
            </p>
          ) : (
            <p className="dxe-mdpick__hint">{gate.has_password ? "Remove its password on Markdrop to embed it, or embed it anyway." : "Only its owner can change who can open it. Ask them to share it with anyone who has the link, or embed it anyway."}</p>
          )}
          <div className="dxe-mdpick__actions">
            <Button variant="ghost" iconLeft="arrowLeft" onClick={() => setGate(null)} disabled={sharing}>Back</Button>
            <span className="flex-1" />
            <Button variant="secondary" onClick={() => onPick(gate)} disabled={sharing}>Embed anyway</Button>
            {gate.can_share && (
              <Button variant="primary" iconLeft="globe" loading={sharing} onClick={() => void share()}>
                Make viewable and embed
              </Button>
            )}
          </div>
        </div>
      ) : (
        <>
          <Tabs items={tabs} value={tab} onChange={(v) => setTab(v as PickTab)} variant="pill" size="sm" aria-label="Where the file is" />
          {(tab === "mine" || tab === "workspace") && (
            <div className="dxe-mdpick__lib">
              <div className="dxe-mdpick__filters">
                <Input size="sm" iconPrefix="search" placeholder="Search by name or link" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search files" id={searchId} autoFocus />
                <div className="dxe-mdpick__types" role="radiogroup" aria-label="Kind of file">
                  {TYPES.map((t) => (
                    <button key={t.value} type="button" role="radio" aria-checked={type === t.value} className={cx("dxe-mdpick__type", type === t.value && "dxe-mdpick__type--on")} onClick={() => setType(t.value)}>
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
              {error ? (
                <Alert tone="danger">{error}</Alert>
              ) : items === null ? (
                <div className="dxe-mdpick__empty"><Spinner label="Loading your files" /></div>
              ) : items.length === 0 ? (
                <div className="dxe-mdpick__empty">
                  <Icon name="inbox" />
                  <span>{query || type !== "all" ? "No files match." : tab === "workspace" ? "Nothing in this workspace yet." : "You haven't published any files yet."}</span>
                  {host.upload && <Button size="sm" variant="secondary" iconLeft="upload" onClick={() => setTab("upload")}>Upload one</Button>}
                </div>
              ) : (
                <ul className="ph-no-capture dxe-mdpick__list" aria-label="Files" aria-busy={loading || undefined}>
                  {items.map((it) => (
                    <li key={it.slug}>
                      <button type="button" className="dxe-mdpick__item" onClick={() => void choose(it.src)} disabled={!!busy || !it.embeddable} aria-describedby={`${it.slug}-meta`}>
                        <span className="dxe-mdpick__icon" aria-hidden><KindIcon renderer={it.renderer} /></span>
                        <span className="dxe-mdpick__text">
                          <span className="dxe-mdpick__title">{it.title}</span>
                          <span className="dxe-mdpick__meta" id={`${it.slug}-meta`}>
                            {[KIND_LABEL[it.renderer] ?? it.type_label, LIVE.has(it.renderer) || it.renderer === "doc" ? null : "opens on Markdrop", it.size_bytes ? formatBytes(it.size_bytes) : null, ago(it.updated_at)].filter(Boolean).join(" · ")}
                          </span>
                        </span>
                        {busy === it.src ? (
                          <Spinner size={14} label="Checking" />
                        ) : !it.embeddable ? (
                          <Badge size="sm">Can't embed</Badge>
                        ) : !it.public ? (
                          <Badge tone="warning" size="sm" icon="lock">{REASON_SHORT[it.reason ?? ""] ?? "Not public"}</Badge>
                        ) : (
                          <Icon name="plus" className="dxe-mdpick__add" />
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {items && page < pages && (
                <Button size="sm" variant="ghost" onClick={() => void more()} loading={loading}>Load more</Button>
              )}
            </div>
          )}
          {tab === "link" && (
            <form
              className="dxe-mdpick__link"
              onSubmit={(e) => {
                e.preventDefault();
                setLinkErr("");
                if (!link.trim()) return;
                void choose(link.trim());
              }}
            >
              <label className="dxe-field dxe-field--wide">
                <span className="dxe-field__label">Markdrop link</span>
                <Input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://markdrop.in/acme-pricing" mono invalid={!!linkErr} aria-invalid={!!linkErr || undefined} autoFocus />
              </label>
              {linkErr && <p className="dxe-mdpick__err" role="alert">{linkErr}</p>}
              <p className="dxe-mdpick__hint">The address of any file you can open on Markdrop: an HTML page, a zipped site, a PDF, a video or a document.</p>
              <div className="dxe-mdpick__actions">
                <span className="flex-1" />
                <Button type="submit" variant="primary" loading={!!busy} disabled={!link.trim()}>Embed</Button>
              </div>
            </form>
          )}
          {tab === "upload" && host.upload && (
            <div
              className={cx("dxe-mdpick__drop", progress !== null && "dxe-mdpick__drop--busy")}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes("Files")) e.preventDefault();
              }}
              onDrop={(e) => {
                const f = e.dataTransfer.files?.[0];
                if (f) {
                  e.preventDefault();
                  void upload(f);
                }
              }}
            >
              {progress !== null ? (
                <Progress value={progress} label="Uploading to Markdrop" showValue className="w-full max-w-[360px]" />
              ) : (
                <>
                  <Icon name="upload" />
                  <strong>Drop a file here</strong>
                  <span>An HTML page, a zipped website, a PDF or a video. It's published on Markdrop, viewable by anyone with the link, then embedded here.</span>
                  <Button size="sm" variant="secondary" iconLeft="upload" onClick={() => fileRef.current?.click()}>Choose a file</Button>
                  <input ref={fileRef} type="file" hidden accept={host.accept ?? ".html,.htm,.zip,.pdf,.mp4,.mov,.webm,video/*,application/pdf,text/html,application/zip"} onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) void upload(f);
                  }} />
                </>
              )}
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}

/* ── the block ───────────────────────────────────────────────────────────── */

const SIZES = [
  { value: "", label: "Automatic" },
  { value: "16:9", label: "Wide (16:9)" },
  { value: "4:3", label: "Standard (4:3)" },
  { value: "1:1", label: "Square (1:1)" },
  { value: "9:16", label: "Phone (9:16)" },
  { value: "custom", label: "Custom height" },
];

export function MarkdropView({ node, updateAttributes, deleteNode, selected, editor }: ReactNodeViewProps) {
  const host = useHost();
  const toast = useToast();
  const md = host.markdrop;
  const a = useMemo(() => (node.attrs.attributes ?? {}) as Record<string, string>, [node.attrs.attributes]);
  const label = (node.attrs.label as string | null) ?? undefined;
  const ro = host.readOnly;
  const [picking, setPicking] = useState(false);
  const [info, setInfo] = useState<MarkdropFileInfo | null>(null);
  const [infoErr, setInfoErr] = useState("");
  const [sharing, setSharing] = useState(false);
  const [showText, setShowText] = useState(!!a.summary);
  const [typed, setTyped] = useState("");
  const textId = useId();
  const src = a.src ?? "";
  const slug = parseMarkdropSrc(src, md?.config.extraHosts);
  const opened = useRef(false);

  const set = useCallback(
    (patch: Record<string, string | null>) => {
      const next: Record<string, string> = { ...a };
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === "") delete next[k];
        else next[k] = v;
      }
      updateAttributes({ attributes: next });
    },
    [a, updateAttributes],
  );

  // A block just inserted (it mounts empty while the editor has focus: the slash menu, the status
  // bar's Embed button) opens the picker straight away, once. An empty block already on a page when
  // it opens doesn't (the editor isn't focused yet), until it is selected while editing.
  useEffect(() => {
    if (src || !md || ro || opened.current) return;
    const open = () => {
      if (opened.current || !editor.isFocused) return false;
      opened.current = true;
      setPicking(true);
      return true;
    };
    if (open()) return;
    const t = window.setTimeout(open, 60);
    return () => window.clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- on mount only
  useEffect(() => {
    if (!src && selected && md && !ro && !opened.current && editor.isFocused) {
      opened.current = true;
      setPicking(true);
    }
  }, [src, selected, md, ro, editor]);

  useEffect(() => {
    if (!md || !slug) {
      setInfo(null);
      return;
    }
    let live = true;
    setInfoErr("");
    checkOnce(md, src)
      .then((i) => live && setInfo(i))
      .catch((e) => live && setInfoErr(e instanceof Error ? e.message : "Couldn't check this file."));
    return () => {
      live = false;
    };
  }, [md, slug, src]);

  const pick = (i: MarkdropFileInfo) => {
    setPicking(false);
    setInfo(i);
    const keepTitle = a.title && info && a.title !== info.title;
    set({ src: i.src, title: keepTitle ? a.title : i.title, version: null });
    md?.onEvent?.("inserted", { renderer: i.renderer, public: i.public });
  };

  const share = async () => {
    if (!md || !info) return;
    setSharing(true);
    try {
      const after = await md.share(info.src);
      infoCache.set(after.src, Promise.resolve(after));
      setInfo(after);
      md.onEvent?.("shared", { renderer: after.renderer });
      toast.success("Anyone with the link can now view it.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't change who can view it.");
    } finally {
      setSharing(false);
    }
  };

  const pinVersion = async (v: string) => {
    if (!md || !info) return;
    if (!v) {
      set({ version: null });
      return;
    }
    try {
      await md.pin(info.src, Number(v));
      set({ version: v });
      md.onEvent?.("pinned", { version: Number(v) });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't pin that version.");
    }
  };

  // A video's captions / chapters: WebVTT files of the guide (its own uploads), for the player and
  // the text version's transcript and chapter list.
  const [vttBusy, setVttBusy] = useState<"captions" | "chapters" | null>(null);
  const addVtt = (which: "captions" | "chapters") => {
    if (!host.upload) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".vtt,text/vtt";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f || !host.upload) return;
      setVttBusy(which);
      try {
        set({ [which]: await uploadUrl(host.upload, f, { variant: "light" }) });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "The upload failed. Try again.");
      } finally {
        setVttBusy(null);
      }
    };
    input.click();
  };

  const config = useMemo<MarkdropEmbedConfig>(() => (md ? { ...md.config, files: md.config.files ?? null, track: false } : FALLBACK_CONFIG), [md]);
  const del = !ro && <IconButton icon="trash" label="Remove Markdrop file" size="sm" onClick={() => deleteNode()} />;
  const picker = md && <MarkdropPicker open={picking} onClose={() => setPicking(false)} onPick={pick} host={md} />;

  if (!src) {
    return (
      <NodeViewWrapper className={cx("dxe-block dxe-leaf dxe-mdblock dxe-mdblock--empty", selected && "dxe-selected")} data-drag-handle="">
        <div className="dxe-mdblock__empty" contentEditable={false}>
          <span className="dxe-mdblock__glyph" aria-hidden><Icon name="layers" /></span>
          <div className="dxe-mdblock__copy">
            <strong>Embed a Markdrop file</strong>
            <span>An interactive HTML demo, a website, a PDF or a video, rendered right in the page and kept up to date with the file.</span>
          </div>
          {!ro && (
            <div className="dxe-mdblock__go">
              {md ? (
                <Button size="sm" variant="primary" iconLeft="search" onClick={() => setPicking(true)}>Choose a file</Button>
              ) : (
                <form
                  className="dxe-drop__url"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (parseMarkdropSrc(typed.trim())) set({ src: typed.trim() });
                  }}
                >
                  <Input size="sm" mono placeholder="https://markdrop.in/…" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Markdrop link" />
                  <Button size="sm" variant="ghost" type="submit" disabled={!parseMarkdropSrc(typed.trim())}>Embed</Button>
                </form>
              )}
              {del}
            </div>
          )}
        </div>
        {picker}
      </NodeViewWrapper>
    );
  }

  const attrs = embedAttrs(a, { label, extraHosts: md?.config.extraHosts });
  const sizeValue = a.aspect ? (SIZES.some((s) => s.value === a.aspect) ? a.aspect : "custom") : a.height ? "custom" : "";
  const live = info ? LIVE.has(info.renderer) : true;
  const versions = info?.can_pin ? info.versions : [];

  return (
    <NodeViewWrapper className={cx("dxe-block dxe-leaf dxe-mdblock", selected && "dxe-selected")}>
      <div contentEditable={false} className="dxe-mdblock__preview" data-drag-handle="">
        <MarkdropEmbed raw={a} label={label} config={config} />
      </div>
      {!ro && (
        <div contentEditable={false} className="dxe-mdblock__panel">
          <div className="dxe-mdblock__status" role="status">
            {infoErr ? (
              <span className="dxe-mdblock__warn"><Icon name="alertCircle" />{infoErr}</span>
            ) : !info ? (
              md && slug ? <span className="dxe-mdblock__muted"><Spinner size={12} /> Checking who can see it…</span> : !slug ? <span className="dxe-mdblock__warn"><Icon name="alertCircle" />{attrs.errors[0]}</span> : null
            ) : info.public ? (
              <span className="dxe-mdblock__ok"><Icon name="checkCircle" />Readers can see it: anyone with the link can view this file{live ? "" : ". It shows as a card that opens it on Markdrop"}.</span>
            ) : (
              <span className="dxe-mdblock__warn">
                <Icon name="lock" />
                {info.reason_text || "Readers can't see it."}
                {info.can_share && (
                  <Button size="sm" variant="secondary" loading={sharing} onClick={() => void share()}>Make viewable by anyone with the link</Button>
                )}
              </span>
            )}
          </div>
          <div className="dxe-form dxe-mdblock__form">
            <label className="dxe-field dxe-field--wide">
              <span className="dxe-field__label">Title</span>
              <Input size="sm" value={a.title ?? label ?? ""} placeholder={info?.title ?? "The file's own title"} onChange={(e) => set({ title: e.target.value })} />
            </label>
            {live && (
              <div className="dxe-field">
                <span className="dxe-field__label" id={`${textId}-mode`}>Shows</span>
                <SegmentedControl
                  aria-labelledby={`${textId}-mode`}
                  size="sm"
                  value={a.mode === "preview" || a.mode === "card" ? a.mode : "live"}
                  onChange={(v) => set({ mode: v === "live" ? null : v })}
                  options={[
                    { value: "live", label: "Live" },
                    { value: "preview", label: "On click" },
                    { value: "card", label: "Card" },
                  ]}
                />
              </div>
            )}
            {live && info?.renderer !== "video" && (
              <label className="dxe-field">
                <span className="dxe-field__label">Size</span>
                <Select
                  value={sizeValue}
                  options={SIZES}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "custom") set({ aspect: null, height: a.height || "640" });
                    else set({ aspect: v || null, height: null });
                  }}
                />
              </label>
            )}
            {live && sizeValue === "custom" && !a.aspect && (
              <label className="dxe-field">
                <span className="dxe-field__label">Height (px)</span>
                <Input size="sm" type="number" min={160} max={2000} step={20} value={a.height ?? ""} onChange={(e) => set({ height: e.target.value })} />
              </label>
            )}
            {versions.length > 1 && (
              <label className="dxe-field">
                <span className="dxe-field__label">Version</span>
                <Select
                  value={a.version ?? ""}
                  onChange={(e) => void pinVersion(e.target.value)}
                  options={[
                    { value: "", label: "Latest (updates with the file)" },
                    ...versions.map((v) => ({ value: String(v.version), label: `Version ${v.version}${v.current ? " (current)" : ""}${v.created_at ? ` · ${new Date(v.created_at).toLocaleDateString("en", { month: "short", day: "numeric" })}` : ""}` })),
                  ]}
                />
              </label>
            )}
          </div>
          {info?.renderer === "video" && host.upload && (
            <div className="dxe-mdblock__vtt">
              {(["captions", "chapters"] as const).map((k) => (
                <span key={k} className="dxe-mdblock__vttitem">
                  <Button size="sm" variant="secondary" iconLeft={k === "captions" ? "type" : "list"} loading={vttBusy === k} onClick={() => addVtt(k)}>
                    {a[k] ? `Replace ${k}` : k === "captions" ? "Add captions (.vtt)" : "Add chapters (.vtt)"}
                  </Button>
                  {a[k] && (
                    <>
                      <code className="dxe-mdblock__vttname" title={a[k]}>{a[k].split("/").pop()}</code>
                      <IconButton icon="x" size="sm" label={`Remove ${k}`} onClick={() => set({ [k]: null })} />
                    </>
                  )}
                </span>
              ))}
            </div>
          )}
          <div className="dxe-mdblock__text">
            <button type="button" className="dxe-mdblock__texttoggle" aria-expanded={showText} aria-controls={textId} onClick={() => setShowText(!showText)}>
              <Icon name={showText ? "chevronDown" : "chevronRight"} />
              Text version{a.summary ? "" : " (recommended)"}
            </button>
            {showText && (
              <div id={textId} className="dxe-mdblock__textbody">
                <Textarea
                  rows={3}
                  value={a.summary ?? ""}
                  onChange={(e) => set({ summary: e.target.value.replace(/\s*\n\s*/g, " ") })}
                  placeholder={info?.renderer === "html" || info?.renderer === "bundle" ? "What the demo does and what readers can try: “Pick a plan and a number of seats; the monthly and yearly totals update.”" : "What it shows, in a sentence or two"}
                  aria-label="Text version"
                />
                <p className="dxe-mdblock__muted">Shown under the block and to readers without JavaScript, and read by search, Ask AI and AI agents (llms.txt){info?.renderer === "pdf" ? ". The PDF's own text is added when you publish" : info?.renderer === "video" ? ". A video's captions become its transcript, and its chapters a list" : ""}.</p>
              </div>
            )}
          </div>
          <div className="dxe-mdblock__tools">
            {md && <Button size="sm" variant="ghost" iconLeft="refresh" onClick={() => setPicking(true)}>Replace</Button>}
            {slug && <Button size="sm" variant="ghost" iconLeft="external" className="no-underline" href={info?.url ?? `https://markdrop.in/${slug}`} target="_blank" rel="noopener">Open on Markdrop</Button>}
            <span className="flex-1" />
            {del}
          </div>
        </div>
      )}
      {picker}
    </NodeViewWrapper>
  );
}
