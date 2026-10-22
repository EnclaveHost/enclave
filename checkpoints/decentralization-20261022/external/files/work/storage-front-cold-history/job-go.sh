#!/bin/sh
# Go vet/build (all three front tag sets, m3), the bootstrap/front unit tests, then the two rig-driven Go suites:
# the frozen front's guest reader (renamed providers) and the cold-history direct path.
set -e
export GOFLAGS=-mod=mod
T=/home/steven/Documents/Codex/2026-10-18/wo/work/storage-front-cold-history/tree
cd $T/isolation/m2
go vet ./appconfig ./release ./bootstrap ./front
go vet -tags bootstrapdirect ./front
go vet -tags "shielddirect bootstrapdirect" ./front
go build ./...
go build -o /dev/null -tags bootstrapdirect ./front
(cd ../m3 && go vet ./secretrun && go build -o /dev/null ./secretrun)
echo BUILD-OK
go test -count=1 -p 1 ./appconfig ./release ./bootstrap ./front
go test -count=1 -p 1 -tags bootstrapdirect ./front
go test -count=1 -p 1 -tags "shielddirect bootstrapdirect" ./front
echo GO-TESTS-OK
cd $T
node --test --test-concurrency=1 test/storage-front-binding-go.test.mjs
echo FROZEN-GO-RIG-OK
node --test --test-concurrency=1 test/storage-front-cold-history.test.mjs
echo COLD-HISTORY-OK
