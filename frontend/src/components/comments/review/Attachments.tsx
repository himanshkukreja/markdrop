"use client";

/**
 * Files in comments: the composer's Attach tool (upload → the draft carries their ids) and, under each
 * message, its images (thumbnails) and files (chips). Links are signed for this viewer by the server and
 * renewed before they expire; nobody who can't see the comments ever gets one.
 */
import { useEffect, useRef, useState } from "react";
import { FileIcon, Icon, IconButton, useToast } from "@/components/ui";
import type { Message, Thread } from "@/lib/comments";
import { ACCEPT, MAX_FILE_BYTES, MAX_FILES, discardFile, fileSize, uploadFile } from "@/lib/commentsReview";
import type { CommentsCtx } from "../context";
import type { Draft } from "../slots";
import { links, useFileLink } from "./store";

function opts(ctx: CommentsCtx) {
  return { readPassword: ctx.readPassword ?? null };
}

type Att = { id: string; name: string; mime: string; size: number; url?: string | null };

function FileItem({ a, ctx }: { a: Att; ctx: CommentsCtx }) {
  const link = useFileLink(ctx.slug, a.id, opts(ctx));
  const url = link?.url ?? null;
  if (a.mime.startsWith("image/")) {
    return url ? (
      <a className="cr-file cr-file--image" href={url} target="_blank" rel="noopener noreferrer" title={a.name}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={a.name} loading="lazy" width={link?.width} height={link?.height} />
      </a>
    ) : (
      <span className="cr-file cr-file--image cr-file--pending" aria-label={a.name}>
        <Icon name="image" size={18} aria-hidden />
      </span>
    );
  }
  const body = (
    <>
      <FileIcon name={a.name} mime={a.mime} size={18} />
      <span className="cr-file__name">{a.name}</span>
      <span className="cr-file__size">{fileSize(a.size)}</span>
    </>
  );
  return url ? (
    <a className="cr-file" href={url} target="_blank" rel="noopener noreferrer" download={a.name}>
      {body}
    </a>
  ) : (
    <span className="cr-file cr-file--pending">{body}</span>
  );
}

export function MessageFiles({ message, ctx }: { message: Message; thread: Thread; ctx: CommentsCtx }) {
  const files = message.attachments ?? [];
  if (!files.length || message.deleted) return null;
  return (
    <div className="cr-files" data-testid="comment-files">
      {files.map((a) => (
        <FileItem key={a.id} a={a} ctx={ctx} />
      ))}
    </div>
  );
}

export function AttachTool({ draft, setDraft, ctx }: { draft: Draft; setDraft(d: Draft): void; ctx: CommentsCtx; threadId: string | null }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(0);
  const toast = useToast();
  const latest = useRef(draft);
  latest.current = draft;

  async function add(files: FileList | null) {
    if (!files?.length) return;
    const room = MAX_FILES - latest.current.attachments.length;
    const list = [...files].slice(0, Math.max(0, room));
    if (files.length > list.length) toast.error(`A comment can carry up to ${MAX_FILES} files.`);
    for (const f of list) {
      if (f.size > MAX_FILE_BYTES) {
        toast.error(`${f.name} is over 10 MB.`);
        continue;
      }
      setBusy((n) => n + 1);
      try {
        const up = await uploadFile(ctx.slug, f, opts(ctx));
        if (up.url) links.put(ctx.slug, { ...up, url: up.url, expires_at: null });
        const cur = latest.current;
        setDraft({ ...cur, attachments: [...cur.attachments, { id: up.id, name: up.name, mime: up.mime, size: up.size }] });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "That file couldn't be added.");
      } finally {
        setBusy((n) => n - 1);
      }
    }
  }

  // Pasting an image (a screenshot) into this composer's text attaches it.
  const addRef = useRef(add);
  addRef.current = add;
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const target = e.target as Node | null;
      const files = e.clipboardData?.files;
      if (!target || !files?.length || !input.current) return;
      let el: HTMLElement | null = input.current.parentElement;
      for (let i = 0; i < 4 && el; i++, el = el.parentElement) {
        if (el.contains(target)) {
          e.preventDefault();
          void addRef.current(files);
          return;
        }
      }
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  function remove(id: string) {
    const cur = latest.current;
    setDraft({ ...cur, attachments: cur.attachments.filter((a) => a.id !== id) });
    void discardFile(ctx.slug, id, opts(ctx)).catch(() => {});
  }

  if (!ctx.perms.comment) return null;
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT}
        hidden
        data-testid="comment-file-input"
        onChange={(e) => {
          void add(e.target.files);
          e.target.value = "";
        }}
      />
      <IconButton icon="upload" label={busy ? "Uploading…" : "Attach a file"} size="sm" disabled={busy > 0 || draft.attachments.length >= MAX_FILES} onClick={() => input.current?.click()} />
      {(draft.attachments.length > 0 || busy > 0) && (
        <div className="cr-draft-files">
          {draft.attachments.map((a) => (
            <span key={a.id} className="cr-draft-file">
              <FileIcon name={a.name} mime={a.mime} size={14} />
              <span className="cr-file__name">{a.name}</span>
              <button type="button" className="cr-draft-file__x" aria-label={`Remove ${a.name}`} onClick={() => remove(a.id)}>
                <Icon name="x" size={12} aria-hidden />
              </button>
            </span>
          ))}
          {busy > 0 && <span className="cr-draft-file cr-draft-file--busy">Uploading…</span>}
        </div>
      )}
    </>
  );
}
