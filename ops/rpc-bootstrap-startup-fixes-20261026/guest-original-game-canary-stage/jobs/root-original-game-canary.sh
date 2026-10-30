#!/bin/bash
# guest-original-game-canary (host side; PREPARED, NOT run by Claude). ROOT runs it through the shared queue (host floor 16 GiB):
#   python3 -u ../claude-test-queue.py --mib 512 --log guest-original-game-canary-stage/logs/root-original-game-canary.guard -- bash guest-original-game-canary-stage/jobs/root-original-game-canary.sh
# = the FROZEN guest canary r3 host flow (this file is derived from its job) + the r3 guest/canary.sh and guest/cleanup.sh used IN PLACE
# (sha-pinned, never copied): same 512M scope, PIDs-unchanged invariant, own CL :15052 / EL :18645, Helios 127.0.0.1:18550, pinned
# checkpoint 2e8502e6 + provenance c8629825, floor watchdog, owned cleanup on ANY exit. Bytes = the FROZEN final composition named in
# COMPOSED-STAGE-PINS.json (assembled by the cold-proof canary assembler, reused byte-identically) + the pinned initial receipt
# b9a90847 at the consumer contract's install path. Driver = ONLY the capture module's ORIGINAL-GAME `recheck` mode + verify.
# Result: PUBLIC-RECEIPT.json status verified | refused (eligibility etc., reported as is) | failed | blocked (contract/source gap).
set -uo pipefail
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; S=$P/guest-original-game-canary-stage; R3S=$P/guest-capture-canary-stage/r3
OUTS=/home/steven/Documents/Codex/2026-10-18/wo/outputs/rpc-production-final-20261025
CK=${CHECKPOINT_FILE:-$OUTS/l1-authority-live-1941/checkpoint.json}; PV=${PROVENANCE_FILE:-$OUTS/l1-caught-up/fresh-finality-provenance-1941.json}
SSH=(ssh -F /home/steven/.local/state/enclave-rpc-production/ssh_config -o ConnectTimeout=10 -o BatchMode=yes enclave-rpc)
ID=""; STAGED=0; DONE=0; WD=""
die() { echo "## SETUP: $*"; exit 20; }
cleanup() {                                                       # owned cleanup: diagnostics first, then only this run's paths
  local rc=$?; [ $DONE = 1 ] && return; DONE=1
  [ -n "$WD" ] && { kill $WD 2>/dev/null; wait $WD 2>/dev/null; }
  if [ $STAGED = 1 ]; then
    timeout 60 "${SSH[@]}" "sudo -n systemctl stop enclave-a1-canary-$ID.scope" 2>/dev/null
    timeout 120 "${SSH[@]}" "sudo -n sh -c 'cd /run/enclave-canary-$ID 2>/dev/null && ls -la; for f in pids-before.txt pids-after.txt created-parent; do [ -f \$f ] && { echo == \$f; cat \$f; }; done; [ -d /var/lib/enclave-rpc/canary-$ID/out ] && tar -C /var/lib/enclave-rpc/canary-$ID -cf - out | base64 -w0 | head -c 4000000 > /run/enclave-canary-$ID/diag.b64; true'" > $OUT/diagnostics.txt 2>&1
    [ -s $OUT/result.tar ] || timeout 120 "${SSH[@]}" "sudo -n cat /run/enclave-canary-$ID/result.tar" > $OUT/result.tar 2>/dev/null || rm -f $OUT/result.tar
    timeout 120 "${SSH[@]}" "sudo -n cat /run/enclave-canary-$ID/diag.b64" 2>/dev/null | base64 -d > $OUT/diag-out.tar 2>/dev/null || rm -f $OUT/diag-out.tar
    timeout 120 "${SSH[@]}" "sudo -n bash -s $ID" < $R3S/guest/cleanup.sh > $OUT/cleanup.out 2>&1 || echo "## CLEANUP FAILED: see $OUT/cleanup.out (manual: guest/cleanup.sh $ID)"
  fi
  echo "## guest-canary rc=$rc"; }
