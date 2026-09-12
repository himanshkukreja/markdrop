/**
 * The one control visible while a document or artifact is shown full-bleed.
 *
 * Shown to everyone, not just owners: the framed view is where Report, Edit and
 * the rest of the chrome live, so a visitor who couldn't leave immersive mode
 * would have no way to flag abusive content. Bottom-right because top-right is
 * where PDF.js, SheetJS and plenty of user-authored pages put their own
 * toolbars. Fades back until hovered so it never fights the content.
 */
export default function ImmersiveExit({ onExit }: { onExit: () => void }) {
  return (
    <button
      onClick={onExit}
      aria-label="Show document details"
      className="no-print fixed bottom-4 right-4 z-[101] inline-flex items-center gap-2 rounded-full bg-black/60 hover:bg-black/85 backdrop-blur px-3.5 py-2 text-xs font-medium text-white/85 hover:text-white shadow-lg opacity-45 hover:opacity-100 focus:opacity-100 transition-all"
    >
      <svg
        className="w-3.5 h-3.5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M9 3H5a2 2 0 0 0-2 2v4M15 3h4a2 2 0 0 1 2 2v4M9 21H5a2 2 0 0 1-2-2v-4M15 21h4a2 2 0 0 0 2-2v-4" />
      </svg>
      Show details
      <kbd className="hidden sm:inline rounded border border-white/25 px-1 text-[10px] leading-4">Esc</kbd>
    </button>
  );
}
