#!/bin/sh
# Offline OP receipts-root tests (no network). Deps (@noble/hashes 1.8.0, viem 2.53.1) pinned in test/deps.mjs.
cd "$(dirname "$0")"
export ANCHOR_DEPS_ROOT="${ANCHOR_DEPS_ROOT:?set ANCHOR_DEPS_ROOT to a checkout with node_modules (see test/deps.mjs)}"
ip link set lo up 2>/dev/null || true
exec node --test test/op-receipts-root.test.mjs
