#!/bin/bash
# base-state-readonly-stage/r5 POSITIVE + NEGATIVE fixtures on REAL compiled binaries (PREPARED by Claude; NOT run by Claude). Root:
#   bash jobs/q-exit-status.sh bsro-r5-positive 512 unshare -Urnm bash base-state-readonly-stage/r5/jobs/positive.sh <ABS runs/build-.../>
# mk_fixture writes each case into a NEW disposable dir under /tmp; the dir is then bind-remounted READ-ONLY (ST_RDONLY, private
# mount namespace) and the COMPILED helper runs on it; the tree must be byte-identical afterwards. 10 runs over 9 cases; every
# expectation below must hold exactly (rc, root vs the builder's INDEPENDENT alloy-trie root, header match, coherence, plain counts).
set -uo pipefail
export PATH=/usr/bin:/bin
BD=${1:?build dir}; case "$BD" in /*) ;; *) echo "build dir must be absolute"; exit 9;; esac
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || { echo "stage != SHA256SUMS"; exit 9; }
H=$BD/base-state-readonly; M=$BD/mk_fixture; [ -x "$H" ] && [ -x "$M" ] || { echo "binaries missing in $BD"; exit 9; }
ip -4 route 2>/dev/null | grep -q . && { echo "network route present: run under unshare -Urnm"; exit 9; }
T=/tmp/bsro-r5-pos-$(date -u +%Y%m%dT%H%M%SZ)-$$; if [ -e "$T" ]; then echo "$T exists"; exit 9; fi
mkdir -p "$T/out" || exit 9
O=$S/runs/positive-$(basename "$T"); mkdir -p "$O" || exit 9
sha256sum "$H" "$M" > "$O/binaries.sha256"
fails=0
one() { # label case extra-helper-args...
  local label=$1 c=$2; shift 2; local d=$T/$label
  timeout 120 "$M" "$c" "$d" > "$O/$label.mk.txt" 2>&1 || { echo "case $label: mk_fixture failed"; cat "$O/$label.mk.txt"; fails=$((fails+1)); return; }
  mount --bind "$d" "$d" && mount -o remount,bind,ro "$d" || { echo "case $label: ro bind failed"; fails=$((fails+1)); return; }
  local before; before=$(cd "$d" && find . -printf '%p %s %T@\n' | sort | sha256sum)
  local rk=$d/rocksdb; [ "$c" = v2-no-rocksdb ] && rk=$d/rocksdb
  timeout 300 "$H" --db "$d/db" --static-files "$d/static_files" --rocksdb "$rk" --out "$T/out/$label.json" "$@" > "$O/$label.helper.txt" 2>&1; local rc=$?
  local after; after=$(cd "$d" && find . -printf '%p %s %T@\n' | sort | sha256sum)
  cp "$d/expected.json" "$O/$label.expected.json"; [ -f "$T/out/$label.json" ] && cp "$T/out/$label.json" "$O/$label.result.json"
  python3 -I -B - "$label" "$rc" "$O/$label.expected.json" "$O/$label.result.json" "$([ "$before" = "$after" ] && echo 1 || echo 0)" \
      "$(stat -f -c %T "$d" 2>/dev/null)" "$(findmnt -n -o OPTIONS --target "$d" | tr ',' '\n' | grep -cx ro)" <<'PY' || fails=$((fails+1))
import json, sys
label, rc, ep, rp, unchanged, _fstype, ro = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5] == "1", sys.argv[6], sys.argv[7] == "1"
e = json.load(open(ep))
# label -> (rc, rootMatchesHeader, coherent, plainStatus, accountMismatches, slotMismatches)   None = not checked / refused
EXP = {"v1-pass": (0, True, True, "PASS", 0, 0), "v1-pass-noplain": (5, True, True, "NOT_RUN", None, None),
       "v1-plain-modified": (4, True, True, "FAIL", 0, 1), "v1-hashed-missing": (4, True, True, "FAIL", 0, 1),
       "v1-hashed-extra": (4, True, True, "FAIL", 0, 0), "v1-wrong-root": (4, False, True, "PASS", 0, 0),
       "v1-checkpoint-mismatch": (4, True, False, "PASS", 0, 0), "v2-not-applicable": (5, True, True, "NOT_APPLICABLE", None, None),
       "v1-no-header": (3,) + (None,) * 5, "v2-no-rocksdb": (3,) + (None,) * 5}[label]
bad = []
if not ro: bad.append("fixture was not mounted read-only")
if not unchanged: bad.append("fixture tree CHANGED during the helper run")
if rc != EXP[0]: bad.append(f"rc {rc} != {EXP[0]}")
if EXP[0] == 3:
    import os
    if os.path.exists(rp): bad.append("a refused run wrote a result")
else:
    r = json.load(open(rp))
    if r["stateRoot"]["computed"] != e["expectedRoot"]: bad.append(f"computed root {r['stateRoot']['computed']} != independent {e['expectedRoot']}")
    if r["tipHeader"]["stateRoot"] != e["headerRoot"] or r["finish"] != e["tip"]: bad.append("tip header / finish not the fixture's")
    if r["stateRoot"]["matchesHeader"] is not EXP[1]: bad.append("matchesHeader wrong")
    if r["checkpointsCoherent"] is not EXP[2]: bad.append("checkpointsCoherent wrong")
    p = r["plainVsHashed"]
    if p["status"] != EXP[3]: bad.append(f"plain status {p['status']} != {EXP[3]}")
    if r["fullStateIntegrity"] is not (EXP[0] == 0): bad.append("fullStateIntegrity wrong")
    if r["trieKeyAdapter"] != ("PackedKeyAdapter" if e["storageV2"] else "LegacyKeyAdapter"): bad.append("adapter wrong")
    if EXP[4] is not None:
        want = (e["plainAccounts"], e["hashedAccounts"], EXP[4], e["plainSlots"], e["hashedSlots"], EXP[5])
        got = (p["plainAccounts"], p["hashedAccounts"], p["accountMismatches"], p["plainSlots"], p["hashedSlots"], p["slotMismatches"])
        if got != want: bad.append(f"plain counts {got} != {want}")
    if label == "v2-not-applicable" and (p.get("plainAccountsEntries"), p.get("plainStorageEntries")) != (0, 0): bad.append("v2 plain tables not empty")
print(f"case {label}: {'PASS' if not bad else 'FAIL ' + '; '.join(bad)}"); sys.exit(1 if bad else 0)
PY
}
one v1-pass                v1-pass                --plain-hashed
one v1-pass-noplain        v1-pass
one v1-plain-modified      v1-plain-modified      --plain-hashed
one v1-hashed-missing      v1-hashed-missing      --plain-hashed
one v1-hashed-extra        v1-hashed-extra        --plain-hashed
one v1-wrong-root          v1-wrong-root          --plain-hashed
one v1-checkpoint-mismatch v1-checkpoint-mismatch --plain-hashed
one v2-not-applicable      v2-not-applicable      --plain-hashed
one v1-no-header           v1-no-header           --plain-hashed
one v2-no-rocksdb          v2-no-rocksdb          --plain-hashed
for d in "$T"/*/; do mountpoint -q "$d" && umount "$d"; done
rm -rf "$T"
echo "## cases=10 failed=$fails"; echo "## outputs $O"; echo "## bsro-r5-positive rc=$([ $fails = 0 ] && echo 0 || echo 1)"; [ $fails = 0 ]
