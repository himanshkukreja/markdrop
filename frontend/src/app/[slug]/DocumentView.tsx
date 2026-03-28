"use client";

import { useState } from "react";
import MarkdownPreview from "@/components/MarkdownPreview";
import CopyButton from "@/components/CopyButton";

interface Props {
  slug: string;
  content: string;
  url: string;
  createdAt: string;
  isNew?: boolean;
  editSecret?: string;
}

export default function DocumentView({ slug, content, url, createdAt, isNew, editSecret }: Props) {
  const [showRaw, setShowRaw] = useState(false);

  return (
    <div className="space-y-4">
      {isNew && editSecret && (
        <div className="bg-green-900/30 border border-green-700 rounded-lg p-4 space-y-2">
          <p className="text-green-300 text-sm font-medium">Document published!</p>
          <p className="text-green-400/70 text-xs">
            Save this secret to edit or delete later — it won&apos;t be shown again:
          </p>
          <div className="flex items-center gap-2">
            <code className="bg-gray-900 px-3 py-1 rounded text-xs text-green-300 select-all">
              {editSecret}
            </code>
            <CopyButton text={editSecret} label="Copy Secret" />
          </div>
        </div>
      )}

      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <h1 className="font-mono text-sm text-gray-400">/{slug}</h1>
          <span className="text-xs text-gray-600">
            {new Date(createdAt).toLocaleDateString()}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <CopyButton text={url} />
          <button
            onClick={() => setShowRaw(!showRaw)}
            className="px-3 py-1.5 text-xs border border-gray-600 rounded-md hover:bg-gray-800 transition-colors"
          >
            {showRaw ? "Rendered" : "Raw"}
          </button>
        </div>
      </div>

      <div className="border border-gray-800 rounded-lg p-6 min-h-[40vh] bg-gray-900/50">
        {showRaw ? (
          <pre className="font-mono text-sm text-gray-300 whitespace-pre-wrap break-words">
            {content}
          </pre>
        ) : (
          <MarkdownPreview content={content} />
        )}
      </div>
    </div>
  );
}
