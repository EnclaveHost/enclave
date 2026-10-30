#!/bin/bash
# postdelete-bitmap-stage/r3 REAL offline check (PREPARED by Claude; NOT run by Claude). Run ONLY after pdb-r3-tests PASS (21):
#   bash jobs/q-exit-status.sh pdb-r3-check 512 unshare -Urn bash postdelete-bitmap-stage/r3/jobs/root-check.sh
# Must run as the UNPRIVILEGED owner (uid 1000) in its own user namespace; refused for real root (review 1687 F6).
# Inputs: ONLY the local journal COPY + local metadata text/JSON under logs/base-journal-copy-1626 (pinned in case/base-1626.json),
# hashed with nofollow opens. No device, USB, image, mount, replay or write except NEW files under a NEW runs/check-* directory.
# Requires a receipt of pdb-r3-tests bound to THIS stage's SHA256SUMS, checker, runtime and test file (review 1687 F4).
# Bounds: 5400 s wall, 3600 s CPU; <= 24 verifier calls (r2 needed 5; r3 adds the 27 leaf targets + 1 index phase) + <= 262144 image reads.
# rc: 0 NO_REUSE_OBSERVED_IN_JOURNALED_HISTORY, 4 REUSE_OBSERVED, 5 BLOCKED, 3 refused, 9 precondition. NONE is a recovery acceptance.
set -uo pipefail
export PATH=/usr/bin:/bin
read -r _in outer _n < /proc/self/uid_map
[ "$outer" != 0 ] || { echo "REFUSED: run as the unprivileged owner under unshare -Urn, never as real root (uid_map outer 0)"; exit 9; }
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P); P=$(cd "$S/../.." && pwd -P); JR=$P/journal-recovery-verifier-stage
[ "$(stat -c %u "$S")" = "$(id -u)" ] && [ ! -L "$S" ] || { echo "REFUSED: stage not owned by the caller"; exit 9; }
L=$P/logs/base-journal-copy-1626
J=$L/journal-8.bin; FS=$L/fs-stats.out; COV=$L/candidate-extent-coverage.json; CASE=$S/case/base-1626.json
JSHA=d95d81fcaf1fdecb305f5645bc5bf2d6093d0a7fc40affbfc769894798cbc073
PR1_SUMS=f5c89089199de733163e87ef1c982b4c529bf89c8eb6f90974b04492e62447c5; PR2_SUMS=51c393bfeef5506752b44ebb3ae27c1a7f40faffa0126a278948b705113b529d
R1_SUMS=1a7bcc31444776ddb4cf54b3fb2eca0c8d8f61b2e6b467b98f86752022cee46a; R3_SUMS=f12578a688c08d43d71ba0a38dfd52b2e732dac0e9d981031af38dc7c08f6adf
N=21
hsh() { python3 -I -B -c '
import hashlib, os, stat, sys
fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
st = os.fstat(fd)
if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid():
    sys.exit("not a regular file owned by the caller: " + sys.argv[1])
h = hashlib.sha256()
for b in iter(lambda: os.read(fd, 8 << 20), b""):
    h.update(b)
print(h.hexdigest())' "$1"; }
O=$S/runs/check-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p "$S/runs" && mkdir "$O" || { echo "REFUSED: run directory exists or cannot be created"; exit 9; }
ip -4 route 2>/dev/null | grep -q . && { echo "network route present: run under unshare -Urn"; exit 9; }
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || { echo "stage != SHA256SUMS"; exit 9; }
for p in "r1 $R1_SUMS" "r3 $R3_SUMS"; do set -- $p
  [ "$(sha256sum < "$JR/$1/SHA256SUMS" | cut -c1-64)" = "$2" ] && (cd "$JR/$1" && sha256sum -c --quiet SHA256SUMS) || { echo "frozen verifier $1 changed"; exit 9; }
  cmp -s "$S/jbd2_verify.py" "$JR/$1/jbd2_verify.py" || { echo "runtime differs from verifier $1"; exit 9; }
done
for p in "r1 $PR1_SUMS" "r2 $PR2_SUMS"; do set -- $p; D=$(cd "$S/../$1" && pwd -P)
  [ "$(sha256sum < "$D/SHA256SUMS" | cut -c1-64)" = "$2" ] && (cd "$D" && sha256sum -c --quiet SHA256SUMS) || { echo "frozen postdelete $1 changed"; exit 9; }
done
for f in jbd2_verify.py case/base-1626.json; do cmp -s "$S/$f" "$S/../r1/$f" || { echo "$f differs from postdelete r1"; exit 9; }; done
python3 -I -B - "$S" "$N" <<'PY' || { echo "no passing pdb-r3-tests receipt bound to this stage/checker/runtime/tests"; exit 9; }
import glob, hashlib, json, os, stat, sys
S, n = sys.argv[1], int(sys.argv[2])
def rd(p):
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or st.st_size > 4 << 20:
            raise OSError("not a small regular file owned by the caller")
        return os.read(fd, 4 << 20)
    finally:
        os.close(fd)
sha = lambda p: hashlib.sha256(rd(p)).hexdigest()
want = {"stageSums": sha(f"{S}/SHA256SUMS"), "checkerSha256": sha(f"{S}/postdelete_bitmap.py"), "runtimeSha256": sha(f"{S}/jbd2_verify.py"),
        "testsSha256": sha(f"{S}/tests/test_postdelete_bitmap.py")}
ok = []
for p in sorted(glob.glob(f"{S}/runs/tests-*/receipt.json")):
    try:
        r = json.loads(rd(p))
    except (OSError, ValueError):
        continue
    if isinstance(r, dict) and r.get("format") == "enclave-postdelete-bitmap-test-receipt/r3" and r.get("pass") is True \
            and r.get("expectedTests") == n and r.get("ran") == [str(n)] and all(r.get(k) == v for k, v in want.items()):
        ok.append(p)
print("## bound test receipt", ok[-1] if ok else None)
sys.exit(0 if ok else 1)
PY
for f in "$J" "$FS" "$COV" "$CASE"; do [ -f "$f" ] && [ ! -L "$f" ] || { echo "input missing or a symlink: $f"; exit 9; }; done
[ "$(hsh "$J")" = "$JSHA" ] || { echo "journal copy != $JSHA"; exit 9; }
for f in "$J" "$FS" "$COV" "$CASE"; do echo "$(hsh "$f")  $f"; done > "$O/inputs.sha256"
(ulimit -t 3600 && env -i PATH=$PATH timeout -k 10 5400 python3 -I -B "$S/postdelete_bitmap.py" --journal "$J" --fs-stats "$FS" \
    --coverage "$COV" --case "$CASE" --out "$O/result.json") > "$O/stdout.txt" 2> "$O/stderr.txt"; rc=$?
[ "$(hsh "$J")" = "$JSHA" ] || { echo "journal copy changed during the run"; rc=9; }
cat "$O/stdout.txt" "$O/stderr.txt"
if [ -f "$O/result.json" ] && [ ! -L "$O/result.json" ]; then
  echo "$(hsh "$O/result.json")  $O/result.json"
  python3 -I -B - "$O/result.json" <<'PY'
import json, os, sys
fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW)
with os.fdopen(fd) as f:
    d = json.load(f)
