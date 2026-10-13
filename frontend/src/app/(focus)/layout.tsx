import SiteHeader from "@/components/shell/SiteHeader";

/** Focus pages (sign-in, invite, auth handoff, extension authorize): minimal header, centred card. */
export default function FocusLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteHeader variant="minimal" />
      <main id="main" className="flex-1 min-h-0 min-w-0 flex flex-col w-full mx-auto max-w-screen-xl px-4 sm:px-6 py-4">{children}</main>
    </>
  );
}
