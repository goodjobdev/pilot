#!/usr/bin/env bash
# Rebuild the preview gateway container against the current dashboard container.
#
# The gateway shares the dashboard container's network namespace
# (`--network container:<dashboard>`), so it must be recreated whenever the
# dashboard container is replaced by a release. Nothing here publishes a port,
# so the only reachable address is the dashboard's own loopback.
#
# Every deployment-specific value comes from the environment; this file carries
# no hostname, node id, owner login, image id or path from a real deployment.
#
# Required:
#   DASHBOARD_CONTAINER            running dashboard container name or id
#   GATEWAY_IMAGE                  digest-pinned gateway image
#   TAILNET_GATEWAY_NODE_ID        stable node id the gateway enrolls as
#   TAILNET_HOST_NODE_ID           node id of the host serving the preview
#   TAILNET_ALLOWED_REMOTE_NODE_IDS comma-separated node ids allowed to reach it
#   TAILNET_OWNER_LOGIN            the single owner login accepted
#   PREVIEW_DOMAIN                 gateway DNS name inside the tailnet
#   DASHBOARD_ORIGIN               https origin of the dashboard (set in its env)
#
# Optional:
#   PREVIEW_PORTS                  default 8443
#   PREVIEW_ALLOWED_PORTS          default 5173
#   PREVIEW_CONTROL_HOST           default preview-control-unused.example.org
#   PREVIEW_STATE_ROOT             default /var/lib/pilot-preview
#   GATEWAY_NAME                   default pi-workspace-pilot-preview
#   GATEWAY_HOSTNAME               default pilot-preview
#   GATEWAY_SERVICE_UID            default 10002
#   PILOT_SERVICE_UID              default 10001
#   REPLACE=1                      remove an existing container of that name first
#
# Usage: set the variables (or source a private env file), then run it with no
# arguments. It prints {"gateway": "<id>", "dashboard": "<id>", "ready": true}
# on success and exits non-zero, leaving the container in place for inspection,
# on any failed check.
set -euo pipefail

die() { printf 'refused: %s\n' "$*" >&2; exit 1; }
need() { [[ -n "${!1:-}" ]] || die "missing required setting: $1"; }

for v in DASHBOARD_CONTAINER GATEWAY_IMAGE TAILNET_GATEWAY_NODE_ID TAILNET_HOST_NODE_ID \
         TAILNET_ALLOWED_REMOTE_NODE_IDS TAILNET_OWNER_LOGIN PREVIEW_DOMAIN DASHBOARD_ORIGIN; do
    need "$v"
done

PREVIEW_PORTS=${PREVIEW_PORTS:-8443}
PREVIEW_ALLOWED_PORTS=${PREVIEW_ALLOWED_PORTS:-5173}
PREVIEW_CONTROL_HOST=${PREVIEW_CONTROL_HOST:-preview-control-unused.example.org}
PREVIEW_STATE_ROOT=${PREVIEW_STATE_ROOT:-/var/lib/pilot-preview}
GATEWAY_NAME=${GATEWAY_NAME:-pi-workspace-pilot-preview}
GATEWAY_HOSTNAME=${GATEWAY_HOSTNAME:-pilot-preview}
GATEWAY_SERVICE_UID=${GATEWAY_SERVICE_UID:-10002}
PILOT_SERVICE_UID=${PILOT_SERVICE_UID:-10001}
REPLACE=${REPLACE:-0}

say() { docker inspect "$1" --format "$2"; }

state="${PREVIEW_STATE_ROOT%/}/state"
keys="${PREVIEW_STATE_ROOT%/}/keys"

# --- dashboard ---------------------------------------------------------------
[[ "$(say "$DASHBOARD_CONTAINER" '{{.State.Status}}')" == running ]] \
    || die "dashboard container is not running"
[[ "$(say "$DASHBOARD_CONTAINER" '{{if .State.Health}}{{.State.Health.Status}}{{end}}')" == healthy ]] \
    || die "dashboard container is not healthy"
dashboard_id=$(say "$DASHBOARD_CONTAINER" '{{.Id}}')

origin_from_dashboard=$(say "$DASHBOARD_CONTAINER" '{{range .Config.Env}}{{println .}}{{end}}' \
    | sed -n 's/^DASHBOARD_ORIGIN=//p' | head -1)
[[ -z "$origin_from_dashboard" || "$origin_from_dashboard" == "$DASHBOARD_ORIGIN" ]] \
    || die "DASHBOARD_ORIGIN does not match the dashboard's own environment"

# --- state and keys ----------------------------------------------------------
check_dir() {
    local path=$1 uid=$2
    [[ -d "$path" && ! -L "$path" ]] || die "$path is not a directory"
    [[ "$(stat -c %u "$path")" == "$uid" ]] || die "$path is not owned by uid $uid"
    [[ "$(stat -c %a "$path")" == 700 ]] || die "$path is not 0700"
}
check_file() {
    local path=$1 uid=$2
    [[ -f "$path" && ! -L "$path" ]] || die "$path is not a regular file"
    [[ "$(stat -c %u "$path")" == "$uid" ]] || die "$path is not owned by uid $uid"
    [[ "$(stat -c %a "$path")" == 600 ]] || die "$path is not 0600"
}
check_dir "$PREVIEW_STATE_ROOT" 0
check_dir "$state" "$GATEWAY_SERVICE_UID"
check_dir "$keys" "$GATEWAY_SERVICE_UID"
check_file "$keys/assertion.key" "$GATEWAY_SERVICE_UID"
check_file "$keys/assertion.pub" "$GATEWAY_SERVICE_UID"
check_file "$state/tailscaled.state" "$GATEWAY_SERVICE_UID"

