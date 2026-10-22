#!/bin/sh
# make-patches.sh: the deliverable patches against CURRENT main (work/enclave), read-only towards main.
# Each changed file's edit (snapshot base -> candidate) is replayed onto main's CURRENT file (patch, context only), so a
# file main changed since the snapshot (relay/api-relay.js) keeps main's change. result/ holds the exact files root gets;
# INVENTORY.txt: patch, sha256(main file or NEW), sha256(result file), path. Also delta-from-frozen.patch (frozen front
# candidate -> this candidate) for review.
set -e
W=/home/steven/Documents/Codex/2026-10-18/wo/work; M=$W/enclave; T=$W/storage-front-cold-history/tree; F=$W/storage-front-binding/tree
B=$W/storage-front-binding/base/orig; P=$W/storage-front-cold-history/patches; R=$W/storage-front-cold-history/result
rm -rf $P $R; mkdir -p $P $R
base_of() {   # the file the candidate's edit was made against: the frozen front's recorded original, else main's
  if [ -e "$B/$1" ]; then echo "$B/$1"; elif [ -e "$M/$1" ]; then echo "$M/$1"; else echo /dev/null; fi; }
group() { out=$1; shift; : > $P/$out
  for f in "$@"; do
    mkdir -p "$(dirname "$R/$f")"
    if [ ! -e "$M/$f" ]; then cp "$T/$f" "$R/$f"
    elif [ "$f" = relay/deploy.sh ]; then
      # main's CURRENT deploy.sh (root: keep it), plus only lease-generation.mjs after "scp api-relay.js"
      [ "$(grep -c 'scp api-relay.js ' $M/$f)" = 1 ] || { echo "deploy.sh: not exactly one api-relay scp line"; exit 1; }
      sed 's|scp api-relay.js |scp api-relay.js lease-generation.mjs |' "$M/$f" > "$R/$f"
    else
      cp "$M/$f" "$R/$f"
      diff -u --label "a/$f" --label "b/$f" "$(base_of $f)" "$T/$f" > /tmp/cold-one.patch || true
      (cd $R && patch -s -p1 --no-backup-if-mismatch < /tmp/cold-one.patch) || { echo "DOES NOT APPLY TO MAIN: $f"; exit 1; }
    fi
    if [ -e "$M/$f" ]; then diff -u --label "a/$f" --label "b/$f" "$M/$f" "$R/$f" >> $P/$out || true
    else diff -u --label /dev/null --label "b/$f" /dev/null "$R/$f" >> $P/$out || true; fi
    printf '%s  %s  %s  %s\n' "$out" "$( [ -e $M/$f ] && sha256sum < $M/$f | cut -c1-64 || echo NEW)" "$(sha256sum < $R/$f | cut -c1-64)" "$f" >> $P/INVENTORY.txt
  done; }
group 01-relay-writer-authority.patch relay/lease-generation.mjs relay/secrets-release.mjs relay/shield-secrets.mjs relay/shield-app-verifier.mjs relay/deploy.sh
group 02-api-relay-wiring.patch relay/api-relay.js
group 03-go-front-facts.patch isolation/m2/appconfig/facts.go isolation/m2/release/release.go isolation/m2/bootstrap/chain.go isolation/m2/bootstrap/leasegen.go \
  isolation/m2/bootstrap/manifest.go isolation/m2/bootstrap/history.go isolation/m2/bootstrap/cooldown.go isolation/m2/front/measured_reader.go isolation/m2/front/provision.go \
  isolation/m2/front/bootstrap.go isolation/m2/front/shield_secrets.go isolation/m2/front/shield_direct.go isolation/m2/front/shield_direct_custody.go \
  isolation/m3/secretrun/main.go
group 04-tests.patch isolation/m2/appconfig/facts_test.go isolation/m2/front/facts_test.go isolation/m2/bootstrap/lease16d_rig_test.go \
  isolation/m2/bootstrap/history_test.go isolation/m2/bootstrap/cold_history_rig_test.go isolation/m2/bootstrap/live_cold_history_test.go \
  isolation/m2/bootstrap/late_disagreement_test.go isolation/m2/bootstrap/deadline_progress_test.go \
  test/helpers/lease16d-rig.mjs test/fixtures/ledger-rev16d/EnclaveDeployments.json test/fixtures/ledger-rev16d/EnclaveLedgerBandwidth.json \
  test/fixtures/ledger-rev16d/PROVENANCE.txt test/storage-front-binding.test.mjs test/storage-front-binding-release.test.mjs \
  test/storage-front-binding-shield.test.mjs test/storage-front-binding-go.test.mjs test/storage-front-cold-history.test.mjs test/storage-front-resource-bounds.test.mjs
# the delta from the frozen front candidate, for review
: > $P/delta-from-frozen.patch
for f in $(awk '{print $4}' $P/INVENTORY.txt); do
  if [ -e "$F/$f" ]; then diff -u --label "frozen/$f" --label "cold/$f" "$F/$f" "$T/$f" >> $P/delta-from-frozen.patch || true
  else diff -u --label /dev/null --label "cold/$f" /dev/null "$T/$f" >> $P/delta-from-frozen.patch || true; fi
done
(cd $P && sha256sum *.patch > SHA256SUMS)
wc -l $P/*.patch
