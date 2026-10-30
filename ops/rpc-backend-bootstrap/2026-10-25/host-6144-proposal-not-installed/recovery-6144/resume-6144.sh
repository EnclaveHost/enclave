#!/bin/bash
# RESUME of the M10 tests at 6144 MiB after FOUR node-build guard stops (1792: 1818; 2560: 2566; 4096: host floor at 3932;
# 4096: cap at 4262 MiB, rustc 3993). From recovery-4096 (reviewed) by counted substitutions. Launch ONLY through
# run-root-6144.sh (unique receipt; the rc is the queue's own exit code) after the reviewed 6144 queue is installed. ROOT-LAUNCHED, FOREGROUND, OFFLINE, existing queue (max 4096, unchanged):
#   R=$M/recovery-6144; python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 6144 --extra-start-mib 2048 \
#     --log $R/logs/resume-1.guard -- env CARGO_BUILD_JOBS=1 RUSTFLAGS='-C link-arg=-Wl,--threads=1' RESUME=1 \
#     unshare -rn bash $R/resume-6144.sh > $R/logs/resume-1.out 2>&1; echo $? > $R/logs/resume-1.rc
# DRY (no compile, cap not enforced): same with --mib 256, RESUME=dry1 DRY=1, logs dry-1.*.
# Validates every frozen input pin and the failed attempt, then runs resume-body.sh = the pinned root-test-m10.sh 51ffbda2
# with counted step-0 substitutions only (make-resume-body.py; re-derived and compared here). The retained build/ (tree,
# control, private cargo home, target) is reused; each phase still does `cargo clean -p <crate>` and requires fresh=false
# exactly as the original. Writes only under recovery-6144/ and (via cargo) build/target; never removes build/ or old logs.
set -uo pipefail
M=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/m10-bootstrap
R=$M/recovery-6144; L=$M/logs
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
pin $R/make-resume-body-6144.py ea8e1ba02eaa351a0094a169ab5f51b5c5c22c1143489b50aad555823ceb6ad8
pin $R/resume-body-6144.sh 6b2538b425ad87bd0e4feb3b56850ca88d128472b2d6f079580c2411bf0bf00b
need "resume-body-6144.sh == make-resume-body-6144.py(root-test-m10.sh)" python3 -I $R/make-resume-body-6144.py --check $M/jobs/root-test-m10.sh $R/resume-body-6144.sh
need "resume-body-6144.sh differs from the reviewed 4096 body 0b0d3de0 only in 3 lines (dirs, echo)" bash -c "[ \"\$(diff $M/recovery-4096/resume-body-4096.sh $R/resume-body-6144.sh | grep -c '^[<>]')\" = 6 ]"
need "from phase() onward resume-body.sh is byte-identical to the original job" bash -c "diff <(sed -n '/^phase()/,\$p' $M/jobs/root-test-m10.sh) <(sed -n '/^phase()/,\$p' $R/resume-body-6144.sh)"
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
echo "== 4096 resume failures (root receipts logs/root-m10-resume4096-2155.* and -2-2215.*, kept, never rewritten)"
R4=$M/recovery-4096
pin $W/root-m10-resume4096-2155.out 865e57b47af5de33102c2843422f1822518dad1cdcb23804d996ccee10c2e522
pin $W/root-m10-resume4096-2155.guard cdbadffe95491d058d61a72d1e012ea75e11f15172326b8cca2cdf9e9350b22f
need "4096 #1 rc 99: FLOOR stop (host MemAvailable 16352 < 16384), node phase not reached OK" bash -c "[ \"\$(cat $W/root-m10-resume4096-2155.rc)\" = 99 ] && grep -q 'STOPPING own job: host MemAvailable 16352 MiB < floor 16384 MiB' $W/root-m10-resume4096-2155.out && ! grep -q '^## node OK' $W/root-m10-resume4096-2155.out"
pin $W/root-m10-resume4096-2-2215.out dee9c0057b6c226f4f885e12295ff23e06f5e075804408fed466536756feb874
pin $W/root-m10-resume4096-2-2215.guard 0658d39e495bcfbf75a4270664f1a4eb75bf0d4438d3788149b44836967dbc87
need "4096 #2 rc 99: CAP stop (tree 4262 > 4096; rustc 3993), node phase not reached OK" bash -c "[ \"\$(cat $W/root-m10-resume4096-2-2215.rc)\" = 99 ] && grep -q 'STOPPING own job: process tree RSS 4262 MiB > 4096 MiB' $W/root-m10-resume4096-2-2215.out && ! grep -q '^## node OK' $W/root-m10-resume4096-2-2215.out"
need "both 4096 runs: engine REBUILT b21d891a, 152 passed, engine OK" bash -c "for f in $W/root-m10-resume4096-2155.out $W/root-m10-resume4096-2-2215.out; do grep -q '^## engine: REBUILT base_consensus_engine-22bbca68e14337e9 sha256 b21d891ac2d82db5526ad6168a9c501ce0d090ab310cf30ad6676f77912ca214$' \$f && grep -q '^test result: ok. 152 passed; 0 failed' \$f && grep -q '^## engine OK$' \$f || exit 1; done"
need "recovery-4096 resume-1.rc and resume-2.rc == 99" bash -c "[ \"\$(cat $R4/logs/resume-1.rc)\" = 99 ] && [ \"\$(cat $R4/logs/resume-2.rc)\" = 99 ]"
need "recovery-4096 per-phase logs run-1 and run-2 unchanged (7 + 7 files)" bash -c "cd $R4/logs && printf '%s\\n' '9c16fcb16e5f7910057f6b02387c44cfc9d13cf19e23a2652844ad0d082b0911  run-1/engine.build.err' '535e1869196dd1ae3637e91e178b1bed76f482c34b61f44d295d9f002326a755  run-1/engine.build.json' '837b3bbff6d7ebe8bf3b5186478dcab9f05b2ab5341e04fcb4116b345179578b  run-1/engine.clean.out' 'c09318e6b146d99d9723d7627f7da380ae4f74c3f705ab087ab68b976637784f  run-1/engine.test.out' '740eab649f83a13cfe9029a51284538e0d912090205161a7fcbd148ea4e3420c  run-1/node.build.err' '97d61df0591d18e1405baf8b64377fe40ec8276899da9f8ab8805d4b0adbdae0  run-1/node.build.json' 'b2ad04d5d853c2be2170a8ce6243a150228ce986e2c503d8224bd964cd38253a  run-1/node.clean.out' 'e18df7a9c23fba40675635269c6b2ae3326e654139246868a30e18ca442fe9cb  run-2/engine.build.err' '69be01af76820a39810149cb4cbdc0cbcbc33c11f34c07c10ce1e669f9c8c215  run-2/engine.build.json' '837b3bbff6d7ebe8bf3b5186478dcab9f05b2ab5341e04fcb4116b345179578b  run-2/engine.clean.out' '727efdf1a0b516c523718303fed7a1a09814d4b078b3d6caf40155c1b8b5a2b9  run-2/engine.test.out' '740eab649f83a13cfe9029a51284538e0d912090205161a7fcbd148ea4e3420c  run-2/node.build.err' 'bba080c1f975ff1aeff7de4d40c5c199c79a7a1ddafc35a47deb23eff286244d  run-2/node.build.json' 'b2ad04d5d853c2be2170a8ce6243a150228ce986e2c503d8224bd964cd38253a  run-2/node.clean.out' | sha256sum -c --quiet - && [ \"\$(ls run-1 | wc -l)\" = 7 ] && [ \"\$(ls run-2 | wc -l)\" = 7 ]"
E=$M/build/target/debug/deps/base_consensus_engine-22bbca68e14337e9
if [ -e "$E" ]; then echo "[info] original engine test binary still present before re-run: $(h $E) (logged b21d891a)"; else echo "[info] original engine test binary no longer present (a resume phase cleaned it)"; fi
if [ "${DRY:-0}" != 1 ]; then
  need "this attempt's logs are new (resume-$RESUME.rc absent)" [ ! -e $R/logs/resume-$RESUME.rc ]
  [ "$RESUME" = 1 ] || need "previous resume-$((RESUME-1)) ended non-zero" bash -c "[ -s $R/logs/resume-$((RESUME-1)).rc ] && [ \"\$(cat $R/logs/resume-$((RESUME-1)).rc)\" != 0 ]"
  cg=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup | head -1)
  need "running under the 6144 MiB allocation (memory.max $(cat $cg/memory.max 2>/dev/null))" [ "$(cat $cg/memory.max 2>/dev/null)" = 6442450944 ]
  avail=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo)
  need "explicit start headroom: MemAvailable $avail MiB >= 16384 floor + 6144 cap + 256 + 2048 extra = 24832 MiB" [ "$avail" -ge 24832 ]
fi
echo "== resume body (root-test-m10.sh 51ffbda2 + counted step-0 substitutions)"
export RESUME
exec bash $R/resume-body-6144.sh
