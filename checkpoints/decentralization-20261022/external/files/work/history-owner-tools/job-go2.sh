#!/bin/sh
# Go with the checkpoint (SNP evidence port, checkpoint statement/adoption, writerAuthority seeding), every tag set, then
# the frozen rig and the cold suite (now with the attested-checkpoint case).
set -e
T=/home/steven/Documents/Codex/2026-10-18/wo/work/history-owner-tools/tree
export GOFLAGS=-mod=mod
cd $T/isolation/m2
go vet ./appconfig ./release ./bootstrap ./front
go vet -tags bootstrapdirect ./front
go vet -tags "shielddirect bootstrapdirect" ./front
go build ./... && go build -o /dev/null -tags bootstrapdirect ./front
go test -count=1 -p 1 ./appconfig ./release ./bootstrap ./front
go test -count=1 -p 1 -run 'TestSNPEvidence|TestCheckpoint|TestOwnerHistory' -v ./bootstrap | grep -E -e '^(--- |=== RUN|ok|FAIL)' | grep -v '=== RUN' | tail -80
go test -count=1 -p 1 -tags bootstrapdirect ./front
go test -count=1 -p 1 -tags "shielddirect bootstrapdirect" ./front
echo GO-OK
cd $T
node --test --test-concurrency=1 test/storage-front-binding-go.test.mjs
echo FROZEN-GO-RIG-OK
node --test --test-concurrency=1 test/storage-front-cold-history.test.mjs
echo COLD-HISTORY-OK
