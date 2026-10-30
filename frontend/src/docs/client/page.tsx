"use client";

/**
 * What a page's client islands need to know about it: its Markdown (Copy page), its sections
 * (Copy section), section hashes (changed dots) and the addresses built from them. Provided once
 * per article by the server page.
 */
import { createContext, useContext } from "react";
import { copyText, useToast } from "@/components/ui";

export interface DocPageInfo {
  path: string;
  title: string;
  /** Canonical address of the page. */
  url: string;
  /** Address of the page's Markdown twin. */
  mdUrl: string;
  markdown: string;
  prereq?: { markdown: string; count: number };
  /** id → plain Markdown of that h2/h3 section. */
  sections: Record<string, string>;
  hashes: Record<string, string>;
  editUrl?: string;
  feedbackUrl?: string;
}

const Ctx = createContext<DocPageInfo | null>(null);

export function DocPageProvider({ value, children }: { value: DocPageInfo; children: React.ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDocPage(): DocPageInfo | null {
  return useContext(Ctx);
}

export const OPEN_IN = [
  { id: "claude", label: "Open in Claude", hint: "Asks Claude about this page", base: "https://claude.ai/new?q=" },
  { id: "chatgpt", label: "Open in ChatGPT", hint: "Asks ChatGPT about this page", base: "https://chatgpt.com/?hints=search&q=" },
  { id: "perplexity", label: "Open in Perplexity", hint: "Searches with this page as context", base: "https://www.perplexity.ai/search?q=" },
] as const;

export function assistantPrompt(mdUrl: string): string {
  return `Read ${mdUrl} and answer my questions about it.`;
}

export function openInHref(base: string, mdUrl: string): string {
  return base + encodeURIComponent(assistantPrompt(mdUrl));
}

/** Copy actions with the toasts the boards specify. */
export function usePageCopy() {
  const page = useDocPage();
  const toasts = useToast();
  return {
    page,
    copyPage: async () => {
      if (!page) return;
      if (await copyText(page.markdown)) toasts.success("Page copied as Markdown");
      else toasts.error("Couldn't copy. Open View as Markdown and copy it from there.");
    },
    copyWithPrereqs: async () => {
      if (!page?.prereq) return;
      const n = page.prereq.count;
      if (await copyText(page.prereq.markdown)) toasts.success(`Page copied with the ${n === 1 ? "page" : `${n} pages`} it builds on`);
      else toasts.error("Couldn't copy. Open View as Markdown and copy it from there.");
    },
    /** Runs inside the click that opens the assistant, so the clipboard write keeps the gesture. */
    copyForAssistant: () => {
      if (!page) return;
      void copyText(page.markdown).then((ok) => {
        if (ok) toasts.info("Page copied too — paste it if the assistant can't open the link");
      });
    },
    copySection: async (id: string) => {
      const md = page?.sections[id];
      if (!md) return;
      if (await copyText(md)) toasts.success("Section copied as Markdown");
      else toasts.error("Couldn't copy the section.");
    },
  };
}
