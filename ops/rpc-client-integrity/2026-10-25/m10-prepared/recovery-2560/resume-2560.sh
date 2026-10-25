#!/bin/bash
# RESUME of the M10 tests at 2560 MiB after the 1792 guard stop (root attempt root-after4096-test-m10-1: rc 99, node build,
# tree 1818 MiB > 1792: rustc 1483 + cargo 331). ROOT-LAUNCHED, FOREGROUND, OFFLINE, existing queue (max 4096, unchanged):
#   R=$M/recovery-2560; python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 2560 \
#     --log $R/logs/resume-1.guard -- env CARGO_BUILD_JOBS=1 RUSTFLAGS='-C link-arg=-Wl,--threads=1' RESUME=1 \
#     unshare -rn bash $R/resume-2560.sh > $R/logs/resume-1.out 2>&1; echo $? > $R/logs/resume-1.rc
# DRY (no compile, cap not enforced): same with --mib 256, RESUME=dry1 DRY=1, logs dry-1.*.
# Validates every frozen input pin and the failed attempt, then runs resume-body.sh = the pinned root-test-m10.sh 51ffbda2
# with counted step-0 substitutions only (make-resume-body.py; re-derived and compared here). The retained build/ (tree,
# control, private cargo home, target) is reused; each phase still does `cargo clean -p <crate>` and requires fresh=false
# exactly as the original. Writes only under recovery-2560/ and (via cargo) build/target; never removes build/ or old logs.
set -uo pipefail
M=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/m10-bootstrap
R=$M/recovery-2560; L=$M/logs
die() { echo "## RESUME REFUSED: $*"; echo "## aggregate rc=1"; exit 1; }
need() { local w=$1; shift; "$@" && echo "[ok] $w" || die "$w"; }
h() { sha256sum < "$1" | cut -c1-64; }
pin() { need "$(basename "$1") == ${2:0:8}" [ "$(h "$1")" = "$2" ]; }
if [ "${DRY:-0}" = 1 ]; then [[ "${RESUME:-}" =~ ^dry[1-9]$ ]] || die "DRY needs RESUME=dry<N>"; else [[ "${RESUME:-}" =~ ^[1-9]$ ]] || die "RESUME=<1-9> required"; fi
echo "== frozen input pins (root-input-pins.json ead48b1d)"
pin $M/root-input-pins.json ead48b1d47ef813c7ba8f5fc999445f6c148c46a46e3ba692814629b34b8e9a9
need "every pinned frozen input unchanged" python3 -I - "$M" <<'PY'
import hashlib, json, pathlib, sys
m = pathlib.Path(sys.argv[1]); pins = json.loads((m / "root-input-pins.json").read_text())
bad = [n for n, w in pins.items() if hashlib.sha256((m / n).read_bytes()).hexdigest() != w]
print("    " + ", ".join(f"{n} {w[:8]}" for n, w in pins.items())); sys.exit(1 if bad or len(pins) != 8 else 0)
PY
pin $M/jobs/root-test-m10.sh 51ffbda21d257a9af3b2ab935b3e63b7801112ae4c47ed1645fa67074ad2bae5
pin $R/make-resume-body.py 005e22d4b0d3de027f124f4469e4380b0c73f354748b5867674d64fe7393e759
pin $R/resume-body.sh 4064654e4f6e97836d92928cbf36aca9b4ad914243bca6397f18da6133d67daf
need "resume-body.sh == make-resume-body.py(root-test-m10.sh)" python3 -I $R/make-resume-body.py --check $M/jobs/root-test-m10.sh $R/resume-body.sh
need "from phase() onward resume-body.sh is byte-identical to the original job" bash -c "diff <(sed -n '/^phase()/,\$p' $M/jobs/root-test-m10.sh) <(sed -n '/^phase()/,\$p' $R/resume-body.sh)"
echo "== failed attempt (kept, never rewritten)"
need "root-after4096-test-m10-1.rc == 99" [ "$(cat $L/root-after4096-test-m10-1.rc)" = 99 ]
pin $L/root-after4096-test-m10-1.out 125ce2a121e5685ae700d176c95f2f51006abe4267f9b9fdef48c97bd1a96e05
pin $L/root-after4096-test-m10-1.guard 02b66f4bca479159ecbbacec8bd0462a3e595f3f52b309a6f1882bb2541416ab
need "attempt 1: cap 1792, guard stop 1818 > 1792, node phase not reached OK" bash -c "head -1 $L/root-after4096-test-m10-1.out | grep -q 'cap=1792MiB' && grep -q 'STOPPING own job: process tree RSS 1818 MiB > 1792 MiB' $L/root-after4096-test-m10-1.out && ! grep -q '^## node OK' $L/root-after4096-test-m10-1.out"
need "attempt 1: engine REBUILT b21d891a, 152 passed, engine OK" bash -c "grep -q '^## engine: REBUILT base_consensus_engine-22bbca68e14337e9 sha256 b21d891ac2d82db5526ad6168a9c501ce0d090ab310cf30ad6676f77912ca214$' $L/root-after4096-test-m10-1.out && grep -q '^test result: ok. 152 passed; 0 failed' $L/root-after4096-test-m10-1.out && grep -q '^## engine OK$' $L/root-after4096-test-m10-1.out"
pin $L/engine.test.out 1b3d5d6b9e3e48394c8cc42bac561156e8ce3d9fc1519c767532d7fa0895cad4
pin $L/node.build.err 46c807e13f9aa93a5a42dcea122cc0cfdc1f55f14a9f8d181cf63f623cb88cd6
E=$M/build/target/debug/deps/base_consensus_engine-22bbca68e14337e9
if [ -e "$E" ]; then echo "[info] original engine test binary still present before re-run: $(h $E) (logged b21d891a)"; else echo "[info] original engine test binary no longer present (a resume phase cleaned it)"; fi
if [ "${DRY:-0}" != 1 ]; then
  need "this attempt's logs are new (resume-$RESUME.rc absent)" [ ! -e $R/logs/resume-$RESUME.rc ]
  [ "$RESUME" = 1 ] || need "previous resume-$((RESUME-1)) ended non-zero" bash -c "[ -s $R/logs/resume-$((RESUME-1)).rc ] && [ \"\$(cat $R/logs/resume-$((RESUME-1)).rc)\" != 0 ]"
  cg=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup | head -1)
  need "running under the 2560 MiB allocation (memory.max $(cat $cg/memory.max 2>/dev/null))" [ "$(cat $cg/memory.max 2>/dev/null)" = 2684354560 ]
fi
echo "== resume body (root-test-m10.sh 51ffbda2 + counted step-0 substitutions)"
export RESUME
exec bash $R/resume-body.sh
