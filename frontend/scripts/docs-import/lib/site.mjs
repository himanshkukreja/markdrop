/**
 * Reading a published GitBook site's structure from its public outputs: llms.txt (page list and
 * descriptions), the sidebar in the page HTML (groups, order, labels), the header (name, logo),
 * theme variables (accent), and the download links behind {% file %} blocks.
 *
 * GitBook's HTML is not a stable API; everything here degrades to "not found" rather than failing,
 * and the importer reports what it couldn't read.
 */
import { decodeEntities, parseHtml, rgbToHex, textOf } from "./html.mjs";

/**
 * True when an image can't be transparent: a PNG without an alpha channel or tRNS chunk, a JPEG,
 * a lossy WebP without alpha. Such a logo shows its own background (often a white square), so on
 * the dark theme it belongs on a light tile (site.json brand.logo.tile). Unknown formats: false.
 */
export function isOpaqueImage(buf) {
  if (!buf || buf.length < 32) return false;
  if (buf.readUInt32BE(0) === 0x89504e47) {
    const colorType = buf[25];
    if (colorType === 4 || colorType === 6) return false;
    // tRNS comes before IDAT; look through the chunks.
    let at = 8;
    while (at + 8 <= buf.length) {
      const len = buf.readUInt32BE(at);
      const type = buf.toString("latin1", at + 4, at + 8);
      if (type === "tRNS") return false;
      if (type === "IDAT" || type === "IEND") break;
      at += 12 + len;
    }
    return true;
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) return true;
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
    const chunk = buf.toString("latin1", 12, 16);
    if (chunk === "VP8 ") return true;
    if (chunk === "VP8X") return (buf[20] & 0x10) === 0;
    return false; // VP8L: may carry alpha
  }
  return false;
}

