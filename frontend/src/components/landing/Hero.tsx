"use client";

import { useEffect, useRef, useState } from "react";
import MarkdownPreview from "@/components/MarkdownPreview";

const SAMPLE = `# Release Notes 🚀

**Markdrop v2** is live.

- Instant share links
- No login required
- \`code\` friendly

> Paste. Publish. Share.
`;

const SLUG = "release-notes";

type Phase = "typing" | "publishing" | "published";

function prefersReducedMotion() {
  return typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** VS Code–styled window that types Markdown, renders it live, then "publishes" a link. */
function DemoWindow() {
  const [typed, setTyped] = useState("");
  const [phase, setPhase] = useState<Phase>("typing");
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    // Reduced motion → jump straight to the finished, published state.
    if (prefersReducedMotion()) {
      setTyped(SAMPLE);
      setPhase("published");
      return;
    }

    let cancelled = false;
    const clearAll = () => { timers.current.forEach(clearTimeout); timers.current = []; };
    const wait = (ms: number) => new Promise<void>((res) => timers.current.push(setTimeout(res, ms)));

    async function run() {
      while (!cancelled) {
        setPhase("typing");
        for (let i = 0; i <= SAMPLE.length; i++) {
          if (cancelled) return;
          setTyped(SAMPLE.slice(0, i));
          // Slightly longer pause after newlines for a natural rhythm.
          await wait(SAMPLE[i - 1] === "\n" ? 90 : 26);
        }
        await wait(900);
        if (cancelled) return;
        setPhase("publishing");
        await wait(1100);
        if (cancelled) return;
        setPhase("published");
        await wait(3200);
        if (cancelled) return;
        setTyped("");
      }
    }
    run();
    return () => { cancelled = true; clearAll(); };
  }, []);

  return (
    <div className="w-full rounded-xl overflow-hidden border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] ring-1 ring-blue-500/10 bg-white dark:bg-[#0b0f1a] vscode:bg-[#1e1e1e] shadow-2xl shadow-blue-500/20">
      {/* Title bar */}
      <div className="flex items-center gap-2 px-3 py-2 bg-gray-100 dark:bg-gray-900 vscode:bg-[#323233] border-b border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c]">
        <span className="w-3 h-3 rounded-full bg-[#ff5f57]" />
        <span className="w-3 h-3 rounded-full bg-[#febc2e]" />
        <span className="w-3 h-3 rounded-full bg-[#28c840]" />
        <span className="ml-2 text-xs font-mono text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d]">
          welcome.md — markdrop
        </span>
      </div>

      {/* Tab strip */}
      <div className="flex items-stretch text-xs border-b border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] bg-gray-50 dark:bg-gray-950 vscode:bg-[#252526]">
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-r border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] bg-white dark:bg-[#0b0f1a] vscode:bg-[#1e1e1e] text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4]">
          <span className="text-blue-500 vscode:text-[#4fc1ff]">◆</span> welcome.md
        </div>
        <div className="hidden sm:flex items-center px-3 py-1.5 text-gray-400 dark:text-gray-600 vscode:text-[#6a6a6a]">
          Preview
        </div>
      </div>

      {/* Body: editor + live preview */}
      <div className="grid grid-cols-1 sm:grid-cols-2 h-64 sm:h-72">
        {/* Editor */}
        <div className="p-4 overflow-hidden font-mono text-[12.5px] leading-relaxed text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4] border-b sm:border-b-0 sm:border-r border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c]">
          <pre className="whitespace-pre-wrap break-words">
            {typed}
            {phase === "typing" && <span className="md-caret text-blue-500">▋</span>}
          </pre>
        </div>
        {/* Live preview */}
        <div className="p-4 overflow-hidden bg-gray-50/50 dark:bg-gray-900/40 vscode:bg-[#252526]">
          {typed.trim() ? (
            <MarkdownPreview content={typed} />
          ) : (
            <p className="text-xs text-gray-400 dark:text-gray-600">Preview…</p>
          )}
        </div>
      </div>

      {/* Status / publish bar */}
      <div className="relative h-9 flex items-center px-3 text-xs font-mono border-t border-gray-200 dark:border-gray-800 vscode:border-transparent bg-gradient-to-r from-blue-600 to-sky-600 text-white overflow-hidden">
        {phase === "published" ? (
          <div className="flex items-center gap-2 text-white animate-[md-fade-up_0.4s_ease-out]">
            <svg className="w-3.5 h-3.5 text-green-300" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 011.4-1.4l3.3 3.3 6.8-6.8a1 1 0 011.4 0z" clipRule="evenodd" />
            </svg>
            <span>Published →</span>
            <span className="text-white font-semibold underline decoration-white/40">markdrop.in/{SLUG}</span>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-white/90">
            {phase === "publishing" ? (
              <>
                <span className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
                Publishing…
              </>
            ) : (
              <>
                <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
                Markdown · UTF-8 · Ln {typed.split("\n").length}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function Hero() {
  return (
    <section className="relative pt-10 sm:pt-16 pb-14 sm:pb-20">
      {/* Decorative glow */}
      <div
        aria-hidden
        className="md-glow pointer-events-none absolute -top-24 left-1/2 -translate-x-1/2 w-[42rem] max-w-full h-[28rem] rounded-full blur-3xl opacity-70"
        style={{ background: "radial-gradient(circle at center, rgba(59,130,246,0.38), rgba(14,165,233,0.15) 45%, transparent 70%)" }}
      />

      <div className="relative grid lg:grid-cols-2 gap-10 lg:gap-12 items-center">
        {/* Copy */}
        <div className="text-center lg:text-left">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-300 vscode:text-[#4fc1ff]">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
            No login. No friction. Just links.
          </span>

          <h1 className="mt-5 text-4xl sm:text-5xl lg:text-[3.4rem] font-bold tracking-tight leading-[1.08] text-gray-900 dark:text-white vscode:text-[#e8e8e8]">
            Publish Markdown.<br />
            Share files.{" "}
            <span className="md-gradient-text">Sync from your editor.</span>
          </h1>

          <p className="mt-5 text-base sm:text-lg text-gray-600 dark:text-gray-400 vscode:text-[#a0a0a0] max-w-xl mx-auto lg:mx-0">
            Paste markdown and get a shareable link instantly — no account required.
            Send any file peer-to-peer, and keep your docs in sync straight from VS Code.
          </p>

          <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center lg:justify-start">
            <a
              href="/new"
              className="group inline-flex items-center justify-center gap-2 px-6 py-3 rounded-lg bg-gradient-to-r from-blue-600 to-sky-600 hover:from-blue-500 hover:to-sky-500 text-white text-sm font-semibold transition-all shadow-lg shadow-blue-600/30 hover:shadow-blue-500/40"
            >
              <svg className="w-4 h-4 transition-transform group-hover:rotate-90" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              New document
            </a>
            <a
              href="/share"
              className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-lg border border-gray-300 dark:border-gray-700 vscode:border-[#3c3c3c] hover:bg-gray-100 dark:hover:bg-gray-800 vscode:hover:bg-[#2d2d2d] text-gray-800 dark:text-gray-200 vscode:text-[#d4d4d4] text-sm font-semibold transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
              </svg>
              Share a file
            </a>
          </div>

          <p className="mt-5 text-xs text-gray-500 dark:text-gray-500 vscode:text-[#6a6a6a]">
            No account required · Instant links · End-to-end encrypted transfers · Open source
          </p>
        </div>

        {/* Interactive demo */}
        <div className="relative md-float">
          {/* Soft glow behind the window — gives it depth without the animated border */}
          <div
            aria-hidden
            className="md-glow pointer-events-none absolute -inset-6 rounded-3xl blur-2xl opacity-70"
            style={{ background: "radial-gradient(60% 60% at 50% 40%, rgba(59,130,246,0.28), rgba(99,102,241,0.12) 55%, transparent 75%)" }}
          />
          <div className="relative">
            <DemoWindow />
          </div>
        </div>
      </div>
    </section>
  );
}
