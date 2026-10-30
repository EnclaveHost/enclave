#!/bin/bash
# Guest A1 call-timeout diagnostic r3 (host side; PREPARED, NOT run by Claude). r1 and r2 frozen and untouched. r3 = r2 + fixed probes
# (el_probe empty-params crash, incremental flush, complete flag) + stricter status.py; REFUSES unless jobs/root-probe-fixture-tests.sh
# has a PASS RESULT for these exact r3 bytes.
# ROOT runs it through the shared queue (host floor 16 GiB; claim 768 MiB >= guest aggregate 640 MiB = Helios 512 + relay 128):
#   python3 -u ../claude-test-queue.py --mib 768 --log guest-call-timeout-diagnostic-stage/r3/logs/root-guest-call-diagnostic-r3.guard -- bash guest-call-timeout-diagnostic-stage/r3/jobs/root-guest-call-diagnostic-r3.sh
# Q=400 comparison runs ONLY with DIAG_VARIANTS="100 400" (root coordinates it with the KVM owner first); default "100".
# Bytes: the FROZEN canary r3 bundle (r3's own assembler + R10 pins), pinned checkpoint 2e8502e6, r1's probes (byte-identical).
# Result rc: 0 every requested phase complete + invariants hold; 10 incomplete; 20 setup or host-floor stop; 30 invariant violation
# (production PIDs changed / own listener left bound / PIDs never re-checked); 40 cleanup failed. PUBLIC-STATUS.json says which.
# These are DIAGNOSTIC OBSERVATIONS, never a capture, readiness or finality verdict.
set -uo pipefail
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; S=$P/guest-call-timeout-diagnostic-stage/r3; R3=$P/guest-capture-canary-stage/r3
CK=/home/steven/Documents/Codex/2026-10-18/wo/outputs/rpc-production-final-20261025/l1-authority-live-1941/checkpoint.json
SSH=(ssh -F /home/steven/.local/state/enclave-rpc-production/ssh_config -o ConnectTimeout=10 -o BatchMode=yes enclave-rpc)
V=${DIAG_VARIANTS:-100}; ID=""; STAGED=0; DONE=0; WD=""; OUT=""; GRC=""; FLOOR=0
die() { echo "## SETUP: $*"; exit 20; }
stopall() { timeout 60 "${SSH[@]}" "sudo -n sh -c 'touch /run/enclave-diag-$ID/abort; for u in el h100 h400 px100 px400; do systemctl stop enclave-a1-diag-$ID-\$u.scope 2>/dev/null; done; true'"; }
fetch() { timeout 180 "${SSH[@]}" "sudo -n cat /run/enclave-diag-$ID/result.tar" > $OUT/result.tar.new 2>/dev/null && [ -s $OUT/result.tar.new ] \
            && mv -f $OUT/result.tar.new $OUT/result.tar || rm -f $OUT/result.tar.new; }
finish() {
  local rc=$?; [ $DONE = 1 ] && return; DONE=1; local sc=-1 dc=-1
  [ -n "$WD" ] && { kill $WD 2>/dev/null; wait $WD 2>/dev/null; }
  [ -e "$OUT/floor.txt" ] && FLOOR=1
  if [ $STAGED = 1 ]; then
    fetch                                                                   # evidence first (whatever the rolling snapshot holds)
    timeout 180 "${SSH[@]}" "sudo -n bash -s stop-collect $ID" < $S/guest/cleanup.sh > $OUT/stop-collect.out 2>&1; sc=$?
    fetch                                                                   # re-fetch after own processes stopped + PIDs re-checked
    if [ $sc = 0 ]; then timeout 120 "${SSH[@]}" "sudo -n bash -s delete $ID" < $S/guest/cleanup.sh > $OUT/delete.out 2>&1; dc=$?
    else echo "## own processes not confirmed stopped: owned paths NOT deleted (see $OUT/stop-collect.out; manual: guest/cleanup.sh stop-collect|delete $ID)"; fi
  fi
  local st=""; if [ -s "$OUT/result.tar" ]; then rm -rf $OUT/result; mkdir -m 0700 $OUT/result && tar -C $OUT/result -xf $OUT/result.tar \
      && python3 -I $S/tools/status.py $OUT/result/out "$V" > $OUT/status.out 2>&1; st=$?; fi
  local final verdict
  if [ -z "$OUT" ] || [ $STAGED = 0 ]; then final=$rc; verdict=setup
  elif [ $FLOOR = 1 ]; then final=20; verdict=stopped-host-floor
  elif [ "$st" = 30 ] || [ "$GRC" = 30 ]; then final=30; verdict=invariant-violation
  elif [ $sc != 0 ] || [ $dc != 0 ]; then final=40; verdict=cleanup-failed
  elif [ "$st" = 0 ] && [ "$GRC" = 0 ]; then final=0; verdict=complete
  else final=10; verdict=incomplete; fi
  if [ -n "$OUT" ] && [ -d "$OUT" ]; then python3 -I - "$OUT" "$verdict" "${GRC:-none}" "$sc" "$dc" "$FLOOR" <<'PY' > $OUT/PUBLIC-STATUS.json
import json, pathlib, sys
o, verdict, grc, sc, dc, floor = sys.argv[1:]; p = pathlib.Path(o) / 'result/out/status.json'
print(json.dumps({'run': pathlib.Path(o).name, 'verdict': verdict, 'kind': 'diagnostic observations only; NOT a capture, readiness or finality verdict',
                  'guestRc': grc, 'stopCollectRc': int(sc), 'deleteRc': int(dc), 'hostFloorBreach': floor == '1',
                  'status': json.loads(p.read_text()) if p.exists() else None}, indent=1))
PY
    cat $OUT/PUBLIC-STATUS.json; fi
  echo "## guest-diag r3 rc=$final ($verdict)"; exit $final; }
