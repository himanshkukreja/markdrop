/** "Sending lots of files?" — how bulk sharing works, shown on the idle /share page. */

const STEPS = [
  {
    title: "Pick them all at once",
    body: (
      <>
        Select several files — hold <Kbd>⌘</Kbd> / <Kbd>Ctrl</Kbd> to pick, <Kbd>Shift</Kbd> for a range — or drop a
        whole folder. On a phone, open your photo library and tap <strong className="font-semibold">Select</strong>.
      </>
    ),
    d: "M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z",
  },
  {
    title: "Share one link",
    body: <>One link and one QR code for the whole lot — send it to one person or ten; they can all download at once. Forgot something? Add it while the link is open.</>,
    d: "M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244",
  },
  {
    title: "They choose what to keep",
    body: <>Everything in one tap, or just the files they want. Each file saves the moment it arrives, and on an iPhone photos go straight to the camera roll.</>,
    d: "M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
  },
];

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center px-1 py-px rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 font-sans text-[10px] font-medium text-gray-600 dark:text-gray-300">
      {children}
    </kbd>
  );
}

export default function BulkGuide() {
  return (
    <div className="rounded-2xl border border-gray-200 dark:border-gray-700/60 bg-gray-50 dark:bg-gray-900/40 p-5">
      <div className="flex items-center gap-2">
        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-blue-500/15 text-blue-600 dark:text-blue-300">New</span>
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Sending lots of files?</h2>
      </div>
      <ol className="mt-4 grid sm:grid-cols-3 gap-3">
        {STEPS.map((s, i) => (
          <li key={s.title} className="rounded-xl border border-gray-200 dark:border-gray-700/60 bg-white/60 dark:bg-gray-900/50 p-3.5">
            <div className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-lg bg-blue-500/10 flex items-center justify-center shrink-0">
                <svg className="w-3.5 h-3.5 text-blue-500" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" d={s.d} />
                </svg>
              </span>
              <span className="text-xs font-semibold text-gray-800 dark:text-gray-200">
                <span className="text-gray-400 dark:text-gray-500 mr-1">{i + 1}.</span>{s.title}
              </span>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">{s.body}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
