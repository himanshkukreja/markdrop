/**
 * The docs-site studio (/w/<ws>/docs/new and /w/<ws>/docs/<site>/…): full-window screens with their
 * own top bar (boards 2–7), so no site header and no drive rail. Each screen renders <main id="main">.
 */
export default function StudioLayout({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-dvh w-full min-w-0 flex-1 flex-col bg-bg text-text">{children}</div>;
}
