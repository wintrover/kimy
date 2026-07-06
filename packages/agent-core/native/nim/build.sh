#!/usr/bin/env bash
# build.sh — Build the Nim native addon as a shared library
# Steps: Nim -> C -> patch visibility -> gcc -> .so
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NIM_SRC="$SCRIPT_DIR/src/agent_core.nim"
NIMCACHE="$SCRIPT_DIR/.nimcache"
OUT="$SCRIPT_DIR/libagent_core.so"
NIM_LIB_DIR="$(dirname "$(dirname "$(which nim)")")/lib"

echo "[nim] Compiling to C..."
nim c \
  --mm:arc \
  --app:lib \
  --boundChecks:on \
  --compileOnly \
  --nimcache:"$NIMCACHE" \
  "$NIM_SRC"

echo "[nim] Patching visibility..."
sed -i 's/N_LIB_PRIVATE N_CDECL/N_LIB_EXPORT N_CDECL/g' \
  "$NIMCACHE"/@mcost_pure.nim.c \
  "$NIMCACHE"/@msnapshot.nim.c

echo "[nim] Compiling C to shared library..."
gcc -shared -fPIC -fvisibility=default \
  -o "$OUT" \
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

echo "[nim] Verifying exports..."
nm -D "$OUT" | grep -E "scoreMove|evaluateHeuristic|checkInvariant|traceConsequences|computeStateHash|validateSnapshot|applyEvents|migrateSnapshot"

echo "[nim] Done: $OUT"
file "$OUT"
