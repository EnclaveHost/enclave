#!/bin/sh
# make-patches.sh: patches of the candidate tree against CURRENT main (work/enclave), one file group each, plus the
# inventory (sha256 of main's file, the candidate's file). Read-only towards main.
W=/home/steven/Documents/Codex/2026-10-18/wo/work; M=$W/enclave; T=$W/storage-front-binding/tree; P=$W/storage-front-binding/patches
rm -rf $P; mkdir -p $P
group() { out=$1; shift; : > $P/$out
  for f in "$@"; do
    if [ -e "$M/$f" ]; then diff -u --label "a/$f" --label "b/$f" "$M/$f" "$T/$f" >> $P/$out
    else diff -u --label /dev/null --label "b/$f" /dev/null "$T/$f" >> $P/$out; fi
    printf '%s  %s  %s  %s\n' "$out" "$( [ -e $M/$f ] && sha256sum < $M/$f | cut -c1-64 || echo NEW)" "$(sha256sum < $T/$f | cut -c1-64)" "$f" >> $P/INVENTORY.txt
  done; }
group 01-relay-writer-authority.patch relay/lease-generation.mjs relay/secrets-release.mjs relay/shield-secrets.mjs relay/shield-app-verifier.mjs relay/deploy.sh
group 02-api-relay-wiring.patch relay/api-relay.js
group 03-go-front-facts.patch isolation/m2/appconfig/facts.go isolation/m2/release/release.go isolation/m2/bootstrap/chain.go isolation/m2/bootstrap/leasegen.go isolation/m2/front/measured_reader.go isolation/m2/front/provision.go isolation/m2/front/bootstrap.go isolation/m2/front/shield_secrets.go isolation/m2/front/shield_direct.go isolation/m2/front/shield_direct_custody.go isolation/m3/secretrun/main.go
group 04-tests.patch isolation/m2/appconfig/facts_test.go isolation/m2/front/facts_test.go isolation/m2/bootstrap/lease16d_rig_test.go test/helpers/lease16d-rig.mjs test/fixtures/ledger-rev16d/EnclaveDeployments.json test/fixtures/ledger-rev16d/EnclaveLedgerBandwidth.json test/fixtures/ledger-rev16d/PROVENANCE.txt test/storage-front-binding.test.mjs test/storage-front-binding-release.test.mjs test/storage-front-binding-shield.test.mjs test/storage-front-binding-go.test.mjs
(cd $P && sha256sum *.patch > SHA256SUMS)
wc -l $P/*.patch
