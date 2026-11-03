"use client";

/**
 * A page's one-line blocks (EditorHost.pages):
 *
 *   ::bookmark{url title description image site}   a link with its preview, fetched once by the server
 *   ::toc                                           the page's headings, live
 *   ::breadcrumb                                    where the page sits
 *   ::page{src=<slug>}                              a sub-page, made here and linked
 *
 * and the web embed (::embed{src}) for allowlisted providers. Readers see the same thing through
 * the page renderer.
 */
import { useEffect, useRef, useState } from "react";
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { Button, Icon, IconButton, Input, Spinner, useToast } from "@/components/ui";
import { webEmbedUrl } from "@/lib/pageBlocks.mjs";
import { useHost } from "../host";
import { cx } from "./shared";
import { useResolved } from "./pageItems";

function useHeadings(editor: ReactNodeViewProps["editor"]) {
  const [list, setList] = useState<Array<{ level: number; text: string }>>([]);
  useEffect(() => {
    const read = () => {
      const out: Array<{ level: number; text: string }> = [];
      editor.state.doc.descendants((n) => {
        if (n.type.name === "heading" && n.attrs.level <= 3 && n.textContent.trim()) out.push({ level: n.attrs.level, text: n.textContent.trim() });
        return n.type.name !== "heading";
      });
      setList((prev) => (JSON.stringify(prev) === JSON.stringify(out) ? prev : out));
    };
    read();
    editor.on("update", read);
    return () => {
      editor.off("update", read);
    };
  }, [editor]);
  return list;
}

function Toc({ editor }: { editor: ReactNodeViewProps["editor"] }) {
  const list = useHeadings(editor);
  if (!list.length) return <p className="pb-toc__empty">Add headings to the page and they show here.</p>;
  const min = Math.min(...list.map((h) => h.level));
  return (
    <ul className="pb-toc">
      {list.map((h, i) => (
        <li key={i} style={{ paddingLeft: (h.level - min) * 16 }}>
          {h.text}
        </li>
      ))}
    </ul>
  );
}

function Bookmark({ a, set, del }: { a: Record<string, string>; set: (p: Record<string, string>) => void; del: () => void }) {
  const host = useHost();
  const toast = useToast();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const u = url.trim();
    if (!/^https?:\/\/\S+$/.test(u)) {
      toast.error("Paste a link that starts with https://");
      return;
    }
    setBusy(true);
    try {
      const m = (await host.pages?.linkPreview?.(u)) ?? {};
      const next: Record<string, string> = { url: u };
      if (m.title) next.title = m.title;
      if (m.description) next.description = m.description.slice(0, 300);
      if (m.image_url) next.image = m.image_url;
      if (m.site_name) next.site = m.site_name;
      set(next);
    } catch {
      set({ url: u });
    } finally {
      setBusy(false);
    }
  };
  if (!a.url) {
    return (
      <form className="dxe-drop pb-bookmark-form" onSubmit={submit}>
        <Icon name="link" />
        <Input size="sm" placeholder="Paste a link, e.g. https://…" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Bookmark link" autoFocus readOnly={host.readOnly} />
        <Button size="sm" variant="secondary" type="submit" loading={busy} disabled={host.readOnly}>
          Create bookmark
        </Button>
        <IconButton icon="trash" label="Remove bookmark" size="sm" onClick={del} />
      </form>
    );
  }
  return <BookmarkCard a={a} />;
}

export function BookmarkCard({ a }: { a: Record<string, string | undefined> }) {
  let host = "";
  try {
    host = new URL(a.url ?? "").host;
  } catch {
    /* not a URL */
  }
  const safe = /^https?:\/\//.test(a.url ?? "") ? a.url : undefined;
  const img = /^https:\/\//.test(a.image ?? "") ? a.image : undefined;
  return (
    <a className="pb-bookmark not-prose" href={safe} target="_blank" rel="noopener noreferrer nofollow">
      <span className="pb-bookmark__text">
        <strong className="pb-bookmark__title">{a.title || host || a.url}</strong>
        {a.description && <span className="pb-bookmark__desc">{a.description}</span>}
        <span className="pb-bookmark__url">
          <Icon name="link" size={12} aria-hidden /> {a.site || host}
        </span>
      </span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {img && <img className="pb-bookmark__img" src={img} alt="" loading="lazy" referrerPolicy="no-referrer" />}
    </a>
  );
}

