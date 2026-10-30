#!/bin/bash
# bootstrap-systemd-canary-stage/r5 HOST-SIDE runner (PREPARED, NOT run by Claude). ROOT runs it through the shared queue (host floor):
#   cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025 && \
#   python3 -u ../claude-test-queue.py --mib 512 --log bootstrap-systemd-canary-stage/r5/logs/root-systemd-canary.guard -- bash bootstrap-systemd-canary-stage/r5/jobs/root-systemd-canary.sh
# Derived from guest-original-game-canary-stage/jobs/root-original-game-canary.sh: assembly from the FILLED FINAL-PINS (refuses while null),
# bounded uploads, the guest script over ssh with a hard timeout, a HOST /proc/meminfo watchdog (the physical 16 GiB floor; the guest's
# own reserve is the guest script's separate check) that stops ONLY this run's transient guest units enclave-sdcanary-<ID>-*.service
# (never the VM, never a production unit), and on EVERY exit (incl. a partial setup): stop own units, fetch result/diagnostics, run the
# owned guest cleanup, write HOST-VERDICT.json (pass needs: guest verdict pass + rc 0 + >= 2 host samples all >= floor + no breach).
# r3: the PROCESS exit is that combined result: an original failure is kept (never masked); a guest rc 0 still exits non-zero when the
# validated host verdict is not pass (22) or the owned stop/cleanup failed (21).
set -uo pipefail
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
FLOOR_MIB=16384; MEMINFO=/proc/meminfo; POLL=5; GUEST_TIMEOUT=2400; MAX_UPLOAD=$((16 << 20))
SSH=(ssh -F /home/steven/.local/state/enclave-rpc-production/ssh_config -o ConnectTimeout=10 -o BatchMode=yes enclave-rpc)
if [ -n "${SDC_TEST_FAKE_SSH:-}" ]; then                         # OFFLINE TESTS ONLY: a fake ssh + a fake meminfo under the test's tmp dir
  [[ $SDC_TEST_FAKE_SSH == /tmp/* || $SDC_TEST_FAKE_SSH == ${TMPDIR:-/nonexistent}/* ]] || { echo "## SETUP: test overrides outside tmp"; exit 20; }
  SSH=("$SDC_TEST_FAKE_SSH"); MEMINFO=${SDC_TEST_MEMINFO:-/proc/meminfo}; POLL=${SDC_TEST_POLL:-1}; GUEST_TIMEOUT=${SDC_TEST_GUEST_TIMEOUT:-60}
fi
ID=""; STAGED=0; DONE=0; WD=""; OUT=""
die() { echo "## SETUP: $*"; exit 20; }
hostavail() { awk '/^MemAvailable:/{print int($2/1024)}' "$MEMINFO"; }
host_sample() {                                                # r5: one REAL reading, tagged (start | periodic | end); a breach stops own units
  local a; a=$(hostavail); echo "$(date -u +%s) ${a:-unreadable} $1" >> "$OUT/host-memavail.txt"
  if [ -z "$a" ] || [ "$a" -lt $FLOOR_MIB ]; then echo "FLOOR BREACH ${a:-unreadable} MiB $1 $(date -u +%FT%TZ)" >> "$OUT/floor.txt"; stop_own >> "$OUT/floor.txt" 2>&1; fi; }
stop_own() { timeout 30 "${SSH[@]}" "sudo -n systemctl stop 'enclave-sdcanary-$ID-*.service'"; }
stop_watchdog() { [ -n "$WD" ] || return 0; rm -f "$OUT/sampling"; kill "$WD" 2>/dev/null; wait "$WD" 2>/dev/null; WD=""; }
cleanup() {
  local rc=$? cfail=0 hv=1; [ $DONE = 1 ] && return; DONE=1
  stop_watchdog
  if [ $STAGED = 1 ]; then
    stop_own > "$OUT/stop-own.out" 2>&1 || cfail=1
    [ -s "$OUT/result.tar" ] || timeout 120 "${SSH[@]}" "sudo -n cat /run/enclave-sdcanary-$ID/result.tar" > "$OUT/result.tar" 2>/dev/null || rm -f "$OUT/result.tar"
    timeout 120 "${SSH[@]}" "sudo -n sh -c 'ls -la /run/enclave-sdcanary-in-$ID /run/enclave-sdcanary-$ID 2>&1; [ -d /run/enclave-sdcanary-$ID/out ] && tar -C /run/enclave-sdcanary-$ID -cf - out 2>/dev/null | base64 -w0 | head -c 4000000; true'" > "$OUT/diagnostics.txt" 2>&1
    timeout 120 "${SSH[@]}" "sudo -n bash -s $ID" < "$S/guest/cleanup.sh" > "$OUT/cleanup.out" 2>&1 || { cfail=1; echo "## CLEANUP FAILED: see $OUT/cleanup.out (manual: guest/cleanup.sh $ID)"; }
  fi
  if [ -n "$OUT" ] && [ -d "$OUT" ]; then                       # validated: exit 0 AND the written JSON says pass true
    /usr/bin/python3 -I "$S/tools/host_verdict.py" "$OUT" "$rc" "$FLOOR_MIB" > "$OUT/HOST-VERDICT.json" 2>&1 \
      && /usr/bin/python3 -I -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])).get("pass") is True else 1)' "$OUT/HOST-VERDICT.json" && hv=0
    cat "$OUT/HOST-VERDICT.json"
  fi
  local final=$rc
  if [ "$final" = 0 ]; then [ $cfail = 0 ] || final=21; [ "$final" = 0 ] && [ $hv != 0 ] && final=22; fi
  echo "## systemd-canary-host rc=$final (run rc=$rc cleanupFailed=$cfail hostVerdictPass=$([ $hv = 0 ] && echo true || echo false))"
  exit "$final"; }
trap cleanup EXIT; trap 'exit 130' INT; trap 'exit 143' TERM
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || die "canary r2 != SHA256SUMS (FINAL-PINS filled after the freeze require a re-freeze)"
a=$(hostavail); [ -n "$a" ] && [ "$a" -ge $((FLOOR_MIB + 512)) ] || die "host MemAvailable ${a:-?} MiB < floor + canary bound"
ID=$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n'); OUT=${SDC_OUT_ROOT:-$S/logs}/run-$ID
mkdir -p -m 0700 "$OUT" || die "out"
/usr/bin/python3 -I "$S/tools/assemble_canary_bundle.py" "$OUT/upload" > "$OUT/assemble.json" 2>&1 || die "assembly refused (FINAL-PINS null until r13-final qualifies; see assemble.json)"
for f in bundle.tar BUNDLE.sha256 FINAL-PINS.json; do s=$(stat -c %s "$OUT/upload/$f") && [ "$s" -le $MAX_UPLOAD ] || die "upload $f missing or > $MAX_UPLOAD bytes"; done
timeout 60 "${SSH[@]}" "sudo -n install -d -m 0700 /run/enclave-sdcanary-in-$ID" || die "guest staging dir"; STAGED=1
up() { timeout 120 "${SSH[@]}" "sudo -n tee /run/enclave-sdcanary-in-$ID/$1 > /dev/null" < "$OUT/upload/$1" > /dev/null || die "upload $1"; }
up bundle.tar; up BUNDLE.sha256; up FINAL-PINS.json
host_sample start                                              # r5: a real START reading (a fast guest may finish before the 1st period)
touch "$OUT/sampling"                                           # BEFORE the watchdog starts: it can never see a missing flag and exit early
( while [ -e "$OUT/sampling" ]; do sleep "$POLL"; [ -e "$OUT/sampling" ] && host_sample periodic; done ) & WD=$!
timeout -k 30 "$GUEST_TIMEOUT" "${SSH[@]}" "sudo -n bash -s $ID" < "$S/guest/systemd_canary.sh" > "$OUT/guest.out" 2>&1; rc=$?
host_sample end                                                 # r5: a real END reading after the guest returned
stop_watchdog
timeout 120 "${SSH[@]}" "sudo -n cat /run/enclave-sdcanary-$ID/result.tar" > "$OUT/result.tar" 2>/dev/null && mkdir -m 0700 "$OUT/result" && tar -C "$OUT/result" -xf "$OUT/result.tar" || rm -f "$OUT/result.tar"
[ -e "$OUT/floor.txt" ] && { echo "## host floor breached: own units stopped (NOT a verdict)"; [ $rc = 0 ] && rc=20; }
exit $rc
