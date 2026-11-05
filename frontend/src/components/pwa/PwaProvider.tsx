"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Button, Dialog, Drawer, useToast } from "@/components/ui";
import { track } from "@/lib/track";
import { DOCS_PAGES } from "@/lib/docsLinks";
import { docsUrl } from "@/components/shell/links";
import { BUILD_ID, PWA_ENABLED, installPathFor, isAppRoute, isStandalone, pwaSurface, type InstallPath } from "@/lib/pwa";
import { openInApp, refreshPush } from "@/lib/push";
import { useAuth } from "@/contexts/AuthContext";

/**
 * Markdrop as an installed app (lib/pwa.ts), for the whole page:
 *
 *   - registers the service worker (/sw.js, lib/pwaWorker.ts) from app screens on markdrop.in and
 *     guides.markdrop.in in production builds, and unregisters it where it must not run (dev, or
 *     the NEXT_PUBLIC_PWA=0 kill switch);
 *   - checks for a new version when the app comes back to the foreground and every 30 minutes; a
 *     new build waits until the person chooses Reload on the "new version" toast (silently takes
 *     over when this page already is that build);
 *   - the install UI's state: the browser's install prompt (caught early by PWA_BOOT_SCRIPT in the
 *     root layout), "installed", and the iPhone / iPad and Mac Safari instructions sheet.
 *
 *   - opens what a push notification's click asks for in this window (MD_OPEN from the worker).
 *
 * `usePwa()` gives the account menu its "Install app" item.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

declare global {
  interface Window {
    __mdInstallPrompt?: BeforeInstallPromptEvent | null;
  }
}

export interface PwaApi {
  /** How this browser installs the app here; null when it can't (or it already is installed). */
  installPath: InstallPath;
  /** Running as the installed app (standalone window). */
  standalone: boolean;
  /** "Markdrop" or "Markdrop Guides". */
  appName: string;
  install: () => void;
}

const NONE: PwaApi = { installPath: null, standalone: false, appName: "Markdrop", install: () => {} };
const PwaCtx = createContext<PwaApi>(NONE);

export function usePwa(): PwaApi {
  return useContext(PwaCtx);
}

const UPDATE_EVERY_MS = 30 * 60_000;
const FOREGROUND_CHECK_MS = 5 * 60_000;

/** Ask a worker which build it is (null when it doesn't answer in time). */
function versionOf(worker: ServiceWorker): Promise<string | null> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const t = setTimeout(() => resolve(null), 2000);
    ch.port1.onmessage = (e) => {
      clearTimeout(t);
      resolve(typeof e.data === "string" ? e.data : null);
    };
    try {
      worker.postMessage({ type: "VERSION" }, [ch.port2]);
    } catch {
      clearTimeout(t);
      resolve(null);
    }
  });
}

