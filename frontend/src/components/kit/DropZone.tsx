"use client";
/**
 * DropZone (K2 link & frames kit; REVAMP_PLAN 7.16, 6.2 "Dropzone").
 *
 * Drop target + file picker. Behaviour contract:
 * - Files are collected SYNCHRONOUSLY inside the drop handler (the DataTransfer is emptied once the
 *   event returns). With `folder`, the handler calls `filesFromDrop(e.dataTransfer)` from lib/p2p (the
 *   same function /share uses: `webkitGetAsEntry` read in the same tick, then async traversal; dotfiles
 *   and hidden folders skipped). Without `folder`, dropped directories are skipped and plain files are
 *   handed over at once.
 * - `onFiles(files, { source })` fires once per drop or pick, possibly with an empty array (e.g. a folder
 *   holding only hidden files), so the caller can say "Nothing to send in that folder".
 * - Keyboard: the default actions are real buttons ("Choose files", and "Choose a folder" when `folder`,
 *   hidden on touch). With `actions={null}` the whole zone becomes `role="button"` (Enter/Space open the
 *   picker). Either way focus is visible (DS ring on the control; the zone's edge turns `border-focus`).
 * - Pointer: clicking empty space in the zone opens the picker too ("click to browse").
 * - Dragover: `border-focus` edge + `accent-soft` wash + scale 1.01 + three ghost file cards fanning ±6°
 *   (art "tile"; the "fan" art spreads its resting fan by 6° more). Reduced motion: no scale, no fan.
 * - `accept` filters the picker only; dropped files are passed through for the caller to validate.
 */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Button, FileIcon } from "@/components/ui";
import { filesFromDrop } from "@/lib/p2p/dropped";
import { KitIcon } from "./DeviceGlyph";
import styles from "./DropZone.module.css";

export type DropSource = "drop" | "picker" | "folder-picker";

export interface DropZoneApi {
  /** Opens the file picker. */
  openFiles: () => void;
  /** Opens the folder picker (only meaningful with `folder`). */
  openFolder: () => void;
  /** True while files are dragged over the zone. */
  dragging: boolean;
}

export interface DropZoneProps {
  onFiles: (files: File[], info: { source: DropSource }) => void;
  /** Accept folders: drop traversal + a "Choose a folder" button (hidden on touch). */
  folder?: boolean;
  /** Picker filter, e.g. ".html,.pdf,application/pdf". */
  accept?: string;
  /** Allow several files from the picker (default true). */
  multiple?: boolean;
  /** One-row layout (a list's "add more" target, 72px). */
  compact?: boolean;
  disabled?: boolean;
  /** Default: "Drop files or a whole folder" / "Drop files here" / "Drop a file here". */
  title?: ReactNode;
  /** Title while dragging (default "Drop to add them" / "Drop to add it"). */
  dragTitle?: ReactNode;
  caption?: ReactNode;
  /**
   * Buttons under the copy. Undefined = the defaults; a node replaces them; a function gets
   * { openFiles, openFolder, dragging }; null = no buttons (the zone itself becomes the button).
   */
  actions?: ReactNode | ((api: DropZoneApi) => ReactNode) | null;
  /** Label of the default choose button (default "Choose files" / "Choose a file"). */
  chooseLabel?: string;
  /** Variant of the default choose button (default "secondary"). */
  chooseVariant?: "primary" | "secondary";
  /** Accessible name when the zone is the button (actions={null}); default `chooseLabel`. */
  label?: string;
  /** "tile" (56px upload tile, ghost cards appear on dragover), "fan" (the /upload resting fan), "none". */
  art?: "tile" | "fan" | "none";
  /** Tile icon (default "upload"). */
  icon?: string;
  className?: string;
  id?: string;
}

const GHOSTS = [
  { name: "brief.pdf", mime: "application/pdf", ext: ".pdf", pos: "l" },
  { name: "budget.xlsx", mime: "application/vnd.ms-excel", ext: ".xlsx", pos: "r" },
  { name: "index.html", mime: "text/html", ext: ".html", pos: "c" },
] as const;

const hasFiles = (dt: DataTransfer | null) => !!dt && Array.from(dt.types ?? []).includes("Files");

/** Synchronous collection for the non-folder case: plain files only, directories skipped. */
function plainFiles(dt: DataTransfer): File[] {
  const items = dt.items ? Array.from(dt.items) : [];
  if (!items.length) return Array.from(dt.files ?? []);
  const out: File[] = [];
  for (const it of items) {
    if (it.kind !== "file") continue;
    const entry = it.webkitGetAsEntry?.();
    if (entry?.isDirectory) continue;
    const f = it.getAsFile();
    if (f) out.push(f);
  }
  return out;
}

/** Folder-picker results without dotfiles or anything inside a hidden folder (matches filesFromDrop). */
function visible(files: File[]): File[] {
  return files.filter((f) => {
    const path = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    return !path.split("/").some((seg) => seg.startsWith("."));
  });
}

