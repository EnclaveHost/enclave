#!/bin/bash
# root-guest-smoke-runner.sh: HOST side of the guest runtime smoke (ROOT; PREPARED, NOT run by Claude). Root, inside the authorized KVM
# window, through the shared queue with a 1024 MiB reservation:
#   cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025 && \
#   python3 -u ../claude-test-queue.py --mib 1024 --log guest-capture-smoke-stage/logs/root-guest-smoke.guard -- \
#     bash guest-capture-smoke-stage/jobs/root-guest-smoke-runner.sh
# Before SSH: stage sums verify; the kit's bundle copy is byte+mode identical to the frozen bundle 020cc8bf (capture stage 7f3fb478);
# PHYSICAL host MemAvailable >= 16 GiB floor + 1024. During the run the host /proc/meminfo is sampled every 5 s; a floor breach stops the
# guest units + removes the kit (remote cleanup) and is never a pass. On EVERY exit the ssh client is killed and the remote cleanup must
# report `clean <ID>` (no enclave-hsmoke-<ID>-* unit, no /var/lib/enclave-rpc/hcap-smoke/<ID>). Nothing else on the guest is touched:
# no production DB, no production bundle write, no service start/stop/restart, no mount in the guest's own namespace.
# Exit: 0 SMOKE PASS + clean; 1 smoke failed; 20 floor breach/precondition; 21 cleanup failed/units or kit left; 22 rc 0 without SMOKE PASS.
set -uo pipefail
export PATH=/usr/bin:/bin
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
W=$(dirname "$S"); CAP=$W/historical-capture-deployment-stage
SSH=(ssh -F /home/steven/.local/state/enclave-rpc-production/ssh_config -o ConnectTimeout=10 -o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=4 enclave-rpc)
MEMINFO=/proc/meminfo; FLOOR_MIB=16384; RESERVE_MIB=1024; POLL=5; GUEST_TIMEOUT=900
ID=""; OUT=""; WD=""; CH=""; DONE=0; STARTED=0
die() { echo "## REFUSED: $*"; exit 20; }
hostavail() { awk '/^MemAvailable:/{print int($2/1024)}' "$MEMINFO" 2>/dev/null; }
remote_cleanup() { timeout 90 "${SSH[@]}" "sudo -n /bin/bash -c 'systemctl stop \"enclave-hsmoke-$ID-*\" 2>/dev/null; systemctl reset-failed \"enclave-hsmoke-$ID-*\" 2>/dev/null; rm -rf --one-file-system /var/lib/enclave-rpc/hcap-smoke/$ID; if systemctl list-units --all --plain --no-legend \"enclave-hsmoke-$ID-*\" | grep -q . || [ -e /var/lib/enclave-rpc/hcap-smoke/$ID ]; then echo LEFT; exit 21; fi; echo clean $ID'"; }
host_sample() { local a; a=$(hostavail); echo "$(date -u +%s) ${a:-unreadable} $1" >> "$OUT/host-memavail.txt"
  if [ -z "$a" ] || [ "$a" -lt $FLOOR_MIB ]; then echo "FLOOR BREACH ${a:-unreadable} MiB $1" >> "$OUT/floor.txt"; remote_cleanup >> "$OUT/floor.txt" 2>&1
    [ -s "$OUT/ssh.pid" ] && kill "$(cat "$OUT/ssh.pid")" 2>/dev/null; fi; return 0; }
