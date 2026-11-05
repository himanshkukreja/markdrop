/**
 * The service worker's source, served at /sw.js by app/sw.js/route.ts with this build's id
 * written in, so every deploy is a byte-different worker and an open app finds it on its next
 * update check (components/pwa/PwaProvider shows "A new version of Markdrop is ready · Reload").
 *
 * What it does, and what it never does:
 *   - Build assets are cache-first: /_next/static/* (hashed, immutable: the app's code, CSS and
 *     its two fonts), /icons/*, /icon.svg, /apple-icon.png. One cache across builds (hashed names
 *     never change meaning), trimmed to the newest MAX_STATIC entries.
 *   - Page loads (navigations) always go to the network (with navigation preload, so the worker
 *     adds no start-up delay); only when the network fails does it answer with the branded
 *     /offline.html, precached at install. No page's HTML is ever stored.
 *   - Everything else passes through untouched: the API (another origin), /api/* route handlers,
 *     /mdp/* analytics, React Server Component payloads (?_rsc), event streams, range requests
 *     (video), uploads and every non-GET request, and anything cross-origin (R2, the file origin,
 *     fonts from Google). WebSockets and WebRTC never reach a service worker.
 *   - A new version installs in the background and waits; the page tells it to take over when
 *     the person chooses Reload (or silently when the page is already that version).
 *
 * Plain JavaScript in a string (no imports, no build step); pwa.test.mjs runs it in a sandbox.
 */

export const SW_VERSION_TOKEN = "__MARKDROP_BUILD__";

const SOURCE = String.raw`/* Markdrop service worker. Build __MARKDROP_BUILD__. Source: frontend/src/lib/pwaWorker.ts */
"use strict";
var VERSION = "__MARKDROP_BUILD__";
var SHELL = "md-shell-" + VERSION;
var STATIC = "md-static-v1";
var OFFLINE = "/offline.html";
var PRECACHE = [OFFLINE, "/icon.svg", "/icons/icon-192.png"];
var MAX_STATIC = 400;

function isStaticAsset(url) {
  var p = url.pathname;
  return p.indexOf("/_next/static/") === 0 || p.indexOf("/icons/") === 0 || p === "/icon.svg" || p === "/apple-icon.png";
}

self.addEventListener("install", function (event) {
  event.waitUntil(caches.open(SHELL).then(function (cache) {
    return cache.addAll(PRECACHE.map(function (u) { return new Request(u, { cache: "reload" }); }));
  }));
});

self.addEventListener("activate", function (event) {
  event.waitUntil((async function () {
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch (e) {}
    }
    var keys = await caches.keys();
    await Promise.all(keys.filter(function (k) {
      return k.indexOf("md-") === 0 && k !== SHELL && k !== STATIC;
    }).map(function (k) { return caches.delete(k); }));
    await self.clients.claim();
  })());
});

self.addEventListener("message", function (event) {
  var data = event.data || {};
  if (data.type === "SKIP_WAITING") self.skipWaiting();
  else if (data.type === "VERSION" && event.ports && event.ports[0]) event.ports[0].postMessage(VERSION);
});

async function trim(cache) {
  var keys = await cache.keys();
  for (var i = 0; i < keys.length - MAX_STATIC; i++) await cache.delete(keys[i]);
}

async function cacheFirst(event) {
  var cache = await caches.open(STATIC);
  var hit = await cache.match(event.request);
  if (hit) return hit;
  var res = await fetch(event.request);
  if (res.ok && res.type === "basic") {
    var copy = res.clone();
    event.waitUntil(cache.put(event.request, copy).then(function () { return trim(cache); }).catch(function () {}));
  }
  return res;
}

async function navigate(event) {
  try {
    var pre = await event.preloadResponse;
    if (pre) return pre;
    return await fetch(event.request);
  } catch (err) {
    var cache = await caches.open(SHELL);
    var page = await cache.match(OFFLINE);
    return page || Response.error();
  }
}

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === "navigate") {
    event.respondWith(navigate(event));
    return;
  }
  if (isStaticAsset(url) && !req.headers.has("range")) event.respondWith(cacheFirst(event));
});
`;

/** The worker's source for one build. The id is quoted into a JS string, so keep it to [\w.-]. */
export function serviceWorkerSource(buildId: string): string {
  const id = (buildId || "dev").replace(/[^\w.-]/g, "").slice(0, 64) || "dev";
  return SOURCE.split(SW_VERSION_TOKEN).join(id);
}
