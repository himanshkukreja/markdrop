export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center py-20 space-y-4">
      <h1 className="text-4xl font-bold text-gray-400 dark:text-gray-500">404</h1>
      <p className="text-gray-500 dark:text-gray-400">This document doesn&apos;t exist or has been deleted.</p>
      <a
        href="/"
        className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition-colors"
      >
        Create a new document
      </a>
    </div>
  );
}
