import type { Metadata } from "next";
import "./globals.css";
import "highlight.js/styles/github-dark.css";
import ThemeToggle from "@/components/ThemeToggle";

export const metadata: Metadata = {
  title: "Markdrop — Instant Markdown Sharing",
  description: "Paste markdown, get a shareable link. No login required.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full" style={{ background: "#1e1e1e" }} suppressHydrationWarning>
      <head>
        {/* Inline script: runs synchronously during HTML parsing, before any paint.
            Reads localStorage and applies the correct theme class + background. */}
        <script dangerouslySetInnerHTML={{ __html: `(function(){var t=localStorage.getItem('theme')||'vscode';var cl=t==='dark'?'dark':'vscode';var bg=t==='dark'?'#030712':'#1e1e1e';var el=document.documentElement;el.classList.add(cl);el.style.background=bg;new MutationObserver(function(){if(!el.classList.contains('vscode')&&!el.classList.contains('dark')){el.classList.add(cl);el.style.background=bg;}}).observe(el,{attributes:true,attributeFilter:['class']});})();` }} />
      </head>
      <body className="h-full flex flex-col dark:bg-gray-950 vscode:bg-[#1e1e1e] dark:text-gray-100 vscode:text-[#d4d4d4]">
        <header className="no-print shrink-0 border-b border-gray-200 dark:border-gray-800 vscode:border-[#3c3c3c] vscode:bg-[#252526]">
          <div className="max-w-screen-xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <a href="/" className="text-xl font-bold tracking-tight">
                mark<span className="text-blue-500 dark:text-blue-400">drop</span>
              </a>
              <a
                href="https://github.com/himanshkukreja/markdrop"
                target="_blank"
                rel="noopener noreferrer"
                title="View on GitHub"
                className="text-gray-400 dark:text-gray-500 vscode:text-[#9d9d9d] hover:text-gray-700 dark:hover:text-gray-200 vscode:hover:text-[#d4d4d4] transition-colors"
              >
                <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                  <path d="M12 2C6.477 2 2 6.484 2 12.021c0 4.428 2.865 8.184 6.839 9.504.5.092.682-.217.682-.482 0-.237-.009-.868-.013-1.703-2.782.605-3.369-1.342-3.369-1.342-.454-1.154-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844a9.59 9.59 0 012.504.337c1.909-1.296 2.747-1.026 2.747-1.026.546 1.378.202 2.397.1 2.65.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.942.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0022 12.021C22 6.484 17.522 2 12 2z" />
                </svg>
              </a>
            </div>
            <div className="flex items-center gap-4">
              <a href="/" className="text-sm text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d] hover:text-gray-800 dark:hover:text-gray-200 vscode:hover:text-[#d4d4d4] transition-colors">
                + New
              </a>
              <ThemeToggle />
            </div>
          </div>
        </header>
        <main className="flex-1 min-h-0 flex flex-col max-w-screen-xl w-full mx-auto px-4 sm:px-6 py-4">
          {children}
        </main>
      </body>
    </html>
  );
}
