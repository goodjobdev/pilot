# Test-only prototype. Supply immutable linux/arm64 image references, e.g. name@sha256:<verified digest>.
ARG GO_BUILD_IMAGE
ARG NODE_BUILD_IMAGE
ARG NODE_RUNTIME_IMAGE

FROM --platform=linux/arm64 ${GO_BUILD_IMAGE} AS go-build
ARG GO_BUILD_IMAGE
RUN digest=${GO_BUILD_IMAGE##*@sha256:}; test "$digest" != "$GO_BUILD_IMAGE" && test ${#digest} -eq 64 && case "$digest" in *[!0-9a-f]*) exit 1;; esac
WORKDIR /src
COPY ingress/ ./
RUN test "$(go env GOVERSION)" = go1.27.4 && test -f go.sum && mkdir -p /out && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -buildvcs=false -ldflags='-s -w' -o /out/tsnet-ingress ./cmd/tsnet-ingress

FROM --platform=linux/arm64 ${NODE_BUILD_IMAGE} AS node-build
ARG NODE_BUILD_IMAGE
RUN digest=${NODE_BUILD_IMAGE##*@sha256:}; test "$digest" != "$NODE_BUILD_IMAGE" && test ${#digest} -eq 64 && case "$digest" in *[!0-9a-f]*) exit 1;; esac
WORKDIR /src
COPY gateway/package.json gateway/package-lock.json ./gateway/
WORKDIR /src/gateway
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY gateway/ ./
RUN test "$(node -p 'process.platform + "/" + process.arch')" = linux/arm64 \
 && node_include="$(node -p 'require("path").resolve(require("fs").realpathSync(process.execPath), "../../include/node")')" \
 && test -r "$node_include/node_api.h" \
 && g++ -std=c++17 -O2 -fPIC -shared -fvisibility=hidden -DNODE_GYP_MODULE_NAME=peercred_linux -I"$node_include" peercred-linux.cc -o peercred-linux.node \
 && node -e 'if (typeof require("./peercred-linux.node").peerUid !== "function") process.exit(1)'

FROM --platform=linux/arm64 ${NODE_RUNTIME_IMAGE} AS runtime
ARG NODE_RUNTIME_IMAGE
RUN digest=${NODE_RUNTIME_IMAGE##*@sha256:}; test "$digest" != "$NODE_RUNTIME_IMAGE" && test ${#digest} -eq 64 && case "$digest" in *[!0-9a-f]*) exit 1;; esac
USER 0:0
COPY --from=go-build /out/tsnet-ingress /usr/local/bin/tsnet-ingress
COPY --from=node-build --chown=10002:10002 /src/gateway /opt/preview/gateway
COPY --chown=10002:10002 supervisor.mjs /opt/preview/
RUN test "$(node -p 'process.platform + "/" + process.arch')" = linux/arm64 \
 && node -e 'if (typeof require("/opt/preview/gateway/peercred-linux.node").peerUid !== "function") process.exit(1)' \
 && chmod 0555 /usr/local/bin/tsnet-ingress \
 && chmod -R go-w /opt/preview \
 && mkdir -p /var/lib/tsnet /run/preview/keys /run/preview/socket \
 && chown 10002:10002 /var/lib/tsnet /run/preview /run/preview/keys /run/preview/socket \
 && chmod 0700 /var/lib/tsnet /run/preview /run/preview/keys /run/preview/socket
ENV HOME=/var/lib/tsnet NODE_ENV=production
USER 10002:10002
# The deployment must set Compose init: true to provide a PID 1 reaper.
ENTRYPOINT ["node", "/opt/preview/supervisor.mjs"]
