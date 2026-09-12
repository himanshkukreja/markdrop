import MarkdropLoader from "@/components/MarkdropLoader";

/**
 * Route-level fallback for /[slug].
 *
 * The page does a blocking server fetch before it can tell markdown from an
 * artifact, so a client-side navigation here (dashboard, admin, a link) sat on
 * an empty main element until that resolved. Same brand loader as the artifact
 * frame, so the wait reads as one continuous loading state rather than two.
 */
export default function Loading() {
  return (
    <div className="flex-1 min-h-[60vh] flex items-center justify-center">
      <MarkdropLoader label="Fetching document…" />
    </div>
  );
}
