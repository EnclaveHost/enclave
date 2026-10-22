#!/bin/sh
# make-patches.sh: the deliverable patches of work/history-owner-tools against CURRENT main (work/enclave), read-only
# towards main. Refuses unless every accepted cold-history file in main is still its base or exactly the accepted result
# (root integrated all 38: base/accepted-state-in-main.txt), and every other file touched here is unchanged in main. Also delta-from-accepted.patch (the accepted 38-file
# result -> this candidate) for review.
set -e
W=/home/steven/Documents/Codex/2026-10-18/wo/work; M=$W/enclave; H=$W/history-owner-tools; T=$H/tree; P=$H/patches
A=$W/storage-front-cold-history/result
# each accepted file in main is either still its base, or the accepted result exactly (root integrated it); else refuse
awk '{print $2"  "$3"  "$4}' $H/base/accepted-INVENTORY.txt | while read h r f; do
  m=$( [ -e "$M/$f" ] && sha256sum < "$M/$f" | cut -c1-64 || echo ABSENT)
  if [ "$m" = "$r" ]; then echo "INTEGRATED $f"; elif [ "$m" = "$h" ] || { [ "$h" = NEW ] && [ "$m" = ABSENT ]; }; then echo "BASE $f"
  else echo "MAIN DIVERGED: $f"; exit 1; fi
done > $H/base/accepted-state-in-main.txt
while read h f; do [ "$(sha256sum < $M/$f | cut -c1-64)" = "$h" ] || { echo "CHANGED IN MAIN: $f"; exit 1; }; done < $H/base/touched-main-hashes.txt.byhash
rm -rf $P; mkdir -p $P
group() { out=$1; shift; : > $P/$out
  for f in "$@"; do
    [ -e "$M/$f" ] && cmp -s "$M/$f" "$T/$f" && continue   # identical to main (e.g. integrated accepted files): nothing to apply
    if [ -e "$M/$f" ]; then diff -u --label "a/$f" --label "b/$f" "$M/$f" "$T/$f" >> $P/$out || true
    else diff -u --label /dev/null --label "b/$f" /dev/null "$T/$f" >> $P/$out || true; fi
    printf '%s  %s  %s  %s\n' "$out" "$( [ -e $M/$f ] && sha256sum < $M/$f | cut -c1-64 || echo NEW)" "$(sha256sum < $T/$f | cut -c1-64)" "$f" >> $P/INVENTORY.txt
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
group 05-owner-history-tools.patch sdk/bootstrap/package.mjs site/js/core/startup-package.js site/components/deployments/deployments.js cli/enclave.mjs \
  scripts/history-vectors.mjs isolation/m2/bootstrap/testdata/history-vectors.json isolation/m2/bootstrap/history_vectors_test.go \
  test/history-owner-tools.test.mjs test/cli.test.mjs
group 06-attested-checkpoints.patch isolation/m2/bootstrap/snpverify.go isolation/m2/bootstrap/checkpoint.go isolation/m2/bootstrap/checkpoint_test.go
: > $P/delta-from-accepted.patch
for f in $(awk '{print $4}' $P/INVENTORY.txt); do
  if [ -e "$A/$f" ]; then diff -u --label "accepted/$f" --label "owner-tools/$f" "$A/$f" "$T/$f" >> $P/delta-from-accepted.patch || true
  elif [ -e "$M/$f" ]; then diff -u --label "main/$f" --label "owner-tools/$f" "$M/$f" "$T/$f" >> $P/delta-from-accepted.patch || true
  else diff -u --label /dev/null --label "owner-tools/$f" /dev/null "$T/$f" >> $P/delta-from-accepted.patch || true; fi
done
find $P -name "*.patch" -size 0 -delete
(cd $P && sha256sum *.patch > SHA256SUMS)
wc -l $P/*.patch
