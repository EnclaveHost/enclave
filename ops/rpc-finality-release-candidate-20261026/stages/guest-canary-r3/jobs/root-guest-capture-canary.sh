#!/bin/bash
# Guest capture canary r3 (host side; r3 = r10 bytes only, initial + recheck-capture + core compatibility; PREPARED, NOT run by Claude). ROOT runs it through the shared queue (host floor 16 GiB):
#   python3 -u ../claude-test-queue.py --mib 512 --log guest-capture-canary-stage/r3/logs/root-guest-capture-canary.guard -- bash guest-capture-canary-stage/r3/jobs/root-guest-capture-canary.sh
# Bootstrap anchor = the EXISTING authentic weak-subjectivity checkpoint record, used UNCHANGED (default; overridable only by an
# identical-hash file): CHECKPOINT_FILE (sha 2e8502e6...) + PROVENANCE_FILE (sha c8629825...; five HTTP-200 observations, own
# Lighthouse + 4 independent providers, root 0xb5d80340... epoch 484719 = slot 15511008). No external RPC is contacted by this job.
# Guest: private dir + transient scope (MemoryMax=512M, MemorySwapMax=0, CPUQuota=100%, 2700 s). Owned cleanup runs on ANY exit
# (success, failure, interrupt) AFTER diagnostics are fetched; it removes only this run's canary paths, never a shared production path.
set -uo pipefail
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; S=$P/guest-capture-canary-stage/r3
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
    timeout 120 "${SSH[@]}" "sudo -n bash -s $ID" < $S/guest/cleanup.sh > $OUT/cleanup.out 2>&1 || echo "## CLEANUP FAILED: see $OUT/cleanup.out (manual: guest/cleanup.sh $ID)"
  fi
  echo "## guest-canary rc=$rc"; }
trap cleanup EXIT; trap 'exit 130' INT; trap 'exit 143' TERM
(cd $S && sha256sum -c --quiet SHA256SUMS) || die "canary r3 != SHA256SUMS (pins filled after the r10 freeze require a re-freeze)"
(cd $P/base-finality-proof-stage/r10 && sha256sum -c --quiet SHA256SUMS) || die "r10 changed after its freeze"
[ "$(sha256sum < "$CK" | cut -c1-64)" = 2e8502e68864abb49a230a69612bd7c98c94775d8dd81f956a0185d53652ac33 ] || die "checkpoint record is not the pinned 2e8502e6"
[ "$(sha256sum < "$PV" | cut -c1-64)" = c862982520d65e81041f24162f29dd9d71839161ece6b06e559f9af822c1974d ] || die "provenance is not the pinned c8629825"
ID=$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n'); OUT=$S/logs/run-$ID; mkdir -p -m 0700 $OUT || die out
python3 -I $S/tools/assemble_canary_bundle.py $OUT > $OUT/assemble.json || die "bundle assembly (r10 pins pending or r10 bytes differ)"
# r10's bundled l1_authority.py's OWN checkpoint rules (schema, epoch boundary, age <= 604800, >= 2 sources, not own-only), host-side preview
python3 -I -c 'import importlib.util,sys,time; s=importlib.util.spec_from_file_location("l1a",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print("checkpoint", m.load_checkpoint(sys.argv[2],"mainnet",604800,int(time.time())))' \
  $OUT/bundle/opt/a1-capture/l1_authority.py "$CK" || die "checkpoint refused by l1_authority.py rules (age/schema/provenance)"
tar -C $OUT -cf $OUT/bundle.tar bundle && rm -rf $OUT/bundle
timeout 60 "${SSH[@]}" "sudo -n install -d -m 0700 /run/enclave-canary-$ID" || die "guest staging dir"; STAGED=1
up() { timeout 600 "${SSH[@]}" "sudo -n tee /run/enclave-canary-$ID/$2 > /dev/null" < "$1" || die "upload $2"; }
up $OUT/bundle.tar bundle.tar; up $OUT/BUNDLE.sha256 BUNDLE.sha256; up "$CK" checkpoint.json; up "$PV" provenance.json; up $OUT/HELIOS.txt HELIOS.txt; up $S/guest/canary_driver.py canary_driver.py
( while sleep 5; do a=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo); if [ "$a" -lt 16384 ]; then echo "FLOOR BREACH $a MiB $(date -u +%FT%TZ)" >> $OUT/floor.txt
    timeout 30 "${SSH[@]}" "sudo -n systemctl stop enclave-a1-canary-$ID.scope"; fi; done ) & WD=$!
timeout -k 30 3300 "${SSH[@]}" "sudo -n bash -s $ID" < $S/guest/canary.sh > $OUT/guest.out 2>&1; rc=$?
timeout 120 "${SSH[@]}" "sudo -n cat /run/enclave-canary-$ID/result.tar" > $OUT/result.tar 2>/dev/null && mkdir -m 0700 $OUT/result && tar -C $OUT/result -xf $OUT/result.tar
[ -e $OUT/floor.txt ] && { echo "## host floor breached: canary stopped (NOT a verdict)"; rc=20; }
python3 -I - $OUT <<'PY' > $OUT/PUBLIC-RECEIPT.json
import json, pathlib, sys
o = pathlib.Path(sys.argv[1]); r = o / 'result/out'; j = lambda p: json.loads((r / p).read_text()) if (r / p).exists() else None
rec = j('receipt.json') or {}; s = lambda k: rec.get(k) or {}
print(json.dumps({'run': o.name, 'moduleSha256': rec.get('moduleSha256'), 'failedAt': rec.get('failedAt'), 'failure': rec.get('failure'),
                  'initial': {k: s('initial').get(k) for k in ('captureOk', 'captureSec', 'forwardProgress', 'el')}, 'initialVerified': 'verify' in s('initial'),
                  'consumerExpectedInitialCaptureSha256': rec.get('consumerExpectedInitialCaptureSha256'),
                  'recheck': {k: s('recheck').get(k) for k in ('captureOk', 'captureSec', 'forwardProgress', 'el')}, 'recheckVerified': 'verify' in s('recheck'),
                  'recheckInitialBinding': (s('recheck').get('verify') or {}).get('initialCapture'), 'finalityCore': rec.get('finalityCore'),
                  'liveBaseProof': rec.get('liveBaseProof'), 'l1': j('l1-consistency.json'),
                  'pidsUnchanged': (r / 'pids-before.txt').exists() and (r / 'pids-before.txt').read_text() == (r / 'pids-after.txt').read_text()}, indent=1))
PY
cat $OUT/PUBLIC-RECEIPT.json; tail -3 $OUT/guest.out
echo "## private captures: $OUT/result/captures (0700)"; exit $rc
