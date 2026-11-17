#!/bin/sh
set -eu
out=${1:?usage: scripts/build-linux-procfs-docstore-test.sh OUTPUT.cjs}
./node_modules/.bin/esbuild tests/server/linux-procfs-docstore.test.ts \
  --bundle --platform=node --format=cjs --target=node24 --outfile="$out"
