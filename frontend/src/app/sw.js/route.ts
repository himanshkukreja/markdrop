import { serviceWorkerSource } from "@/lib/pwaWorker";

/**
 * The service worker, at /sw.js so it can cover the whole origin (lib/pwaWorker.ts has the source
 * and what it may and may not touch). A static route rather than public/sw.js: the build id is
 * written into it, so each deploy is a new worker and open apps offer "Reload". no-cache: the
 * browser always revalidates it (it also skips the HTTP cache for it, updateViaCache "none").
 * Never on a workspace's own domain or the docs host (middleware); registered only from app
 * screens (components/pwa/PwaProvider).
 */
export const dynamic = "force-static";

export function GET(): Response {
  return new Response(serviceWorkerSource(process.env.NEXT_PUBLIC_BUILD_ID || "dev"), {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=0, must-revalidate",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
