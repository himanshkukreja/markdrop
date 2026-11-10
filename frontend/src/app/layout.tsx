import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { AuthProvider } from "@/contexts/AuthContext";
import { ToastProvider } from "@/components/Toast";
import { NextLinkProvider } from "@/components/theme/NextLinkProvider";
import { StatusRegion } from "@/components/ui";
import { AssistantRoot } from "@/components/assistant/AssistantRoot";
import VercelInsights from "@/components/VercelInsights";
import SiteTracker from "@/components/SiteTracker";
import ThirdPartyAnalytics from "@/components/analytics/ThirdPartyAnalytics";
import { AppTrackers } from "@/docs/client/AppTrackers";
import { themeScript } from "@/lib/themeScript";
import { pwaBootScript } from "@/lib/pwa";
import { PwaProvider } from "@/components/pwa/PwaProvider";
import { DEFAULT_OG_IMAGE, SITE_ORIGIN } from "@/lib/og";

const SITE_DESCRIPTION =
  "Publish markdown and AI docs with no account, upload HTML, PDFs, sheets, Word docs and video, or build a help center or product guide with Markdrop Guides. Links that open in any browser.";

export const metadata: Metadata = {
  // Relative og:image / canonical URLs resolve here: link-preview crawlers need an absolute https URL.
  metadataBase: new URL(SITE_ORIGIN),
  title: "Markdrop — Docs and files as links that render",
  description: SITE_DESCRIPTION,
  // app/manifest.webmanifest/route.ts (a route, so the docs layout's `manifest: null` can drop it).
  manifest: "/manifest.webmanifest",
  // Installed on an iPhone or iPad (lib/pwa.ts): full screen, the status bar in the page's
  // theme-color (light or dark, lib/themeScript), content below it. No apple title: iOS then takes
  // the manifest's name, which is "Markdrop Guides" on the studio host.
  appleWebApp: { capable: true, statusBarStyle: "default" },
  formatDetection: { telephone: false },
  openGraph: {
    title: "Drop it. It renders.",
    description: SITE_DESCRIPTION,
    siteName: "Markdrop",
    type: "website",
    // The site-wide card: every URL without one of its own (dashboard, settings, /new, /builder…)
    // still unfurls with a cover. A page that sets `openGraph` must set its own `images` (lib/og.ts).
    images: [DEFAULT_OG_IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    title: "Drop it. It renders.",
    description: SITE_DESCRIPTION,
    images: [DEFAULT_OG_IMAGE.url],
  },
};

// The no-JS default: a media-query pair. The head script replaces it with one meta for the
// resolved theme (a meta that carries `media` can't be overridden when OS and choice disagree).
export const viewport: Viewport = {
  // Pages reach the screen's edges (notch, home indicator, rounded corners); every bar that sits
  // on an edge pads itself with env(safe-area-inset-*) (globals.css --safe-*).
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#E3E7ED" },
    { media: "(prefers-color-scheme: dark)", color: "#030712" },
  ],
};

// Manrope is the UI and reading face, so it is preloaded (it is on the LCP path of every page);
// JetBrains Mono is only for code, slugs and keys, so it loads when first used.
const manrope = localFont({
  src: "./fonts/Manrope-Variable.woff2",
  variable: "--font-manrope",
  weight: "200 800",
  display: "swap",
  preload: true,
  adjustFontFallback: "Arial",
});
const jetbrains = localFont({
  src: "./fonts/JetBrainsMono-Variable.woff2",
  variable: "--font-jetbrains",
  weight: "100 800",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${manrope.variable} ${jetbrains.variable}`} suppressHydrationWarning>
      <head>
        {/* Resolves the theme before first paint. Static, so ISR-safe: it never reads cookies,
            headers or the URL fragment (which carries E2E keys). See lib/theme.ts. */}
        <script dangerouslySetInnerHTML={{ __html: themeScript() }} />
        {/* The install prompt, and the installed app skipping the landing page (lib/pwa.ts). */}
        <script dangerouslySetInnerHTML={{ __html: pwaBootScript() }} />
      </head>
      <body className="min-h-dvh flex flex-col bg-bg text-text">
        {/* NextLinkProvider: design-system links use next/link for in-app hrefs. StatusRegion: the
            one polite live region announce() writes to. Group layouts render the chrome. */}
        <NextLinkProvider>
          <AuthProvider>
            <ToastProvider>
              <StatusRegion />
              {/* Service worker, "new version" toast, install prompt (components/pwa). */}
              <PwaProvider>{children}</PwaProvider>
              {/* Ask Markdrop everywhere: ⌘J, and the panel once opened (components/assistant). */}
              <AssistantRoot />
            </ToastProvider>
          </AuthProvider>
        </NextLinkProvider>
        {/* Markdrop's trackers: everywhere but a docs site that isn't Markdrop's (docs/client/AppTrackers). */}
        <AppTrackers>
          {/* Vercel's own analytics only exist on Vercel: the Cloudflare build sets NEXT_PUBLIC_VERCEL_INSIGHTS=off. */}
          {process.env.NEXT_PUBLIC_VERCEL_INSIGHTS !== "off" && <VercelInsights />}
          <SiteTracker />
          <ThirdPartyAnalytics />
        </AppTrackers>
      </body>
    </html>
  );
}
