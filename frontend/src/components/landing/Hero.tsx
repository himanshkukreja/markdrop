"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import MarkdownPreview from "@/components/MarkdownPreview";
import { SectionIcon } from "@/lib/readmeSectionIcons";
import { useAuth } from "@/contexts/AuthContext";

const MARKETPLACE_URL =
  "https://marketplace.visualstudio.com/items?itemName=HimanshuKukreja.markdrop";

const F = "```"; // code fence (template literals can't hold raw backticks)

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

/** Types `text` out one character at a time while `active`; jumps to full text
 *  under reduced-motion. Returns the partial string and whether it's finished. */
function useTypewriter(text: string, active: boolean) {
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (!active) return;
    if (prefersReducedMotion()) {
      setTyped(text);
      return;
    }
    setTyped("");
    let i = 0;
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const step = () => {
      if (cancelled) return;
      setTyped(text.slice(0, i));
      if (i < text.length) {
        const prev = text[i - 1];
        i++;
        timers.push(setTimeout(step, prev === "\n" ? 55 : 20));
      }
    };
    step();
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [text, active]);
  return { typed, done: text.length > 0 && typed.length >= text.length };
}

const PHRASE_FADE_MS = 500; // fade-out / fade-in leg of each phrase swap

/** Headline phrase that cycles through the feature list on its own timer, with a
 *  fade-out → swap → fade-in crossfade. Runs independently of the demo scene.
 *  Phrases (SCENES[].phrase) are short + uniform so the single line never wraps,
 *  which would otherwise change the headline height mid-cycle and jolt the layout. */
function RotatingPhrase() {
  const [i, setI] = useState(0);
  const [show, setShow] = useState(true);
  useEffect(() => {
    if (prefersReducedMotion()) return;
    let swap: ReturnType<typeof setTimeout>;
    const interval = setInterval(() => {
      setShow(false); // fade the current phrase out…
      swap = setTimeout(() => {
        setI((x) => (x + 1) % SCENES.length); // …swap while invisible…
        setShow(true); // …then fade the next one in.
      }, PHRASE_FADE_MS);
    }, 2800);
    return () => {
      clearInterval(interval);
      clearTimeout(swap);
    };
  }, []);
  return (
    <span
      className="md-gradient-text inline-block whitespace-nowrap"
      style={{
        opacity: show ? 1 : 0,
        transform: show ? "translateY(0)" : "translateY(0.3em)",
        transition: `opacity ${PHRASE_FADE_MS}ms cubic-bezier(0.16,1,0.3,1), transform ${PHRASE_FADE_MS}ms cubic-bezier(0.16,1,0.3,1)`,
      }}
    >
      {SCENES[i].phrase}
    </span>
  );
}

// ── Demo scenes ───────────────────────────────────────────────────────────────
type SceneId = "publish" | "diagram" | "artifacts" | "builder" | "send" | "sync" | "export";
// `phrase` is the headline word for this scene — short + uniform so the rotating
// line never wraps to two lines (which would jolt the headline height mid-cycle).
const SCENES: { id: SceneId; pill: string; tab: string; phrase: string; cta: string; dwell: number; isNew?: boolean }[] = [
  { id: "publish", pill: "Publish", tab: "welcome.md", phrase: "Instant links.", cta: "New document", dwell: 6200 },
  { id: "diagram", pill: "Diagrams & math", tab: "diagram.md", phrase: "Diagrams & math.", cta: "Try a diagram", dwell: 5600 },
  { id: "artifacts", pill: "Artifacts", tab: "report.pdf", phrase: "HTML, PDF & sheets.", cta: "Publish an artifact", dwell: 5400, isNew: true },
  { id: "builder", pill: "README builder", tab: "builder", phrase: "README builder.", cta: "Open the builder", dwell: 5000 },
  { id: "send", pill: "P2P file share", tab: "transfer", phrase: "Send any file.", cta: "Share a file", dwell: 5000 },
  { id: "sync", pill: "VS Code sync", tab: "notes.md", phrase: "VS Code sync.", cta: "Get the extension", dwell: 4600 },
  { id: "export", pill: "Docs & analytics", tab: "README.md", phrase: "Docs & analytics.", cta: "Open dashboard", dwell: 5400 },
];

