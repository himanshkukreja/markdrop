/**
 * Branded loading state, built out of the Markdrop logo itself.
 *
 * The logo is a dark pill holding a monospace "m" with a blue dot beside it —
 * the dot being the "drop". So the loader doesn't bolt a generic spinner onto
 * the brand: it animates the logo's own story, a drop falling into the mark and
 * rippling out. Geometry here is deliberately identical to `app/icon.svg`
 * (viewBox 0 0 32 32, pill rx 8, "m" at 3/23, dot at 27/20 r 4) so the resting
 * frame is pixel-for-pixel the favicon.
 */

// `mark` is the rendered box, which is wider than the pill: the viewBox carries
// padding so the drop can fall in from above the logo and the ripple can carry
// past its edge. The pill itself renders at roughly 70% of these numbers.
const SIZES = {
  sm: { mark: 56, word: "text-sm", gap: "gap-2", bar: "w-20" },
  md: { mark: 78, word: "text-lg", gap: "gap-2.5", bar: "w-28" },
  lg: { mark: 104, word: "text-2xl", gap: "gap-3", bar: "w-36" },
} as const;

interface Props {
  /** Line under the wordmark. Pass null for a mark-only loader. */
  label?: string | null;
  size?: keyof typeof SIZES;
  /** Hide the "markdrop" wordmark — for tight spots where it'd be redundant. */
  hideWordmark?: boolean;
  className?: string;
}

export default function MarkdropLoader({
  label = "Loading",
  size = "md",
  hideWordmark = false,
  className = "",
}: Props) {
  const s = SIZES[size];
  return (
    <div
      className={`flex flex-col items-center ${s.gap} ${className}`}
      role="status"
      aria-live="polite"
      aria-label={label || "Loading"}
    >
      <svg
        width={s.mark}
        height={s.mark}
        // Padded viewBox around the logo's own 0 0 32 32: the drop needs sky to
        // fall out of, and the accent dot sits at x=27 of 32, so a ripple that
        // stays inside the pill gets shaved into a crescent on the right.
        viewBox="-7 -11 46 46"
        fill="none"
        aria-hidden
        // On the <svg> rather than on the pill: a CSS filter set on an SVG
        // *child* is clipped to that element's filter region, which turns the
        // glow into a visible grey square.
        className="drop-shadow-[0_3px_16px_rgba(59,130,246,0.28)]"
      >
        {/* Pill — the logo's dark slate ground */}
        <rect width="32" height="32" rx="8" fill="#0f172a" />
        <rect
          x="0.5"
          y="0.5"
          width="31"
          height="31"
          rx="7.5"
          fill="none"
          stroke="#1e293b"
          strokeWidth="1"
        />

        {/* The "m", exactly as the favicon draws it */}
        <text
          x="3"
          y="23"
          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
          fontSize="18"
          fontWeight="700"
          fill="#f1f5f9"
        >
          m
        </text>

        {/* Two rings from the one impact — a single hoop reads mechanical,
            a pair reads like water. */}
        <circle
          className="md-drop-ripple"
          cx="27"
          cy="20"
          r="4"
          fill="none"
          stroke="#3b82f6"
          strokeWidth="1.5"
        />
        <circle
          className="md-drop-ripple md-drop-ripple-2"
          cx="27"
          cy="20"
          r="4"
          fill="none"
          stroke="#60a5fa"
          strokeWidth="1"
        />

        {/* The accent dot — the logo's resting "drop" */}
        <circle className="md-drop-absorb" cx="27" cy="20" r="4" fill="#3b82f6" />

        {/* The falling drop: a teardrop pointed at the top with a round bulb
            centred on (27, 9) — the fall translates that bulb onto the dot at
            (27, 20), so the two become one. */}
        <path
          className="md-drop-fall"
          d="M27 3.2c0 0 3 4.1 3 5.8a3 3 0 0 1-6 0c0-1.7 3-5.8 3-5.8z"
          fill="#60a5fa"
        />
      </svg>

      {!hideWordmark && (
        <div className={`font-bold tracking-tight ${s.word} text-gray-900 dark:text-gray-100 vscode:text-[#d4d4d4]`}>
          mark<span className="text-blue-500 dark:text-blue-400">drop</span>
        </div>
      )}

      {/* Indeterminate sweep: nothing here knows a real percentage. */}
      <div className={`${s.bar} h-[2px] rounded-full overflow-hidden bg-gray-200 dark:bg-gray-800 vscode:bg-[#3c3c3c]`}>
        <div className="md-loader-sweep h-full w-1/3 rounded-full bg-blue-500 dark:bg-blue-400" />
      </div>

      {label && (
        <p className="text-xs text-gray-500 dark:text-gray-400 vscode:text-[#9d9d9d]">{label}</p>
      )}
    </div>
  );
}
