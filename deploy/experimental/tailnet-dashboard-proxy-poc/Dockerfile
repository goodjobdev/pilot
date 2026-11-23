# Opt-in tailnet dashboard proxy. Supply immutable base image references.
ARG GO_BUILD_IMAGE
ARG RUNTIME_IMAGE

FROM --platform=linux/arm64 ${GO_BUILD_IMAGE} AS build
ARG GO_BUILD_IMAGE
RUN digest=${GO_BUILD_IMAGE##*@sha256:}; test "$digest" != "$GO_BUILD_IMAGE" && test ${#digest} -eq 64 && case "$digest" in *[!0-9a-f]*) exit 1;; esac
WORKDIR /src
COPY go.mod go.sum ./
COPY . .
RUN test "$(go env GOVERSION)" = go1.27.4 && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -buildvcs=false -ldflags='-s -w' -o /out/proxy ./cmd/proxy

FROM --platform=linux/arm64 ${RUNTIME_IMAGE}
ARG RUNTIME_IMAGE
RUN digest=${RUNTIME_IMAGE##*@sha256:}; test "$digest" != "$RUNTIME_IMAGE" && test ${#digest} -eq 64 && case "$digest" in *[!0-9a-f]*) exit 1;; esac
COPY --from=build /out/proxy /usr/local/bin/proxy
RUN test "$(stat -c '%a' /usr/local/bin/proxy)" -le 0555 && chmod 0555 /usr/local/bin/proxy
USER 10002:10002
ENTRYPOINT ["/usr/local/bin/proxy"]
