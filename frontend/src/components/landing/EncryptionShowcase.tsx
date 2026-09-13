"use client";

import { useEffect, useState } from "react";
import Reveal from "./Reveal";

const PLAINTEXT = ["# Q4 board notes", "Revenue up 18% on the back of…", "Headcount plan: 12 roles, 3 backfills"];
const CIPHER_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
// Fixed seed for the server render; the scramble only starts after mount, so the
// first paint matches and hydration stays quiet.
const SEED = "n0Nwc46OaOx2JnZF4mhyv2-CWrYPE0QHbdyhwvkzvGImcYFlWzZMxq9Qv9R1uIADbQ79BZHF";

/** Cycles the ciphertext so it reads as noise rather than as a second password. */
function useScramble(enabled: boolean) {
  const [text, setText] = useState(SEED);
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => {
      setText((prev) =>
        prev
          .split("")
          .map((c) => (Math.random() < 0.12 ? CIPHER_ALPHABET[Math.floor(Math.random() * CIPHER_ALPHABET.length)] : c))
          .join("")
      );
    }, 140);
    return () => clearInterval(id);
  }, [enabled]);
  return text;
}

export default function EncryptionShowcase() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const cipher = useScramble(mounted);

  return (
    <section className="py-16 sm:py-20">
      <div className="grid lg:grid-cols-2 gap-10 lg:gap-14 items-center [&>*]:min-w-0">
        {/* Copy — second on desktop, so the run of showcases keeps alternating */}
        <Reveal className="lg:order-2">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold uppercase tracking-wider bg-emerald-500/10 text-emerald-500 ring-1 ring-emerald-500/25">
            End-to-end encryption
          </span>
          <h2 className="mt-4 text-2xl sm:text-3xl font-bold tracking-tight text-gray-900 dark:text-gray-100 vscode:text-[#d4d4d4]">
            Publish documents we can&apos;t read
          </h2>
          <p className="mt-3 text-gray-600 dark:text-gray-400 vscode:text-[#9d9d9d] leading-relaxed">
            Tick one box and your browser encrypts the document — title and all — before it
            leaves the tab. The key travels in the
            <span className="text-gray-800 dark:text-gray-200 vscode:text-[#d4d4d4] font-medium"> # </span>
            part of the link, which browsers never send to a server. Markdrop stores
            ciphertext and holds no key to it.
          </p>
          <ul className="mt-5 space-y-2.5 text-sm text-gray-600 dark:text-gray-400 vscode:text-[#9d9d9d]">
            {[
              "AES-256-GCM, generated and applied in your browser",
              "The title is encrypted too — not just the body",
              "Rotate the key any time; the old link stops working",
              "No account needed, and nothing to configure",
            ].map((t) => (
              <li key={t} className="flex items-start gap-2.5">
                <svg className="w-4 h-4 mt-0.5 shrink-0 text-emerald-500" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                  <path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-8 8a1 1 0 01-1.4 0l-4-4a1 1 0 111.4-1.4L8 12.58l7.3-7.3a1 1 0 011.4 0z" clipRule="evenodd" />
                </svg>
                <span>{t}</span>
              </li>
            ))}
          </ul>
          <a
            href="/new"
            className="mt-7 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium transition-colors"
          >
            Publish an encrypted document
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
            </svg>
          </a>
        </Reveal>

        {/* Visual */}
        <Reveal delay={120} className="lg:order-1">
          <div className="rounded-2xl border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] bg-white/60 dark:bg-gray-900/50 vscode:bg-[#252526]/80 backdrop-blur-sm overflow-hidden">
            {/* In the browser */}
            <div className="px-4 sm:px-5 py-4">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
                In your browser
              </p>
              <div className="mt-2.5 space-y-1 font-mono text-[11px] sm:text-xs text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4]">
                {PLAINTEXT.map((line) => (
                  <p key={line} className="truncate">{line}</p>
                ))}
              </div>
              <div className="mt-3 flex items-center gap-2 text-[11px] text-emerald-600 dark:text-emerald-400">
                <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                  <path fillRule="evenodd" d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z" clipRule="evenodd" />
                </svg>
                encrypted with AES-256-GCM
              </div>
            </div>

            {/* What leaves the tab */}
            <div className="border-t border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] px-4 sm:px-5 py-4 bg-gray-50/70 dark:bg-gray-950/40 vscode:bg-[#1e1e1e]/60">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
                What Markdrop stores
              </p>
              <p className="mt-2.5 font-mono text-[10px] sm:text-[11px] leading-relaxed break-all text-gray-400 dark:text-gray-600 select-none">
                mdx1.{cipher}
              </p>
            </div>

            {/* The part that actually explains it */}
            <div className="border-t border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] px-4 sm:px-5 py-4">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
                Your link
              </p>
              <p className="mt-2.5 font-mono text-[11px] sm:text-xs break-all">
                <span className="text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4]">markdrop.in/a7f3q2</span>
                <span className="text-emerald-600 dark:text-emerald-400">#k=iM-tyYaQvDVjtkfW3Z_4ql</span>
              </p>
              <div className="mt-2 grid grid-cols-2 gap-3 text-[11px]">
                <div className="flex items-start gap-1.5 text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d]">
                  <span className="mt-1 h-px w-4 shrink-0 bg-gray-400 dark:bg-gray-600" />
                  <span>sent to the server</span>
                </div>
                <div className="flex items-start gap-1.5 text-emerald-600 dark:text-emerald-400">
                  <span className="mt-1 h-px w-4 shrink-0 bg-emerald-500" />
                  <span className="font-medium">never leaves your browser</span>
                </div>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
