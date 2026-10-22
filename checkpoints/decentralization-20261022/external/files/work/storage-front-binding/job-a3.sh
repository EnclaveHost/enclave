#!/bin/sh
# After the one-window search step: Go vet/build/tests of the changed package and its consumers, then the guest reader on the rig.
set -e
export GOFLAGS=-mod=mod
cd /home/steven/Documents/Codex/2026-10-18/wo/work/storage-front-binding/tree/isolation/m2
go vet ./bootstrap ./front
go vet -tags "shielddirect bootstrapdirect" ./front
go build ./...
go test -count=1 -p 1 ./bootstrap ./front
go test -count=1 -p 1 -tags "shielddirect bootstrapdirect" ./front
echo GO-TESTS-OK
cd ../..
node --test --test-concurrency=1 test/storage-front-binding-go.test.mjs
echo GO-RIG-OK
