"use client";

// Minimal error boundary: an API outage or a failed render shows this instead
// of a 404, so a document that still exists never looks deleted.
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 sm:py-20 space-y-4">
      <h1 className="text-2xl sm:text-3xl font-bold text-gray-400 dark:text-gray-500">
        Something went wrong
      </h1>
      <p className="text-gray-500 dark:text-gray-400">
        This page couldn&apos;t be loaded right now. Nothing has been deleted.
      </p>
      <button
        type="button"
        onClick={() => reset()}
        className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition-colors"
      >
        Try again
      </button>
    </div>
  );
}
