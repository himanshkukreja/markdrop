/**
 * What a page refers to (its embeds, mentions, sub-page links and page images), read with the same
 * micromark extensions as the renderer. Kept apart from pageBlocks.mjs, which has no dependencies,
 * so the document view can use those rules without loading a Markdown parser.
 */
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { math } from "micromark-extension-math";
import { mathFromMarkdown } from "mdast-util-math";
import { directive } from "micromark-extension-directive";
import { directiveFromMarkdown } from "mdast-util-directive";
import { assetId, embedSlug } from "./pageBlocks.mjs";

const PARSE = {
  extensions: [gfm(), math(), directive()],
  mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown(), directiveFromMarkdown()],
};

/**
 * What a page refers to: the slugs of its embeds and mentions (in order, once each) and its page
 * images' asset ids. Code and math are not read.
 */
export function pageRefs(markdown) {
  const md = String(markdown ?? "");
  // The same text again (the renderer and the image links both ask): the answer we have.
  if (md === last.md) return last.refs;
  const refs = md && REFS_HINT.test(md) ? readRefs(md) : { slugs: [], embeds: [], mentions: [], assets: [] };
  last = { md, refs };
  return refs;
}

// Every reference has one of these in its text; a page without any needs no parse.
const REFS_HINT = /asset:|markdrop|::page/;
let last = { md: null, refs: null };

function readRefs(md) {
  const embeds = [];
  const mentions = [];
  const assets = [];
  let tree;
  try {
    tree = fromMarkdown(md, PARSE);
  } catch {
    return { slugs: [], embeds, mentions, assets };
  }
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "leafDirective" && n.name === "page") {
      const s = embedSlug(n.attributes?.src);
      if (s) embeds.push(s);
    } else if (n.type === "leafDirective" && n.name === "markdrop") {
      const s = embedSlug(n.attributes?.src);
      if (s) embeds.push(s);
    } else if (n.type === "textDirective" && n.name === "markdrop") {
      const s = embedSlug(n.attributes?.src);
      if (s) mentions.push(s);
    } else if (n.type === "image") {
      const a = assetId(n.url);
      if (a) assets.push(a);
    }
    if (Array.isArray(n.children)) n.children.forEach(walk);
  };
  walk(tree);
  const uniq = (xs) => [...new Set(xs)];
  return { slugs: uniq([...embeds, ...mentions]), embeds: uniq(embeds), mentions: uniq(mentions), assets: uniq(assets) };
}
