#!/bin/bash
# base-state-readonly-stage/r5 GUARDED offline build (PREPARED by Claude 1728; NOT run by Claude). Root, after bsro-r5-guard-tests PASS
# and the probe has ended:
#   bash jobs/q-exit-status.sh bsro-r5-build 4096 unshare -Urn bash base-state-readonly-stage/r5/jobs/build.sh
# Refuses unless a guard-tests receipt of THIS frozen stage passed, and /vm is still the pinned device (findmnt UUID). The build body
# (jobs/build-inner.sh = r4 build, pinned rustup env, Base-lock-only, cache/rustup unchanged) runs under jobs/disk_guard.py with its
# scratch in a NEW 0700 run dir under /vm/enclave-volumes/rpc-recovery-validation-build: start only with >= 64 GiB free; the guard
# stops ONLY its own process group if /vm free < 40 GiB, the run dir's allocated blocks > 20 GiB, or after 7500 s. Scratch is kept.
set -uo pipefail
export PATH=/usr/bin:/bin
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
BASE=/vm/enclave-volumes/rpc-recovery-validation-build
VM_UUID=aaae081c-f829-4484-a50f-a9bbb87d31f9; VM_SRC=/dev/mapper/cryptvm; VM_FS=ext4; VM_MM=253:1     # read-only findmnt, 1728
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || { echo "## REFUSED: stage != SHA256SUMS"; exit 9; }
SUMS=$(sha256sum < "$S/SHA256SUMS" | cut -c1-64)
python3 -I -B - "$S" "$SUMS" <<'PY' || { echo "## REFUSED: no passing bsro-r5-guard-tests receipt for this frozen stage"; exit 9; }
import glob, json, sys
ok = False
for p in glob.glob(sys.argv[1] + "/runs/guard-tests-*/receipt.json"):
    try:
        r = json.load(open(p))
    except (OSError, ValueError):
        continue
    ok = ok or (r.get("pass") is True and r.get("stageSums") == sys.argv[2] and r.get("format") == "bsro-guard-test-receipt/r5")
sys.exit(0 if ok else 1)
PY
[ "$(findmnt -n -o UUID,SOURCE,FSTYPE,MAJ:MIN -T /vm/enclave-volumes | tr -s ' ')" = "$VM_UUID $VM_SRC $VM_FS $VM_MM" ] || { echo "## REFUSED: /vm is not the pinned device"; exit 9; }
python3 -I -B "$S/jobs/disk_guard.py" --base "$BASE" --mount-majmin $VM_MM --mount-source $VM_SRC --mount-fstype $VM_FS \
  --min-start-gib 64 --floor-gib 40 --max-scratch-gib 20 --interval 15 --timeout 7500 -- bash "$S/jobs/build-inner.sh"; rc=$?
echo "## bsro-r5-build rc=$rc (child rc; 3 refused; 70 /vm < 40 GiB; 71 scratch > 20 GiB; 72 timeout; 73 cancelled; 9 precondition)"; exit $rc
