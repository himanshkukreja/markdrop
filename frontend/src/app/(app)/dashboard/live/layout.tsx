/**
 * Analytics on phones and tablets: the marker turns on the touch sizes (styles/touch.css: 44 px
 * targets, 16 px fields, nothing under 12 px) for these screens' main column and what it opens (not the app shell's header).
 */
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <span className="md-touch-main" hidden />
      {children}
    </>
  );
}
