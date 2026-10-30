#!/bin/bash
# GUEST launcher (root, FOREGROUND, ONE attempt): bash run-guest.sh <attempt 1-9> <MANIFEST.sha256 sha256>
# Runs m10-guest-test.sh as the dedicated user m10build in a transient systemd unit (MemoryMax 12G, no swap, CPUQuota 200%,
# Nice 10, private network, read-only system, writable ONLY in its run directory; RuntimeMaxSec/TimeoutStartSec 3h,
# KillMode=control-group, TimeoutStopSec 30 so nothing detached survives a cancel), inside the copied general memory guard
# (tree cap 12288 MiB, guest MemAvailable floor 16384 MiB) and the disk guard (root-disk floor 8192 MiB). Each guard stops
# ONLY this job's own tree/unit; nothing is deleted. The receipt (root-owned, outside the run dir) records the real exit
# code from `systemd-run --wait` and the unit result; zero ignored tests is required in addition to the job's own rc.
# NOT implemented here (root's OUTER launcher): the host 16 GiB floor guard and cleanup after an SSH disconnect.
set -uo pipefail
BASE=/srv/m10-guest-validation; S=$BASE/stage; N=${1:-}; WANT=${2:-}
[[ "$N" =~ ^[1-9]$ ]] && [[ "$WANT" =~ ^[0-9a-f]{64}$ ]] || { echo "## REFUSED: usage run-guest.sh <1-9> <manifest-sha256>"; exit 2; }
RUN=$BASE/runs/run-$N; R=$BASE/receipts; U=m10-guest-validation-$N
[ "$(id -u)" = 0 ] || { echo "## REFUSED: run as root"; exit 2; }
for p in $RUN $R/run-$N.out $R/run-$N.rc $R/run-$N.receipt.json $R/run-$N.preflight.out; do [ ! -e $p ] || { echo "## REFUSED: $p exists"; exit 2; }; done
install -d -m 0755 $R
bash $S/runner/verify-stage.sh $S $WANT > $R/run-$N.preflight.out 2>&1 || { cat $R/run-$N.preflight.out; echo "## REFUSED: preflight failed"; echo 2 > $R/run-$N.rc; exit 2; }
install -d -o m10build -g m10build -m 0750 $RUN $RUN/home
S0=$(date -u +%FT%TZ)
systemd-run --unit=$U --uid=m10build --gid=m10build --wait --pipe --quiet \
  -p MemoryMax=12G -p MemorySwapMax=0 -p CPUQuota=200% -p Nice=10 -p PrivateNetwork=yes -p PrivateTmp=yes \
  -p RuntimeMaxSec=3h -p TimeoutStartSec=3h -p KillMode=control-group -p TimeoutStopSec=30 \
  -p NoNewPrivileges=yes -p ProtectSystem=strict -p ProtectHome=yes -p ReadWritePaths=$RUN -p WorkingDirectory=$RUN \
  -E M10_STAGE=$S -E M10_RUN=$RUN -E HOME=$RUN/home -E LANG=C.UTF-8 -E CARGO_BUILD_JOBS=1 -E "RUSTFLAGS=-C link-arg=-Wl,--threads=1" \
  -- /usr/bin/node $S/runner/memory-guard.mjs --max-rss-mib 12288 --floor-available-mib 16384 --log $RUN/memory-guard.log -- \
     /usr/bin/python3 -I $S/runner/disk-guard.py --path $RUN --floor-mib 8192 --log $RUN/disk-guard.log -- \
     /bin/bash $S/runner/m10-guest-test.sh > $R/run-$N.out 2>&1
rc=$?
printf '%s\n' "$rc" > $R/run-$N.rc
UNIT=$(systemctl show $U -p Result -p ExecMainCode -p ExecMainStatus -p MemoryPeak 2>/dev/null | tr '\n' ' '); systemctl reset-failed $U 2>/dev/null || true
python3 -I - "$R" "$N" "$rc" "$S0" "$(date -u +%FT%TZ)" "$WANT" "$UNIT" "$RUN" > $R/run-$N.receipt.json <<'PY'
import glob, hashlib, json, pathlib, re, sys
r, n, rc, s0, s1, want, unit, run = sys.argv[1:]; r = pathlib.Path(r)
out = (r / f"run-{n}.out").read_text(errors="replace")
res = [l for f in sorted(glob.glob(f"{run}/logs/*.test.out")) for l in pathlib.Path(f).read_text(errors="replace").splitlines() if l.startswith("test result:")]
ign = sum(int(m.group(1)) for l in res for m in [re.search(r"(\d+) ignored", l)] if m)
agg = next((l for l in out.splitlines() if l.startswith("## aggregate rc=")), None)
print(json.dumps({"attempt": int(n), "systemdRunExit": int(rc), "unit": unit, "start": s0, "end": s1, "stageManifestSha256": want,
                  "outSha256": hashlib.sha256((r / f"run-{n}.out").read_bytes()).hexdigest(), "aggregateLine": agg,
                  "testResultLines": len(res), "ignoredTotal": ign,
                  "guardLines": [l for l in out.splitlines() if l.startswith(("[memory-guard]", "[disk-guard]"))],
                  "pass": int(rc) == 0 and agg == "## aggregate rc=0" and ign == 0 and len(res) > 0}, indent=1))
PY
P=$(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))["pass"])' $R/run-$N.receipt.json)
echo "## guest attempt $N: systemd-run exit $rc, pass=$P (receipt $R/run-$N.receipt.json)"
[ "$P" = True ] && exit 0; [ "$rc" != 0 ] && exit $rc; exit 1