b, w, m, t = d["boundary"], d["journal"]["window"], d["bitmaps"], d["tree"]
print("## verdict", d["verdict"]); print("## blockers", json.dumps(d["blockers"][:20]))
print("## boundary mode/P/S0/C/R", b["mode"], b["lastLiveTid"], b["deletionStartTid"], b["completionTid"], b["slotReuseTid"])
print("## tree", json.dumps(t))
print("## window", json.dumps({k: w.get(k) for k in ("from", "lastLiveTid", "newestProven", "newestCommitSec", "sSequence", "sHead", "contiguous",
                                                     "gapsTotal", "strayHeaderTids", "failedTids", "tail")}))
print("## fs lastWriteTime / lastMountTime", d["geometry"]["lastWriteTime"], "/", d["geometry"]["lastMountTime"])
print("## bitmaps", json.dumps({k: m.get(k) for k in ("groups", "dataBlocks", "reusedBlocks", "notObservedFreedBlocks", "preDeletionClearBlocks",
                                                      "observedSetToClearBlocks", "clearWithoutObservedSetBlocks")}))
print("## verifierCalls", len(d["runtime"]["verifierCalls"]), "imagesRead", d["runtime"]["imagesRead"])
PY
fi
echo "## outputs $O"; echo "## pdb-r3-check rc=$rc"; exit $rc
