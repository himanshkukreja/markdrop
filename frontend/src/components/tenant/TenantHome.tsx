import { Icon } from "@/components/ui";
import { TenantFooter } from "./TenantFooter";
import { TenantHandoff } from "./TenantHandoff";
import { TenantHeader } from "./TenantHeader";

/**
 * The root of a workspace's own domain when there is no index to show (the folder listing is
 * unavailable). Documents here are reached by their links, so the page says so instead of
 * pretending the site is empty.
 */
export function TenantHome({ siteName }: { siteName: string }) {
  return (
    <>
      <TenantHandoff />
      <TenantHeader returnPath="/" />
      <main
        id="main"
        tabIndex={-1}
        className="flex w-full min-w-0 flex-1 flex-col items-center justify-center px-4 py-16 outline-none sm:py-24"
      >
        <div className="flex w-full max-w-[30rem] flex-col items-center gap-4 text-center">
          <span className="grid size-16 place-items-center rounded-xl bg-accent-soft text-accent-text" aria-hidden>
            <Icon name="doc" size={28} />
          </span>
          <h1 dir="auto" className="text-h1 text-text [overflow-wrap:anywhere]">{siteName}</h1>
          <p className="text-body-lg text-text-secondary">
            Documents here open from the links you&rsquo;re sent. Open one to start reading.
          </p>
        </div>
      </main>
      <TenantFooter />
    </>
  );
}

export default TenantHome;
