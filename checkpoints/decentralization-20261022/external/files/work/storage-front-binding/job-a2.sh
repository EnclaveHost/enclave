#!/bin/sh
# The guest reader against the anvil rig only (job A's other steps passed in run 2).
set -e
export GOFLAGS=-mod=mod
cd /home/steven/Documents/Codex/2026-10-18/wo/work/storage-front-binding/tree
node --test --test-concurrency=1 test/storage-front-binding-go.test.mjs
echo GO-RIG-OK
