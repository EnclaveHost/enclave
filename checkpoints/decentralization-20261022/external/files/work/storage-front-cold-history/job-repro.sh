#!/bin/sh
# Reproduction on CURRENT main: a fresh copy of work/enclave (no .git/node_modules/target, no custody/dkg; on disk), the four
# patches applied (dry run first), every applied file compared to result/, then all suites of the touched files.
set -e
W=/home/steven/Documents/Codex/2026-10-18/wo/work; S=$W/storage-front-cold-history; R=$S/repro
rm -rf $R; mkdir -p $R
rsync -a --exclude .git --exclude node_modules --exclude target --exclude custody/dkg $W/enclave/ $R/
ln -s $W/enclave/node_modules $R/node_modules
cd $R
for p in $S/patches/0*.patch; do patch -p1 --dry-run -s < $p; done
for p in $S/patches/0*.patch; do patch -p1 -s < $p; done
awk '{print $3"  "$4}' $S/patches/INVENTORY.txt | sha256sum -c --quiet
echo PATCHES-APPLIED-AND-MATCH-RESULT
node --test --test-concurrency=1 test/storage-front-resource-bounds.test.mjs test/storage-front-binding.test.mjs \
  test/storage-front-binding-release.test.mjs test/storage-front-binding-shield.test.mjs test/secrets-release.test.mjs test/relay-deploy-closure.test.mjs
echo JS-OK
node --test --test-concurrency=1 test/api-relay.test.mjs
echo API-RELAY-OK
export GOFLAGS=-mod=mod
cd $R/isolation/m2
go vet ./appconfig ./release ./bootstrap ./front
go vet -tags bootstrapdirect ./front
go vet -tags "shielddirect bootstrapdirect" ./front
go build ./... && go build -o /dev/null -tags bootstrapdirect ./front
(cd ../m3 && go vet ./secretrun && go build -o /dev/null ./secretrun && go test -count=1 ./secretrun)
go test -count=1 -p 1 ./appconfig ./release ./bootstrap ./front
go test -count=1 -p 1 -tags bootstrapdirect ./front
go test -count=1 -p 1 -tags "shielddirect bootstrapdirect" ./front
echo GO-OK
cd $R
node --test --test-concurrency=1 test/storage-front-binding-go.test.mjs
echo FROZEN-GO-RIG-OK
node --test --test-concurrency=1 test/storage-front-cold-history.test.mjs
echo COLD-HISTORY-OK
