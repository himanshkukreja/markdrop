import Link from "@/docs/client/Link";
import { Button } from "@/components/ui";
import { getSite } from "@/docs/content";
import { DocsFooter, DocsHeader } from "@/docs/ui/Chrome";

export default function DocsNotFound() {
  const site = getSite();
  return (
    <>
      <DocsHeader />
      <main id="main" className="dx-notfound">
        <p className="dx-eyebrow">404</p>
        <h1 className="dx-title">There&apos;s no page here</h1>
        <p className="dx-lede">The page may have moved. Search the docs, or start from the home page.</p>
        <div className="dx-notfound__actions">
          <Button href="/" iconLeft="home">
            Go to {site.name}
          </Button>
          <Link href="/changelog" className="md-btn md-btn--secondary md-btn--md">
            See what changed
          </Link>
        </div>
      </main>
      <DocsFooter />
    </>
  );
}
