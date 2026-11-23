#!/bin/sh
set -eu
node -e "if (Number(process.versions.node.split('.')[0]) < 24) process.exit(1)"
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT HUP INT TERM
tar -xf - -C "$root"
test -f "$root/linux-procfs-docstore.test.cjs"
node --test "$root/linux-procfs-docstore.test.cjs"