export function createSite(origin, base = "") {
  const host = new URL(origin).hostname;
  const abs = (p) => new URL(p, origin + base + "/").href;

  /** GitBook path ("/a/b") from any URL or href on the site; null when it's elsewhere. */
  function gbPathOf(href, from = "/") {
    let u;
    try {
      u = new URL(decodeEntities(href), origin + base + (from === "/" ? "/" : from));
    } catch {
      return null;
    }
    if (u.origin !== origin) return null;
    let p;
    try {
      p = decodeURIComponent(u.pathname);
    } catch {
      p = u.pathname;
    }
    if (base && p.startsWith(base)) p = p.slice(base.length);
    p = p.replace(/\.md$/, "").replace(/\/+$/, "");
    if (/(^|\/)readme$/i.test(p)) p = p.replace(/\/?readme$/i, "");
    return p || "/";
  }

  /** llms.txt → [{ title, pages: [{ title, url, description, gb }] }] (one per "## " section). */
  function parseLlms(text) {
    const sections = [];
    let cur = null;
    for (const line of text.split("\n")) {
      if (/^#\s+Agent Instructions/.test(line)) break;
      const h = /^##\s+(.+)$/.exec(line);
      if (h) {
        cur = { title: h[1].trim(), pages: [] };
        sections.push(cur);
        continue;
      }
      const m = /^\s*-\s+\[([^\]]+)\]\(([^)\s]+)\)(?::\s*(.*))?$/.exec(line);
      if (m) {
        if (!cur) sections.push((cur = { title: "", pages: [] }));
        cur.pages.push({ title: m[1].trim(), url: m[2], description: (m[3] ?? "").trim(), gb: gbPathOf(m[2]) });
      }
    }
    return sections.filter((s) => s.pages.length);
  }

  /**
   * The left sidebar: { groups: [{ group: string|null, items: [{ gb, title, depth }] }], external }.
   * A group is a top-level button with a label; top-level links outside any group get group null.
   */
  function parseSidebar(html) {
    const start = html.indexOf('data-testid="toc-scroll-container"');
    if (start < 0) return null;
    const end = html.indexOf("</aside>", start);
    const seg = html.slice(start, end < 0 ? undefined : end);
    const groups = [];
    const external = [];
    let depth = 0;
    let group = null;
    let groupDepth = 0;
    const re = /<(\/?)ul\b[^>]*>|<button\b[^>]*>([\s\S]*?)<\/button>|<a\b([^>]*)>([\s\S]*?)<\/a>/g;
    const text = (h) => textOf(parseHtml(h.replace(/<svg[\s\S]*?<\/svg>/g, ""))).replace(/\s+/g, " ").trim();
    let m;
    while ((m = re.exec(seg))) {
      if (m[0].startsWith("<ul") || m[0].startsWith("</ul")) {
        depth += m[1] ? -1 : 1;
        continue;
      }
      if (m[2] !== undefined) {
        const t = text(m[2]);
        if (t && depth <= 1) {
          group = { group: t, items: [] };
          groupDepth = depth;
          groups.push(group);
        }
        continue;
      }
      const href = /href="([^"]*)"/.exec(m[3])?.[1];
      if (!href || /gitbook\.com\/powered-by/.test(href)) continue;
      const title = text(m[4]);
      const gb = gbPathOf(href);
      if (!gb) {
        external.push({ href: decodeEntities(href), title });
        continue;
      }
      let target = group && depth > groupDepth ? group : null;
      if (!target) {
        group = null;
        const last = groups[groups.length - 1];
        if (last && last.group === null) target = last;
        else groups.push((target = { group: null, items: [] }));
      }
      target.items.push({ gb, title, depth: Math.max(0, depth - (target.group ? groupDepth + 1 : 1)) });
    }
    return { groups, external };
  }

  /** GitBook proxies images through /~gitbook/image?url=<original>&…: the original's URL. */
  function originalImageUrl(src) {
    try {
      const u = new URL(decodeEntities(src), origin);
      if (u.pathname.includes("/~gitbook/image") && u.searchParams.get("url")) return u.searchParams.get("url");
      return u.href;
    } catch {
      return null;
    }
  }

  /**
   * GitBook's own copy of an image: /~gitbook/image?url=<original>&sign=… on the site's origin, with
   * the size parameters dropped (the full-size image; the signature covers the url only). This is
   * how the site shows a logo or picture whose original lives on a host the importer doesn't read
   * (a logo from Google's favicon service, an image on a customer CDN). null for anything else.
   */
  function proxyImageUrl(src) {
    try {
      const u = new URL(decodeEntities(src), origin);
      if (u.origin !== origin || !u.pathname.includes("/~gitbook/image") || !u.searchParams.get("url") || !u.searchParams.get("sign")) return null;
      for (const k of ["width", "height", "dpr", "quality", "format"]) u.searchParams.delete(k);
      return u.href;
    } catch {
      return null;
    }
  }

  /** Every image GitBook proxies on a page: Map(original URL → full-size proxy URL on the site). */
  function proxiedImages(html) {
    const out = new Map();
    for (const m of String(html ?? "").matchAll(/https?:\/\/[^"'\s,]*\/~gitbook\/image\?[^"'\s,]+/g)) {
      const proxy = proxyImageUrl(m[0]);
      const original = proxy && originalImageUrl(proxy);
      if (original && !out.has(original)) out.set(original, proxy);
    }
    return out;
  }

  /**
   * GitBook's look from a page's HTML: the <html> classes (`straight-corners`, `circular-corners`,
   * `font-Inter`…) → { corners: "sharp"|"soft"|"round", font: GitBook's font name or null }.
   */
  function detectLook(html) {
    const cls = /<html[^>]*class="([^"]*)"/.exec(String(html ?? ""))?.[1] ?? "";
    const has = (c) => cls.split(/\s+/).includes(c);
    const corners = has("straight-corners") ? "sharp" : has("circular-corners") ? "round" : "soft";
    const font = /(?:^|\s)font-([A-Za-z][A-Za-z0-9]+)(?:\s|$)/.exec(cls)?.[1] ?? null;
    return { corners, font };
  }

  /** Site name, logo, favicon and theme colours from a page's HTML. */
  function detectBrand(html) {
    const at = html.indexOf("data-gb-site-header");
    const header = at < 0 ? "" : html.slice(at, at + 30000);
    const homeLink = /<a\b[^>]*href="\/"[^>]*>([\s\S]*?)<\/a>/.exec(header)?.[1] ?? "";
    // GitBook writes the logo twice: `dark:hidden` for the light theme, `dark:block` for the dark one.
    const imgs = [...homeLink.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
    const srcOf = (tag) => /\ssrc="([^"]+)"/.exec(tag ?? "")?.[1];
    const classOf = (tag) => /\sclass="([^"]*)"/.exec(tag ?? "")?.[1] ?? "";
    const lightTag = imgs.find((t) => /(^|\s)dark:hidden(\s|$)/.test(classOf(t))) ?? imgs.find((t) => !/(^|\s)dark:block(\s|$)/.test(classOf(t))) ?? imgs[0];
    const darkTag = imgs.find((t) => t !== lightTag && /(^|\s)dark:block(\s|$)/.test(classOf(t)));
    const img = srcOf(lightTag);
    const darkImg = srcOf(darkTag);
    const imgAlt = /\salt="([^"]*)"/.exec(lightTag ?? "")?.[1];
    const name = textOf(parseHtml(homeLink.replace(/<svg[\s\S]*?<\/svg>/g, ""))).replace(/\s+/g, " ").trim();
    const title = decodeEntities(/<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "");
    const icon = /<link\b[^>]*rel="icon"[^>]*href="([^"]+)"/.exec(html)?.[1] ?? /<link\b[^>]*href="([^"]+)"[^>]*rel="icon"/.exec(html)?.[1];
    const primary = /--primary-original:\s*([\d\s.,]+);/.exec(html)?.[1];
    const tint = /--tint-original:\s*([\d\s.,]+);/.exec(html)?.[1];
    return {
      siteName: name || title.split(" | ").pop() || host,
      logo: img ? originalImageUrl(img) : null,
      // GitBook's own copies (its image proxy on the site), for originals on hosts the importer doesn't read.
      logoProxy: img ? proxyImageUrl(img) : null,
      // The dark theme's logo, only when it is a different image.
      logoDark: darkImg && img && originalImageUrl(darkImg) !== originalImageUrl(img) ? originalImageUrl(darkImg) : null,
      logoDarkProxy: darkImg ? proxyImageUrl(darkImg) : null,
      logoAlt: decodeEntities(imgAlt ?? ""),
      wordmark: !!img && !name,
      favicon: icon ? originalImageUrl(icon) : null,
      faviconProxy: icon ? proxyImageUrl(icon) : null,
      accent: primary ? rgbToHex(primary) : null,
      tint: tint ? rgbToHex(tint) : null,
      themeClass: /<html[^>]*class="([^"]*)"/.exec(html)?.[1] ?? "",
    };
  }

  /**
   * Page icons from the sidebar data GitBook embeds in its pages (the React payload lists every
   * page as { id, title, href, icon, … }): Map(GitBook path → Font Awesome name). The rendered
   * sidebar only has inline SVG paths, so this is the one place the names are readable.
   */
  function pageIcons(html) {
    const out = new Map();
    const text = String(html ?? "").replace(/\\"/g, '"');
    for (const m of text.matchAll(/"href":"([^"]*)","icon":"([a-z0-9-]+)"/g)) {
      const gb = gbPathOf(m[1]);
      if (gb && !out.has(gb)) out.set(gb, m[2]);
    }
    return out;
  }

  /** {% file %} blocks in a page's HTML, in order: [{ url, name, size }]. */
  function fileLinks(html) {
    const out = [];
    const seen = new Set();
    const re = /<a\b[^>]*href="(https:\/\/[^"]*(?:files\.gitbook\.io|\/~\/files\/)[^"]*)"[^>]*>([^<]+)<\/a>\s*<\/div>\s*<div[^>]*>([^<]{1,20})<\/div>/g;
    let m;
    while ((m = re.exec(html))) {
      const url = decodeEntities(m[1]);
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ url, name: decodeEntities(m[2]).trim(), size: decodeEntities(m[3]).trim() });
    }
    return out;
  }

  /**
   * The cards GitBook drew on a page, in order: [{ href, text }]. A card is clickable when GitBook
   * wraps it in a link (its card target); href is null for one that isn't. `text` is the card's
   * visible text, to check a card against the Markdown's row before borrowing its target.
   */
  function htmlCards(html) {
    const s = String(html ?? "");
    const main = s.indexOf("<main");
    const m = main < 0 ? s : s.slice(main);
    const out = [];
    const re = /data-card=""/g;
    let hit;
    while ((hit = re.exec(m))) {
      const before = m.slice(Math.max(0, hit.index - 4000), hit.index);
      const tags = [...before.matchAll(/<(a|div)\b((?:[^>"]|"[^"]*")*)>/g)];
      const own = tags[tags.length - 1];
      const href = own && own[1] === "a" ? /\shref="([^"]*)"/.exec(own[2])?.[1] ?? null : null;
      const next = m.indexOf('data-card=""', hit.index + 12);
      const body = m.slice(hit.index, next < 0 ? hit.index + 6000 : Math.min(next, hit.index + 6000));
      const text = decodeEntities(
        body
          .replace(/^[^>]*>/, "")
          .replace(/<[^>]*$/, "")
          .replace(/<(svg|script|style)\b[\s\S]*?<\/\1>/g, " ")
          .replace(/<[^>]*>/g, " "),
      )
        .replace(/\s+/g, " ")
        .trim();
      out.push({ href: href ? decodeEntities(href) : null, text });
    }
    return out;
  }

  return { abs, gbPathOf, parseLlms, parseSidebar, detectBrand, detectLook, fileLinks, originalImageUrl, proxyImageUrl, proxiedImages, pageIcons, htmlCards };
}