function SubPage({ a, set, del }: { a: Record<string, string>; set: (p: Record<string, string>) => void; del: () => void }) {
  const host = useHost();
  const toast = useToast();
  const started = useRef(false);
  const [title, setTitle] = useState<string | null>(null);
  useEffect(() => {
    if (a.src || started.current || host.readOnly) return;
    if (!host.pages?.createSubPage) return;
    started.current = true;
    host.pages
      .createSubPage("Untitled")
      .then((p) => {
        setTitle(p.title);
        set({ src: p.slug });
      })
      .catch((e) => {
        toast.error(e instanceof Error ? e.message : "Couldn't create the sub-page.");
        del();
      });
  }, [a.src, host, set, del, toast]);
  const resolved = useResolved(host.pages, a.src || null);
  if (!a.src) {
    return (
      <div className="pb-subpage pb-subpage--new">
        <Spinner size={14} /> Creating a sub-page…
      </div>
    );
  }
  return <div className="pb-subpage-wrap">{host.pages?.renderEmbed({ slug: a.src, mode: "card", label: title, resolved })}</div>;
}

function Breadcrumb() {
  const host = useHost();
  const crumbs = host.pages?.crumbs ?? [];
  return (
    <nav className="pb-crumbs pb-crumbs--block" aria-label="Breadcrumb">
      {crumbs.map((c) => (
        <span key={c.slug} className="pb-crumbs__item">
          {c.title || "Untitled"} <Icon name="chevronRight" size={12} aria-hidden />
        </span>
      ))}
      <span aria-current="page">{host.pages?.pageTitle || "This page"}</span>
    </nav>
  );
}

function WebEmbed({ a, set, del }: { a: Record<string, string>; set: (p: Record<string, string>) => void; del: () => void }) {
  const host = useHost();
  const [url, setUrl] = useState("");
  const [err, setErr] = useState("");
  const src = a.src ? webEmbedUrl(a.src) : null;
  if (!a.src) {
    return (
      <form
        className="dxe-drop pb-bookmark-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!webEmbedUrl(url.trim())) {
            setErr("Paste a YouTube, Vimeo, Loom, Figma, Google Maps or CodePen link.");
            return;
          }
          set({ src: url.trim() });
        }}
      >
        <Icon name="globe" />
        <Input size="sm" placeholder="YouTube, Loom, Figma, Google Maps, CodePen link" value={url} onChange={(e) => { setUrl(e.target.value); setErr(""); }} aria-label="Embed link" autoFocus invalid={!!err} readOnly={host.readOnly} />
        <Button size="sm" variant="secondary" type="submit" disabled={host.readOnly}>Embed</Button>
        <IconButton icon="trash" label="Remove embed" size="sm" onClick={del} />
        {err && <p className="pb-form-err" role="alert">{err}</p>}
      </form>
    );
  }
  return src ? (
    <div className="pb-webembed">
      <iframe src={src} title={a.title || "Embedded content"} sandbox="allow-scripts allow-same-origin allow-popups allow-presentation allow-forms" allow="fullscreen; picture-in-picture; encrypted-media" referrerPolicy="strict-origin-when-cross-origin" loading="lazy" />
    </div>
  ) : (
    <div className="pb-locked">
      <span>This site can&apos;t be embedded: {a.src}</span>
    </div>
  );
}

/** The views above, for a page; `fallback` draws anything else (the Guides forms). */
export function PageLeafView(props: ReactNodeViewProps & { fallback: React.ReactNode }) {
  const { node, updateAttributes, deleteNode, selected, editor, fallback } = props;
  const host = useHost();
  const name = node.attrs.name as string;
  const a = (node.attrs.attributes ?? {}) as Record<string, string>;
  const set = (p: Record<string, string>) => updateAttributes({ attributes: { ...a, ...p } });
  const del = () => deleteNode();
  let body: React.ReactNode;
  if (name === "bookmark") body = <Bookmark a={a} set={set} del={del} />;
  else if (name === "toc") body = <Toc editor={editor} />;
  else if (name === "breadcrumb") body = <Breadcrumb />;
  else if (name === "page") body = <SubPage a={a} set={set} del={del} />;
  else if (name === "embed") body = <WebEmbed a={a} set={set} del={del} />;
  else return <>{fallback}</>;
  return (
    <NodeViewWrapper className={cx("dxe-block dxe-pleaf", selected && "dxe-selected")} data-drag-handle="" data-leaf={name}>
      <div contentEditable={false}>
        {body}
        {!host.readOnly && (name === "toc" || name === "breadcrumb" || (name === "bookmark" && a.url) || (name === "embed" && a.src)) && (
          <div className="dxe-pembed__tools">
            {(name === "bookmark" || name === "embed") && (
              <Button size="sm" variant="ghost" iconLeft="edit" onClick={() => updateAttributes({ attributes: {} })}>
                Change link
              </Button>
            )}
            <IconButton icon="trash" label={`Remove ${name}`} size="sm" onClick={del} />
          </div>
        )}
      </div>
    </NodeViewWrapper>
  );
}
