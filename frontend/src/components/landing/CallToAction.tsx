"use client";

import Reveal from "./Reveal";

export default function CallToAction() {
  return (
    <section className="py-16 sm:py-20">
      <Reveal>
        <div className="relative overflow-hidden rounded-3xl border border-blue-500/30 bg-gradient-to-br from-blue-600/20 via-sky-500/10 to-transparent px-6 py-14 sm:px-12 text-center">
          <div
            aria-hidden
            className="md-glow pointer-events-none absolute -top-20 left-1/2 -translate-x-1/2 w-[36rem] max-w-full h-[24rem] rounded-full blur-3xl opacity-60"
            style={{ background: "radial-gradient(circle at center, rgba(59,130,246,0.42), rgba(14,165,233,0.15) 45%, transparent 70%)" }}
          />
          <div className="relative">
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-gray-900 dark:text-white vscode:text-[#e8e8e8]">
              Ready when you are.
            </h2>
            <p className="mt-3 text-gray-600 dark:text-gray-300 vscode:text-[#a0a0a0] max-w-lg mx-auto">
              No sign-up, no credit card, no catch. Publish your first document right now.
            </p>
            <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
              <a href="/new" className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-lg bg-gradient-to-r from-blue-600 to-sky-600 hover:from-blue-500 hover:to-sky-500 text-white text-sm font-semibold transition-all shadow-lg shadow-blue-600/30">
                Create a document
              </a>
              <a href="/share" className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-lg border border-gray-300 dark:border-gray-700 vscode:border-[#3c3c3c] hover:bg-gray-100 dark:hover:bg-gray-800 vscode:hover:bg-[#2d2d2d] text-gray-800 dark:text-gray-200 vscode:text-[#d4d4d4] text-sm font-semibold transition-colors">
                Share a file
              </a>
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  );
}
