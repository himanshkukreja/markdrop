import { AmbientBackground as DSAmbientBackground } from "@/components/ui";

/**
 * The static landing glow (compat wrapper over the DS AmbientBackground): a dot grid plus one
 * accent-soft radial, no drifting blobs. Fixed behind the page by default, as before; pass
 * `fixed={false}` to place it absolutely inside a `relative isolate` parent.
 */
export default function AmbientBackground({ fixed = true, className }: { fixed?: boolean; className?: string }) {
  return <DSAmbientBackground fixed={fixed} className={className} />;
}
