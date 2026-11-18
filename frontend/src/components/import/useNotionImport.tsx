"use client";

/**
 * Open "Import from Notion" from anywhere: `const notion = useNotionImport(preset)`, then `notion.open()` and render
 * `notion.dialog`. The dialog's code loads only on first open (next/dynamic), and stays mounted after that so an
 * import keeps polling (and says when it's done) while the dialog is closed.
 */
import dynamic from "next/dynamic";
import { useCallback, useState } from "react";
import type { NotionImportPreset } from "./NotionImportDialog";

const NotionImportDialog = dynamic(() => import("./NotionImportDialog"), { ssr: false });

export type { NotionImportPreset };

export function useNotionImport(preset?: NotionImportPreset) {
  const [isOpen, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const open = useCallback(() => { setMounted(true); setOpen(true); }, []);
  const close = useCallback(() => setOpen(false), []);
  const dialog = mounted ? <NotionImportDialog open={isOpen} onClose={close} preset={preset} /> : null;
  return { open, dialog };
}
