#!/bin/sh
# Offline A1 original-game recheck tests (no network). Deps pinned in test/deps.mjs.
cd "$(dirname "$0")"
export ANCHOR_DEPS_ROOT="${ANCHOR_DEPS_ROOT:-/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/relay-consumer-source}"
ip link set lo up 2>/dev/null || true
exec node --test test/a1-recheck.test.mjs
