"use client";

import { useState } from "react";

export default function CopyButton({ text, label = "Copy Link", className }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      onClick={handleCopy}
      className={`px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 vscode:border-[#3c3c3c] rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 vscode:hover:bg-[#2d2d2d] transition-colors text-gray-700 dark:text-gray-300 vscode:text-[#d4d4d4]${className ? ` ${className}` : ""}`}
    >
      {copied ? "Copied!" : label}
    </button>
  );
}
