"use client";

import { createContext, useContext } from "react";
import type { ApiOperationOption, UploadImage } from "./types";

/** What node views need from the editor's host (props of DocsEditor). */
export interface EditorHost {
  upload?: UploadImage;
  resolveAsset: (src: string) => string;
  operations: ApiOperationOption[];
  readOnly: boolean;
  /** Switches to Markdown mode (raw blocks offer it). */
  toMarkdown?: () => void;
}

export const EditorHostContext = createContext<EditorHost>({ resolveAsset: (s) => s, operations: [], readOnly: false });

export const useHost = () => useContext(EditorHostContext);

/** The URL an upload resolved with. */
export async function uploadUrl(upload: UploadImage, file: File, info: Parameters<UploadImage>[1]): Promise<string> {
  const r = await upload(file, info);
  return typeof r === "string" ? r : r.url;
}

/** `x.webp` → `x.dark.webp`: where the docs engine looks for an image's dark-theme version. */
export function darkVariantPath(src: string): string {
  const m = /^(.*?)(\.[a-z0-9]+)?(\?.*)?$/i.exec(src);
  if (!m) return `${src}.dark`;
  return `${m[1]}.dark${m[2] ?? ""}${m[3] ?? ""}`;
}
