"use client";

/**
 * A tiny window-event bus between the shell and the page in it. The header (outside the shell)
 * opens the ⌘K palette; the palette (in the shell) asks the folder page to open its own dialogs
 * ("Share Guides", "New folder", "Invite people"), which only the page can draw with the right data.
 */
import { useEffect } from "react";

const PALETTE = "md:cmdk";
const FOLDER = "md:folder-command";

export type FolderCommand = "share" | "invite" | "new-folder" | "preview";

export function openCommandPalette() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(PALETTE));
}

export function usePaletteRequests(cb: () => void) {
  useEffect(() => {
    window.addEventListener(PALETTE, cb);
    return () => window.removeEventListener(PALETTE, cb);
  }, [cb]);
}

export function sendFolderCommand(command: FolderCommand) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(FOLDER, { detail: { command } }));
}

export function useFolderCommands(cb: (command: FolderCommand) => void) {
  useEffect(() => {
    const on = (e: Event) => {
      const c = (e as CustomEvent<{ command: FolderCommand }>).detail?.command;
      if (c) cb(c);
    };
    window.addEventListener(FOLDER, on);
    return () => window.removeEventListener(FOLDER, on);
  }, [cb]);
}