# --- existing container ------------------------------------------------------
if docker container inspect "$GATEWAY_NAME" >/dev/null 2>&1; then
    [[ "$REPLACE" == 1 ]] || die "$GATEWAY_NAME already exists (set REPLACE=1 to replace it)"
    docker rm -f "$GATEWAY_NAME" >/dev/null
fi

# --- create ------------------------------------------------------------------
env_args=()
add() { env_args+=(-e "$1=$2"); }
add GATEWAY_SERVICE_UID "$GATEWAY_SERVICE_UID"
add PILOT_SERVICE_UID "$PILOT_SERVICE_UID"
add TSNET_STATE_DIR /var/lib/tsnet
add TSNET_HOSTNAME "$GATEWAY_HOSTNAME"
add TAILNET_GATEWAY_NODE_ID "$TAILNET_GATEWAY_NODE_ID"
add TAILNET_HOST_NODE_ID "$TAILNET_HOST_NODE_ID"
add TAILNET_ALLOWED_REMOTE_NODE_IDS "$TAILNET_ALLOWED_REMOTE_NODE_IDS"
add TAILNET_OWNER_LOGIN "$TAILNET_OWNER_LOGIN"
add PREVIEW_DOMAIN "$PREVIEW_DOMAIN"
add PREVIEW_PORTS "$PREVIEW_PORTS"
add PREVIEW_ALLOWED_PORTS "$PREVIEW_ALLOWED_PORTS"
add PREVIEW_PRIVATE_IPV4 127.0.0.1
add PREVIEW_CONTROL_HOST "$PREVIEW_CONTROL_HOST"
add DASHBOARD_ORIGIN "$DASHBOARD_ORIGIN"
add PREVIEW_SITE_REVIEWED true
add PREVIEW_PORTS_REVIEWED true
add INGRESS_ASSERTION_KEY_FILE /run/preview/keys/assertion.key
add INGRESS_ASSERTION_PUBLIC_KEY_FILE /run/preview/keys/assertion.pub
add PREVIEW_CORE_SOCKET /run/preview/socket/core.sock

gateway_id=$(docker create --name "$GATEWAY_NAME" --pull=never --init \
    --network "container:$dashboard_id" --read-only --user "$GATEWAY_SERVICE_UID:$GATEWAY_SERVICE_UID" \
    --cap-drop ALL --security-opt no-new-privileges:true --ulimit core=0:0 \
    --pids-limit 128 --cpus 1 --memory 512m --restart=no --stop-timeout 30 \
    --mount "type=bind,src=$state,dst=/var/lib/tsnet" \
    --mount "type=bind,src=$keys,dst=/run/preview/keys,readonly" \
    --tmpfs "/run/preview/socket:rw,nodev,nosuid,noexec,size=4m,mode=0700,uid=$GATEWAY_SERVICE_UID,gid=$GATEWAY_SERVICE_UID" \
    --tmpfs "/tmp:rw,nodev,nosuid,noexec,size=16m,mode=0700,uid=$GATEWAY_SERVICE_UID,gid=$GATEWAY_SERVICE_UID" \
    "${env_args[@]}" "$GATEWAY_IMAGE")

docker start "$gateway_id" >/dev/null

# --- verify ------------------------------------------------------------------
for _ in $(seq 1 40); do
    status=$(say "$gateway_id" '{{.State.Status}}')
    [[ "$status" == running ]] || die "gateway exited during startup; inspect $gateway_id before recovery"
    docker logs --tail 80 "$gateway_id" 2>&1 | grep -q 'tsnet HTTPS ingress ready' && break
    sleep 1
done
docker logs --tail 80 "$gateway_id" 2>&1 | grep -q 'tsnet HTTPS ingress ready' \
    || die "gateway readiness not observed"

[[ "$(say "$gateway_id" '{{.HostConfig.NetworkMode}}')" == "container:$dashboard_id" ]] \
    || die "gateway is not sharing the dashboard network namespace"
[[ "$(say "$gateway_id" '{{.HostConfig.ReadonlyRootfs}}')" == true ]] || die "gateway root is writable"
[[ "$(say "$gateway_id" '{{json .HostConfig.PortBindings}}')" == "{}" ]] || die "gateway publishes a port"
[[ "$(say "$gateway_id" '{{json .HostConfig.CapDrop}}')" == '["ALL"]' ]] || die "gateway kept capabilities"

socket_posture=$(docker exec --user "$GATEWAY_SERVICE_UID:$GATEWAY_SERVICE_UID" "$gateway_id" \
    stat -c '%u:%g/%a/%F' /run/preview/socket/core.sock)
[[ "$socket_posture" == "$GATEWAY_SERVICE_UID:$GATEWAY_SERVICE_UID/600/socket" ]] \
    || die "private socket posture is $socket_posture"

printf '{"gateway": "%s", "dashboard": "%s", "ready": true}\n' "$gateway_id" "$dashboard_id"
