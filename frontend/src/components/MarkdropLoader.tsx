import { MarkdropLoader as DSMarkdropLoader, type MarkdropLoaderProps } from "@/components/ui";

/**
 * The brand loader (compat wrapper over the DS MarkdropLoader): the mark's own drop falling into
 * the pill. Same props as before (`label`, `size`, `hideWordmark`, `className`), plus `delay`
 * (ms before it renders; default 300 so fast loads never flash a loader; 0 renders at once).
 */
export type { MarkdropLoaderProps };

export default function MarkdropLoader(props: MarkdropLoaderProps) {
  return <DSMarkdropLoader {...props} />;
}