export function PwaProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || "/";
  const router = useRouter();
  const { info, success } = useToast();
  const [surface, setSurface] = useState<"app" | "studio" | null>(null);
  const [standalone, setStandalone] = useState(false);
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [ua, setUa] = useState<{ ua: string; touch: number } | null>(null);
  const [sheet, setSheet] = useState(false);
  const offered = useRef(new WeakSet<ServiceWorker>());
  const reloadOnTakeover = useRef(false);
  const appName = surface === "studio" ? "Markdrop Guides" : "Markdrop";

  /* ── Where we are, and the browser's install prompt ───────────────────── */
  useEffect(() => {
    setSurface(pwaSurface(window.location.hostname));
    setUa({ ua: navigator.userAgent, touch: navigator.maxTouchPoints || 0 });
    const mq = matchMedia("(display-mode: standalone)");
    const syncStandalone = () => setStandalone(isStandalone());
    syncStandalone();
    mq.addEventListener?.("change", syncStandalone);
    const takePrompt = () => setPrompt(window.__mdInstallPrompt ?? null);
    takePrompt();
    const onPrompt = (e: Event) => {
      e.preventDefault();
      window.__mdInstallPrompt = e as BeforeInstallPromptEvent;
      takePrompt();
    };
    const onInstalled = () => {
      window.__mdInstallPrompt = null;
      setPrompt(null);
      setInstalled(true);
      track("pwa_installed");
    };
    window.addEventListener("md:installprompt", takePrompt);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      mq.removeEventListener?.("change", syncStandalone);
      window.removeEventListener("md:installprompt", takePrompt);
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  useEffect(() => {
    if (installed) success(`${appName} is installed. Open it from your apps, dock or home screen.`);
  }, [installed, appName, success]);

  /* ── The service worker ───────────────────────────────────────────────── */
  const offerUpdate = useCallback(
    async (worker: ServiceWorker) => {
      if (offered.current.has(worker)) return;
      offered.current.add(worker);
      // This page already is the new build (it loaded after the deploy): take over quietly.
      if ((await versionOf(worker)) === BUILD_ID) {
        worker.postMessage({ type: "SKIP_WAITING" });
        return;
      }
      info(`A new version of ${appName} is ready.`, {
        duration: 24 * 60 * 60_000,
        action: {
          label: "Reload",
          onClick: () => {
            reloadOnTakeover.current = true;
            worker.postMessage({ type: "SKIP_WAITING" });
            // If the takeover never comes (the worker was replaced again), reload anyway.
            setTimeout(() => window.location.reload(), 4000);
          },
        },
      });
    },
    [appName, info],
  );

  // Registered once this page has been on an app screen (or runs as the installed app).
  const [registerHere, setRegisterHere] = useState(false);
  useEffect(() => {
    if (registerHere || !("serviceWorker" in navigator)) return;
    if (!PWA_ENABLED) {
      // Development (or the kill switch): no worker may serve this origin's files.
      void navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => {
        const url = (r.active || r.waiting || r.installing)?.scriptURL;
        if (url && new URL(url).pathname === "/sw.js") void r.unregister();
      })).catch(() => {});
      return;
    }
    const where = pwaSurface(window.location.hostname);
    if (where && (isAppRoute(pathname, where) || isStandalone())) setRegisterHere(true);
  }, [pathname, registerHere]);

  useEffect(() => {
    if (!registerHere) return;
    const sw = navigator.serviceWorker;
    let live = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    let reg: ServiceWorkerRegistration | null = null;
    let lastCheck = Date.now();
    const check = () => {
      lastCheck = Date.now();
      void reg?.update().catch(() => {});
    };
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - lastCheck > FOREGROUND_CHECK_MS) check();
    };
    const onTakeover = () => {
      if (reloadOnTakeover.current) window.location.reload();
    };
    const watch = (w: ServiceWorker | null) => {
      if (!w) return;
      const ready = () => {
        if (live && w.state === "installed" && sw.controller) void offerUpdate(w);
      };
      ready();
      w.addEventListener("statechange", ready);
    };
    const onFound = () => watch(reg?.installing ?? null);

    sw.addEventListener("controllerchange", onTakeover);
    document.addEventListener("visibilitychange", onVisible);
    sw.register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((r) => {
        if (!live) return;
        reg = r;
        watch(r.waiting);
        watch(r.installing);
        r.addEventListener("updatefound", onFound);
        timer = setInterval(check, UPDATE_EVERY_MS);
      })
      .catch(() => {});
    return () => {
      live = false;
      clearInterval(timer);
      reg?.removeEventListener("updatefound", onFound);
      sw.removeEventListener("controllerchange", onTakeover);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [registerHere, offerUpdate]);

  /* ── A click on a push notification (lib/pwaWorker.ts asks the open window to go there) ── */
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const sw = navigator.serviceWorker;
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type !== "MD_OPEN" || typeof e.data.url !== "string") return;
      e.ports?.[0]?.postMessage("ok"); // "on it": the worker doesn't reload the page
      openInApp(e.data.url, (h) => router.push(h));
    };
    sw.addEventListener("message", onMessage);
    // Messages wait until the page says it listens (startMessages); harmless when already on.
    sw.startMessages?.();
    return () => sw.removeEventListener("message", onMessage);
  }, [router]);

  // Signed in on markdrop.in with notifications allowed: keep this device's subscription fresh.
  const { user } = useAuth();
  const userId = user?.id;
  useEffect(() => {
    if (!userId || !registerHere || pwaSurface(window.location.hostname) !== "app") return;
    void refreshPush(userId).catch(() => {});
  }, [userId, registerHere]);

  /* ── Install ──────────────────────────────────────────────────────────── */
  const installPath: InstallPath = useMemo(() => {
    if (!surface || standalone || installed || !ua) return null;
    return installPathFor(ua.ua, ua.touch, !!prompt);
  }, [surface, standalone, installed, ua, prompt]);

  const install = useCallback(() => {
    track("pwa_install_click", { via: installPath || "none" });
    if (installPath === "prompt" && prompt) {
      void prompt.prompt().catch(() => {});
      void prompt.userChoice
        .then((c) => track("pwa_install_choice", { outcome: c.outcome }))
        .catch(() => {})
        .finally(() => {
          // A prompt can be shown once; the browser fires a fresh one if it is still installable.
          window.__mdInstallPrompt = null;
          setPrompt(null);
        });
      return;
    }
    if (installPath === "ios" || installPath === "mac-safari") setSheet(true);
  }, [installPath, prompt]);

  const api = useMemo<PwaApi>(() => ({ installPath, standalone, appName, install }), [installPath, standalone, appName, install]);

  return (
    <PwaCtx.Provider value={api}>
      {children}
      {installPath === "ios" && <IosInstallSheet open={sheet} onClose={() => setSheet(false)} appName={appName} iPad={/iPad|Macintosh/.test(ua?.ua || "")} />}
      {installPath === "mac-safari" && <MacSafariDialog open={sheet} onClose={() => setSheet(false)} appName={appName} />}
    </PwaCtx.Provider>
  );
}