trap cleanup EXIT; trap 'exit 130' INT; trap 'exit 143' TERM
(cd $S && sha256sum -c --quiet SHA256SUMS) || die "original-game canary != SHA256SUMS (contract/pins filled after freeze require a re-freeze)"
[ "$(sha256sum < $R3S/SHA256SUMS | cut -c1-64)" = 9367c877519d4e34867461ebbea9aafcd478109b1d77557d01d8c060eb67c882 ] || die "canary r3 is not the frozen 9367c877"
(cd $R3S && sha256sum -c --quiet SHA256SUMS) || die "canary r3 changed"
CS=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["stage"] or "")' $S/COMPOSED-STAGE-PINS.json); [ -n "$CS" ] || die "final composition pending"
(cd $P/$CS && sha256sum -c --quiet SHA256SUMS) || die "$CS changed after its freeze"
[ "$(sha256sum < "$CK" | cut -c1-64)" = 2e8502e68864abb49a230a69612bd7c98c94775d8dd81f956a0185d53652ac33 ] || die "checkpoint record is not the pinned 2e8502e6"
[ "$(sha256sum < "$PV" | cut -c1-64)" = c862982520d65e81041f24162f29dd9d71839161ece6b06e559f9af822c1974d ] || die "provenance is not the pinned c8629825"
ID=$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n'); OUT=$S/logs/run-$ID; mkdir -p -m 0700 $OUT || die out
python3 -I $S/tools/assemble.py $OUT > $OUT/assemble.json || die "assembly refused (contract/pins pending or composed bytes differ; see assemble.json)"
# the composed stage's bundled l1_authority.py's OWN checkpoint rules (schema, epoch boundary, age <= 604800, >= 2 sources, not own-only), host-side preview
python3 -I -c 'import importlib.util,sys,time; s=importlib.util.spec_from_file_location("l1a",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print("checkpoint", m.load_checkpoint(sys.argv[2],"mainnet",604800,int(time.time())))' \
  $OUT/bundle/opt/a1-capture/l1_authority.py "$CK" || die "checkpoint refused by l1_authority.py rules (age/schema/provenance)"
tar -C $OUT -cf $OUT/bundle.tar bundle && rm -rf $OUT/bundle
timeout 60 "${SSH[@]}" "sudo -n install -d -m 0700 /run/enclave-canary-$ID" || die "guest staging dir"; STAGED=1
up() { timeout 600 "${SSH[@]}" "sudo -n tee /run/enclave-canary-$ID/$2 > /dev/null" < "$1" || die "upload $2"; }
up $OUT/bundle.tar bundle.tar; up $OUT/BUNDLE.sha256 BUNDLE.sha256; up "$CK" checkpoint.json; up "$PV" provenance.json; up $OUT/HELIOS.txt HELIOS.txt; up $S/guest/canary_driver.py canary_driver.py; up $OUT/CONSUMER-CONTRACT.json CONSUMER-CONTRACT.json
( while sleep 5; do a=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo); if [ "$a" -lt 16384 ]; then echo "FLOOR BREACH $a MiB $(date -u +%FT%TZ)" >> $OUT/floor.txt
    timeout 30 "${SSH[@]}" "sudo -n systemctl stop enclave-a1-canary-$ID.scope"; fi; done ) & WD=$!
timeout -k 30 3300 "${SSH[@]}" "sudo -n bash -s $ID" < $R3S/guest/canary.sh > $OUT/guest.out 2>&1; rc=$?
timeout 120 "${SSH[@]}" "sudo -n cat /run/enclave-canary-$ID/result.tar" > $OUT/result.tar 2>/dev/null && mkdir -m 0700 $OUT/result && tar -C $OUT/result -xf $OUT/result.tar
[ -e $OUT/floor.txt ] && { echo "## host floor breached: canary stopped (NOT a verdict)"; rc=20; }
python3 -I - $OUT <<'PY' > $OUT/PUBLIC-RECEIPT.json
import json, pathlib, sys
o = pathlib.Path(sys.argv[1]); r = o / 'result/out'; j = lambda p: json.loads((r / p).read_text()) if (r / p).exists() else None
rec = j('receipt.json') or {}
print(json.dumps({'run': o.name, 'status': rec.get('status') or 'no-receipt', 'why': rec.get('why'), 'moduleSha256': rec.get('moduleSha256'),
                  'expected': rec.get('expected'), 'sources': rec.get('sources'), 'evidence': rec.get('evidence'), 'checks': rec.get('checks'),
                  'gate': rec.get('gate'), 'capture': {k: (rec.get('capture') or {}).get(k) for k in ('ok', 'sec', 'kwargs', 'refused')},
                  'forwardProgress': rec.get('forwardProgress'), 'l1': j('l1-consistency.json'),
                  'pidsUnchanged': (r / 'pids-before.txt').exists() and (r / 'pids-before.txt').read_text() == (r / 'pids-after.txt').read_text()}, indent=1))
PY
cat $OUT/PUBLIC-RECEIPT.json; tail -3 $OUT/guest.out
echo "## private captures: $OUT/result/captures (0700)"; exit $rc
