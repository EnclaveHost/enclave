#!/bin/bash
# witness-rpc-live-canary-stage/r2 HOST runner (ROOT; PREPARED, NOT run by Claude). Through the shared queue (host floor):
#   cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025 && \
#   python3 -u ../claude-test-queue.py --mib 512 --log witness-rpc-live-canary-stage/r2/logs/root-witness-fixture-canary.guard -- bash witness-rpc-live-canary-stage/r2/jobs/root-witness-fixture-canary.sh
# Uploads ONLY the fixture inputs (r14 bridge cb976541, shipped unit e4bdc947, fixture_node.py, check_props.py, UPLOAD.sha256) to
# /run/enclave-wbcanary-in-<ID>, runs guest/fixture_canary.sh over the existing ssh config with a hard timeout, watches the PHYSICAL host's
# /proc/meminfo (start + periodic + end samples; a breach stops ONLY enclave-wbcanary-<ID>-*.service), and on EVERY exit (incl. a disconnect
# or partial setup) independently stops exactly the owned units, removes exactly the owned paths and re-checks them remotely.
# Exit: the run's failure is kept; a run rc 0 exits 22 unless the guest WBC-VERDICT says pass and host samples hold, 21 if owned cleanup or its
# independent check failed. Writes PUBLIC-RECEIPT.json (no secret: properties, booleans, PIDs-unchanged flags, host memory numbers).
set -uo pipefail
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P); P=$(cd "$S/../.." && pwd -P)
R14=$P/base-finality-proof-stage/r14-witness; R14_SUMS=1ba2d51a47d0576cada1e0e24b885234e39c6c53f4e6af5e8c9e5ee5e921793b
BRIDGE_PIN=cb9765418d30d238ded384c6908462516d153161f17631f28c7247905198fc9d; UNIT_PIN=e4bdc94784d2bc6cb1e29a30d62c8e65a24846585271009224754960b22b9611
FLOOR_MIB=16384; MEMINFO=/proc/meminfo; POLL=5; GUEST_TIMEOUT=600
SSH=(ssh -F /home/steven/.local/state/enclave-rpc-production/ssh_config -o ConnectTimeout=10 -o BatchMode=yes enclave-rpc)
if [ -n "${WBC_TEST_FAKE_SSH:-}" ]; then                         # OFFLINE TESTS ONLY: fakes must live under the test's tmp
  for v in "$WBC_TEST_FAKE_SSH" "${WBC_TEST_R14:-$R14}" "${WBC_TEST_MEMINFO:-/tmp/x}"; do
    [[ $v == /tmp/* || $v == ${TMPDIR:-/nonexistent}/* || $v == "$R14" ]] || { echo "## SETUP: test override outside tmp"; exit 20; }; done
  SSH=("$WBC_TEST_FAKE_SSH"); R14=${WBC_TEST_R14:-$R14}; R14_SUMS=${WBC_TEST_R14_SUMS:-$R14_SUMS}; MEMINFO=${WBC_TEST_MEMINFO:-$MEMINFO}; POLL=1; GUEST_TIMEOUT=${WBC_TEST_GUEST_TIMEOUT:-60}
fi
ID=""; STAGED=0; DONE=0; WD=""; OUT=""
die() { echo "## SETUP: $*"; exit 20; }
hostavail() { awk '/^MemAvailable:/{print int($2/1024)}' "$MEMINFO" 2>/dev/null; }
stop_own() { timeout 30 "${SSH[@]}" "sudo -n systemctl stop 'enclave-wbcanary-$ID-*.service'"; }
host_sample() { local a; a=$(hostavail); echo "$(date -u +%s) ${a:-unreadable} $1" >> "$OUT/host-memavail.txt"
  if [ -z "$a" ] || [ "$a" -lt $FLOOR_MIB ]; then echo "FLOOR BREACH ${a:-unreadable} MiB $1" >> "$OUT/floor.txt"; stop_own >> "$OUT/floor.txt" 2>&1; fi; }
stop_watchdog() { [ -n "$WD" ] || return 0; rm -f "$OUT/sampling"; kill "$WD" 2>/dev/null; wait "$WD" 2>/dev/null; WD=""; }
cleanup() {
  local rc=$? cfail=0 hv=1; [ $DONE = 1 ] && return; DONE=1
  stop_watchdog
  if [ $STAGED = 1 ]; then          # independent of the guest's own trap: exact owned names only, then a remote re-check
    timeout 60 "${SSH[@]}" "sudo -n sh -c 'systemctl stop enclave-wbcanary-$ID-fixture.service enclave-wbcanary-$ID-bridge.service 2>/dev/null; systemctl reset-failed enclave-wbcanary-$ID-fixture.service enclave-wbcanary-$ID-bridge.service 2>/dev/null; rm -rf --one-file-system -- /run/enclave-wbcanary-$ID /run/enclave-wbcanary-in-$ID; true'" > "$OUT/cleanup.out" 2>&1 || cfail=1
    timeout 60 "${SSH[@]}" "sudo -n sh -c 'systemctl list-units --all --plain --no-legend enclave-wbcanary-$ID-* | grep . ; ls -d /run/enclave-wbcanary-$ID /run/enclave-wbcanary-in-$ID 2>/dev/null; true'" > "$OUT/postcheck.out" 2>&1 || cfail=1
    [ -s "$OUT/postcheck.out" ] && { cfail=1; echo "## OWNED LEFTOVERS on the guest: $(tr '\n' ' ' < "$OUT/postcheck.out")"; }
  fi
  if [ -n "$OUT" ] && [ -d "$OUT" ]; then
    /usr/bin/python3 -I - "$OUT" "$rc" "$FLOOR_MIB" "$cfail" > "$OUT/PUBLIC-RECEIPT.json" <<'PYR' && hv=0
import json, pathlib, sys
o, rc, floor, cfail = pathlib.Path(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]), sys.argv[4] == '1'
g = (o / 'guest.out').read_text(errors='replace').splitlines() if (o / 'guest.out').exists() else []
vl = [l[len('WBC-VERDICT '):] for l in g if l.startswith('WBC-VERDICT ')]
v = json.loads(vl[-1]) if len(vl) == 1 else None
rows = [l.split() for l in (o / 'host-memavail.txt').read_text().splitlines()] if (o / 'host-memavail.txt').exists() else []
s = [int(r[1]) if len(r) == 3 and r[1].isdigit() else None for r in rows]; tags = [r[2] for r in rows if len(r) == 3]
checks = {'run rc 0': rc == 0, 'exactly one guest WBC-VERDICT': len(vl) == 1, 'guest verdict pass': bool(v and v.get('pass') is True),
          'guest owned cleanup ok': bool(v and (v.get('cleanup') or {}).get('ok') is True), 'host owned cleanup + independent re-check ok': not cfail,
          'host start+end samples': 'start' in tags and 'end' in tags, f'host >= {floor} MiB throughout': bool(s) and None not in s and min(s) >= floor,
          'no host floor breach': not (o / 'floor.txt').exists()}
print(json.dumps({'run': o.name, 'pass': all(checks.values()), 'checks': checks, 'hostMinAvailMiB': min([x for x in s if x is not None], default=None),
                  'guest': v, 'note': 'DISPOSABLE fixture socket in the real bridge unit sandbox; NOT a node test'}, indent=1, sort_keys=True))
sys.exit(0 if all(checks.values()) else 1)
PYR
    cat "$OUT/PUBLIC-RECEIPT.json"
  fi
  local final=$rc
  if [ "$final" = 0 ]; then [ $cfail = 0 ] || final=21; [ "$final" = 0 ] && [ $hv != 0 ] && final=22; fi
  echo "## witness-fixture-canary rc=$final (run rc=$rc cleanupFailed=$cfail receiptPass=$([ $hv = 0 ] && echo true || echo false))"
  exit "$final"; }
trap cleanup EXIT; trap 'exit 130' INT; trap 'exit 143' TERM
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || die "fixture canary r2 != its SHA256SUMS"
[ "$(sha256sum < "$R14/SHA256SUMS" | cut -c1-64)" = "$R14_SUMS" ] && (cd "$R14" && sha256sum -c --quiet SHA256SUMS) || die "r14-witness is not the qualified 1ba2d51a"
[ "$(sha256sum < "$R14/witness/witness_rpc_bridge.py" | cut -c1-64)" = $BRIDGE_PIN ] || die "bridge is not the reviewed cb976541"
[ "$(sha256sum < "$R14/units/enclave-witness-bridge-base.service" | cut -c1-64)" = $UNIT_PIN ] || die "unit is not the shipped e4bdc947"
a=$(hostavail); [ -n "$a" ] && [ "$a" -ge $((FLOOR_MIB + 512)) ] || die "host MemAvailable ${a:-?} MiB < floor + bound"
ID=$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n'); OUT=${WBC_OUT_ROOT:-$S/logs}/run-$ID; mkdir -p -m 0700 "$OUT/upload" || die "out"
cp "$R14/witness/witness_rpc_bridge.py" "$OUT/upload/bridge.py" && cp "$R14/units/enclave-witness-bridge-base.service" "$OUT/upload/unit.service" \
  && cp "$S/guest/fixture_node.py" "$S/guest/check_props.py" "$OUT/upload/" && (cd "$OUT/upload" && sha256sum bridge.py unit.service fixture_node.py check_props.py > UPLOAD.sha256) || die "upload set"
for f in "$OUT"/upload/*; do [ "$(stat -c %s "$f")" -le 1048576 ] || die "upload $f too large"; done
timeout 60 "${SSH[@]}" "sudo -n install -d -m 0700 /run/enclave-wbcanary-in-$ID" || die "guest staging dir"; STAGED=1
for f in bridge.py unit.service fixture_node.py check_props.py UPLOAD.sha256; do
  timeout 60 "${SSH[@]}" "sudo -n tee /run/enclave-wbcanary-in-$ID/$f > /dev/null" < "$OUT/upload/$f" > /dev/null || die "upload $f"; done
host_sample start; touch "$OUT/sampling"
( while [ -e "$OUT/sampling" ]; do sleep "$POLL"; [ -e "$OUT/sampling" ] && host_sample periodic; done ) & WD=$!
timeout -k 30 "$GUEST_TIMEOUT" "${SSH[@]}" "sudo -n bash -s $ID" < "$S/guest/fixture_canary.sh" > "$OUT/guest.out" 2>&1; rc=$?
host_sample end; stop_watchdog
[ -e "$OUT/floor.txt" ] && { echo "## host floor breached: own units stopped (NOT a verdict)"; [ $rc = 0 ] && rc=20; }
exit $rc
