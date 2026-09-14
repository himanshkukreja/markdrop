"use client";

import { useEffect, useRef, useState } from "react";
import { useWorkspaceTargets, type PublishTargetValue } from "@/lib/useWorkspaceTargets";

/**
 * The publish settings for a new document, as one row of chips.
 *
 * Replaces a stack of always-expanded controls that took roughly a third of the
 * page before anyone had typed anything. Two ideas do the work:
 *
 * Each chip states its **value**, not its input — "Encrypted", "Never expires",
 * "No password". Five answers read faster than five form fields, and most
 * documents never change any of them.
 *
 * Settings stay **visible but collapsed** rather than hidden behind the Publish
 * button. End-to-end encryption is the feature this product is sold on; putting
 * it one click deeper would quietly reduce how often anyone turns it on.
 *
 * On a phone the popovers become bottom sheets. An anchored popover next to a
 * chip that is itself in a scrolling row is unusable on a small screen — the
 * sheet is the same content given the width it needs.
 */

type PanelId = "destination" | "access" | "link" | "password" | "encrypt" | "expiry";

export interface PublishBarProps {
  target: PublishTargetValue;
  onTarget: (v: PublishTargetValue) => void;
  customSlug: string;
  onSlug: (v: string) => void;
  slugError: string;
  password: string;
  onPassword: (v: string) => void;
  encrypt: boolean;
  onEncrypt: (v: boolean) => void;
  encryptSupported: boolean;
  expiresIn: string;
  onExpiresIn: (v: string) => void;
  /** Who can open it once published. Only meaningful when signed in — there is
   *  nobody to be "only me" for otherwise. */
  accessLevel: "private" | "link";
  onAccessLevel: (v: "private" | "link") => void;
  signedIn: boolean;
  /** Rendered inside the expiry panel when a custom date is selected. */
  customDatePicker?: React.ReactNode;
  disabled?: boolean;
}

const field =
  "w-full bg-gray-50 dark:bg-gray-900 vscode:bg-[#2d2d2d] border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] rounded-lg px-3 py-2 text-sm text-gray-800 dark:text-gray-200 outline-none focus:border-blue-500 transition-colors";
const legend =
  "block text-[10.5px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1.5";

function Icon({ d, className = "w-3.5 h-3.5" }: { d: React.ReactNode; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {d}
    </svg>
  );
}

const ICONS = {
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
  link: <><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" /></>,
  lock: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
};

const EXPIRY_LABEL: Record<string, string> = {
  never: "Never expires",
  "1d": "Expires in 1 day",
  "7d": "Expires in 7 days",
  "30d": "Expires in 30 days",
  custom: "Custom expiry",
};

