# syntax=docker/dockerfile:1.7
#
# Markdrop Guides, self-host: one image that builds a guide's content folder with the same engine as
# Markdrop Guides and docs.markdrop.in, and serves the static result (pages, Markdown twins, search,
# link previews, llms.txt, /mcp).
#
#   docker run --rm -p 8080:8080 -v "$PWD/my-guide:/site:ro" -v markdrop-guides-data:/data \
#     ghcr.io/himanshkukreja/markdrop-guides
#
#   docker build -f docs-platform/docker/Dockerfile -t markdrop-guides .        (from the repo root)
#
# /site   the content folder (site.json, pages, public/docs-assets, redirects.json), read-only
# /data   the build output and the object store (keep it on a volume: rebuilds stay incremental)
#
# The container rebuilds when /site changes (--watch) and switches to the new build atomically;
# a failed build keeps serving the last good one. Published by .github/workflows/guides-image.yml.
#
# Two stages: everything is installed, bundled and warmed in `build`; the image is a fresh base plus
# /opt/markdrop from it, so npm's cache, the Worker tooling (wrangler, workerd, esbuild) and the
# prebuilt binaries for other C libraries never reach a layer.

FROM node:22-bookworm-slim AS build
ENV NEXT_TELEMETRY_DISABLED=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    npm_config_fund=false \
    npm_config_audit=false \
    npm_config_update_notifier=false
WORKDIR /opt/markdrop

# The engine: the frontend app (its docs routes are what gets built). Dependencies first, for the
# layer cache; npm's download cache lives in a cache mount, never in a layer.
COPY frontend/package.json frontend/package-lock.json frontend/
RUN --mount=type=cache,target=/root/.npm,sharing=locked cd frontend && npm ci
COPY frontend/ frontend/

# The platform: builder, edge handler, server. esbuild is only needed to bundle the edge.
COPY docs-platform/package.json docs-platform/package-lock.json docs-platform/
RUN --mount=type=cache,target=/root/.npm,sharing=locked cd docs-platform && npm ci
COPY docs-platform/ docs-platform/
RUN cd docs-platform && node builder/cli.mjs bundle

# Warm the engine once: the stage and Next's webpack cache are baked into the image, so a
# container's first build is a warm one (~20 s for ~100 pages) instead of a cold compile.
ENV MARKDROP_DOCS_WORK=/opt/markdrop/work
RUN node docs-platform/builder/cli.mjs build docs-platform/examples/minimal \
      --out /tmp/warm/dist --work "$MARKDROP_DOCS_WORK" --quiet \
 && rm -rf /tmp/warm "$MARKDROP_DOCS_WORK/stage/.next/server" "$MARKDROP_DOCS_WORK/stage/.next/static"

# What a site build never runs: the Worker tooling (wrangler, workerd, esbuild), the browser test
# runner, and prebuilt binaries for musl (this image is glibc; Next, sharp, lightningcss and
# Tailwind's oxide pick the -gnu builds).
RUN cd docs-platform && npm prune --omit=dev \
 && cd ../frontend/node_modules \
 && rm -rf playwright playwright-core @playwright \
 && find . -mindepth 1 -maxdepth 2 -type d \( -name '*-musl' -o -name '*linuxmusl*' \) -prune -exec rm -rf {} +

FROM node:22-bookworm-slim
LABEL org.opencontainers.image.title="Markdrop Guides" \
      org.opencontainers.image.description="Build a Markdrop Guides content folder and serve it: pages, search, link previews, llms.txt and /mcp." \
      org.opencontainers.image.source="https://github.com/himanshkukreja/markdrop" \
      org.opencontainers.image.documentation="https://docs.markdrop.in/guides/self-hosting" \
      org.opencontainers.image.licenses="MIT"
ENV NEXT_TELEMETRY_DISABLED=1 \
    MARKDROP_DOCS_WORK=/opt/markdrop/work \
    PORT=8080 \
    NODE_ENV=production
WORKDIR /opt/markdrop
COPY --from=build /opt/markdrop /opt/markdrop
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/robots.txt').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["node", "/opt/markdrop/docs-platform/server/server.mjs", "start", "--content", "/site", "--data", "/data", "--watch"]
