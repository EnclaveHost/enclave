#!/bin/bash
# Guest A1 call-timeout diagnostic (host side; PREPARED, NOT run by Claude). ROOT runs it through the shared queue (host floor 16 GiB):
#   python3 -u ../claude-test-queue.py --mib 512 --log guest-call-timeout-diagnostic-stage/logs/root-guest-call-diagnostic.guard -- bash guest-call-timeout-diagnostic-stage/jobs/root-guest-call-diagnostic.sh
# Bytes: the FROZEN canary r3 bundle (r3's own assembler + R10 pins; no new binary), the pinned checkpoint 2e8502e6, this stage's three
# probes. Same envelope as r3: floor watchdog stops the guest scopes, owned cleanup on ANY exit removes only diag-<ID> paths.
set -uo pipefail
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; S=$P/guest-call-timeout-diagnostic-stage; R3=$P/guest-capture-canary-stage/r3
CK=/home/steven/Documents/Codex/2026-10-18/wo/outputs/rpc-production-final-20261025/l1-authority-live-1941/checkpoint.json
SSH=(ssh -F /home/steven/.local/state/enclave-rpc-production/ssh_config -o ConnectTimeout=10 -o BatchMode=yes enclave-rpc)
ID=""; STAGED=0; DONE=0; WD=""; OUT=""
die() { echo "## SETUP: $*"; exit 20; }
stopall() { timeout 60 "${SSH[@]}" "sudo -n sh -c 'for u in el h100 h400 px100 px400; do systemctl stop enclave-a1-diag-$ID-\$u.scope 2>/dev/null; done; true'"; }
cleanup() {
  local rc=$?; [ $DONE = 1 ] && return; DONE=1
  [ -n "$WD" ] && { kill $WD 2>/dev/null; wait $WD 2>/dev/null; }
  if [ $STAGED = 1 ]; then
    stopall
    [ -s $OUT/result.tar ] || timeout 120 "${SSH[@]}" "sudo -n cat /run/enclave-diag-$ID/result.tar" > $OUT/result.tar 2>/dev/null || rm -f $OUT/result.tar
    timeout 120 "${SSH[@]}" "sudo -n bash -s $ID" < $S/guest/cleanup.sh > $OUT/cleanup.out 2>&1 || echo "## CLEANUP FAILED: see $OUT/cleanup.out (manual: guest/cleanup.sh $ID)"
  fi
  echo "## guest-diag rc=$rc"; }
trap cleanup EXIT; trap 'exit 130' INT; trap 'exit 143' TERM
(cd $S && sha256sum -c --quiet SHA256SUMS) || die "diagnostic stage != SHA256SUMS"
[ "$(sha256sum < $R3/SHA256SUMS | cut -c1-64)" = 9367c877519d4e34867461ebbea9aafcd478109b1d77557d01d8c060eb67c882 ] || die "canary r3 is not the frozen 9367c877"
(cd $R3 && sha256sum -c --quiet SHA256SUMS) || die "canary r3 changed"
[ "$(sha256sum < "$CK" | cut -c1-64)" = 2e8502e68864abb49a230a69612bd7c98c94775d8dd81f956a0185d53652ac33 ] || die "checkpoint is not the pinned 2e8502e6"
ID=$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n'); OUT=$S/logs/run-$ID; mkdir -p -m 0700 $OUT || die out
python3 -I $R3/tools/assemble_canary_bundle.py $OUT > $OUT/assemble.json || die "r3 bundle assembly"
tar -C $OUT -cf $OUT/bundle.tar bundle && rm -rf $OUT/bundle
timeout 60 "${SSH[@]}" "sudo -n install -d -m 0700 /run/enclave-diag-$ID" || die "guest staging dir"; STAGED=1
up() { timeout 600 "${SSH[@]}" "sudo -n tee /run/enclave-diag-$ID/$2 > /dev/null" < "$1" || die "upload $2"; }
up $OUT/bundle.tar bundle.tar; up $OUT/BUNDLE.sha256 BUNDLE.sha256; up $OUT/HELIOS.txt HELIOS.txt; up "$CK" checkpoint.json
for f in el_probe.mjs helios_probe.mjs rpc_log_proxy.py; do up $S/guest/$f $f; done
( while sleep 5; do a=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo); if [ "$a" -lt 16384 ]; then echo "FLOOR BREACH $a MiB $(date -u +%FT%TZ)" >> $OUT/floor.txt; stopall; fi; done ) & WD=$!
timeout -k 30 3600 "${SSH[@]}" "sudo -n bash -s $ID" < $S/guest/diag.sh > $OUT/guest.out 2>&1; rc=$?
timeout 120 "${SSH[@]}" "sudo -n cat /run/enclave-diag-$ID/result.tar" > $OUT/result.tar 2>/dev/null && mkdir -m 0700 $OUT/result && tar -C $OUT/result -xf $OUT/result.tar
[ -e $OUT/floor.txt ] && { echo "## host floor breached: diagnostic stopped (NOT a verdict)"; rc=20; }
tail -12 $OUT/guest.out; echo "## results: $OUT/result/out (el-probe.json, el-requests-{100,400}.jsonl, helios-probe-{100,400}.json, scope-*.txt, state-*.txt)"; exit $rc