// Artifact scene: the type chips, then a "rendered" chart standing in for the
// file itself. Colours mirror components/ArtifactBadge.tsx.
const ARTIFACT_CHIPS: { label: string; cls: string }[] = [
  { label: "HTML", cls: "bg-orange-500/10 text-orange-500 ring-orange-500/25" },
  { label: "PDF", cls: "bg-red-500/10 text-red-500 ring-red-500/25" },
  { label: "Excel", cls: "bg-emerald-500/10 text-emerald-500 ring-emerald-500/25" },
  { label: "Word", cls: "bg-blue-500/10 text-blue-500 ring-blue-500/25" },
  { label: "Site", cls: "bg-teal-500/10 text-teal-500 ring-teal-500/25" },
];
// Widths of the "rendered content" lines — uneven so it reads as prose rather
// than a loading skeleton.
const ARTIFACT_LINES = ["46%", "88%", "72%", "94%", "61%"];

// Blocks shown assembling in the README-builder scene (reuse the real section icons).
const BUILDER_BLOCKS: { id: string; name: string }[] = [
  { id: "title-and-description", name: "Title and Description" },
  { id: "badges", name: "Badges" },
  { id: "installation", name: "Installation" },
  { id: "mermaid-flowchart", name: "Flowchart" },
  { id: "api", name: "API Reference" },
];

const PUBLISH_MD = `# Release Notes 🚀

**Markdrop v2** is live.

- Instant share links
- Live preview + \`code\`
- Export to PDF

> Paste. Publish. Share.`;

const DIAGRAM_MD = `## How it flows

${F}mermaid
graph LR
  A[Write] --> B[Preview]
  B --> C[Publish 🚀]
${F}

Energy: $E = mc^2$`;

function PeerBox({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="w-11 h-11 rounded-xl flex items-center justify-center border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] bg-gray-50 dark:bg-gray-800/60 vscode:bg-[#2d2d2d] text-blue-600 dark:text-blue-400 vscode:text-[#4fc1ff]">
        {children}
      </div>
      <span className="text-[11px] text-gray-500 dark:text-gray-400">{label}</span>
    </div>
  );
}

function StatusBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative h-9 flex items-center px-3 text-xs font-mono border-t border-gray-200 dark:border-gray-800 vscode:border-transparent bg-gradient-to-r from-blue-600 to-sky-600 text-white overflow-hidden">
      {children}
    </div>
  );
}

const chip =
  "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border";

