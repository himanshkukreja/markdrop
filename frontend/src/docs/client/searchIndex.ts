"use client";

/**
 * The docs' static search index (`/search-index.json`), fetched once per page load and shared by
 * the ⌘K palette (MiniSearch) and Ask AI (related sections for "Ask next").
 */
import MiniSearch from "minisearch";
import type { SearchDoc } from "../types";

let docsPromise: Promise<SearchDoc[]> | null = null;
export function loadDocs(): Promise<SearchDoc[]> {
  docsPromise ??= fetch("/search-index.json")
    .then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.json() as Promise<SearchDoc[]>;
    })
    .catch((e) => {
      docsPromise = null;
      throw e;
    });
  return docsPromise;
}

let indexPromise: Promise<MiniSearch<SearchDoc>> | null = null;
export function loadIndex(): Promise<MiniSearch<SearchDoc>> {
  indexPromise ??= loadDocs()
    .then((docs) => {
      const ms = new MiniSearch<SearchDoc>({
        fields: ["title", "keywords", "where", "text"],
        storeFields: ["kind", "title", "where", "href", "snippet"],
        searchOptions: { boost: { title: 4, keywords: 2, where: 1.2 }, prefix: true, fuzzy: 0.15 },
      });
      ms.addAll(docs);
      return ms;
    })
    .catch((e) => {
      indexPromise = null;
      throw e;
    });
  return indexPromise;
}