trap finish EXIT; trap 'exit 130' INT; trap 'exit 143' TERM
[ "$V" = 100 ] || [ "$V" = "100 400" ] || die "DIAG_VARIANTS must be '100' or '100 400'"
(cd $S && sha256sum -c --quiet SHA256SUMS) || die "diagnostic r3 != SHA256SUMS"
G=$(ls -1 $S/logs/probe-fixture-*/RESULT 2>/dev/null | sort | tail -1)
[ -n "$G" ] && grep -qx "PASS probe-fixture Ran 7 r3-sums $(sha256sum < $S/SHA256SUMS | cut -c1-64)" "$G" || die "no passing probe-fixture RESULT for these exact r3 bytes (run jobs/root-probe-fixture-tests.sh first)"
[ "$(sha256sum < $R3/SHA256SUMS | cut -c1-64)" = 9367c877519d4e34867461ebbea9aafcd478109b1d77557d01d8c060eb67c882 ] || die "canary r3 is not the frozen 9367c877"
(cd $R3 && sha256sum -c --quiet SHA256SUMS) || die "canary r3 changed"
[ "$(sha256sum < "$CK" | cut -c1-64)" = 2e8502e68864abb49a230a69612bd7c98c94775d8dd81f956a0185d53652ac33 ] || die "checkpoint is not the pinned 2e8502e6"
ID=$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n'); OUT=$S/logs/run-$ID; mkdir -p -m 0700 $OUT || die out
python3 -I $R3/tools/assemble_canary_bundle.py $OUT > $OUT/assemble.json || die "r3 bundle assembly"
tar -C $OUT -cf $OUT/bundle.tar bundle && rm -rf $OUT/bundle
timeout 60 "${SSH[@]}" "sudo -n install -d -m 0700 /run/enclave-diag-$ID" || die "guest staging dir"; STAGED=1
up() { timeout 600 "${SSH[@]}" "sudo -n tee /run/enclave-diag-$ID/$2 > /dev/null" < "$1" || die "upload $2"; }
up $OUT/bundle.tar bundle.tar; up $OUT/BUNDLE.sha256 BUNDLE.sha256; up $OUT/HELIOS.txt HELIOS.txt; up "$CK" checkpoint.json
for f in el_probe.mjs helios_probe.mjs rpc_log_proxy.py; do up $S/guest/$f $f; done; up $S/tools/status.py status.py
( while sleep 5; do a=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo); if [ "$a" -lt 16384 ]; then echo "FLOOR BREACH $a MiB $(date -u +%FT%TZ)" >> $OUT/floor.txt; stopall; fi; done ) & WD=$!
T=3000; [ "$V" = "100 400" ] && T=5000
timeout -k 30 $T "${SSH[@]}" "sudo -n bash -s $ID '$V'" < $S/guest/diag.sh > $OUT/guest.out 2>&1; GRC=$?
tail -12 $OUT/guest.out
exit $GRC
