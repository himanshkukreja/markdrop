"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createDocument } from "@/lib/api";

export default function Home() {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  async function handlePublish() {
    if (!content.trim()) return;
    setLoading(true);
    setError("");
    try {
      const doc = await createDocument(content);
      // Store edit secret in sessionStorage so user can edit later
      sessionStorage.setItem(`secret:${doc.slug}`, doc.edit_secret);
      router.push(`/${doc.slug}?new=1&secret=${encodeURIComponent(doc.edit_secret)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-300">New Document</h1>
        <span className="text-xs text-gray-500">{content.length.toLocaleString()} chars</span>
      </div>

      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Paste your markdown here..."
        className="w-full h-[60vh] bg-gray-900 border border-gray-700 rounded-lg p-4 font-mono text-sm text-gray-200 placeholder-gray-600 resize-none focus:outline-none focus:border-blue-500 transition-colors"
        autoFocus
        maxLength={256 * 1024}
      />

      {error && (
        <p className="text-red-400 text-sm">{error}</p>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={handlePublish}
          disabled={loading || !content.trim()}
          className="px-6 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-colors"
        >
          {loading ? "Publishing..." : "Publish"}
        </button>
        <span className="text-xs text-gray-500">
          No login required. Your document gets a shareable link instantly.
        </span>
      </div>
    </div>
  );
}
