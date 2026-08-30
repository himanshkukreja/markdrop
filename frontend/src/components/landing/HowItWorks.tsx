"use client";

import Reveal from "./Reveal";

const STEPS = [
  {
    n: "01",
    title: "Write or paste",
    desc: "Drop markdown into the editor, or send a file — no account, no setup, nothing to install.",
  },
  {
    n: "02",
    title: "Publish in one click",
    desc: "Get a clean markdrop.in link instantly. Add a custom slug, password, or expiry if you like.",
  },
  {
    n: "03",
    title: "Share the link",
    desc: "Send it anywhere. Edit or delete later with your secret key, or claim it to an account.",
  },
];

export default function HowItWorks() {
  return (
    <section className="py-16 sm:py-20">
      <Reveal className="text-center max-w-2xl mx-auto">
        <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-gray-900 dark:text-white vscode:text-[#e8e8e8]">
          Live in <span className="md-gradient-text">three steps</span>
        </h2>
        <p className="mt-3 text-gray-600 dark:text-gray-400 vscode:text-[#a0a0a0]">
          From blank page to shareable link in seconds.
        </p>
      </Reveal>

      <div className="mt-12 grid sm:grid-cols-3 gap-6 [&>*]:min-w-0">
        {STEPS.map((s, i) => (
          <Reveal key={s.n} delay={i * 100}>
            <div className="relative h-full rounded-2xl border border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] bg-white/60 dark:bg-gray-900/40 vscode:bg-[#252526]/80 backdrop-blur-sm p-6 transition-all duration-300 hover:-translate-y-1 hover:border-blue-500/40">
              <span className="md-gradient-text text-4xl font-bold">{s.n}</span>
              <h3 className="mt-2 text-lg font-semibold text-gray-900 dark:text-white vscode:text-[#e8e8e8]">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-gray-600 dark:text-gray-400 vscode:text-[#a0a0a0]">{s.desc}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
