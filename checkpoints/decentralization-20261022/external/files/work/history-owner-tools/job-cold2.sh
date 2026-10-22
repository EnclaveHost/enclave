#!/bin/sh
# The cold suite alone (its checkpoint case's CRL now fresh by the guest's clock).
set -e
cd /home/steven/Documents/Codex/2026-10-18/wo/work/history-owner-tools/tree/isolation/m2 && GOFLAGS=-mod=mod go vet ./bootstrap
cd /home/steven/Documents/Codex/2026-10-18/wo/work/history-owner-tools/tree && GOFLAGS=-mod=mod node --test --test-concurrency=1 test/storage-front-cold-history.test.mjs
echo COLD-HISTORY-OK