/** VS Code–styled window that cycles through a scene per feature. */
function DemoWindow({
  scene,
  setScene,
  setPaused,
}: {
  scene: number;
  setScene: (n: number) => void;
  setPaused: (p: boolean) => void;
}) {
  const active = SCENES[scene].id;
  const router = useRouter();
  const { user, openAuthModal } = useAuth();

  // Clicking the window opens the feature the current scene is showing.
  function activate() {
    switch (active) {
      case "publish":
        router.push("/new");
        break;
      case "diagram":
        router.push("/new?sample=diagrams");
        break;
      case "artifacts":
        router.push("/upload");
        break;
      case "builder":
        router.push("/builder");
        break;
      case "send":
        router.push("/share");
        break;
      case "sync":
        window.open(MARKETPLACE_URL, "_blank", "noopener,noreferrer");
        break;
      case "export":
        // Dashboard needs an account — sign in first, then land on it.
        if (user) {
          router.push("/dashboard");
        } else {
          openAuthModal({
            next: "/dashboard",
            title: "Sign in to Markdrop",
            message: "Sign in to open your dashboard — all your docs, view counts and analytics.",
            onSuccess: () => router.push("/dashboard"),
          });
        }
        break;
    }
  }

  const pub = useTypewriter(PUBLISH_MD, active === "publish");
  const dia = useTypewriter(DIAGRAM_MD, active === "diagram");

  // Publish sub-phase: typing → publishing → published.
  const [pubPhase, setPubPhase] = useState<"typing" | "publishing" | "published">("typing");
  useEffect(() => {
    if (active !== "publish") {
      setPubPhase("typing");
      return;
    }
    if (prefersReducedMotion()) {
      setPubPhase("published");
      return;
    }
    if (!pub.done) {
      setPubPhase("typing");
      return;
    }
    const t1 = setTimeout(() => setPubPhase("publishing"), 500);
    const t2 = setTimeout(() => setPubPhase("published"), 1500);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [active, pub.done]);

  const split = active === "publish" || active === "diagram";

  return (
    <div
      className="relative"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {/* Feature-pill tabs — name every pillar + drive the demo.
          Seven of these wrapped to a second row and shoved the demo down, so
          the strip scrolls horizontally instead, with masked edges hinting
          there's more. Tight sizing keeps all seven on one line on desktop. */}
      <div
        className="mb-3 -mx-1 px-1 flex flex-nowrap gap-1 overflow-x-auto md-no-scrollbar justify-start lg:justify-start"
        style={{
          maskImage:
            "linear-gradient(to right, transparent 0, #000 12px, #000 calc(100% - 12px), transparent 100%)",
          WebkitMaskImage:
            "linear-gradient(to right, transparent 0, #000 12px, #000 calc(100% - 12px), transparent 100%)",
        }}
      >
        {SCENES.map((sc, i) => (
          <button
            key={sc.id}
            onClick={() => setScene(i)}
            aria-pressed={i === scene}
            className={`relative shrink-0 whitespace-nowrap px-2 py-1 rounded-full text-[11px] font-medium border transition-colors ${
              i === scene
                ? sc.isNew
                  ? "border-amber-400/70 bg-amber-400/15 text-amber-600 dark:text-amber-300"
                  : "border-blue-500/60 bg-blue-500/15 text-blue-600 dark:text-blue-300 vscode:text-[#4fc1ff]"
                : sc.isNew
                ? "border-amber-400/40 text-amber-600/90 dark:text-amber-300/80 hover:border-amber-400/70"
                : "border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] text-gray-500 dark:text-gray-400 hover:border-blue-400/50 hover:text-blue-500"
            }`}
          >
            {sc.pill}
            {sc.isNew && (
              // A quiet pulsing dot rather than a shouted "NEW!" — enough to
              // pull the eye to a pill that would otherwise read as one of six.
              <span className="absolute -top-0.5 -right-0.5 flex h-2 w-2" aria-hidden>
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
              </span>
            )}
            {sc.isNew && <span className="sr-only"> (new)</span>}
          </button>
        ))}
      </div>

      {SCENES[scene].isNew && (
        // Sits on the frame rather than in the layout, so the demo doesn't
        // shift by a row when the rotation reaches (or leaves) a new feature.
        <span className="pointer-events-none absolute -top-2.5 left-4 z-20 inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-amber-500 to-orange-500 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-white shadow-lg shadow-amber-500/25">
          <svg className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M12 2l2.4 6.3L21 9.3l-4.8 4.3 1.4 6.4L12 16.8 6.4 20l1.4-6.4L3 9.3l6.6-1z" />
          </svg>
          Just shipped
        </span>
      )}

      <div
        role="link"
        tabIndex={0}
        onClick={activate}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            activate();
          }
        }}
        title={`${SCENES[scene].cta} →`}
        aria-label={SCENES[scene].cta}
        className="group/win relative w-full rounded-xl overflow-hidden border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] ring-1 ring-blue-500/10 bg-white dark:bg-[#0b0f1a] vscode:bg-[#1e1e1e] shadow-2xl shadow-blue-500/20 cursor-pointer transition-all duration-200 hover:-translate-y-0.5 hover:ring-2 hover:ring-blue-500/50 hover:shadow-blue-500/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      >
        {/* Hover hint — signals the window is clickable */}
        <div className="no-print pointer-events-none absolute top-9 right-2 z-20 opacity-0 translate-y-1 group-hover/win:opacity-100 group-hover/win:translate-y-0 transition-all duration-200">
          <span className="inline-flex items-center gap-1 rounded-full bg-blue-600 text-white text-[11px] font-medium px-2.5 py-1 shadow-lg">
            {SCENES[scene].cta}
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.4" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
            </svg>
          </span>
        </div>
        {/* Title bar */}
        <div className="flex items-center gap-2 px-3 py-2 bg-gray-100 dark:bg-gray-900 vscode:bg-[#323233] border-b border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c]">
          <span className="w-3 h-3 rounded-full bg-[#ff5f57]" />
          <span className="w-3 h-3 rounded-full bg-[#febc2e]" />
          <span className="w-3 h-3 rounded-full bg-[#28c840]" />
          <span className="ml-2 text-xs font-mono text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d]">
            {SCENES[scene].tab} — markdrop
          </span>
        </div>

        {/* Tab strip */}
        <div className="flex items-stretch text-xs border-b border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] bg-gray-50 dark:bg-gray-950 vscode:bg-[#252526]">
          <div className="flex items-center gap-1.5 px-3 py-1.5 border-r border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] bg-white dark:bg-[#0b0f1a] vscode:bg-[#1e1e1e] text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4]">
            <span className="text-blue-500 vscode:text-[#4fc1ff]">◆</span> {SCENES[scene].tab}
          </div>
          {split && (
            <div className="hidden sm:flex items-center px-3 py-1.5 text-gray-400 dark:text-gray-600 vscode:text-[#6a6a6a]">
              Preview
            </div>
          )}
        </div>

        {/* Body */}
        <div className="h-64 sm:h-72">
          {/* Publish + Diagram: editor | live preview */}
          {split ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 h-full">
              <div className="p-4 overflow-hidden font-mono text-[12.5px] leading-relaxed text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4] border-b sm:border-b-0 sm:border-r border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c]">
                <pre className="whitespace-pre-wrap break-words">
                  {active === "publish" ? pub.typed : dia.typed}
                  {((active === "publish" && !pub.done) ||
                    (active === "diagram" && !dia.done)) && (
                    <span className="md-caret text-blue-500">▋</span>
                  )}
                </pre>
              </div>
              <div className="p-4 overflow-hidden bg-gray-50/50 dark:bg-gray-900/40 vscode:bg-[#252526]">
                {active === "publish" ? (
                  pub.typed.trim() ? (
                    <MarkdownPreview content={pub.typed} />
                  ) : (
                    <p className="text-xs text-gray-400 dark:text-gray-600">Preview…</p>
                  )
                ) : dia.done ? (
                  <MarkdownPreview content={DIAGRAM_MD} />
                ) : (
                  <p className="text-xs text-gray-400 dark:text-gray-600">Rendering…</p>
                )}
              </div>
            </div>
          ) : active === "artifacts" ? (
            // ── Artifacts: a file lifting into the frame and rendering ──────
            // Bars bouncing said "chart", not "artifact". This reads as the
            // actual promise: a file goes in, a page comes out.
            <div className="h-full p-4 sm:p-5 overflow-hidden flex flex-col gap-3">
              <div className="flex items-center gap-1.5 flex-wrap">
                {ARTIFACT_CHIPS.map((c, i) => (
                  <span
                    key={c.label}
                    className={`md-stagger rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ${c.cls}`}
                    style={{ animationDelay: `${i * 90}ms` }}
                  >
                    {c.label}
                  </span>
                ))}
              </div>

              <div className="relative flex-1 min-h-0 rounded-lg border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] bg-gray-50 dark:bg-[#111c33] vscode:bg-[#1e1e1e] overflow-hidden">
                {/* A render sweep passing down the page */}
                <div
                  className="md-art-scan pointer-events-none absolute inset-x-0 top-0 h-10 z-10"
                  style={{
                    background:
                      "linear-gradient(to bottom, transparent, rgba(249,115,22,.16), transparent)",
                  }}
                  aria-hidden
                />

                {/* The file, lifting in */}
                <div className="md-art-lift absolute left-4 top-4 flex items-center gap-2 rounded-lg border border-orange-500/30 bg-orange-500/10 px-2.5 py-1.5 shadow-sm">
                  <svg className="h-4 w-4 text-orange-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" strokeLinejoin="round" />
                    <path d="M14 2v6h6" strokeLinejoin="round" />
                  </svg>
                  <span className="text-[10px] font-semibold text-orange-600 dark:text-orange-400">
                    report.pdf
                  </span>
                </div>

                {/* …becoming rendered content */}
                <div className="absolute inset-x-4 bottom-4 top-16 flex flex-col gap-2">
                  {ARTIFACT_LINES.map((w, i) => (
                    <div
                      key={i}
                      className={`md-art-line h-2 rounded ${
                        i === 0
                          ? "bg-gradient-to-r from-orange-500 to-orange-400"
                          : "bg-gray-300/70 dark:bg-slate-600/70"
                      }`}
                      style={{ width: w, animationDelay: `${300 + i * 130}ms` }}
                    />
                  ))}
                </div>
              </div>
            </div>
          ) : active === "builder" ? (
            // ── README builder (drag-and-drop blocks) ───────────────────────
            <div className="h-full p-4 sm:p-5 overflow-hidden">
              <div className="flex items-center justify-between mb-2.5">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
                  Your README
                </span>
                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-500 dark:text-blue-400">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14m7-7H5" />
                  </svg>
                  Add section
                </span>
              </div>
              <div className="space-y-1.5">
                {BUILDER_BLOCKS.map((b, idx) => {
                  const lifted = idx === 2; // one block "grabbed" mid-drag
                  return (
                    <div
                      key={b.id}
                      className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 text-xs transition-colors ${
                        lifted
                          ? "md-float relative z-10 border-blue-500/60 bg-white dark:bg-gray-900 vscode:bg-[#2d2d2d] shadow-lg shadow-blue-500/20 ring-1 ring-blue-500/40"
                          : "md-stagger border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] bg-gray-50/70 dark:bg-gray-900/40 vscode:bg-[#252526]"
                      }`}
                      style={lifted ? undefined : { animationDelay: `${idx * 90}ms` }}
                    >
                      <span className={`shrink-0 ${lifted ? "text-blue-500 cursor-grabbing" : "text-gray-300 dark:text-gray-600"}`}>
                        <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                          <circle cx="7" cy="4" r="1.4" /><circle cx="13" cy="4" r="1.4" />
                          <circle cx="7" cy="10" r="1.4" /><circle cx="13" cy="10" r="1.4" />
                          <circle cx="7" cy="16" r="1.4" /><circle cx="13" cy="16" r="1.4" />
                        </svg>
                      </span>
                      <SectionIcon
                        id={b.id}
                        className={`w-4 h-4 shrink-0 ${lifted ? "text-blue-500 dark:text-blue-400" : "text-gray-400 dark:text-gray-500"}`}
                      />
                      <span className="truncate text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4]">
                        {b.name}
                      </span>
                    </div>
                  );
                })}
              </div>
              <p className="mt-3 text-[11px] text-gray-400 dark:text-gray-500 text-center">
                45+ blocks · drag to reorder · publish or download .md
              </p>
            </div>
          ) : active === "send" ? (
            // ── P2P file share ──────────────────────────────────────────────
            <div className="flex flex-col items-center justify-center h-full gap-6 p-6">
              <div className="flex items-center gap-3 w-full max-w-xs">
                <PeerBox label="You">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.7" viewBox="0 0 24 24">
                    <rect x="3" y="4" width="18" height="12" rx="2" />
                    <path strokeLinecap="round" d="M2 20h20" />
                  </svg>
                </PeerBox>
                <div className="relative flex-1 h-px border-t border-dashed border-blue-400/50">
                  <span className="md-packet-anim absolute -top-[3px] w-1.5 h-1.5 rounded-full bg-blue-500 shadow-[0_0_8px_2px_rgba(59,130,246,0.6)]" />
                </div>
                <PeerBox label="Peer">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.7" viewBox="0 0 24 24">
                    <rect x="7" y="2" width="10" height="20" rx="2" />
                    <path strokeLinecap="round" d="M11 18h2" />
                  </svg>
                </PeerBox>
              </div>
              <div className="w-full max-w-xs">
                <div className="flex items-center justify-between text-xs mb-1.5 text-gray-600 dark:text-gray-300">
                  <span className="truncate font-medium">design-assets.zip</span>
                  <span className="text-gray-400 tabular-nums">48 MB</span>
                </div>
                <div className="h-1.5 rounded-full bg-gray-200 dark:bg-gray-800 overflow-hidden">
                  <div className="md-progress-anim h-full bg-gradient-to-r from-blue-500 to-sky-500" />
                </div>
              </div>
              <span className={`${chip} border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400`}>
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <rect x="5" y="11" width="14" height="9" rx="2" />
                  <path strokeLinecap="round" d="M8 11V8a4 4 0 018 0v3" />
                </svg>
                End-to-end encrypted · never touches a server
              </span>
            </div>
          ) : active === "sync" ? (
            // ── VS Code two-way sync ────────────────────────────────────────
            <div className="flex flex-col items-center justify-center h-full gap-7 p-6">
              <div className="flex items-center gap-3 w-full max-w-xs">
                <PeerBox label="VS Code">
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M17 2 8.5 10 4 6.5 2 7.5v9L4 17.5 8.5 14 17 22l5-2V4l-5-2zm0 4.7v10.6L10.5 12 17 6.7z" />
                  </svg>
                </PeerBox>
                <div className="relative flex-1">
                  <span className="absolute -top-[18px] left-1/2 -translate-x-1/2 text-[10px] text-gray-400">two-way</span>
                  <div className="h-px border-t border-dashed border-blue-400/50" />
                  <span className="md-shuttle-anim absolute -top-[3px] w-1.5 h-1.5 rounded-full bg-blue-500 shadow-[0_0_8px_2px_rgba(59,130,246,0.6)]" />
                </div>
                <PeerBox label="markdrop.in">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.7" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M3 12h18M12 3a15 15 0 010 18M12 3a15 15 0 000 18" />
                  </svg>
                </PeerBox>
              </div>
              <div className="w-full max-w-xs">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-mono text-gray-600 dark:text-gray-300">notes.md</span>
                  <span className={`${chip} border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400`}>
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.4" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                    Synced
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-gray-200 dark:bg-gray-800 overflow-hidden">
                  <div className="md-progress-anim h-full bg-gradient-to-r from-blue-500 to-sky-500" />
                </div>
              </div>
              <p className="text-[11px] text-gray-400 dark:text-gray-500 text-center max-w-xs">
                Save locally to push · edit on the web to pull back — with safe conflict diffs.
              </p>
            </div>
          ) : (
            // ── Export: Docs + PDF + builder + analytics ────────────────────
            <div className="flex flex-col items-center justify-center h-full gap-5 p-6">
              <div className="flex items-center gap-2">
                <div className="w-12 h-14 rounded-lg border border-gray-200 dark:border-gray-700 vscode:border-[#3c3c3c] bg-gray-50 dark:bg-gray-800/60 flex items-center justify-center text-gray-400">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth="1.6" viewBox="0 0 24 24">
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                    <path d="M14 2v6h6M8 13h8M8 17h5" />
                  </svg>
                </div>
                <div className="relative w-9 self-center">
                  <div className="h-px border-t border-dashed border-blue-400/50" />
                  <span className="md-shuttle-anim absolute -top-[3px] w-1.5 h-1.5 rounded-full bg-blue-500 shadow-[0_0_8px_2px_rgba(59,130,246,0.6)]" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className={`md-stagger ${chip} border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400`} style={{ animationDelay: "0ms" }}>
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.4" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                    Google Docs
                  </span>
                  <span className={`md-stagger ${chip} border-gray-300/50 dark:border-gray-700 text-gray-500 dark:text-gray-400`} style={{ animationDelay: "130ms" }}>PDF export</span>
                  <span className={`md-stagger ${chip} border-gray-300/50 dark:border-gray-700 text-gray-500 dark:text-gray-400`} style={{ animationDelay: "260ms" }}>Public link</span>
                </div>
              </div>
              <div className="flex flex-col items-center gap-1.5">
                <div className="flex items-end gap-1 h-8">
                  {[0.55, 0.85, 0.4, 1, 0.7, 0.9].map((h, i) => (
                    <span
                      key={i}
                      className="md-bar-anim w-1.5 rounded-sm bg-gradient-to-t from-blue-600 to-sky-400"
                      style={{ height: `${h * 100}%`, animationDelay: `${i * 150}ms` }}
                    />
                  ))}
                </div>
                <span className="text-[11px] text-gray-400 dark:text-gray-500">View counts &amp; geo analytics</span>
              </div>
              <p className="text-[11px] text-gray-400 dark:text-gray-500 text-center">
                Optional login unlocks a dashboard for all your docs.
              </p>
            </div>
          )}
        </div>

        {/* Status bar */}
        {active === "publish" ? (
          <StatusBar>
            {pubPhase === "published" ? (
              <div className="flex items-center gap-2 animate-[md-fade-up_0.4s_ease-out]">
                <svg className="w-3.5 h-3.5 text-green-300" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 011.4-1.4l3.3 3.3 6.8-6.8a1 1 0 011.4 0z" clipRule="evenodd" />
                </svg>
                <span>Published →</span>
                <span className="font-semibold underline decoration-white/40">markdrop.in/release-notes</span>
              </div>
            ) : pubPhase === "publishing" ? (
              <div className="flex items-center gap-2 text-white/90">
                <span className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
                Publishing…
              </div>
            ) : (
              <div className="flex items-center gap-2 text-white/90">
                <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
                Markdown · UTF-8 · Ln {pub.typed.split("\n").length}
              </div>
            )}
          </StatusBar>
        ) : active === "diagram" ? (
          <StatusBar>
            <span className="w-2 h-2 rounded-full bg-white animate-pulse mr-2" />
            Mermaid + LaTeX · rendered live in the browser
          </StatusBar>
        ) : active === "artifacts" ? (
          <StatusBar>
            <svg className="w-3.5 h-3.5 mr-2" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <rect x="4" y="4" width="16" height="16" rx="2" />
              <path strokeLinecap="round" d="M4 9h16" />
            </svg>
            HTML · PDF · Excel · Word — sandboxed on an isolated domain
          </StatusBar>
        ) : active === "builder" ? (
          <StatusBar>
            <svg className="w-3.5 h-3.5 mr-2" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h10" />
            </svg>
            Drag-and-drop README builder · 45+ section templates
          </StatusBar>
        ) : active === "send" ? (
          <StatusBar>
            <svg className="w-3.5 h-3.5 mr-2" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <rect x="5" y="11" width="14" height="9" rx="2" />
              <path strokeLinecap="round" d="M8 11V8a4 4 0 018 0v3" />
            </svg>
            Sending peer-to-peer · end-to-end encrypted
          </StatusBar>
        ) : active === "sync" ? (
          <StatusBar>
            <svg className="w-3.5 h-3.5 text-green-300 mr-2" fill="none" stroke="currentColor" strokeWidth="2.4" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            Synced with VS Code · two-way
          </StatusBar>
        ) : (
          <StatusBar>
            <svg className="w-3.5 h-3.5 text-green-300 mr-2" fill="none" stroke="currentColor" strokeWidth="2.4" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            Exported to Google Docs · PDF ready
          </StatusBar>
        )}
      </div>
    </div>
  );
}

export default function Hero() {
  // Single source of truth: the active scene drives BOTH the headline phrase and
  // the demo graphic, so copy and visual always describe the same feature.
  const [scene, setScene] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (prefersReducedMotion() || paused) return;
    const t = setTimeout(
      () => setScene((s) => (s + 1) % SCENES.length),
      SCENES[scene].dwell
    );
    return () => clearTimeout(t);
  }, [scene, paused]);

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
            Publish Markdown.
            <br />
            Share anything.
            <br />
            <RotatingPhrase />
          </h1>

          <p className="mt-5 text-base sm:text-lg text-gray-600 dark:text-gray-400 vscode:text-[#a0a0a0] max-w-xl mx-auto lg:mx-0">
            Paste markdown for a shareable link — no account required. Render Mermaid
            diagrams &amp; LaTeX live, build a README from 45+ blocks, sync two-way from
            VS Code, export to Google Docs, or send any file peer-to-peer.
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
            <DemoWindow scene={scene} setScene={setScene} setPaused={setPaused} />
          </div>
        </div>
      </div>
    </section>
  );
}
