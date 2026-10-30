"use client";

/**
 * The site settings the client islands read (brand name for copy, Ask AI, Try it, the MCP name),
 * provided once by the docs layout. Built on the server by brand.ts `clientSite`. It also points
 * the design system's links at the docs' own link (prefetch on intent, see ./Link).
 */
import { createContext, useContext } from "react";
import type { DocsClientSite } from "../brand";
import { DocsLinkProvider } from "./Link";

const NEUTRAL: DocsClientSite = { url: "", ai: null, mcpName: "docs", tryIt: { tokenEnv: "API_TOKEN", tokenPrefix: "" } };

const Ctx = createContext<DocsClientSite>(NEUTRAL);

export function DocsSiteProvider({ value, children }: { value: DocsClientSite; children: React.ReactNode }) {
  return (
    <Ctx.Provider value={value}>
      <DocsLinkProvider>{children}</DocsLinkProvider>
    </Ctx.Provider>
  );
}

export function useDocsSite(): DocsClientSite {
  return useContext(Ctx);
}

/** "about Markdrop", or "about these docs" for a site that names no product. */
export function aboutText(name: string | undefined): string {
  return name ? `about ${name}` : "about these docs";
}
