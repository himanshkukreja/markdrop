import { MarkdropLoader } from "@/components/ui";

/**
 * Route-level fallback for /[slug] (REVAMP_PLAN 7.9). The page does a blocking server fetch before
 * it can tell markdown from an artifact, so a client navigation here would otherwise sit on an
 * empty screen. The loader only appears after 300ms, so fast loads never flash it, and it renders
 * nothing on the server.
 */
export default function Loading() {
  return (
    <div className="flex min-h-[60vh] flex-1 items-center justify-center">
      <MarkdropLoader label="Opening document" delay={300} />
    </div>
  );
}
