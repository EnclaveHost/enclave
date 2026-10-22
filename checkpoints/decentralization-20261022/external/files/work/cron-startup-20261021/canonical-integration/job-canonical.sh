#!/usr/bin/env bash
# ONE queued job: (A) rebuild ONLY the two build-host-admission bundles in canonical work/enclave (its existing mirror list);
# (B) in a SCRATCH copy, prove the canonical bundles differ from the deployed ones ONLY by PRODUCTION_MIRRORS ([] rebuilds
# 66c6e15a / acfa1b00); (C) targeted tests of the changed composition, in the scratch copy (canonical tree not written by tests).
set -euo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work; E=$W/enclave; CI=$W/cron-startup-20261021/canonical-integration; RS=$W/cron-startup-20261021/release-source
export TMPDIR=$CI/tmp; rm -rf "$TMPDIR"; mkdir -p "$TMPDIR" "$CI/out"
echo "== A. canonical rebuild (scripts/build-host-admission.mjs, existing mirror list 6422d065)"
cd "$E"; [ "$(sha256sum network/platform-host-policy-config.mjs | cut -c1-8)" = 6422d065 ] || { echo "config not canonical"; exit 1; }
node scripts/build-host-admission.mjs
sha256sum windows/node/host-admission.bundle.mjs metal/guest/host-policy.bundle.mjs | tee "$CI/out/canonical-bundles.sha256"
node --check windows/node/host-admission.bundle.mjs && node --check metal/guest/host-policy.bundle.mjs && echo "node --check ok"
grep -c "/platform-policy" windows/node/host-admission.bundle.mjs | sed 's/^/canonical windows bundle \/platform-policy occurrences: /'
T=$TMPDIR/tree; rsync -a --exclude .git --exclude node_modules "$E/" "$T/"
for nm in node_modules network/node_modules relay/node_modules sdk/sessions/node_modules e2e/node_modules windows/node/node_modules; do [ -d "$E/$nm" ] && ln -s "$E/$nm" "$T/$nm"; done
cd "$T"
echo "== B. scratch: the SAME tree with only PRODUCTION_MIRRORS [] must rebuild the DEPLOYED bundle"
cp "$RS/source/network/platform-host-policy-config.mjs" network/
node scripts/build-host-admission.mjs
W1=$(sha256sum windows/node/host-admission.bundle.mjs | cut -d' ' -f1); M1=$(sha256sum metal/guest/host-policy.bundle.mjs | cut -d' ' -f1)
echo "[] windows $W1 (deployed 66c6e15a793b8dc4cb80f209b6ffa405c40c7d235284727384e4833576610067)"; echo "[] metal $M1 (final acfa1b0099530d4c27fe451d7d3f1d124b3f7a213171557c1c2d926976e0dc3c)"
[ "$W1" = 66c6e15a793b8dc4cb80f209b6ffa405c40c7d235284727384e4833576610067 ] && [ "$M1" = acfa1b0099530d4c27fe451d7d3f1d124b3f7a213171557c1c2d926976e0dc3c ] && echo "ONLY-MIRROR-DIFFERENCE PROVEN" || { echo "DIFFERENCE IS NOT ONLY THE MIRROR LIST"; exit 1; }
cp "$E/network/platform-host-policy-config.mjs" network/; cp "$E/windows/node/host-admission.bundle.mjs" windows/node/; cp "$E/metal/guest/host-policy.bundle.mjs" metal/guest/
echo "== C. targeted tests on the canonical composition (scratch copy)"
set +e
node --test --test-concurrency=1 --test-reporter=tap test/host-admission-runtime.test.mjs test/windows-node-platform-policy.test.mjs test/lease-reader.test.mjs > "$CI/out/existing37.tap" 2>&1; r1=$?
node --test --test-concurrency=1 --test-reporter=tap test/host-admission-retry.test.mjs > "$CI/out/admission-retry.tap" 2>&1; r2=$?
node --test --test-concurrency=1 --test-reporter=tap test/windows-node-tick-single-flight.test.mjs > "$CI/out/tick-single-flight.tap" 2>&1; r3=$?
node --test --test-concurrency=1 --test-reporter=tap test/windows-node-wallet-policy.test.mjs test/windows-node-stopapp-tick.test.mjs test/windows-node-norenew.test.mjs test/windows-node-giveup-once.test.mjs > "$CI/out/tick-path16.tap" 2>&1; r4=$?
set -e
for f in existing37 admission-retry tick-single-flight tick-path16; do echo "$f: $(grep -E '^# (tests|pass|fail)' "$CI/out/$f.tap" | tr '\n' ' ')"; done
cd "$CI"; rm -rf "$TMPDIR"
echo "rc existing=$r1 retry=$r2 tick=$r3 path=$r4"; [ $r1 = 0 ] && [ $r2 = 0 ] && [ $r3 = 0 ] && [ $r4 = 0 ] && echo CANONICAL-OK || { echo CANONICAL-NOT-OK; exit 1; }
