/**
 * Server-rendered docs chrome: header, sidebar and footer. Everything they show comes from
 * site.json; the client islands (search, menu sheet, theme) are imported from ../client.
 */
import Link from "@/docs/client/Link";
import { Button, MarkdropMark, Wordmark } from "@/components/ui";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { aiSettings, headerBrand, type HeaderBrand } from "../brand";
import { cx } from "../cx";
import { getNav, getSite } from "../content";
import { MobileMenu, NavLinks } from "../client/Chrome";
import { AskButton } from "../client/ask/entry";
import { SearchTrigger } from "../client/Search";
import { isAppPath } from "../markdown";

/** The header's logo: the Markdrop mark and wordmark, the site's images, or its name as text. */
function BrandMark({ brand }: { brand: HeaderBrand }) {
  const label = brand.label ? <span className="dx-brand__docs">{brand.label}</span> : null;
  if (brand.kind === "markdrop")
    return (
      <>
        <MarkdropMark size={28} />
        <Wordmark className="dx-brand__word" />
        {label}
      </>
    );
  if (brand.kind === "image")
    return (
      <>
        {/* eslint-disable-next-line @next/next/no-img-element -- a logo from site.json: any size, maybe another origin */}
        <img src={brand.light} alt={brand.text ? "" : brand.alt} className={cx("dx-brand__logo", brand.dark && "dx-themed-light", brand.tile && "dx-brand__logo--tile")} />
        {brand.dark && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={brand.dark} alt={brand.text ? "" : brand.alt} className="dx-brand__logo dx-themed-dark" />
        )}
        {brand.text && <span className="dx-brand__word dx-brand__name">{brand.text}</span>}
        {label}
      </>
    );
  return (
    <>
      <span className="dx-brand__word dx-brand__name">{brand.text}</span>
      {label}
    </>
  );
}

export function DocsHeader({ activeTab, current }: { activeTab?: string; current?: string }) {
  const site = getSite();
  const nav = getNav();
  const ai = !!aiSettings(site);
  return (
    <header className="dx-header">
      <div className="dx-header__in">
        <MobileMenu tabs={site.tabs} groups={nav} activeTab={activeTab} current={current} title={site.name} />
        <Link href="/" className="dx-brand" aria-label={`${site.name} home`}>
          <BrandMark brand={headerBrand(site)} />
        </Link>
        <nav aria-label="Docs sections" className="dx-tabsnav">
          {site.tabs.map((t) => (
            <Link key={t.id} href={t.href} className="dx-tabsnav__item" aria-current={t.id === activeTab ? "page" : undefined}>
              {t.label}
            </Link>
          ))}
        </nav>
        <div className="dx-header__tools">
          <span className="dx-only-wide">
            <SearchTrigger />
          </span>
          <span className="dx-only-narrow">
            <SearchTrigger variant="icon" />
          </span>
          {ai && (
            <>
              <span className="dx-only-wide">
                <AskButton />
              </span>
              <span className="dx-only-narrow">
                <AskButton variant="icon" />
              </span>
            </>
          )}
          <ThemeToggle />
          {site.product && (
            <span className="dx-only-xwide">
              <Button href={site.product.url} variant="primary" size="sm" iconRight="external" target="_blank">
                {site.product.openLabel ?? `Open ${site.product.name}`}
              </Button>
            </span>
          )}
        </div>
      </div>
    </header>
  );
}

export function DocsSidebar({ tab, current }: { tab?: string; current?: string }) {
  const groups = getNav().filter((g) => !tab || g.tab === tab);
  return (
    <nav aria-label="Pages" className="dx-nav dx-sidenav">
      <NavLinks groups={groups} current={current} />
    </nav>
  );
}

export function DocsFooter() {
  const site = getSite();
  return (
    <footer className="dx-footer">
      <span>© {site.product?.name ?? site.name}</span>
      {(site.footer ?? []).map((l) =>
        isAppPath(l.href) ? (
          <Link key={l.href} href={l.href}>
            {l.label}
          </Link>
        ) : (
          <a key={l.href} href={l.href}>
            {l.label}
          </a>
        ),
      )}
    </footer>
  );
}

export { InlineCode } from "./InlineCode";
