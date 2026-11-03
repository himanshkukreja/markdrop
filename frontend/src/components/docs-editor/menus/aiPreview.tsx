"use client";

/**
 * An AI answer drawn as blocks, exactly as Accept will put it in: a small read-only editor with the
 * page's own node views (callouts, to-dos with person and date chips, tables…), fed the answer
 * through the same parser (aiAccept.ts `aiBlocks`). While the answer streams in it's redrawn at most
 * once a frame, and only the blocks that changed are touched (ProseMirror keeps the rest).
 */
import { useEffect, useMemo, useRef } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { EditorHostContext, useHost } from "../host";
import { previewExtensions } from "../extensions";
import { aiBlocks } from "./aiAccept";

const EMPTY = { type: "doc", content: [{ type: "paragraph" }] };

export function AiPreview({ markdown, streaming }: { markdown: string; streaming: boolean }) {
  const host = useHost();
  const readOnlyHost = useMemo(() => ({ ...host, readOnly: true, upload: undefined }), [host]);
  const extensions = useMemo(() => previewExtensions(), []);
  const editor = useEditor({
    extensions,
    content: EMPTY as never,
    editable: false,
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: "prose md-prose md-prose--reading dx-prose dxe-content dxe-ai__doc", "aria-label": "Suggested text" },
    },
  });
  const last = useRef("");
  const frame = useRef(0);
  const want = useRef({ markdown, streaming });
  want.current = { markdown, streaming };

  useEffect(() => {
    if (!editor) return;
    const draw = () => {
      frame.current = 0;
      const { markdown: md, streaming: partial } = want.current;
      if (editor.isDestroyed || md === last.current) return;
      last.current = md;
      const blocks = aiBlocks(md, editor.schema, partial);
      try {
        editor.commands.setContent((blocks.length ? { type: "doc", content: blocks } : EMPTY) as never, { emitUpdate: false });
      } catch {
        /* a half-written block the schema refuses: the next frame has more */
      }
    };
    // Once a frame at most (the deltas themselves arrive batched per frame: assist.tsx).
    if (!frame.current) frame.current = requestAnimationFrame(draw);
  }, [editor, markdown, streaming]);
  useEffect(() => () => {
    if (frame.current) cancelAnimationFrame(frame.current);
  }, []);

  return (
    <EditorHostContext.Provider value={readOnlyHost}>
      <div className="dxe-ai__preview dxe-visual" data-readonly="">
        <EditorContent editor={editor} />
      </div>
    </EditorHostContext.Provider>
  );
}