on_exit() {
  local rc=$? cfail=0; [ $DONE = 1 ] && return; DONE=1
  [ -n "$WD" ] && { rm -f "$OUT/sampling"; kill "$WD" 2>/dev/null; wait "$WD" 2>/dev/null; }
  [ -n "$CH" ] && { kill "$CH" 2>/dev/null; wait "$CH" 2>/dev/null; }
  if [ $STARTED = 1 ]; then remote_cleanup > "$OUT/cleanup.out" 2>&1 || cfail=1; grep -qx "clean $ID" "$OUT/cleanup.out" || cfail=1; fi
  if [ -n "$OUT" ] && [ -e "$OUT/floor.txt" ]; then rc=20; fi
  if [ $cfail = 1 ]; then rc=21; fi
  if [ $rc = 0 ] && ! { grep -q '^SMOKE PASS' "$OUT/guest.out" && grep -qx "## guest-smoke $ID rc=0" "$OUT/guest.out"; } 2>/dev/null; then rc=22; fi
  echo "## guest-smoke-runner run=$ID rc=$rc cleanupFailed=$cfail floorBreach=$([ -n "$OUT" ] && [ -e "$OUT/floor.txt" ] && echo yes || echo no)"
  exit $rc; }
trap on_exit EXIT; trap 'exit 130' INT; trap 'exit 143' TERM; trap 'exit 129' HUP
# ---- admission before any SSH ----
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || die "smoke stage != SHA256SUMS"
[ "$(sha256sum < "$CAP/SHA256SUMS" | cut -c1-64)" = 7f3fb478445d57ca4d941d48c8a89b0011fc7ca9771f107b8e6f12144ad6b31b ] || die "capture stage is not 7f3fb478"
python3 -I - "$S/kit/bundle" "$CAP/bundle" <<'PY' || die "kit bundle copy differs from the frozen bundle 020cc8bf (bytes or mode)"
import hashlib, json, os, sys
k, b = sys.argv[1:3]; mb = open(f'{b}/MANIFEST.json', 'rb').read()
assert hashlib.sha256(mb).hexdigest() == '020cc8bf8045cf48441349065c039171fc303783b2fa05dd5fa8f5a45296e22e' and open(f'{k}/MANIFEST.json', 'rb').read() == mb
for rel, e in json.loads(mb)['files'].items():
    assert hashlib.sha256(open(f'{k}/{rel}', 'rb').read()).hexdigest() == e['sha256'] and bool(os.stat(f'{k}/{rel}').st_mode & 0o111) == (e['mode'] == '0755'), rel
PY
a=$(hostavail); [ -n "$a" ] && [ "$a" -ge $((FLOOR_MIB + RESERVE_MIB)) ] || die "host MemAvailable ${a:-?} MiB < floor $FLOOR_MIB + $RESERVE_MIB"
ID=$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n'); OUT=$S/logs/smoke-$ID; mkdir -p -m 0700 "$OUT" || die "out"
echo "smoke $ID host MemAvailable $a MiB" | tee "$OUT/admission.txt"
# ---- run: the kit is piped over the ssh session and extracted ONLY under /var/lib/enclave-rpc/hcap-smoke/<ID> ----
STARTED=1
host_sample start; touch "$OUT/sampling"
( while [ -e "$OUT/sampling" ]; do sleep "$POLL"; [ -e "$OUT/sampling" ] && host_sample periodic; done ) & WD=$!
tar --owner=0 --group=0 --numeric-owner -czf - -C "$S/kit" bundle tests aux -C "$S/guest" guest-smoke.sh | \
  timeout -k 30 "$GUEST_TIMEOUT" "${SSH[@]}" "sudo -n /bin/bash -c 'set -e; umask 022; install -d -m 0755 /var/lib/enclave-rpc/hcap-smoke; mkdir -m 0755 /var/lib/enclave-rpc/hcap-smoke/$ID; tar -xzf - -C /var/lib/enclave-rpc/hcap-smoke/$ID --no-same-owner; exec /bin/bash /var/lib/enclave-rpc/hcap-smoke/$ID/guest-smoke.sh $ID'" \
  > "$OUT/guest.out" 2>&1 & CH=$!
echo "$CH" > "$OUT/ssh.pid"
rc=0; wait "$CH" || rc=$?; CH=""
host_sample end; rm -f "$OUT/sampling"; kill "$WD" 2>/dev/null; wait "$WD" 2>/dev/null; WD=""
grep -E '^(PASS|FAIL|INFO|SMOKE|node |## guest-smoke)' "$OUT/guest.out"
exit $rc
