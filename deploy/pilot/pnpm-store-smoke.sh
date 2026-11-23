#!/bin/sh
# Exercise pnpm's packageManager auto-resolution under the container's production
# filesystem/user boundary. Pass an already-built Pilot image as the sole argument.
set -eu

image=${1:?usage: pnpm-store-smoke.sh IMAGE}
tmp=$(mktemp -d)
project="$tmp/project"
volume="pilot-pnpm-smoke-$$"
cleanup() {
  docker volume rm "$volume" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT HUP INT TERM
mkdir -m 0755 "$project"
cat > "$project/package.json" <<'EOF'
{
  "name": "pnpm-version-resolution-smoke",
  "private": true,
  "packageManager": "pnpm@12.10.1",
  "scripts": { "check": "node -e \"if (process.getuid() !== 10001) process.exit(1); console.log('pnpm check executed as uid ' + process.getuid())\"" }
}
EOF

# Seed a disposable volume as Docker would for an empty volume, then remove the image's
# precreated cache directory to represent an existing /data volume from before this fix.
docker run --rm \
  --user 10001:10001 \
  --volume "$volume:/data" \
  --entrypoint sh \
  "$image" -ec 'test -d /data/pnpm && rm -rf /data/pnpm && touch /data/.legacy-volume-marker && test ! -e /data/pnpm'

docker run --rm \
  --read-only \
  --user 10001:10001 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m,mode=1777 \
  --mount "type=bind,src=$project,dst=/smoke" \
  --volume "$volume:/data" \
  --workdir /smoke \
  "$image" sh -ec '
    test "$(id -u)" = 10001
    test ! -e /data/pnpm
    case ":$PATH:" in *:/data/pnpm:*) echo "PNPM_HOME must not be on PATH" >&2; exit 1 ;; esac
    test "$(command -v pnpm)" = /usr/local/bin/pnpm
    test ! -w /etc
    test "$(pnpm --version)" = 12.10.1
    test -d /data/pnpm/package-manager-store
    pnpm check
  '

printf 'pnpm 12.10.1 packageManager smoke passed in image %s\n' "$image"