export default function PublishBar(p: PublishBarProps) {
  const [open, setOpen] = useState<PanelId | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const ws = useWorkspaceTargets(p.target);

  // Close on outside click and on Escape. Without both, a popover opened by
  // accident has no obvious way out on a keyboard or a trackpad.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(null); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const chip = (id: PanelId, set: boolean, icon: React.ReactNode, label: React.ReactNode) => (
    <button
      type="button"
      key={id}
      disabled={p.disabled}
      aria-expanded={open === id}
      aria-haspopup="dialog"
      onClick={() => setOpen(open === id ? null : id)}
      className={`group/chip shrink-0 inline-flex items-center gap-2 rounded-full border px-3.5 py-[7px] text-[12.5px] font-medium
        transition-all duration-150 disabled:opacity-50 ${
        open === id
          ? "border-blue-500/70 bg-blue-500/20 text-blue-100 shadow-[0_0_0_3px_rgba(59,130,246,.12)]"
          : set
            ? "border-blue-500/40 bg-blue-500/[0.13] text-blue-200 hover:border-blue-500/60 hover:bg-blue-500/[0.18]"
            : "border-gray-200 dark:border-white/[0.09] vscode:border-[#3c3c3c] bg-gray-50 dark:bg-white/[0.03] text-gray-600 dark:text-gray-400 hover:border-gray-300 dark:hover:border-white/20 hover:bg-gray-100 dark:hover:bg-white/[0.06] hover:text-gray-800 dark:hover:text-gray-200"
      }`}
    >
      <Icon d={icon} className="w-3.5 h-3.5 shrink-0 opacity-80" />
      {label}
      {set ? (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-400" aria-hidden />
      ) : (
        <Icon className="w-3 h-3 shrink-0 opacity-40 transition-opacity group-hover/chip:opacity-70"
              d={<path d="m6 9 6 6 6-6" />} />
      )}
    </button>
  );

  /** Anchored popover on desktop; full-width bottom sheet on a phone. */
  const panel = (id: PanelId, title: string, children: React.ReactNode) =>
    open !== id ? null : (
      <>
        {/* Dims the page behind the sheet. Phone only — on desktop the outside
            click handler is enough and a scrim would be heavy for a popover. */}
        <div className="sm:hidden fixed inset-0 z-[95] bg-black/50" onClick={() => setOpen(null)} />
        <div
          role="dialog"
          aria-label={title}
          // z above the feedback widget (z-[90]), which is pinned bottom-right
          // and would otherwise render on top of a sheet occupying the same
          // corner — covering the last line of whichever panel is open.
          className="fixed inset-x-0 bottom-0 z-[100] max-h-[80vh] overflow-y-auto rounded-t-2xl border-t
                     sm:absolute sm:inset-x-auto sm:bottom-auto sm:top-[calc(100%+6px)] sm:left-0 sm:z-30
                     sm:w-[340px] sm:max-h-none sm:rounded-xl sm:border
                     border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c]
                     bg-white dark:bg-gray-900 vscode:bg-[#252526] p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:pb-4 shadow-2xl"
        >
          <div className="sm:hidden mx-auto mb-3 h-1 w-10 rounded-full bg-gray-300 dark:bg-gray-700" />
          <div className="flex items-center justify-between gap-3 mb-3">
            <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">{title}</h3>
            <button type="button" onClick={() => setOpen(null)}
                    aria-label="Close"
                    className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-lg leading-none">×</button>
          </div>
          {children}
        </div>
      </>
    );

  return (
    <div ref={wrapRef} className="no-print relative shrink-0">
      {/* Scrolls sideways on a phone instead of wrapping to three rows and
          eating the editor. `-mx-4 px-4` lets it bleed to the screen edge so the
          last chip doesn't look cut off. */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1 -mx-4 px-4 sm:mx-0 sm:px-0 sm:flex-wrap sm:overflow-visible
                      [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <span className="hidden sm:inline shrink-0 pr-0.5 text-[11px] font-medium uppercase tracking-wider text-gray-400 dark:text-gray-600">
          Settings
        </span>
        {ws.available &&
          chip("destination", !!p.target.workspaceId, ICONS.folder,
            p.target.workspaceId ? (
              <span className="max-w-[190px] truncate">
                {ws.workspace?.name}
                {ws.folder && <span className="opacity-70"> / {ws.folder.path.join(" / ")}</span>}
              </span>
            ) : "Just me")}

        {p.signedIn &&
          chip("access", p.accessLevel === "private", ICONS.lock,
            p.accessLevel === "private" ? "Only me" : "Anyone with link")}

        {chip("link", !!p.customSlug, ICONS.link,
          p.customSlug
            ? <span className="font-mono max-w-[150px] truncate">/{p.customSlug}</span>
            : "Custom link")}

        {chip("password", !!p.password, ICONS.lock, p.password ? "Password set" : "No password")}

        {chip("encrypt", p.encrypt, ICONS.lock, p.encrypt ? "Encrypted" : "Encrypt")}

        {chip("expiry", p.expiresIn !== "never", ICONS.clock,
          EXPIRY_LABEL[p.expiresIn] ?? "Expiry")}
      </div>

      {panel("destination", "Where it publishes", (
        <div className="space-y-3">
          <div>
            <span className={legend}>Workspace</span>
            <select
              className={`${field} cursor-pointer`}
              value={p.target.workspaceId ?? ""}
              onChange={(e) =>
                // Folder ids are scoped to a workspace, so switching must clear
                // the folder or the save would be rejected.
                p.onTarget({ workspaceId: e.target.value || null, folderId: null })
              }
            >
              <option value="">Just me (private)</option>
              {ws.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </div>

          {p.target.workspaceId && (
            <>
              <div>
                <span className={legend}>Folder</span>
                <select
                  className={`${field} cursor-pointer`}
                  value={p.target.folderId ?? ""}
                  onChange={(e) => p.onTarget({ ...p.target, folderId: e.target.value || null })}
                >
                  <option value="">No folder</option>
                  {ws.folders.map((f) => (
                    <option key={f.id} value={f.id}>{f.path.join(" / ") || f.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <span className={legend}>Will publish to</span>
                <p className="rounded-lg border border-blue-500/25 bg-blue-500/10 px-3 py-2 font-mono text-[11px] text-blue-600 dark:text-blue-300 break-all">
                  {ws.preview}
                </p>
              </div>
              <p className="text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
                Everyone in {ws.workspace?.name} can read it; members and admins can edit it.
              </p>
            </>
          )}
        </div>
      ))}

      {panel("access", "Who can open it", (
        <div className="space-y-2">
          {([
            ["link", "Anyone with the link",
             "No sign-in needed. This is how Markdrop links have always worked."],
            ["private", "Only me",
             "Nobody else can open it. You can add people once it's published."],
          ] as const).map(([id, label, hint]) => (
            <button
              key={id}
              onClick={() => p.onAccessLevel(id)}
              className={`flex w-full items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                p.accessLevel === id
                  ? "border-blue-500/45 bg-blue-500/10"
                  : "border-gray-200 dark:border-white/[0.08] hover:bg-gray-50 dark:hover:bg-white/[0.04]"
              }`}
            >
              <span className="min-w-0">
                <span className={`block text-[13px] font-medium ${
                  p.accessLevel === id ? "text-blue-700 dark:text-blue-200" : "text-gray-800 dark:text-gray-200"
                }`}>{label}</span>
                <span className="mt-0.5 block text-[11.5px] leading-snug text-gray-500 dark:text-gray-400">{hint}</span>
              </span>
              {p.accessLevel === id && <span className="ml-auto mt-1 h-2 w-2 shrink-0 rounded-full bg-blue-400" />}
            </button>
          ))}
          <p className="pt-1 text-[11.5px] leading-relaxed text-gray-400">
            Naming specific people, and workspace-only access, are set from Share
            once the document exists.
          </p>
        </div>
      ))}

      {panel("link", "Custom link", (
        <div>
          <div className="flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] bg-gray-50 dark:bg-gray-900 px-3 py-2 focus-within:border-blue-500 transition-colors">
            <span className="shrink-0 text-xs text-gray-400 dark:text-gray-500">markdrop.in/</span>
            <input
              autoFocus
              value={p.customSlug}
              onChange={(e) => p.onSlug(e.target.value)}
              placeholder="custom-url"
              maxLength={50}
              className="min-w-0 flex-1 bg-transparent font-mono text-xs text-gray-700 dark:text-gray-300 placeholder-gray-400 dark:placeholder-gray-600 outline-none"
            />
          </div>
          {p.slugError
            ? <p className="mt-1.5 text-[11px] text-red-500">{p.slugError}</p>
            : <p className="mt-1.5 text-[11px] text-gray-400">Leave blank for a short random link.</p>}
        </div>
      ))}

      {panel("password", "Password", (
        <div>
          <input
            autoFocus
            type="text"
            value={p.password}
            onChange={(e) => p.onPassword(e.target.value)}
            placeholder="password (optional)"
            maxLength={100}
            className={`${field} font-mono`}
          />
          <p className="mt-1.5 text-[11px] leading-relaxed text-gray-400">
            Readers are asked for this before the document opens.
          </p>
        </div>
      ))}

      {panel("encrypt", "End-to-end encryption", (
        <div className="space-y-3">
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={p.encrypt}
              disabled={!p.encryptSupported}
              onChange={(e) => p.onEncrypt(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-emerald-600 disabled:cursor-not-allowed"
            />
            <span className="min-w-0">
              <span className="block text-xs font-medium text-gray-700 dark:text-gray-200">
                Encrypt in this browser
              </span>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
                {!p.encryptSupported
                  ? "Unavailable — this browser doesn't expose WebCrypto on an insecure connection."
                  : p.encrypt
                    ? <>Your browser encrypts the title and the text before publishing. The key goes
                        in the <span className="font-mono">#</span> part of the link, which browsers
                        never send to a server — so only ciphertext ever reaches Markdrop.</>
                    // Describes what happens to the document, not who is kept out
                    // of it. "So not even we can read it" quietly frames the
                    // default as us reading them, which is both wrong and a bad
                    // thing to put in front of someone deciding whether to trust
                    // the product.
                    : "Encrypt in your browser. Only your link can unlock it."}
              </span>
            </span>
          </label>

          {/* Three facts, not three paragraphs. Someone deciding whether to tick
              a box reads labels, not prose. The first is the destructive one and
              is tinted to match. */}
          {p.encrypt && (
            <ul className="space-y-2.5 rounded-lg border border-emerald-500/25 bg-emerald-500/[0.07] p-3">
              <li className="flex items-start gap-2">
                <Icon className="mt-px w-3.5 h-3.5 shrink-0 text-amber-500"
                      d={<><circle cx="7.5" cy="15.5" r="4.5" /><path d="M10.7 12.3 21 2M17.5 5.5 20 8M14 9l2.5 2.5" /></>} />
                <span>
                  <span className="block text-[11px] font-medium text-amber-700 dark:text-amber-400">The link is the key</span>
                  <span className="block text-[11px] leading-snug text-gray-500 dark:text-gray-400">
                    Lose it and the document is gone — no recovery, by anyone.
                  </span>
                </span>
              </li>
              <li className="flex items-start gap-2">
                <Icon className="mt-px w-3.5 h-3.5 shrink-0 text-gray-400"
                      d={<><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></>} />
                <span>
                  <span className="block text-[11px] font-medium text-gray-700 dark:text-gray-300">Anyone with the link can read it</span>
                  <span className="block text-[11px] leading-snug text-gray-500 dark:text-gray-400">
                    Share it as carefully as the document deserves.
                  </span>
                </span>
              </li>
              <li className="flex items-start gap-2">
                <Icon className="mt-px w-3.5 h-3.5 shrink-0 text-gray-400"
                      d={<><circle cx="12" cy="12" r="9" /><path d="M5.6 5.6l12.8 12.8" /></>} />
                <span>
                  <span className="block text-[11px] font-medium text-gray-700 dark:text-gray-300">Some features switch off</span>
                  <span className="block text-[11px] leading-snug text-gray-500 dark:text-gray-400">
                    Google Docs export, VS Code sync and link previews.
                  </span>
                </span>
              </li>
            </ul>
          )}
        </div>
      ))}

      {panel("expiry", "Expires", (
        <div className="space-y-3">
          <select
            className={`${field} cursor-pointer`}
            value={p.expiresIn}
            onChange={(e) => p.onExpiresIn(e.target.value)}
          >
            <option value="never">Never</option>
            <option value="1d">1 Day</option>
            <option value="7d">7 Days</option>
            <option value="30d">30 Days</option>
            <option value="custom">Custom…</option>
          </select>
          {p.expiresIn === "custom" && p.customDatePicker}
        </div>
      ))}
    </div>
  );
}
