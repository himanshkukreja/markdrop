import { Icon } from "@/components/ui";
import type { BrandId } from "@/lib/integrations";

/**
 * An integration's own logo, from public/brands (official marks, unmodified; see public/brands/NOTICE.md),
 * on a neutral tile. Marks that lose contrast on the dark theme switch to their owner's white version there.
 * Used only to identify the integration on the Integrations pages. Markdrop's own tools get a Lucide icon.
 */
const WHITE_IN_DARK: Partial<Record<BrandId, true>> = { jira: true, zoom: true, github: true, chatgpt: true, cursor: true };
/** Wide marks (wordmarks) get more of the tile's width. */
const WIDE: Partial<Record<BrandId, true>> = { zoom: true };

export function BrandMark({ brand, icon, size = 40 }: { brand?: BrandId; icon?: string; size?: number }) {
  const inner = Math.round(size * (brand && WIDE[brand] ? 0.78 : 0.56));
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-lg border border-border bg-bg text-text-secondary"
      style={{ width: size, height: size }}
      data-brand={brand ?? icon}
    >
      {brand ? (
        WHITE_IN_DARK[brand] ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element -- tiny static SVGs, no optimisation needed */}
            <img src={`/brands/${brand}.svg`} alt="" width={inner} height={inner} className="block object-contain dark:hidden" style={{ width: inner, height: inner }} />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/brands/${brand}-white.svg`} alt="" width={inner} height={inner} className="hidden object-contain dark:block" style={{ width: inner, height: inner }} />
          </>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/brands/${brand}.svg`} alt="" width={inner} height={inner} className="block object-contain" style={{ width: inner, height: inner }} />
        )
      ) : (
        <Icon name={icon ?? "layers"} size={Math.round(size * 0.5)} />
      )}
    </span>
  );
}
