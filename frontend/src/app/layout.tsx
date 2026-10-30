import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { AuthProvider } from "@/contexts/AuthContext";
import { ToastProvider } from "@/components/Toast";
import { NextLinkProvider } from "@/components/theme/NextLinkProvider";
import { StatusRegion } from "@/components/ui";
import VercelInsights from "@/components/VercelInsights";
import SiteTracker from "@/components/SiteTracker";
import ThirdPartyAnalytics from "@/components/analytics/ThirdPartyAnalytics";
import { AppTrackers } from "@/docs/client/AppTrackers";
import { themeScript } from "@/lib/themeScript";

const SITE_DESCRIPTION =
  "Publish markdown and AI docs with no account, upload HTML, PDFs, sheets, Word docs and video, or build a docs site with Docs Studio. Links that open in any browser.";

export const metadata: Metadata = {
  title: "Markdrop — Docs and files as links that render",
  description: SITE_DESCRIPTION,
  // app/manifest.webmanifest/route.ts (a route, so the docs layout's `manifest: null` can drop it).
  manifest: "/manifest.webmanifest",
  openGraph: {
    title: "Drop it. It renders.",
    description: SITE_DESCRIPTION,
    siteName: "Markdrop",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Drop it. It renders.",
    description: SITE_DESCRIPTION,
  },
};

// The no-JS default: a media-query pair. The head script replaces it with one meta for the
// resolved theme (a meta that carries `media` can't be overridden when OS and choice disagree).
export const viewport: Viewport = {
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
      </head>
      <body className="min-h-dvh flex flex-col bg-bg text-text">
        {/* NextLinkProvider: design-system links use next/link for in-app hrefs. StatusRegion: the
            one polite live region announce() writes to. Group layouts render the chrome. */}
        <NextLinkProvider>
          <AuthProvider>
            <ToastProvider>
              <StatusRegion />
              {children}
            </ToastProvider>
          </AuthProvider>
        </NextLinkProvider>
        {/* Markdrop's trackers: everywhere but a docs site that isn't Markdrop's (docs/client/AppTrackers). */}
        <AppTrackers>
          <VercelInsights />
          <SiteTracker />
          <ThirdPartyAnalytics />
        </AppTrackers>
      </body>
    </html>
  );
}
