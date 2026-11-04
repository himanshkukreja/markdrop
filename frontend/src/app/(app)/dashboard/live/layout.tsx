/**
 * Analytics on phones and tablets: the marker turns on the touch sizes (styles/touch.css: 44 px
 * targets, 16 px fields, nothing under 12 px) for these screens and what they portal.
 */
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <span className="md-touch" hidden />
      {children}
    </>
  );
}
