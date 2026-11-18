#!/bin/sh
set -eu
[ "$(uname -s)" = Linux ] || { echo 'peercred addon is Linux-only' >&2; exit 1; }
[ "$(uname -m)" = aarch64 ] || { echo 'run this validation on Linux ARM64 (aarch64)' >&2; exit 1; }
command -v node >/dev/null
command -v g++ >/dev/null
node_include=${NODE_INCLUDE_DIR:-$(node -p 'require("path").resolve(require("fs").realpathSync(process.execPath), "../../include/node")')}
if [ ! -r "$node_include/node_api.h" ]; then
  if [ -r /usr/local/include/node/node_api.h ]; then
    node_include=/usr/local/include/node
  elif [ -r /usr/include/node/node_api.h ]; then
    node_include=/usr/include/node
  else
    echo 'install matching Node development headers or set NODE_INCLUDE_DIR' >&2
    exit 1
  fi
fi
node -e 'if (process.platform !== "linux" || process.arch !== "arm64") process.exit(1)'
g++ -std=c++17 -O2 -fPIC -shared -fvisibility=hidden -DNODE_GYP_MODULE_NAME=peercred_linux -I"$node_include" peercred-linux.cc -o peercred-linux.node
node -e 'const c=require("./peercred-linux.node"); if(typeof c.peerUid!=="function") process.exit(1)'
printf 'Built Linux ARM64 SO_PEERCRED addon: %s\n' "$PWD/peercred-linux.node"
