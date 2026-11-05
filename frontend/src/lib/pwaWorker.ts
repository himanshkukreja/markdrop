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
 * Push notifications (lib/push.ts; backend services/push.py): a `push` shows the notification the
 * server composed (only what the bell would say, end-to-end encrypted to this device), one per page
 * (its tag replaces the previous one) and tells open windows so their bell refreshes. A click
 * focuses a Markdrop window (the one already on that page first) and has it open the page at the
 * block, or opens a new window; it also marks the notification read through the one-time link the
 * message carries (no session here). Only same-origin paths are ever opened.
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

/* ── Push notifications ─────────────────────────────────────────────── */
var ICON = "/icons/icon-192.png";
var BADGE = "/icons/badge-96.png";

/** A same-origin path (with query and hash) or the dashboard: a message never opens another site. */
function safePath(u) {
  try {
    var url = new URL(typeof u === "string" && u ? u : "/dashboard", self.location.origin);
    if (url.origin !== self.location.origin) return "/dashboard";
    return url.pathname + url.search + url.hash;
  } catch (e) {
    return "/dashboard";
  }
}

/** The one-time "mark read" link: /api/v1/push/read on this site's API (api.<site>), nothing else. */
function safeReadUrl(u) {
  try {
    var url = new URL(u);
    var site = self.location.hostname.replace(/^www\./, "");
    var local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    var ours = url.protocol === "https:" && (url.hostname === site || url.hostname === "api." + site);
    if ((ours || local) && url.pathname === "/api/v1/push/read" && url.searchParams.get("t")) return url.href;
  } catch (e) {}
  return null;
}

function str(v, max) {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function notificationFrom(data) {
  data = data && typeof data === "object" ? data : {};
  var tag = str(data.tag, 80);
  var options = {
    body: str(data.body, 400) || (data.title ? "" : "You have a new notification."),
    icon: ICON,
    badge: BADGE,
    timestamp: typeof data.ts === "number" ? data.ts : Date.now(),
    data: { url: safePath(data.url), read: data.read ? safeReadUrl(data.read) : null, kind: str(data.kind, 40) || null },
  };
  if (tag) {
    options.tag = tag;
    options.renotify = true;
  }
  return { title: str(data.title, 200) || "Markdrop", options: options };
}

async function showPush(data) {
  var n = notificationFrom(data);
  await self.registration.showNotification(n.title, n.options);
  var list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  list.forEach(function (c) {
    try { c.postMessage({ type: "MD_PUSH", kind: n.options.data.kind }); } catch (e) {}
  });
}

self.addEventListener("push", function (event) {
  var data = null;
  try { data = event.data ? event.data.json() : null; } catch (e) { data = null; }
  event.waitUntil(showPush(data));
});

function withoutHash(href) {
  var i = href.indexOf("#");
  return i < 0 ? href : href.slice(0, i);
}

/** Ask an open page to go there itself (no reload); true once it answers. */
function askToOpen(client, path) {
  return new Promise(function (resolve) {
    var ch = new MessageChannel();
    var done = function (ok) { clearTimeout(t); ch.port1.close(); resolve(ok); };
    var t = setTimeout(function () { done(false); }, 1000);
    ch.port1.onmessage = function () { done(true); };
    try { client.postMessage({ type: "MD_OPEN", url: path }, [ch.port2]); } catch (e) { done(false); }
  });
}

async function openFromNotification(data) {
  data = data || {};
  var path = safePath(data.url);
  var target = new URL(path, self.location.origin).href;
  if (data.read) {
    var read = safeReadUrl(data.read);
    if (read) fetch(read, { method: "POST", mode: "cors", credentials: "omit", keepalive: true }).catch(function () {});
  }
  var list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  var mine = list.filter(function (c) {
    try { return new URL(c.url).origin === self.location.origin; } catch (e) { return false; }
  });
  var pick = mine.find(function (c) { return withoutHash(c.url) === withoutHash(target); })
    || mine.find(function (c) { return c.focused; })
    || mine.find(function (c) { return c.visibilityState === "visible"; })
    || mine[0];
  if (pick) {
    try { pick = (await pick.focus()) || pick; } catch (e) {}
    if (await askToOpen(pick, path)) return pick;
    try {
      var moved = await pick.navigate(target);
      if (moved) return moved;
    } catch (e) {}
  }
  return self.clients.openWindow(target);
}

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var p = openFromNotification(event.notification.data);
  try { event.waitUntil(p); } catch (e) {}
});

self.__mdPush = { notificationFrom: notificationFrom, openFromNotification: openFromNotification, safePath: safePath };

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
