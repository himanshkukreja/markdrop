"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

/**
 * Toasts — feedback for an action that already happened.
 *
 * Settings pages used to report success by revealing a line of green text above
 * the form. On a long page that line is frequently off screen at the moment you
 * press Save, so the honest result was a button that appeared to do nothing.
 * A toast is anchored to the viewport instead of the document, so it is seen
 * wherever you happen to be.
 *
 * Errors are kept deliberately separate in one respect: they stay on screen
 * roughly twice as long, because "saved" is confirming what you expected and
 * a failure is telling you something you didn't know.
 */

type ToastKind = "success" | "error" | "info";

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastApi {
  toast: (message: string, kind?: ToastKind) => void;
  success: (message: string) => void;
  error: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // A no-op rather than a crash: a component that toasts is usually not the
    // reason a tree exists, and losing a confirmation is better than losing the
    // page. Surfaces loudly in development.
    if (process.env.NODE_ENV !== "production") {
      console.warn("useToast() called outside <ToastProvider>; messages are dropped.");
    }
    const noop = () => {};
    return { toast: noop, success: noop, error: noop };
  }
  return ctx;
}

const DURATION: Record<ToastKind, number> = {
  success: 3200,
  info: 3800,
  error: 6500,
};

const ICONS: Record<ToastKind, React.ReactNode> = {
  success: <path d="M20 6 9 17l-5-5" />,
  error: <><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.01" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 7.5v.01" /></>,
};

const TONES: Record<ToastKind, string> = {
  success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  error: "border-red-500/30 bg-red-500/10 text-red-300",
  info: "border-blue-500/30 bg-blue-500/10 text-blue-300",
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const toast = useCallback((message: string, kind: ToastKind = "success") => {
    const id = ++seq.current;
    // Cap the stack. Ten stacked toasts is not information, it's a wall.
    setToasts((t) => [...t.slice(-3), { id, kind, message }]);
    timers.current.set(id, setTimeout(() => dismiss(id), DURATION[kind]));
  }, [dismiss]);

  // Clears pending timers if the provider unmounts mid-flight.
  useEffect(() => {
    const pending = timers.current;
    return () => { pending.forEach(clearTimeout); pending.clear(); };
  }, []);

  const api: ToastApi = {
    toast,
    success: useCallback((m: string) => toast(m, "success"), [toast]),
    error: useCallback((m: string) => toast(m, "error"), [toast]),
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        // Announced politely so a screen reader hears the confirmation without
        // having it interrupt whatever is being read.
        aria-live="polite"
        aria-atomic="false"
        // Bottom-LEFT, not right: the feedback widget is pinned bottom-right,
        // and a toast landing on top of it hid both. Left is empty on every
        // page, and a toast still reads as transient there.
        className="no-print pointer-events-none fixed bottom-4 left-4 z-[200] flex flex-col items-start gap-2"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.kind === "error" ? "alert" : "status"}
            onClick={() => dismiss(t.id)}
            className={`md-toast pointer-events-auto flex max-w-sm cursor-pointer items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm shadow-xl backdrop-blur-md ${TONES[t.kind]}`}
          >
            <svg className="mt-0.5 h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"
                 strokeLinejoin="round" aria-hidden>
              {ICONS[t.kind]}
            </svg>
            <span className="leading-snug">{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
