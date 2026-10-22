#!/bin/sh
# Checkpoint transport, units: both shared vector files generated (history: the SDK; checkpoint: the Go generator,
# synthetic AMD chain), Go vet/build every tag set and every Go package test, then the JS suites of every touched file
# (SDK, site modules, verifier, CLI). The bundle-provenance suite reads main's .git read-only (no .git in this tree).
set -e
W=/home/steven/Documents/Codex/2026-10-18/wo/work; T=$W/history-checkpoint-transport/tree
cd $T && node scripts/history-vectors.mjs
export GOFLAGS=-mod=mod
cd $T/isolation/m2
WRITE_CHECKPOINT_VECTORS=1 go test -count=1 -run '^TestWriteCheckpointVectors$' -v ./bootstrap | grep -E 'wrote|^(ok|FAIL|---)'
go vet ./appconfig ./release ./bootstrap ./front
go vet -tags bootstrapdirect ./front
go vet -tags "shielddirect bootstrapdirect" ./front
go build ./... && go build -o /dev/null -tags bootstrapdirect ./front && go build -o /dev/null -tags "shielddirect bootstrapdirect" ./front
(cd ../m3 && go vet ./secretrun && go test -count=1 ./secretrun)
go test -count=1 -p 1 ./appconfig ./release ./bootstrap ./front
go test -count=1 -p 1 -run 'TestSNPEvidence|TestCheckpoint|TestOwnerHistory|TestHistoryField' -v ./bootstrap | grep -E -e '^(--- |    --- |ok|FAIL)' | tail -150
go test -count=1 -p 1 -run 'TestCheckpoint' -v ./front | grep -E -e '^(--- |ok|FAIL)'
go test -count=1 -p 1 -tags bootstrapdirect ./front
go test -count=1 -p 1 -tags "shielddirect bootstrapdirect" ./front
echo GO-OK
cd $T
node --test --test-concurrency=1 test/history-checkpoint-transport.test.mjs test/history-owner-tools.test.mjs test/bootstrap-package.test.mjs \
  test/bootstrap-names.test.mjs test/site-independent-names.test.mjs test/site-independent-storage.test.mjs \
  test/bootstrap-supervisor.test.mjs test/direct-only-supervisor.test.mjs test/startup-expectation.test.mjs \
  test/windows-shield-startup.test.mjs test/windows-shield-package-transport.test.mjs
GIT_DIR=$W/enclave/.git GIT_WORK_TREE=$T GIT_OPTIONAL_LOCKS=0 node --test --test-concurrency=1 test/site-independent-management-unit.test.mjs
echo JS-PACKAGE-OK
node --test --test-concurrency=1 test/cli.test.mjs
echo CLI-OK
