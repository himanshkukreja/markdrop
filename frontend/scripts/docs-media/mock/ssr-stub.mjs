#!/usr/bin/env node
/**
 * The mocked API's server side (record.mjs clips of pages): Next's server render of /<slug> fetches the
 * document itself, outside Playwright's routes. This stub answers it "sign in to read" (401, X-Markdrop-Gate:
 * signin), so the page renders its gate and the signed-in browser reads the document through the mocked
 * routes (world.mjs). Everything else: 404. No data, no backend.
 *
 *   node scripts/docs-media/mock/ssr-stub.mjs [port=8799]
 */
import http from "node:http";
const port = Number(process.argv[2] || 8799);
http.createServer((req, res) => {
  if (req.url.startsWith("/api/v1/documents/")) {
    res.writeHead(401, { "content-type": "application/json", "x-markdrop-gate": "signin" });
    return res.end('{"detail":"Sign in to read this"}');
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end('{"detail":"Not found"}');
}).listen(port, "127.0.0.1", () => console.log(`ssr stub on 127.0.0.1:${port}`));
