"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Spinner from "@/components/Spinner";
import { formatBytes } from "@/components/ArtifactBadge";

/**
 * Client-side preview of a file before it's published. Nothing is uploaded.
 *
 * SECURITY — user HTML is rendered with `srcDoc` + `sandbox`, never a blob: URL.
 * A blob: URL inherits the origin of the page that created it, so previewing a
 * pasted page that way would run it on markdrop.in with access to the session
 * token in localStorage — precisely the hole the separate artifact origin exists
 * to close. `srcDoc` with a sandbox that omits `allow-same-origin` gives the
 * frame an opaque origin instead, so scripts still run and the page still looks
 * right, but it can reach nothing of ours.
 *
 * Binary types that need a parser (spreadsheets, Word) load one from the CDN on
 * demand with the same pinned SRI digests the artifact Worker uses, so nothing
 * is added to the main bundle for people who never open this page.
 */
const SHEET_JS =
  "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
const SHEET_SRI =
  "sha512-r22gChDnGvBylk90+2e/ycr3RVrDi8DIOkIGNhJlKfuyQM4tIRAI062MaV8sfjQKYVGjOBaZBOA87z+IhZE9DA==";
const MAMMOTH_JS =
  "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.12.1/mammoth.browser.min.js";
const MAMMOTH_SRI =
  "sha512-Ri7OCzulIlV8Rp8BzgFbScplsAV4hqrES1iv1ure0AHE8IgZ39MT03jqpqsOZkP14STXplVFQwUHXetvXH87XQ==";

/** Load a classic script once, verified against its digest. */
function loadScript(src: string, integrity: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const el = document.createElement("script");
    el.src = src;
    el.integrity = integrity;
    el.crossOrigin = "anonymous";
    el.referrerPolicy = "no-referrer";
    el.onload = () => resolve();
    el.onerror = () => reject(new Error("Could not load the preview library"));
    document.head.appendChild(el);
  });
}

type Kind = "html" | "pdf" | "image" | "sheet" | "docx" | "text" | "bundle" | "none";

function kindOf(name: string): Kind {
  const ext = name.toLowerCase().split(".").pop() || "";
  if (["html", "htm"].includes(ext)) return "html";
  if (ext === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "image";
  if (["csv", "xlsx", "xls"].includes(ext)) return "sheet";
  if (ext === "docx") return "docx";
  if (["txt", "json"].includes(ext)) return "text";
  if (ext === "zip") return "bundle";
  return "none";
}

/** Minimal RFC-4180 parse — enough for a preview, and avoids a dependency. */
function parseCsv(text: string, maxRows = 200): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") {
      row.push(cell); cell = "";
      rows.push(row); row = [];
      if (rows.length >= maxRows) return rows;
    } else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] overflow-hidden bg-white dark:bg-[#0b1220] h-[26rem]">
      {children}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full grid place-items-center p-6 text-center text-sm text-gray-500 dark:text-gray-400">
      <div>{children}</div>
    </div>
  );
}

