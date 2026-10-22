#!/bin/sh
# The cold-history case after the fixture polling fix: bootstrap vet/tests (with every source added since job-go), then
# the month-old-lease suite on the rig.
set -e
export GOFLAGS=-mod=mod
T=/home/steven/Documents/Codex/2026-10-18/wo/work/storage-front-cold-history/tree
cd $T/isolation/m2
go vet ./bootstrap ./front
go test -count=1 -p 1 ./bootstrap
echo BOOTSTRAP-OK
cd $T
node --test --test-concurrency=1 test/storage-front-cold-history.test.mjs
echo COLD-HISTORY-OK
