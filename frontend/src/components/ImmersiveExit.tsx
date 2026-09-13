/**
 * The one control visible while a document or artifact is shown full-bleed.
 *
 * Shown to everyone, not just owners: the framed view is where Report, Edit and
 * the rest of the chrome live, so a visitor who couldn't leave immersive mode
 * would have no way to flag abusive content. Fades back until hovered so it
 * never fights the content.
 *
 * The corner is the caller's choice because the safe corner depends on what the
 * framed content puts at its own edges, and the iframe is cross-origin so we
 * cannot measure it. Bottom-right is the default: PDF.js, SheetJS and plenty of
 * user-authored pages anchor toolbars top-right. The video player is the
 * exception -- its transport bar owns the bottom edge, fullscreen and PiP
 * included -- so video asks for top-right instead.
 */
export default function ImmersiveExit({
  onExit,
  placement = "bottom-right",
}: {
  onExit: () => void;
  placement?: "bottom-right" | "top-right";
}) {
  return (
    <button
      onClick={onExit}
      aria-label="Show document details"
      className={`no-print fixed ${
        placement === "top-right" ? "top-4 right-4" : "bottom-4 right-4"
      } z-[101] inline-flex items-center gap-2 rounded-full bg-black/60 hover:bg-black/85 backdrop-blur px-3.5 py-2 text-xs font-medium text-white/85 hover:text-white shadow-lg opacity-45 hover:opacity-100 focus:opacity-100 transition-all`}
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
