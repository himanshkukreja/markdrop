# syntax=docker/dockerfile:1.7
#
# Markdrop Docs, self-host: one image that builds a docs content folder with the same engine as
# docs.markdrop.in and serves the static result (pages, Markdown twins, search, OG cards, /mcp).
#
#   docker build -f docs-platform/docker/Dockerfile -t markdrop-docs .        (from the repo root)
#   docker run --rm -p 8080:8080 -v "$PWD/my-docs:/site:ro" -v markdrop-docs-data:/data markdrop-docs
#
# /site   the content folder (site.json, pages, public/docs-assets, redirects.json), read-only
# /data   the build output and the object store (keep it on a volume: rebuilds stay incremental)
#
# The container rebuilds when /site changes (--watch) and switches to the new build atomically;
# a failed build keeps serving the last good one.

FROM node:22-bookworm-slim
ENV NEXT_TELEMETRY_DISABLED=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    npm_config_fund=false \
    npm_config_audit=false
WORKDIR /opt/markdrop

# The engine: the frontend app (its docs routes are what gets built). Dependencies first, for the
# layer cache.
COPY frontend/package.json frontend/package-lock.json frontend/
RUN cd frontend && npm ci
COPY frontend/ frontend/

# The platform: builder, edge handler, server. esbuild is only needed to bundle the edge.
COPY docs-platform/package.json docs-platform/package-lock.json docs-platform/
RUN cd docs-platform && npm ci
COPY docs-platform/ docs-platform/
RUN cd docs-platform && node builder/cli.mjs bundle

# Warm the engine once: the stage and Next's webpack cache are baked into the image, so a
# container's first build is a warm one (~20 s for ~100 pages) instead of a cold compile.
ENV MARKDROP_DOCS_WORK=/opt/markdrop/work
RUN node docs-platform/builder/cli.mjs build docs-platform/examples/minimal \
      --out /tmp/warm/dist --work "$MARKDROP_DOCS_WORK" --quiet \
 && rm -rf /tmp/warm "$MARKDROP_DOCS_WORK/stage/.next/server" "$MARKDROP_DOCS_WORK/stage/.next/static"

# Wrangler (Worker dev tooling) isn't needed at runtime.
RUN cd docs-platform && npm prune --omit=dev && rm -rf /root/.npm

ENV PORT=8080 \
    NODE_ENV=production
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/robots.txt').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["node", "/opt/markdrop/docs-platform/server/server.mjs", "start", "--content", "/site", "--data", "/data", "--watch"]
