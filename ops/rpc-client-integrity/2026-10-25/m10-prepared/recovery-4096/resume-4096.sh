#!/bin/bash
# RESUME of the M10 tests at 4096 MiB after TWO node-build guard stops: root-after4096-test-m10-1 (1792: 1818 MiB) and the
# 2560 resume root-m10-resume2560-2139 (2566 MiB > 2560: rustc 2296 + cargo 266). From recovery-2560 (reviewed) by counted substitutions. ROOT-LAUNCHED, FOREGROUND, OFFLINE, existing queue (max 4096, unchanged):
#   R=$M/recovery-4096; python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 4096 \
#     --log $R/logs/resume-1.guard -- env CARGO_BUILD_JOBS=1 RUSTFLAGS='-C link-arg=-Wl,--threads=1' RESUME=1 \
#     unshare -rn bash $R/resume-4096.sh > $R/logs/resume-1.out 2>&1; echo $? > $R/logs/resume-1.rc
# DRY (no compile, cap not enforced): same with --mib 256, RESUME=dry1 DRY=1, logs dry-1.*.
# Validates every frozen input pin and the failed attempt, then runs resume-body.sh = the pinned root-test-m10.sh 51ffbda2
# with counted step-0 substitutions only (make-resume-body.py; re-derived and compared here). The retained build/ (tree,
# control, private cargo home, target) is reused; each phase still does `cargo clean -p <crate>` and requires fresh=false
# exactly as the original. Writes only under recovery-4096/ and (via cargo) build/target; never removes build/ or old logs.
set -uo pipefail
M=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/m10-bootstrap
R=$M/recovery-4096; L=$M/logs
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
pin $R/make-resume-body-4096.py 712371960a4b9039b2499d750921ec388fbc312ee6ad4b1ac5d0bb13e04ef146
pin $R/resume-body-4096.sh 0b0d3de00a1ccfff46f0bf29f9f8d398628db655dc42f490ed42fb51a8c983ef
need "resume-body-4096.sh == make-resume-body-4096.py(root-test-m10.sh)" python3 -I $R/make-resume-body-4096.py --check $M/jobs/root-test-m10.sh $R/resume-body-4096.sh
need "resume-body-4096.sh differs from the reviewed 2560 body 4064654e only in 3 lines (dirs, echo)" bash -c "[ \"\$(diff $M/recovery-2560/resume-body.sh $R/resume-body-4096.sh | grep -c '^[<>]')\" = 6 ]"
need "from phase() onward resume-body.sh is byte-identical to the original job" bash -c "diff <(sed -n '/^phase()/,\$p' $M/jobs/root-test-m10.sh) <(sed -n '/^phase()/,\$p' $R/resume-body-4096.sh)"
echo "== failed attempt (kept, never rewritten)"
need "root-after4096-test-m10-1.rc == 99" [ "$(cat $L/root-after4096-test-m10-1.rc)" = 99 ]
pin $L/root-after4096-test-m10-1.out 125ce2a121e5685ae700d176c95f2f51006abe4267f9b9fdef48c97bd1a96e05
pin $L/root-after4096-test-m10-1.guard 02b66f4bca479159ecbbacec8bd0462a3e595f3f52b309a6f1882bb2541416ab
need "attempt 1: cap 1792, guard stop 1818 > 1792, node phase not reached OK" bash -c "head -1 $L/root-after4096-test-m10-1.out | grep -q 'cap=1792MiB' && grep -q 'STOPPING own job: process tree RSS 1818 MiB > 1792 MiB' $L/root-after4096-test-m10-1.out && ! grep -q '^## node OK' $L/root-after4096-test-m10-1.out"
need "attempt 1: engine REBUILT b21d891a, 152 passed, engine OK" bash -c "grep -q '^## engine: REBUILT base_consensus_engine-22bbca68e14337e9 sha256 b21d891ac2d82db5526ad6168a9c501ce0d090ab310cf30ad6676f77912ca214$' $L/root-after4096-test-m10-1.out && grep -q '^test result: ok. 152 passed; 0 failed' $L/root-after4096-test-m10-1.out && grep -q '^## engine OK$' $L/root-after4096-test-m10-1.out"
pin $L/engine.test.out 1b3d5d6b9e3e48394c8cc42bac561156e8ce3d9fc1519c767532d7fa0895cad4
pin $L/node.build.err 46c807e13f9aa93a5a42dcea122cc0cfdc1f55f14a9f8d181cf63f623cb88cd6
echo "== 2560 resume failure (root receipt logs/root-m10-resume2560-2139.*, kept, never rewritten)"
W=${M%/finality-stage/m10-bootstrap}/logs; R2=$M/recovery-2560
pin $W/root-m10-resume2560-2139.out 4ac0f7a7bf1c54328f61644e5c6b43ef5b92a7b8a3f3137d6d4c8068657820fd
pin $W/root-m10-resume2560-2139.guard 1d3b634a1708a839786402e0b16da99fc237af69eb656fc94dd66d988e4ef7d6
need "2560 receipt rc == 99" [ "$(cat $W/root-m10-resume2560-2139.rc)" = 99 ]
need "2560: memory.max 2684354560, guard stop 2566 > 2560, node phase not reached OK" bash -c "grep -q 'memory.max 2684354560' $W/root-m10-resume2560-2139.out && grep -q 'STOPPING own job: process tree RSS 2566 MiB > 2560 MiB' $W/root-m10-resume2560-2139.out && ! grep -q '^## node OK' $W/root-m10-resume2560-2139.out"
need "2560: engine REBUILT b21d891a again, 152 passed, engine OK" bash -c "grep -q '^## engine: REBUILT base_consensus_engine-22bbca68e14337e9 sha256 b21d891ac2d82db5526ad6168a9c501ce0d090ab310cf30ad6676f77912ca214$' $W/root-m10-resume2560-2139.out && grep -q '^test result: ok. 152 passed; 0 failed' $W/root-m10-resume2560-2139.out && grep -q '^## engine OK$' $W/root-m10-resume2560-2139.out"
need "2560 per-phase logs run-1 unchanged (7 files)" bash -c "cd $R2/logs/run-1 && printf '%s\\n' 'a0e2d6d28ecce3afaf5d4d92f7007be70c55fa86ade6a963cb56a2abfca26714  engine.build.err' '9d0b0a8c2d8d1168bab14ad87834a10a83573b2baf52ac1d00f14b2c32410d43  engine.build.json' '837b3bbff6d7ebe8bf3b5186478dcab9f05b2ab5341e04fcb4116b345179578b  engine.clean.out' '9b01ebc8ffc9ab9fdbf880611b259ec3270b1a2be7d1a49871ee2887542e0386  engine.test.out' '740eab649f83a13cfe9029a51284538e0d912090205161a7fcbd148ea4e3420c  node.build.err' '1031fe427e992d7705f24d1b9d7aa81c37bede2c521181e6ef22eef9d4d771d4  node.build.json' 'b2ad04d5d853c2be2170a8ce6243a150228ce986e2c503d8224bd964cd38253a  node.clean.out' | sha256sum -c --quiet - && [ \"\$(ls | wc -l)\" = 7 ]"
echo "[info] recovery-2560/logs/resume-1.rc reads '$(cat $R2/logs/resume-1.rc)'; the authoritative 2560 exit is the root receipt (99)"
E=$M/build/target/debug/deps/base_consensus_engine-22bbca68e14337e9
if [ -e "$E" ]; then echo "[info] original engine test binary still present before re-run: $(h $E) (logged b21d891a)"; else echo "[info] original engine test binary no longer present (a resume phase cleaned it)"; fi
if [ "${DRY:-0}" != 1 ]; then
  need "this attempt's logs are new (resume-$RESUME.rc absent)" [ ! -e $R/logs/resume-$RESUME.rc ]
  [ "$RESUME" = 1 ] || need "previous resume-$((RESUME-1)) ended non-zero" bash -c "[ -s $R/logs/resume-$((RESUME-1)).rc ] && [ \"\$(cat $R/logs/resume-$((RESUME-1)).rc)\" != 0 ]"
  cg=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup | head -1)
  need "running under the 4096 MiB allocation (memory.max $(cat $cg/memory.max 2>/dev/null))" [ "$(cat $cg/memory.max 2>/dev/null)" = 4294967296 ]
fi
echo "== resume body (root-test-m10.sh 51ffbda2 + counted step-0 substitutions)"
export RESUME
exec bash $R/resume-body-4096.sh