export default function ArtifactPreview({
  file,
  html,
}: {
  /** A chosen file, for the upload tab. */
  file?: File | null;
  /** Pasted markup, for the paste tab. */
  html?: string;
}) {
  const kind: Kind = html !== undefined ? "html" : file ? kindOf(file.name) : "none";

  const [docHtml, setDocHtml] = useState<string | null>(null);
  const [rows, setRows] = useState<string[][] | null>(null);
  const [sheets, setSheets] = useState<string[]>([]);
  const [sheet, setSheet] = useState(0);
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const wbRef = useRef<unknown>(null);

  // Object URLs are only ever used for types that cannot script our origin
  // (PDF, images) — never for HTML. Revoked when the file changes.
  const objectUrl = useMemo(
    () => (file && (kind === "pdf" || kind === "image") ? URL.createObjectURL(file) : null),
    [file, kind]
  );
  useEffect(() => () => { if (objectUrl) URL.revokeObjectURL(objectUrl); }, [objectUrl]);

  useEffect(() => {
    setDocHtml(null); setRows(null); setSheets([]); setSheet(0); setText(null); setError("");
    if (!file) return;
    let cancelled = false;

    (async () => {
      setBusy(true);
      try {
        if (kind === "html" || kind === "text") {
          const t = await file.text();
          if (cancelled) return;
          kind === "html" ? setDocHtml(t) : setText(t.slice(0, 200_000));
        } else if (kind === "sheet") {
          if (file.name.toLowerCase().endsWith(".csv")) {
            const t = await file.text();
            if (!cancelled) setRows(parseCsv(t));
          } else {
            await loadScript(SHEET_JS, SHEET_SRI);
            if (cancelled) return;
            const XLSX = (window as unknown as { XLSX: any }).XLSX; // eslint-disable-line @typescript-eslint/no-explicit-any
            const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
            if (cancelled) return;
            wbRef.current = wb;
            setSheets(wb.SheetNames);
            setRows(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 }));
          }
        } else if (kind === "docx") {
          await loadScript(MAMMOTH_JS, MAMMOTH_SRI);
          if (cancelled) return;
          const mammoth = (window as unknown as { mammoth: any }).mammoth; // eslint-disable-line @typescript-eslint/no-explicit-any
          const { value } = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
          if (!cancelled) setDocHtml(value || "<p>This document appears to be empty.</p>");
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not preview this file");
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();

    return () => { cancelled = true; };
  }, [file, kind]);

  function showSheet(i: number) {
    const wb = wbRef.current as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const XLSX = (window as unknown as { XLSX: any }).XLSX; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!wb || !XLSX) return;
    setSheet(i);
    setRows(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[i]], { header: 1 }));
  }

  if (kind === "none" && !file) return null;

  const body = (() => {
    if (error) return <Centered><span className="text-red-500">{error}</span></Centered>;
    if (busy) return <Centered><Spinner className="w-5 h-5 mx-auto mb-2" />Preparing preview…</Centered>;

    if (kind === "html") {
      const source = html !== undefined ? html : docHtml;
      if (!source?.trim()) {
        return <Centered>Your page will appear here as you type.</Centered>;
      }
      return (
        <iframe
          // srcDoc + sandbox WITHOUT allow-same-origin: the frame gets an opaque
          // origin, so the page renders and scripts run but it cannot touch
          // markdrop.in. A blob: URL would inherit our origin instead.
          srcDoc={source}
          sandbox="allow-scripts allow-forms allow-popups allow-modals"
          referrerPolicy="no-referrer"
          title="Preview"
          className="w-full h-full border-0 bg-white"
        />
      );
    }

    if (kind === "pdf" && objectUrl) {
      return <iframe src={objectUrl} title="PDF preview" className="w-full h-full border-0" />;
    }

    if (kind === "image" && objectUrl) {
      return (
        <div className="h-full grid place-items-center p-4 bg-[repeating-conic-gradient(#f3f4f6_0_25%,#fff_0_50%)] bg-[length:20px_20px] dark:bg-none">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={objectUrl} alt="Preview" className="max-w-full max-h-full object-contain" />
        </div>
      );
    }

    if (kind === "docx" && docHtml) {
      return (
        <iframe
          srcDoc={`<style>body{font:15px/1.7 -apple-system,Segoe UI,Roboto,sans-serif;padding:2rem;max-width:44rem;margin:0 auto;color:#111}img{max-width:100%}table{border-collapse:collapse;width:100%}td,th{border:1px solid #e5e7eb;padding:6px}</style>${docHtml}`}
          sandbox=""
          title="Document preview"
          className="w-full h-full border-0 bg-white"
        />
      );
    }

    if (kind === "sheet" && rows) {
      return (
        <div className="h-full flex flex-col">
          {sheets.length > 1 && (
            <div className="flex gap-1 p-2 border-b border-gray-200 dark:border-gray-800 overflow-x-auto md-no-scrollbar">
              {sheets.map((n, i) => (
                <button
                  key={n}
                  onClick={() => showSheet(i)}
                  className={`shrink-0 px-2.5 py-1 text-xs rounded-md transition-colors ${
                    i === sheet
                      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                      : "text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          )}
          <div className="flex-1 overflow-auto">
            <table className="text-xs border-collapse">
              <tbody>
                {rows.slice(0, 200).map((r, i) => (
                  <tr key={i} className={i === 0 ? "sticky top-0" : ""}>
                    {(r || []).map((c, j) => (
                      <td
                        key={j}
                        className={`border border-gray-200 dark:border-gray-800 px-2 py-1 whitespace-nowrap ${
                          i === 0
                            ? "bg-gray-50 dark:bg-gray-900 font-semibold text-gray-700 dark:text-gray-300"
                            : "text-gray-600 dark:text-gray-400"
                        }`}
                      >
                        {String(c ?? "")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    }

    if (kind === "text" && text !== null) {
      return (
        <pre className="h-full overflow-auto p-4 text-xs whitespace-pre-wrap break-words text-gray-700 dark:text-gray-300">
          {text}
        </pre>
      );
    }

    if (kind === "bundle") {
      return (
        <Centered>
          <p className="font-medium text-gray-700 dark:text-gray-300">Zipped site</p>
          <p className="mt-1">
            The archive is unpacked when you publish, and the entry page renders then.
            {file && <> · {formatBytes(file.size)}</>}
          </p>
        </Centered>
      );
    }

    return <Centered>No preview available for this file type.</Centered>;
  })();

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="block text-xs font-medium text-gray-500 dark:text-gray-400">Preview</span>
        <span className="text-[11px] text-gray-400">Rendered here in your browser — nothing uploaded yet</span>
      </div>
      <Frame>{body}</Frame>
    </div>
  );
}
