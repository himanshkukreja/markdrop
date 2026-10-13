import { SiteHeader } from "@/components/shell/SiteHeader";
import { MissedDropMark, AttemptedPath } from "@/components/shell/NotFound";
import { Button } from "@/components/ui";

/**
 * 404 (REVAMP_PLAN 7.9; D41: one page for expired and missing, since the TTL deletes expired rows).
 * Rendered inside the root layout only, so it brings its own header. The attempted path is read
 * after mount, so this HTML stays identical for every missing address.
 */
export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main id="main" tabIndex={-1} className="flex w-full min-w-0 flex-1 flex-col items-center justify-center px-4 py-16 outline-none sm:py-24">
        <div className="flex w-full max-w-[30rem] flex-col items-center gap-5 text-center">
          <MissedDropMark size={88} />
          <h1 className="text-h1 text-text">Nothing at this link</h1>
          <p className="text-body-lg text-text-secondary">It may have expired or been deleted, or the address has a typo.</p>
          <AttemptedPath />
          <div className="mt-2 flex w-full flex-col items-stretch justify-center gap-2 sm:w-auto sm:flex-row sm:items-center">
            <Button variant="primary" size="lg" href="/new">Publish a document</Button>
            <Button variant="secondary" size="lg" href="/">Go to the home page</Button>
          </div>
        </div>
      </main>
    </>
  );
}
