#!/usr/bin/env bash
set -euo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work
H=$W/cron-startup-20261021
S=$H/root-combined-tree
mkdir -p "$S" "$H/root-combined-tmp"
export TMPDIR=$H/root-combined-tmp
rsync -a --exclude .git --exclude node_modules "$W/enclave/" "$S/"
rsync -a "$W/windows-local-relay-migration/stage/source/" "$S/"
for nm in node_modules network/node_modules relay/node_modules sdk/sessions/node_modules e2e/node_modules; do
  if [ -d "$W/enclave/$nm" ]; then ln -sfn "$W/enclave/$nm" "$S/$nm"; fi
done
cp "$H/host-tick/live-b/windows/node/host.mjs" "$S/windows/node/host.mjs"
cp "$H/host-policy-review/final-fix/out/final.host-admission.bundle.mjs" "$S/windows/node/host-admission.bundle.mjs"
cp "$H/host-tick/b/test/windows-node-tick-single-flight.test.mjs" "$S/test/"
cd "$S"
sha256sum windows/node/host.mjs windows/node/host-admission.bundle.mjs windows/node/chain.mjs > "$H/root-combined-pins.txt"
node --test --test-concurrency=1 --test-reporter=tap test/windows-node-tick-single-flight.test.mjs test/windows-node-wallet-policy.test.mjs test/windows-node-stopapp-tick.test.mjs test/windows-node-norenew.test.mjs test/windows-node-giveup-once.test.mjs > "$H/root-combined.tap" 2>&1
tail -10 "$H/root-combined.tap"
