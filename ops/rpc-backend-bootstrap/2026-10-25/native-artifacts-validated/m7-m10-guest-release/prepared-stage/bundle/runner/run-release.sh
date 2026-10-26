#!/bin/bash
# GUEST launcher (root, FOREGROUND, ONE attempt) for the combined M7+M10 release build:
#   bash run-release.sh <N 1-9> <RELEASE_MANIFEST_SHA> <CHILD_N> <COMPOUND_SHA> <LAUNCHER_SHA> <CHILD_OUT_SHA> <SUPPLEMENT_MANIFEST_SHA>
# (the CLI-child compound evidence pins, computed by root from the files it collected; run 2's original receipt stays pass:false)
# Same isolation as the reviewed run-guest.sh (b67fcec1): user m10build, MemoryMax 12G, no swap, CPUQuota 200%, Nice 10, private
# network, read-only system, KillMode=control-group, TimeoutStopSec 30; copied memory guard (12288 / guest floor 16384) and disk
# guard (8192). Writable ONLY: release/run-N and the run-1 cargo home (source extraction). RuntimeMaxSec 6h30min (a release
# build, single job, is longer than a test run; the job's own cargo timeout is 6h). Receipt records the real exit code.
# NOT implemented here (root's OUTER launcher): the host 16 GiB floor guard and SSH-disconnect cleanup.
set -uo pipefail
BASE=/srv/m10-guest-validation; S=$BASE/stage-release-1; OLD=$BASE/stage; CACHE=$BASE/runs/run-1/build; RUN2=$BASE/runs/run-2
N=${1:-}; WANT=${2:-}; CN=${3:-}; CC=${4:-}; CL=${5:-}; CO=${6:-}; CS=${7:-}
[[ "$N" =~ ^[1-9]$ ]] && [[ "$CN" =~ ^[1-9]$ ]] && for x in "$WANT" "$CC" "$CL" "$CO" "$CS"; do [[ "$x" =~ ^[0-9a-f]{64}$ ]] || { echo "## REFUSED: usage run-release.sh <1-9> <manifest> <child-N> <compound> <launcher> <child-out> <supplement-manifest> (sha256 each)"; exit 2; }; done || { echo "## REFUSED: attempt and child attempt must be 1-9"; exit 2; }
REL=$BASE/release/run-$N; R=$BASE/receipts; U=m7-m10-release-$N
[ "$(id -u)" = 0 ] || { echo "## REFUSED: run as root"; exit 2; }
for p in $REL $R/release-$N.out $R/release-$N.rc $R/release-$N.receipt.json $R/release-$N.preflight.out $R/release-$N.compound-gate.json; do [ ! -e $p ] || { echo "## REFUSED: $p exists"; exit 2; }; done
bash $S/runner/verify-stage-release.sh $S $WANT $N $CN $CC $CL $CO $CS > $R/release-$N.preflight.out 2>&1 || { cat $R/release-$N.preflight.out; echo "## REFUSED: preflight failed"; echo 2 > $R/release-$N.rc; exit 2; }
python3 -I $S/runner/check-compound-gate.py --child-stage $BASE/stage-cli-child --receipts $R --run2-logs $BASE/runs/run-2/logs --supplement $BASE/supplement/cli-child-$CN/work/out --attempt $CN --compound-sha $CC --launcher-sha $CL --child-out-sha $CO --supplement-manifest-sha $CS > $R/release-$N.compound-gate.json || { cat $R/release-$N.compound-gate.json; echo 2 > $R/release-$N.rc; exit 2; }
install -d -m 0755 $BASE/release; install -d -o m10build -g m10build -m 0750 $REL; install -m 0444 $R/release-$N.compound-gate.json $REL/compound-gate.json
S0=$(date -u +%FT%TZ)
systemd-run --unit=$U --uid=m10build --gid=m10build --wait --pipe --quiet \
  -p MemoryMax=12G -p MemorySwapMax=0 -p CPUQuota=200% -p Nice=10 -p PrivateNetwork=yes -p PrivateTmp=yes \
  -p RuntimeMaxSec=6h30min -p TimeoutStartSec=6h30min -p KillMode=control-group -p TimeoutStopSec=30 \
  -p NoNewPrivileges=yes -p ProtectSystem=strict -p ProtectHome=yes -p "ReadWritePaths=$REL $CACHE/cargo-home" -p WorkingDirectory=$REL \
  -E M10_STAGE=$S -E M10_OLD_STAGE=$OLD -E M10_CACHE=$CACHE -E M10_RUN2=$RUN2 -E M10_REL=$REL -E HOME=$REL -E LANG=C.UTF-8 \
  -- /usr/bin/node $S/runner/memory-guard.mjs --max-rss-mib 12288 --floor-available-mib 16384 --log $REL/memory-guard.log -- \
     /usr/bin/python3 -I $S/runner/disk-guard.py --path $REL --floor-mib 8192 --log $REL/disk-guard.log -- \
     /bin/bash $S/runner/release-job.sh > $R/release-$N.out 2>&1
rc=$?
printf '%s\n' "$rc" > $R/release-$N.rc
UNIT=$(systemctl show $U -p Result -p ExecMainCode -p ExecMainStatus -p MemoryPeak 2>/dev/null | tr '\n' ' '); systemctl reset-failed $U 2>/dev/null || true
python3 -I - "$R" "$N" "$rc" "$S0" "$(date -u +%FT%TZ)" "$WANT" "$UNIT" "$REL" > $R/release-$N.receipt.json <<'PY'
import hashlib, json, pathlib, re, sys
r, n, rc, s0, s1, want, unit, rel = sys.argv[1:]; r = pathlib.Path(r); out = (r / f"release-{n}.out").read_text(errors="replace")
art = next((m.group(1) for l in out.splitlines() for m in [re.match(r"\[artifact\] ([0-9a-f]{64})  base  ", l)] if m), None)
sums = pathlib.Path(rel, "out/SHA256SUMS"); final = "## rc=0 (ONE combined M7+M10 release build; tree == run-2 tested tree; NOT an independent reproduction)"
print(json.dumps({"attempt": int(n), "systemdRunExit": int(rc), "unit": unit, "start": s0, "end": s1, "releaseStageManifestSha256": want,
                  "outSha256": hashlib.sha256((r / f"release-{n}.out").read_bytes()).hexdigest(), "artifactSha256": art,
                  "outDirSha256sums": hashlib.sha256(sums.read_bytes()).hexdigest() if sums.exists() else None,
                  "compoundGateSha256": hashlib.sha256((r / f"release-{n}.compound-gate.json").read_bytes()).hexdigest(),
                  "guardLines": [l for l in out.splitlines() if l.startswith(("[memory-guard]", "[disk-guard]"))],
                  "pass": int(rc) == 0 and final in out.splitlines() and art is not None and sums.exists()}, indent=1))
PY
P=$(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))["pass"])' $R/release-$N.receipt.json)
echo "## release attempt $N: systemd-run exit $rc, pass=$P (receipt $R/release-$N.receipt.json)"
[ "$P" = True ] && exit 0; [ "$rc" != 0 ] && exit $rc; exit 1
