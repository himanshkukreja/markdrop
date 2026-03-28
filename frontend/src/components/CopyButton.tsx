"use client";

import { useState } from "react";

export default function CopyButton({ text, label = "Copy Link" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      onClick={handleCopy}
      className="px-3 py-1.5 text-xs border border-gray-600 rounded-md hover:bg-gray-800 transition-colors"
    >
      {copied ? "Copied!" : label}
    </button>
  );
}
