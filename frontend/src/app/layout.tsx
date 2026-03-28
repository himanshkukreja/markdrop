import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";
import "highlight.js/styles/github-dark.css";
import ThemeToggle from "@/components/ThemeToggle";

export const metadata: Metadata = {
  title: "Markdrop — Instant Markdown Sharing",
  description: "Paste markdown, get a shareable link. No login required.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full dark" suppressHydrationWarning>
      <body className="h-full flex flex-col bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100">
        {/* Server defaults to dark. Script removes dark class only if user chose light.
            This prevents flash for dark-mode users (the default). */}
        <Script id="theme-init" strategy="beforeInteractive">{`(function(){if(localStorage.getItem('theme')==='light')document.documentElement.classList.remove('dark');})();`}</Script>
        <header className="no-print shrink-0 border-b border-gray-200 dark:border-gray-800">
          <div className="max-w-screen-xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
            <a href="/" className="text-xl font-bold tracking-tight">
              mark<span className="text-blue-500 dark:text-blue-400">drop</span>
            </a>
            <div className="flex items-center gap-3">
              <ThemeToggle />
              <a href="/" className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors">
                + New
              </a>
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