/* ── Instructions where there is no install button ─────────────────────── */

const INSTALL_DOCS = docsUrl(DOCS_PAGES.installApp);

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-caption font-bold text-accent-text">{n}</span>
      <span className="min-w-0 pt-0.5 text-body text-text">{children}</span>
    </li>
  );
}

/** iOS's Share symbol (a box with an arrow out of its top), which is what people look for. */
function IosShareGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden className="inline-block align-[-3px] text-accent-text" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v12M8 7l4-4 4 4M7 11H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1" />
    </svg>
  );
}

function IosInstallSheet({ open, onClose, appName, iPad }: { open: boolean; onClose: () => void; appName: string; iPad: boolean }) {
  return (
    <Drawer
      open={open}
      onClose={onClose}
      side="bottom"
      title={`Install ${appName} on your ${iPad ? "iPad" : "iPhone"}`}
      description="Add it to your Home Screen: it opens full screen, straight to your work, like any app."
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <a href={INSTALL_DOCS} target="_blank" rel="noopener noreferrer" className="text-caption text-text-secondary underline-offset-2 hover:underline">More help</a>
          <Button variant="primary" onClick={onClose}>Got it</Button>
        </div>
      }
    >
      <ol className="m-0 flex list-none flex-col gap-4 p-0" data-testid="pwa-ios-steps">
        <Step n={1}>
          Tap <strong>Share</strong> <IosShareGlyph /> in the browser&rsquo;s toolbar.
          In Safari it may be under <strong>&middot;&middot;&middot;</strong> first.
        </Step>
        <Step n={2}>Scroll down and choose <strong>Add to Home Screen</strong>.</Step>
        <Step n={3}>Keep <strong>Open as Web App</strong> on, then tap <strong>Add</strong>.</Step>
      </ol>
    </Drawer>
  );
}

function MacSafariDialog({ open, onClose, appName }: { open: boolean; onClose: () => void; appName: string }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title={`Install ${appName} on your Mac`}
      description="Safari adds it to your Dock: it opens in its own window, straight to your work."
      footer={<Button variant="primary" onClick={onClose}>Got it</Button>}
    >
      <ol className="m-0 flex list-none flex-col gap-4 p-0">
        <Step n={1}>In Safari&rsquo;s menu bar, choose <strong>File &rsaquo; Add to Dock</strong>.</Step>
        <Step n={2}>Click <strong>Add</strong>.</Step>
      </ol>
    </Dialog>
  );
}
