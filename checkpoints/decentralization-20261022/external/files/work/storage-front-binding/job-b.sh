#!/bin/sh
# Reproduction against CURRENT main: a fresh copy of work/enclave (no .git/node_modules/target; on disk), the four
# patches applied (dry run first), then the JS suites: the new ones and the existing suites of every relay file touched.
# Also the negative control: main's own secrets-release.mjs (no wiring) fails the release test.
set -e
W=/home/steven/Documents/Codex/2026-10-18/wo/work; S=$W/storage-front-binding; R=$S/repro
rm -rf $R; mkdir -p $R
rsync -a --exclude .git --exclude node_modules --exclude target $W/enclave/ $R/
ln -s $W/enclave/node_modules $R/node_modules
cd $R
for p in $S/patches/0*.patch; do patch -p1 --dry-run -s < $p; done
for p in $S/patches/0*.patch; do patch -p1 -s < $p; done
echo PATCHES-APPLIED
node --test --test-concurrency=1 test/storage-front-binding.test.mjs test/storage-front-binding-release.test.mjs test/storage-front-binding-shield.test.mjs \
  test/secrets-release.test.mjs test/shield-app-verifier.test.mjs test/relay-deploy-closure.test.mjs test/release-prewarm.test.mjs
echo JS-OK
# the real relay process boots with the wiring (imports resolve, the reader and tracker are constructed)
node --test --test-concurrency=1 test/api-relay.test.mjs
echo API-RELAY-OK
# shield-secrets has no suite of its own in main's test/ list above; its module must at least load
node -e 'import("./relay/shield-secrets.mjs").then(m=>{if(typeof m.createShieldSecretRelease!=="function")process.exit(1);console.log("SHIELD-SECRETS-LOADS")})'
# the negative controls: main's unwired secrets-release.mjs / shield-secrets.mjs must FAIL the caller-path tests
cp $W/enclave/relay/secrets-release.mjs relay/secrets-release.mjs
if node --test --test-concurrency=1 test/storage-front-binding-release.test.mjs > $S/logs/negative-control.log 2>&1; then echo NEGATIVE-CONTROL-UNEXPECTEDLY-PASSED; exit 1; fi
grep -E "^(not )?ok " $S/logs/negative-control.log
cp $S/tree/relay/secrets-release.mjs relay/secrets-release.mjs
cp $W/enclave/relay/shield-secrets.mjs relay/shield-secrets.mjs
if node --test --test-concurrency=1 test/storage-front-binding-shield.test.mjs > $S/logs/negative-control-shield.log 2>&1; then echo SHIELD-NEGATIVE-CONTROL-UNEXPECTEDLY-PASSED; exit 1; fi
grep -E "^(not )?ok " $S/logs/negative-control-shield.log
cp $S/tree/relay/shield-secrets.mjs relay/shield-secrets.mjs
echo NEGATIVE-CONTROLS-FAIL-AS-EXPECTED
