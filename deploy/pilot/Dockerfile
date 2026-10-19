# Capped development container for the owner-only dashboard pilot.
#
# Ships the verified client build and the bundled server, and installs production
# dependencies only (no devDependencies, no lifecycle scripts). The image runs as
# an unprivileged user and expects every writable path to be an explicit mount.

FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    DASHBOARD_MODE=local \
    DASHBOARD_DATA=/data \
    DASHBOARD_BIND=127.0.0.1 \
    PORT=4319 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# ca-certificates is only recommended by curl, so it must be named explicitly for
# TLS tools inside the image to trust anything.
RUN apt-get update \
 && apt-get install --no-install-recommends --yes curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global pnpm@12.14.0 \
 && useradd --uid 10001 --user-group --create-home --shell /usr/sbin/nologin pilot \
 && mkdir -p /app /data \
 && chown -R pilot:pilot /app /data

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts \
 && pnpm store prune \
 && chown -R pilot:pilot /app

COPY --chown=pilot:pilot dist ./dist

USER 10001:10001
EXPOSE 4319

# The app checks the Host header against its configured origin, so the probe sends
# DASHBOARD_HEALTH_HOST (the origin host) explicitly.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS -H "Host: ${DASHBOARD_HEALTH_HOST}" "http://127.0.0.1:${PORT}/healthz" || exit 1

CMD ["node", "dist/server.mjs"]
