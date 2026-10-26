#!/bin/bash
# root-guest-capture-runner.sh: HOST side of the guest historical capture (ROOT; PREPARED, NOT run by Claude). Admission is the shared
# host queue with a 4096 MiB reservation, inside a resource window root has coordinated BEFORE any SSH:
#   cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025 && HCAP_RESOURCE_WINDOW=confirmed \
#   python3 -u ../claude-test-queue.py --mib 4096 --log historical-capture-deployment-stage/logs/root-guest-capture.guard -- \
#     bash historical-capture-deployment-stage/jobs/root-guest-capture-runner.sh
# HCAP_RESOURCE_WINDOW=confirmed is root's statement that no other heavy job (KVM lane, paid-full, extraction-adjacent copies, volume
# moves) is scheduled for the window. Before SSH this script also refuses unless: stage sums verify; physical host MemAvailable >= 16 GiB
# floor + 4096; the RPC VM capacity guard (guard-status.json) is `armed` with /vm free above its `start` threshold.
# During the run it samples the PHYSICAL host /proc/meminfo every 5 s; a breach of the 16 GiB floor triggers remote cleanup (stop exactly
# enclave-hcap-<ID>-* via `guest-capture.sh --cleanup <ID>`) and is never a pass. On EVERY exit (success, failure, timeout, INT/TERM/HUP,
# ssh disconnect) it kills its ssh client, runs the remote cleanup and requires it to report no remaining unit.
# The guest's MemoryMax/MemAvailable checks bound the guest only; the host floor is enforced HERE, not by them.
# Exit: run rc kept; 20 host floor breach/precondition; 21 remote cleanup failed or units left; 22 rc 0 without COVERED_ALL_SEGMENTS.
set -uo pipefail
export PATH=/usr/bin:/bin
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
SSH=(ssh -F /home/steven/.local/state/enclave-rpc-production/ssh_config -o ConnectTimeout=10 -o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=4 enclave-rpc)
MEMINFO=/proc/meminfo; GUARD=/home/steven/.local/state/enclave-rpc-production/guard-status.json; POLL=5; GUEST_TIMEOUT=43200
FLOOR_MIB=16384; RESERVE_MIB=4096
if [ -n "${HCAP_RUNNER_TEST_SSH:-}" ]; then                     # OFFLINE TESTS ONLY: fakes must live under the test's tmp
  for v in "$HCAP_RUNNER_TEST_SSH" "${HCAP_RUNNER_TEST_MEMINFO:?}" "${HCAP_RUNNER_TEST_GUARD:?}"; do
    [[ $v == /tmp/* || $v == "${TMPDIR:-/nonexistent}"/* ]] || { echo "## SETUP: test override outside tmp"; exit 20; }; done
  SSH=("$HCAP_RUNNER_TEST_SSH"); MEMINFO=$HCAP_RUNNER_TEST_MEMINFO; GUARD=$HCAP_RUNNER_TEST_GUARD; POLL=1; GUEST_TIMEOUT=${HCAP_RUNNER_TEST_TIMEOUT:-60}
fi
ID=""; OUT=""; WD=""; CH=""; DONE=0; STARTED=0
die() { echo "## REFUSED: $*"; exit 20; }
hostavail() { awk '/^MemAvailable:/{print int($2/1024)}' "$MEMINFO" 2>/dev/null; }
remote_cleanup() { timeout 90 "${SSH[@]}" "sudo -n $B/bin/guest-capture.sh --cleanup $ID"; }
host_sample() { local a; a=$(hostavail); echo "$(date -u +%s) ${a:-unreadable} $1" >> "$OUT/host-memavail.txt"
  if [ -z "$a" ] || [ "$a" -lt $FLOOR_MIB ]; then echo "FLOOR BREACH ${a:-unreadable} MiB $1" >> "$OUT/floor.txt"; remote_cleanup >> "$OUT/floor.txt" 2>&1
    [ -s "$OUT/ssh.pid" ] && kill "$(cat "$OUT/ssh.pid")" 2>/dev/null; fi; return 0; }
on_exit() {
  local rc=$? cfail=0; [ $DONE = 1 ] && return; DONE=1
  [ -n "$WD" ] && { rm -f "$OUT/sampling"; kill "$WD" 2>/dev/null; wait "$WD" 2>/dev/null; }
  [ -n "$CH" ] && { kill "$CH" 2>/dev/null; wait "$CH" 2>/dev/null; }
  if [ $STARTED = 1 ]; then
    remote_cleanup > "$OUT/cleanup.out" 2>&1 || cfail=1
    grep -qx "clean $ID" "$OUT/cleanup.out" || cfail=1
  fi
  if [ -n "$OUT" ] && [ -e "$OUT/floor.txt" ]; then rc=20; fi                     # a breach is never a pass, whatever the run said
  if [ $cfail = 1 ]; then rc=21; fi                                                  # units may be left: the strongest signal
  if [ $rc = 0 ] && ! grep -q 'COVERED_ALL_SEGMENTS' "$OUT/guest.out" 2>/dev/null; then rc=22; fi
  echo "## guest-capture run=$ID rc=$rc cleanupFailed=$cfail floorBreach=$([ -n "$OUT" ] && [ -e "$OUT/floor.txt" ] && echo yes || echo no)"
  exit $rc; }
trap on_exit EXIT; trap 'exit 130' INT; trap 'exit 143' TERM; trap 'exit 129' HUP
# ---- admission before any SSH ----
[ "${HCAP_RESOURCE_WINDOW:-}" = confirmed ] || die "HCAP_RESOURCE_WINDOW=confirmed not given (coordinate the resource window first)"
bash "$S/tools/freeze.sh" --check > /dev/null || die "stage != SHA256SUMS"
BID=$(sha256sum < "$S/bundle/MANIFEST.json" | cut -c1-64); B=/opt/enclave-rpc/historical-capture/$BID
a=$(hostavail); [ -n "$a" ] && [ "$a" -ge $((FLOOR_MIB + RESERVE_MIB)) ] || die "host MemAvailable ${a:-?} MiB < floor $FLOOR_MIB + $RESERVE_MIB"
python3 -I - "$GUARD" <<'PY' || die "RPC VM capacity guard not armed or /vm below its start threshold"
import json, sys
g = json.load(open(sys.argv[1])); t = g['thresholds']['nvme']
assert g['state'] == 'armed' and not g.get('reasons') and g['free']['nvme'] > t['start'], g
PY
ID=$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n'); OUT=${HCAP_OUT_ROOT:-$S/logs}/guest-run-$ID; mkdir -p -m 0700 "$OUT" || die "out"
echo "run $ID bundle $BID host MemAvailable $a MiB" | tee "$OUT/admission.txt"
# ---- remote bundle identity (read-only) ----
STARTED=1
timeout 60 "${SSH[@]}" "sudo -n $B/bin/historical-capture verify" > "$OUT/remote-verify.json" 2>&1 || die "bundle $BID not installed/verified on the guest"
grep -q "\"bundleId\": \"$BID\"" "$OUT/remote-verify.json" || die "remote bundle id differs"
# ---- run with watchdog ----
host_sample start; touch "$OUT/sampling"
( while [ -e "$OUT/sampling" ]; do sleep "$POLL"; [ -e "$OUT/sampling" ] && host_sample periodic; done ) & WD=$!
timeout -k 30 "$GUEST_TIMEOUT" "${SSH[@]}" "sudo -n $B/bin/guest-capture.sh --run-id $ID" > "$OUT/guest.out" 2>&1 < /dev/null & CH=$!
echo "$CH" > "$OUT/ssh.pid"
rc=0; wait "$CH" || rc=$?; CH=""
host_sample end; rm -f "$OUT/sampling"; kill "$WD" 2>/dev/null; wait "$WD" 2>/dev/null; WD=""
tail -5 "$OUT/guest.out"
exit $rc