export function DropZone({
  onFiles,
  folder,
  accept,
  multiple = true,
  compact,
  disabled,
  title,
  dragTitle,
  caption,
  actions,
  chooseLabel,
  chooseVariant = "secondary",
  label,
  art = "tile",
  icon = "upload",
  className,
  id,
}: DropZoneProps) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const onFilesRef = useRef(onFiles);
  useEffect(() => {
    onFilesRef.current = onFiles;
  }, [onFiles]);
  const titleId = useId();
  const captionId = useId();

  // A drag that ends outside the zone (Escape, drop elsewhere) must not leave it highlighted.
  useEffect(() => {
    if (!dragging) return;
    const reset = () => {
      depth.current = 0;
      setDragging(false);
    };
    window.addEventListener("dragend", reset);
    window.addEventListener("drop", reset);
    return () => {
      window.removeEventListener("dragend", reset);
      window.removeEventListener("drop", reset);
    };
  }, [dragging]);

  const openFiles = useCallback(() => {
    if (!disabled) fileInput.current?.click();
  }, [disabled]);
  const openFolder = useCallback(() => {
    if (!disabled) folderInput.current?.click();
  }, [disabled]);

  function onDragEnter(e: React.DragEvent) {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    if (disabled) return;
    depth.current += 1;
    setDragging(true);
  }
  function onDragOver(e: React.DragEvent) {
    if (!hasFiles(e.dataTransfer)) return;
    // Always prevent the default, or the browser navigates to the dropped file.
    e.preventDefault();
    e.dataTransfer.dropEffect = disabled ? "none" : "copy";
  }
  function onDragLeave(e: React.DragEvent) {
    if (!hasFiles(e.dataTransfer) || disabled) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    depth.current = 0;
    setDragging(false);
    if (disabled) return;
    const dt = e.dataTransfer;
    if (folder) {
      // filesFromDrop reads every webkitGetAsEntry() before its first await: this call is synchronous
      // with the event, which is what the P2P flow relies on.
      void filesFromDrop(dt).then((files) => onFilesRef.current(files, { source: "drop" }));
      return;
    }
    onFilesRef.current(plainFiles(dt), { source: "drop" });
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>, source: DropSource) {
    const list = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (!list.length) return;
    onFilesRef.current(source === "folder-picker" ? visible(list) : list, { source });
  }

  const zoneIsButton = actions === null;

  function onZoneClick(e: MouseEvent<HTMLDivElement>) {
    if (disabled) return;
    // Clicks on controls inside the zone are theirs.
    if ((e.target as HTMLElement).closest("button, a, input, label, [role=button]:not([data-dropzone])")) return;
    openFiles();
  }
  function onZoneKey(e: KeyboardEvent<HTMLDivElement>) {
    if (!zoneIsButton || disabled || e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openFiles();
    }
  }

  const choose = chooseLabel ?? (multiple ? "Choose files" : "Choose a file");
  const heading =
    title ?? (folder ? "Drop files or a whole folder" : multiple ? "Drop files here" : "Drop a file here");
  const dragHeading = dragTitle ?? (multiple || folder ? "Drop to add them" : "Drop to add it");
  const api: DropZoneApi = { openFiles, openFolder, dragging };

  let actionNode: ReactNode = null;
  if (typeof actions === "function") actionNode = actions(api);
  else if (actions !== undefined) actionNode = actions;
  else
    actionNode = (
      <>
        <Button variant={chooseVariant} size={compact ? "sm" : "md"} iconLeft={compact ? "plus" : "folder"} onClick={openFiles} disabled={disabled}>
          {choose}
        </Button>
        {folder && (
          <Button variant="ghost" size={compact ? "sm" : "md"} iconLeft="folder" onClick={openFolder} disabled={disabled} className={styles.folderBtn}>
            Choose a folder
          </Button>
        )}
      </>
    );

  const zoneA11y = zoneIsButton
    ? {
        role: "button" as const,
        tabIndex: disabled ? -1 : 0,
        "aria-label": label ?? choose,
        "aria-describedby": caption ? captionId : undefined,
        "aria-disabled": disabled || undefined,
        "data-dropzone": "",
      }
    : {
        role: "group" as const,
        "aria-labelledby": titleId,
        "aria-describedby": caption ? captionId : undefined,
        "aria-disabled": disabled || undefined,
      };

  return (
    <div
      id={id}
      {...zoneA11y}
      className={[styles.zone, zoneIsButton ? "md-focus" : "", className ?? ""].join(" ")}
      data-compact={compact || undefined}
      data-dragging={dragging || undefined}
      data-disabled={disabled || undefined}
      data-art={compact ? "none" : art}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={onZoneClick}
      onKeyDown={onZoneKey}
    >
      {!compact && art !== "none" && (
        <div className={styles.art} aria-hidden="true">
          {GHOSTS.map((g) => (
            <div key={g.name} className={styles.ghost} data-pos={g.pos}>
              <FileIcon name={g.name} mime={g.mime} size={art === "fan" ? 22 : 18} />
              <span className={styles.bar} />
              <span className={styles.bar} data-w="78" />
              <span className={styles.bar} data-w="56" />
              <span className={styles.ext}>{g.ext}</span>
            </div>
          ))}
          <span className={styles.tile}>
            <KitIcon name={icon} size={art === "fan" ? 22 : 24} />
          </span>
        </div>
      )}
      {compact && (
        <span className={styles.tile} aria-hidden="true">
          <KitIcon name={icon} size={18} />
        </span>
      )}
      <div className={styles.copy}>
        <div id={titleId} className={styles.title}>
          {dragging ? dragHeading : heading}
        </div>
        {caption && (
          <div id={captionId} className={styles.caption}>
            {caption}
          </div>
        )}
      </div>
      {actionNode && <div className={styles.actions}>{actionNode}</div>}
      <input
        ref={fileInput}
        type="file"
        hidden
        tabIndex={-1}
        multiple={multiple}
        accept={accept}
        disabled={disabled}
        onChange={(e) => onPick(e, "picker")}
      />
      {folder && (
        <input
          ref={folderInput}
          type="file"
          hidden
          tabIndex={-1}
          multiple
          disabled={disabled}
          {...({ webkitdirectory: "" } as Record<string, string>)}
          onChange={(e) => onPick(e, "folder-picker")}
        />
      )}
    </div>
  );
}

export default DropZone;
