#!/bin/bash
# platform-api-activation-closeout job 2 (immutable): after adding --names-only to pa-credentials-assemble.mjs, the same checks: syntax of every new helper and runbook, then the synthetic helper test
# against main's sources (imported read-only; every input fake, written under a mkdtemp in /tmp). Run through the queue at 256.
set -euo pipefail
A=/home/steven/Documents/Codex/2026-10-18/wo/work/platform-api-activation-closeout; E=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave
L=$A/logs/closeout-2; mkdir -p "$L"; fail=0
step() { local name=$1; shift; set +e; "$@" > "$L/$name.log" 2>&1; local rc=$?; set -e; echo "$rc" > "$L/$name.rc"; echo "step $name rc=$rc"; [ "$rc" -eq 0 ] || fail=1; }
step syntax bash -c "for f in $A/helpers/*.mjs $A/test/*.mjs; do node --check \"\$f\" || exit 1; done; bash -n $A/cutover.sh && bash -n $A/rollback.sh"
step sources-hash bash -c "cd $E && sha256sum metal/guest/measured-control.mjs metal/guest/platform-api-role.mjs relay/state-replica.mjs scripts/platform-api-admin.mjs metal/guest/platform-api.bundle.mjs metal/guest/platform-api.bundle.mjs.manifest.json"
step helpers-test env ENCLAVE_TREE="$E" node --test --test-concurrency=1 "$A/test/closeout-helpers.test.mjs"
step sources-unchanged bash -c "cd $E && sha256sum -c $L/sources-hash.log"
echo "closeout-2 fail=$fail"; exit "$fail"
