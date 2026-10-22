#!/bin/sh
# History owner tools: shared vectors, Go (every tag set; vectors through the real Authorize), and every JS suite of the
# touched files (SDK, site modules, CLI, host-side package verification, relay reader).
set -e
T=/home/steven/Documents/Codex/2026-10-18/wo/work/history-owner-tools/tree
cd $T && node scripts/history-vectors.mjs
export GOFLAGS=-mod=mod
cd $T/isolation/m2
go vet ./appconfig ./release ./bootstrap ./front
go vet -tags bootstrapdirect ./front
go vet -tags "shielddirect bootstrapdirect" ./front
go build ./... && go build -o /dev/null -tags bootstrapdirect ./front
(cd ../m3 && go vet ./secretrun && go test -count=1 ./secretrun)
go test -count=1 -p 1 ./appconfig ./release ./bootstrap ./front
go test -count=1 -p 1 -run 'TestOwnerHistoryAgreesWithJavaScriptVectors' -v ./bootstrap | grep -c -- '--- PASS: TestOwnerHistoryAgreesWithJavaScriptVectors/' 
go test -count=1 -p 1 -tags bootstrapdirect ./front
go test -count=1 -p 1 -tags "shielddirect bootstrapdirect" ./front
echo GO-OK
cd $T
node --test --test-concurrency=1 test/history-owner-tools.test.mjs test/bootstrap-package.test.mjs test/bootstrap-names.test.mjs \
  test/site-independent-names.test.mjs test/site-independent-management-unit.test.mjs test/site-independent-storage.test.mjs \
  test/bootstrap-supervisor.test.mjs test/direct-only-supervisor.test.mjs test/startup-expectation.test.mjs \
  test/windows-shield-startup.test.mjs test/windows-shield-package-transport.test.mjs
echo JS-PACKAGE-OK
node --test --test-concurrency=1 test/storage-front-binding.test.mjs test/storage-front-resource-bounds.test.mjs \
  test/storage-front-binding-release.test.mjs test/storage-front-binding-shield.test.mjs
echo JS-RELAY-OK
node --test --test-concurrency=1 test/cli.test.mjs
echo CLI-OK
