import { Spinner as DSSpinner } from "@/components/ui";

/**
 * Small inline loading spinner (compat wrapper over the DS Spinner). Inherits `currentColor`.
 * Size it with `className` (e.g. "w-5 h-5", the old API) or `size` in px.
 */
export default function Spinner({ className = "w-4 h-4", size, label }: { className?: string; size?: number | string; label?: string }) {
  return <DSSpinner className={className} size={size} label={label} />;
}
