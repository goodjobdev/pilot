#!/bin/sh
set -eu
if [ "$#" -ne 2 ]; then
  echo "usage: $0 FROZEN_NODE_MODULES_TAR CACHED_LINUX_NODE_IMAGE" >&2
  exit 2
fi
deps=$1
image=$2
profile="$PWD/scripts/seccomp-deny-statfs.json"
test -f "$profile"
test -f "$deps"
case "$image" in *:*) ;; *) echo 'image must be an explicit cached tag or digest' >&2; exit 2;; esac
docker run --rm --pull=never --network=none --read-only \
  --user 10001:10001 --cap-drop=ALL --security-opt=no-new-privileges \
  --security-opt "seccomp=$profile" --pids-limit=128 \
  --tmpfs /tmp:rw,exec,nosuid,nodev,size=2g,mode=1777 \
  -v "$PWD:/source:ro" -v "$deps:/deps/linux-node-modules.tar:ro" \
  "$image" sh -lc '
    set -eu
    mkdir -p /tmp/task /tmp/deps
    tar -cf - -C /source --exclude=.git --exclude=node_modules . | tar -xf - -C /tmp/task
    tar -xf /deps/linux-node-modules.tar -C /tmp/deps
    ln -s /tmp/deps/node_modules /tmp/task/node_modules
    cd /tmp/task
    PILOT_TEST_EXPECT_PROCFS_UNAVAILABLE=1 ./node_modules/.bin/tsx --test --test-name-pattern="procfs backend failures return 503" tests/server/media.test.ts
  '
