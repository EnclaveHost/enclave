#!/bin/sh
# Reproduction on CURRENT main (which now carries the accepted cold-history work): a fresh copy of work/enclave (no .git,
# node_modules or target; on disk), this work's patches applied (dry run first), every result compared to INVENTORY, then
# Go (every tag set), the JS suites of every touched file, the frozen rig and the cold suite with the checkpoint case.
set -e
W=/home/steven/Documents/Codex/2026-10-18/wo/work; H=$W/history-owner-tools; R=$H/repro
rm -rf $R; mkdir -p $R
rsync -a --exclude .git --exclude node_modules --exclude target --exclude custody/dkg $W/enclave/ $R/
for d in node_modules network/node_modules relay/node_modules sdk/sessions/node_modules; do ln -s $W/enclave/$d $R/$d; done
cd $R
for p in $H/patches/0*.patch; do patch -p1 --dry-run -s < $p; done
for p in $H/patches/0*.patch; do patch -p1 -s < $p; done
awk '{print $3"  "$4}' $H/patches/INVENTORY.txt | sha256sum -c --quiet
echo PATCHES-APPLIED-AND-MATCH
export GOFLAGS=-mod=mod
cd $R/isolation/m2
go vet ./appconfig ./release ./bootstrap ./front
go vet -tags bootstrapdirect ./front
go vet -tags "shielddirect bootstrapdirect" ./front
go build ./... && go build -o /dev/null -tags bootstrapdirect ./front
(cd ../m3 && go vet ./secretrun && go test -count=1 ./secretrun)
go test -count=1 -p 1 ./appconfig ./release ./bootstrap ./front
go test -count=1 -p 1 -tags bootstrapdirect ./front
go test -count=1 -p 1 -tags "shielddirect bootstrapdirect" ./front
echo GO-OK
cd $R
GIT_DIR=$W/enclave/.git GIT_WORK_TREE=$R GIT_OPTIONAL_LOCKS=0 \
node --test --test-concurrency=1 test/history-owner-tools.test.mjs test/bootstrap-package.test.mjs test/bootstrap-names.test.mjs \
  test/site-independent-names.test.mjs test/site-independent-management-unit.test.mjs test/site-independent-storage.test.mjs \
  test/bootstrap-supervisor.test.mjs test/direct-only-supervisor.test.mjs test/startup-expectation.test.mjs \
  test/windows-shield-startup.test.mjs test/windows-shield-package-transport.test.mjs
echo JS-PACKAGE-OK
node --test --test-concurrency=1 test/storage-front-binding.test.mjs test/storage-front-resource-bounds.test.mjs \
  test/storage-front-binding-release.test.mjs test/storage-front-binding-shield.test.mjs test/relay-deploy-closure.test.mjs
echo JS-RELAY-OK
node --test --test-concurrency=1 test/cli.test.mjs
echo CLI-OK
node --test --test-concurrency=1 test/storage-front-binding-go.test.mjs
echo FROZEN-GO-RIG-OK
node --test --test-concurrency=1 test/storage-front-cold-history.test.mjs
echo COLD-HISTORY-OK
