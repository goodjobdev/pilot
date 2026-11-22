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
    PNPM_HOME=/data/pnpm \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# ca-certificates is only recommended by curl, so it must be named explicitly for
# TLS tools inside the image to trust anything.
RUN apt-get update \
 && apt-get install --no-install-recommends --yes curl ca-certificates git openssh-client build-essential python3 \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global pnpm@12.14.0 \
 && useradd --uid 10001 --user-group --create-home --shell /usr/sbin/nologin pilot \
 && mkdir -p /app /data/pnpm \
 && chown -R pilot:pilot /app /data \
 && chmod 0750 /data/pnpm

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# node-pty's native helper must be compiled for the image architecture. Build it from the locked
# source, then discard the toolchain so none is present in the runtime image.
RUN npm_config_build_from_source=true pnpm install --prod --frozen-lockfile \
 && pnpm store prune \
 && apt-get purge --auto-remove --yes build-essential python3 \
 && rm -rf /var/lib/apt/lists/* \
 && chown -R pilot:pilot /app /data/pnpm

COPY --chown=pilot:pilot dist ./dist
# Ship the operator documentation with the release it describes.
COPY --chown=pilot:pilot docs ./docs

USER 10001:10001
EXPOSE 4319

# The app checks the Host header against its configured origin, so the probe sends
# DASHBOARD_HEALTH_HOST (the origin host) explicitly.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS -H "Host: ${DASHBOARD_HEALTH_HOST}" "http://127.0.0.1:${PORT}/healthz" || exit 1

CMD ["node", "dist/server.mjs"]
