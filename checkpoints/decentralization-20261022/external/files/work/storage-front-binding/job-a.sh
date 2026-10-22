#!/bin/sh
# One 768 MiB allocation (compiler + Go): the pinned-solc fixture, Go vet/build/unit tests (3 tag sets + m3), then the
# guest reader against the anvil rig (test/storage-front-binding-go.test.mjs drives go test).
set -e
W=/home/steven/Documents/Codex/2026-10-18/wo/work/storage-front-binding
export GOFLAGS=-mod=mod
cd $W
node fixture-build.mjs
echo FIXTURE-OK
cd $W/tree/isolation/m2
go vet ./appconfig ./release ./bootstrap ./front
go build ./...
go build -o /dev/null -tags bootstrapdirect ./front
go vet -tags "shielddirect bootstrapdirect" ./front
(cd ../m3 && go vet ./secretrun && go build -o /dev/null ./secretrun)
echo BUILD-OK
go test -count=1 -p 1 ./appconfig ./release ./bootstrap ./front
go test -count=1 -p 1 -tags bootstrapdirect ./front
go test -count=1 -p 1 -tags "shielddirect bootstrapdirect" ./front
(cd ../m3 && go test -count=1 ./secretrun)
echo GO-TESTS-OK
cd $W/tree && node --test --test-concurrency=1 test/storage-front-binding-go.test.mjs
echo GO-RIG-OK
