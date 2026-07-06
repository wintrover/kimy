#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NIM_DIR="$SCRIPT_DIR/nim"
NODE_DIR="$SCRIPT_DIR/node"
RELEASE_DIR="$NODE_DIR/build/Release"

echo "[build.sh] Step 1: Nim → C code generation + shared library"
cd "$NIM_DIR"
nim c \
  --mm:arc \
  --app:lib \
  --boundChecks:on \
  --compileOnly \
  --outDir:build \
  --verbosity:0 \
  src/agent_core.nim

echo "[build.sh] Patching visibility..."
NIMCACHE="$NIM_DIR/.nimcache"
sed -i 's/N_LIB_PRIVATE N_CDECL/N_LIB_EXPORT N_CDECL/g' \
  "$NIMCACHE"/@mcost_pure.nim.c \
  "$NIMCACHE"/@msnapshot.nim.c

echo "[build.sh] Compiling Nim → shared library..."
NIM_LIB_DIR="$(dirname "$(dirname "$(which nim)")")/lib"
gcc -shared -fPIC -fvisibility=default \
  -o "$NIM_DIR/libagent_core.so" \
  "$NIMCACHE"/@mcost_pure.nim.c \
  "$NIMCACHE"/@msnapshot.nim.c \
  "$NIMCACHE"/@magent_core.nim.c \
  "$NIMCACHE"/@psystem.nim.c \
  "$NIMCACHE"/@psystem@sexceptions.nim.c \
  "$NIMCACHE"/@psystem@sdollars.nim.c \
  "$NIMCACHE"/@pstd@stypedthreads.nim.c \
  "$NIMCACHE"/@pstd@sprivate@sdigitsutils.nim.c \
  -I"$NIM_LIB_DIR" \
  -lpthread -lm

echo "[build.sh] Step 2: node-gyp build"
cd "$NODE_DIR"
if [ ! -d "node_modules/node-addon-api" ]; then
  npm install --ignore-scripts
fi
npx node-gyp rebuild

echo "[build.sh] Step 3: Symlink shared library into Release dir"
mkdir -p "$RELEASE_DIR"
ln -sf ../../../nim/libagent_core.so "$RELEASE_DIR/libagent_core.so"

echo "[build.sh] Done: native/node/build/Release/nim_agent_core.node"
