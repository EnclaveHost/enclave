#!/usr/bin/env bash
set -uo pipefail
D=/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-host-review-20261021; L=$D/tree-live; P=$D/proposed; cd $L
s(){ grep -E "^# (pass|fail)" | tr '\n' ' '; }
set_pair(){ cp $1 windows/node/host.mjs; cp $2 network/wallet-admission.mjs; echo -n "host $(sha256sum windows/node/host.mjs|cut -c1-8) writer $(sha256sum network/wallet-admission.mjs|cut -c1-8): "; }
T11='a Windows sharing violation of the hold write'
for combo in "A orig-host+orig-writer $P/host.live.mjs.orig $P/wallet-admission.mjs.orig" "B orig-host+v2-writer $P/host.live.mjs.orig $P/wallet-admission.mjs.proposed" \
             "C proposed-host+v2-writer $P/host.live.mjs.proposed $P/wallet-admission.mjs.proposed" "D proposed-host+orig-writer $P/host.live.mjs.proposed $P/wallet-admission.mjs.orig"; do
  set -- $combo; echo -n "$1 $2 "; set_pair $3 $4
  timeout 120 node --test --test-concurrency=1 --test-name-pattern="$T11" test/windows-node-wallet-network-hold-7d.test.mjs 2>&1 | grep -E "^(not )?ok|# (pass|fail)|took|transient" | head -4 | tr '\n' ' '; echo
done
set_pair $P/host.live.mjs.proposed $P/wallet-admission.mjs.proposed; echo "<- C full regressions:"
for t in windows-node-wallet-network-hold-7d wallet-admission-commit-retry-7d wallet-network-admission hold-review host-hold-review-7d; do
  echo "  $t: $(timeout 300 node --test --test-concurrency=1 test/$t.test.mjs 2>&1 | s)"; done
cp $P/wallet-admission.mjs.orig network/wallet-admission.mjs; echo "  control: v2 writer test on ORIGINAL writer: $(timeout 60 node --test test/wallet-admission-commit-retry-7d.test.mjs 2>&1 | s)"
set_pair $P/host.live.mjs.orig $P/wallet-admission.mjs.orig; echo "<- restored"
