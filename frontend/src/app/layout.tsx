import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Markdrop — Instant Markdown Sharing",
  description: "Paste markdown, get a shareable link. No login required.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-gray-950 text-gray-100 min-h-screen">
        <header className="border-b border-gray-800">
          <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
            <a href="/" className="text-xl font-bold tracking-tight">
              mark<span className="text-blue-400">drop</span>
            </a>
            <a
              href="/"
              className="text-sm text-gray-400 hover:text-gray-200 transition-colors"
            >
              + New
            </a>
          </div>
        </header>
        <main className="max-w-4xl mx-auto px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
