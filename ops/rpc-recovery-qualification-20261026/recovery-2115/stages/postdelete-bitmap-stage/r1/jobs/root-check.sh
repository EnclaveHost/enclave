#!/bin/bash
# postdelete-bitmap-stage/r1 REAL offline check (PREPARED by Claude; NOT run by Claude). Run ONLY after pdb-r1-tests PASS:
#   bash jobs/q-exit-status.sh pdb-r1-check 512 unshare -Urn bash postdelete-bitmap-stage/r1/jobs/root-check.sh
# Inputs: ONLY the local journal COPY + local metadata text/JSON under logs/base-journal-copy-1626 (pinned in case/base-1626.json).
# No device, USB, image, mount, replay or write except one NEW 0600 result.json under runs/.
# Bounds: 5400 s wall, 3600 s CPU; journal reads <= 24 verifier calls (each 1 pass + walk <= 4x log) + hashing + <= 262144 image reads.
# rc: 0 NO_REUSE_OBSERVED_IN_JOURNALED_HISTORY, 4 REUSE_OBSERVED, 5 BLOCKED, 3 refused, 9 precondition. NONE is a recovery acceptance.
set -uo pipefail
export PATH=/usr/bin:/bin
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P); P=$(cd "$S/../.." && pwd -P); JR=$P/journal-recovery-verifier-stage
L=$P/logs/base-journal-copy-1626
J=$L/journal-8.bin; FS=$L/fs-stats.out; COV=$L/candidate-extent-coverage.json; CASE=$S/case/base-1626.json
JSHA=d95d81fcaf1fdecb305f5645bc5bf2d6093d0a7fc40affbfc769894798cbc073
R1_SUMS=1a7bcc31444776ddb4cf54b3fb2eca0c8d8f61b2e6b467b98f86752022cee46a; R3_SUMS=f12578a688c08d43d71ba0a38dfd52b2e732dac0e9d981031af38dc7c08f6adf
O=$S/runs/check-$(date -u +%Y%m%dT%H%M%SZ)-$$; mkdir -p "$O" || exit 9
ip -4 route 2>/dev/null | grep -q . && { echo "network route present: run under unshare -Urn"; exit 9; }
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || { echo "stage != SHA256SUMS"; exit 9; }
for p in "r1 $R1_SUMS" "r3 $R3_SUMS"; do set -- $p
  [ "$(sha256sum < "$JR/$1/SHA256SUMS" | cut -c1-64)" = "$2" ] && (cd "$JR/$1" && sha256sum -c --quiet SHA256SUMS) || { echo "frozen verifier $1 changed"; exit 9; }
  cmp -s "$S/jbd2_verify.py" "$JR/$1/jbd2_verify.py" || { echo "runtime differs from verifier $1"; exit 9; }
done
ls "$S"/runs/tests-*/receipt.json >/dev/null 2>&1 && grep -lq '"pass": true' "$S"/runs/tests-*/receipt.json || { echo "no passing pdb-r1-tests receipt"; exit 9; }
for f in "$J" "$FS" "$COV"; do [ -f "$f" ] && [ ! -L "$f" ] || { echo "input missing or a symlink: $f"; exit 9; }; done
[ "$(sha256sum < "$J" | cut -c1-64)" = "$JSHA" ] || { echo "journal copy != $JSHA"; exit 9; }
sha256sum "$J" "$FS" "$COV" "$CASE" > "$O/inputs.sha256"
(ulimit -t 3600 && env -i PATH=$PATH timeout -k 10 5400 python3 -I -B "$S/postdelete_bitmap.py" --journal "$J" --fs-stats "$FS" \
    --coverage "$COV" --case "$CASE" --out "$O/result.json") > "$O/stdout.txt" 2> "$O/stderr.txt"; rc=$?
[ "$(sha256sum < "$J" | cut -c1-64)" = "$JSHA" ] || { echo "journal copy changed during the run"; rc=9; }
cat "$O/stdout.txt" "$O/stderr.txt"
if [ -f "$O/result.json" ]; then
  sha256sum "$O/result.json"
  python3 -I -B - "$O/result.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
b, w, m = d["boundary"], d["journal"]["window"], d["bitmaps"]
print("## verdict", d["verdict"]); print("## blockers", json.dumps(d["blockers"][:20]))
print("## boundary P/S0/C/R", b["lastLiveTid"], b["deletionStartTid"], b["completionTid"], b["slotReuseTid"])
print("## window", json.dumps({k: w.get(k) for k in ("from", "newestProven", "sSequence", "sHead", "contiguous", "gapsTotal", "strayHeaderTids", "failedTids", "tail")}))
print("## bitmaps", json.dumps({k: m.get(k) for k in ("groups", "dataBlocks", "reusedBlocks", "notObservedFreedBlocks", "preDeletionClearBlocks")}))
print("## verifierCalls", len(d["runtime"]["verifierCalls"]), "imagesRead", d["runtime"]["imagesRead"])
PY
fi
echo "## outputs $O"; echo "## pdb-r1-check rc=$rc"; exit $rc
