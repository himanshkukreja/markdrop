/**
 * Pasted images become uploads: after a paste (or a drop) of HTML or Markdown, each new figure
 * whose address is `http(s):` or `data:` is fetched and uploaded through the host's `upload` (the
 * same path a pasted image file takes), and its address is swapped for the upload's in place.
 *
 * The swap isn't an undo step of its own (undo removes the pasted figure, as it would have), and
 * the caret stays where it is. While a figure uploads it carries `.dxe-uploading` (a decoration).
 * A site that refuses cross-origin reads keeps its remote address, quietly; an image that is only
 * data (`data:`) and can't be uploaded is reported once per paste.
 */
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { uploadUrl } from "../host";
import type { UploadImage } from "../types";

const KINDS = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const MAX = 10 * 1024 * 1024;
const PARALLEL = 3;

type Meta = { add?: Array<{ from: number; to: number; id: string }>; remove?: string[] };

export const pasteUploadKey = new PluginKey<DecorationSet>("docsPasteUploads");

/** Marks the figures being uploaded (mapped through every change, so it also tracks them). */
export function pasteUploadPlugin() {
  return new Plugin<DecorationSet>({
    key: pasteUploadKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        let next = set.map(tr.mapping, tr.doc);
        const meta = tr.getMeta(pasteUploadKey) as Meta | undefined;
        if (meta?.remove?.length) next = next.remove(next.find(undefined, undefined, (s) => meta.remove!.includes(s.id)));
        if (meta?.add?.length) next = next.add(tr.doc, meta.add.map((a) => Decoration.node(a.from, a.to, { class: "dxe-uploading", "aria-busy": "true" }, { id: a.id })));
        return next;
      },
    },
    props: {
      decorations(state) {
        return pasteUploadKey.getState(state);
      },
    },
  });
}

/** Where a transaction changed the document, in the new document's positions. */
export function changedRanges(tr: Transaction): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  tr.mapping.maps.forEach((map, i) => {
    const rest = tr.mapping.slice(i + 1);
    map.forEach((_a, _b, from, to) => out.push([rest.map(from, -1), rest.map(to, 1)]));
  });
  return out;
}

const remote = (src: string) => /^https?:\/\//i.test(src) || /^data:image\//i.test(src);

let seq = 0;

/**
 * Watches the editor: figures that a paste or a drop brings in are uploaded. Returns the cleanup.
 * `onDataFailed(n)` reports `data:` images that couldn't be uploaded (once per paste).
 */
export function watchPastedImages(editor: Editor, getUpload: () => UploadImage | undefined, onDataFailed: (n: number) => void): () => void {
  const plugin = pasteUploadPlugin();
  editor.registerPlugin(plugin);
  const cache = new Map<string, Promise<string | null>>();
  let running = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    while (running < PARALLEL && queue.length) {
      running++;
      queue.shift()!();
    }
  };
  const limited = <T,>(fn: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => fn().then(resolve, reject).finally(() => {
        running--;
        next();
      }));
      next();
    });

  const uploadOne = (src: string, up: UploadImage): Promise<string | null> => {
    const hit = cache.get(src);
    if (hit) return hit;
    const p = limited(async () => {
      let blob: Blob;
      try {
        const r = await fetch(src, { mode: "cors", credentials: "omit", referrerPolicy: "no-referrer" });
        if (!r.ok) return null;
        blob = await r.blob();
      } catch {
        return null; // cross-origin refused, offline: the remote address stays
      }
      const type = blob.type.split(";")[0].trim().toLowerCase();
      if (!KINDS.has(type) || blob.size > MAX || blob.size === 0) return null;
      let name = "pasted-image";
      if (!src.startsWith("data:")) {
        try {
          name = decodeURIComponent(new URL(src).pathname.split("/").filter(Boolean).pop() ?? name).replace(/\.[a-z0-9]+$/i, "") || name;
        } catch {
          /* keep the default */
        }
      }
      const file = new File([blob], `${name.slice(0, 80)}.${EXT[type]}`, { type });
      try {
        return await uploadUrl(up, file, { variant: "light" });
      } catch {
        return null;
      }
    });
    cache.set(src, p);
    // A failure isn't remembered: pasting the same image again tries again.
    void p.then((u) => {
      if (!u) cache.delete(src);
    });
    return p;
  };

  const swap = (id: string, src: string, url: string | null) => {
    if (editor.isDestroyed) return;
    const { state } = editor;
    const set = pasteUploadKey.getState(state);
    const deco = set?.find(undefined, undefined, (s) => s.id === id)[0];
    const tr = state.tr.setMeta(pasteUploadKey, { remove: [id] } satisfies Meta).setMeta("addToHistory", false);
    if (url) {
      const at = (pos: number, n: PMNode | null) => {
        if (n && n.type.name === "figure" && n.attrs.src === src) tr.setNodeMarkup(pos, undefined, { ...n.attrs, src: url });
      };
      if (deco) at(deco.from, state.doc.nodeAt(deco.from));
      else
        // The figure was edited while it uploaded (its mark went with it): find it by its address.
        state.doc.descendants((n, pos) => {
          at(pos, n);
          return !n.isAtom;
        });
    }
    editor.view.dispatch(tr);
  };

  const onTransaction = ({ transaction: tr }: { transaction: Transaction }) => {
    const ui = tr.getMeta("uiEvent");
    if ((ui !== "paste" && ui !== "drop") || !tr.docChanged) return;
    const up = getUpload();
    if (!up) return;
    const found: Array<{ pos: number; size: number; src: string }> = [];
    const seen = new Set<number>();
    for (const [from, to] of changedRanges(tr)) {
      tr.doc.nodesBetween(Math.max(0, from), Math.min(tr.doc.content.size, to), (n, pos) => {
        if (n.type.name === "figure" && !seen.has(pos) && remote(String(n.attrs.src ?? ""))) {
          seen.add(pos);
          found.push({ pos, size: n.nodeSize, src: String(n.attrs.src) });
        }
        return !n.isAtom;
      });
    }
    if (!found.length) return;
    const items = found.map((f) => ({ ...f, id: `u${++seq}` }));
    // After this transaction has been applied: mark them, then upload.
    queueMicrotask(() => {
      if (editor.isDestroyed) return;
      const add = items.filter((it) => editor.state.doc.nodeAt(it.pos)?.attrs.src === it.src).map((it) => ({ from: it.pos, to: it.pos + it.size, id: it.id }));
      if (!add.length) return;
      editor.view.dispatch(editor.state.tr.setMeta(pasteUploadKey, { add } satisfies Meta).setMeta("addToHistory", false));
      let dataFailed = 0;
      void Promise.all(
        items.map(async (it) => {
          const url = await uploadOne(it.src, up);
          if (!url && it.src.startsWith("data:")) dataFailed++;
          swap(it.id, it.src, url);
        }),
      ).then(() => {
        if (dataFailed) onDataFailed(dataFailed);
      });
    });
  };
  editor.on("transaction", onTransaction);
  return () => {
    editor.off("transaction", onTransaction);
    if (!editor.isDestroyed) editor.unregisterPlugin(pasteUploadKey);
  };
}
