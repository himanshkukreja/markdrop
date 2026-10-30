/** Content types for a site's own files (pages and outputs keep the type the engine answered with). */
const TYPES = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  mjs: "application/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  vtt: "text/vtt; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  pdf: "application/pdf",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  zip: "application/zip",
  yaml: "text/yaml; charset=utf-8",
  yml: "text/yaml; charset=utf-8",
};

export function mimeOf(file) {
  const ext = file.split(".").pop().toLowerCase();
  return TYPES[ext] || "application/octet-stream";
}

/** Text types the self-host server compresses (Cloudflare compresses Worker responses itself). */
export function compressible(type) {
  return /^(text\/|application\/(javascript|json|xml)|image\/svg\+xml)/.test(type || "");
}
