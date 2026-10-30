#!/bin/bash
# guest-smoke.sh ON THE RPC GUEST as root (started ONLY by jobs/root-guest-smoke-runner.sh, which pipes the kit and owns host admission).
# Qualifies the RUNTIME the historical capture will use, with a TEMPORARY KIT (never the installed production bundle, never a production DB,
# no service start/stop/restart, nothing mounted in the guest's own namespace):
#   T0 versions: /usr/bin/node major >= 18, python3 >= 3.11, systemd-run present, user rpcbase exists
#   T1 kit bundle copy verifies with its own CLI (`bin/historical-capture verify`: every file sha + exec bit, no unlisted file)
#   T2 the 9 test_anchored_origin tests (r8 bytes) on the bundle-copy lib, as rpcbase, in a transient unit
#   T3 origin CLI refuses a receipt that is not the pinned A1 bytes                       (refusal only; not a positive proof)
#   T4 origin CLI refuses a datadir without db/                                           (refusal only)
#   T5 private read-only semantics: a unit where the datadir is writable (ReadWritePaths) -> the CLI refuses "not on a read-only mount";
#      the production-shaped unit (ProtectSystem=strict + BindReadOnlyPaths=<datadir>, as guest-capture.sh's origin step) -> the
#      read-only gate passes and the CLI stops at the next gate ("StageCheckpoints[Finish] absent" from the fake reth db)
#   T6 no persistent mount: the guest's own mountinfo is identical before/after and the fixture datadir is writable again afterwards
#   (info) the installed production bundle's read-only `verify`, if present (root install 1318); never required
# Every unit: User=rpcbase, MemoryMax=1G, MemorySwapMax=0, RuntimeMaxSec=600, NoNewPrivileges, PrivateNetwork, PrivateMounts,
# ProtectSystem=strict, ProtectHome, PrivateTmp, ReadWritePaths only the kit's own out/scratch. The trap stops exactly enclave-hsmoke-<ID>-*
# and removes exactly /var/lib/enclave-rpc/hcap-smoke/<ID>.   usage: guest-smoke.sh <ID>   (the runner extracted the kit there)
set -uo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
ID=${1:-}; [[ $ID =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$ ]] || { echo "bad run id" >&2; exit 2; }
K=/var/lib/enclave-rpc/hcap-smoke/$ID; O=$K/out; RUNAS=rpcbase; NODE=/usr/bin/node; rc=0; DONE=0
PROD=/opt/enclave-rpc/historical-capture/020cc8bf8045cf48441349065c039171fc303783b2fa05dd5fa8f5a45296e22e
units() { systemctl list-units --all --plain --no-legend "enclave-hsmoke-$ID-*" 2>/dev/null | grep . || true; }
on_exit() { local r=$?; [ $DONE = 1 ] && return; DONE=1
  systemctl stop "enclave-hsmoke-$ID-*" 2>/dev/null; systemctl reset-failed "enclave-hsmoke-$ID-*" 2>/dev/null
  left=$(units); [ -n "$left" ] && { echo "UNITS LEFT: $left"; r=21; }
  [ -d "$K" ] && rm -rf --one-file-system -- "$K"; [ -e "$K" ] && { echo "KIT LEFT: $K"; r=21; }
  echo "## guest-smoke $ID rc=$r"; exit $r; }
trap on_exit EXIT; trap 'exit 130' INT; trap 'exit 143' TERM; trap 'exit 129' HUP
ok() { echo "PASS $*"; }; bad() { echo "FAIL $*"; rc=1; }
[ "$(id -u)" = 0 ] && [ -d "$K/bundle" ] || { echo "run as root after the runner extracted the kit to $K" >&2; exit 2; }
id "$RUNAS" >/dev/null 2>&1 || { echo "user $RUNAS absent" >&2; exit 2; }
chown -R root:root "$K" && chmod -R go-w,a+rX "$K" && chmod 0755 "$K" || exit 2
install -d -m 0700 -o $RUNAS -g $RUNAS "$O" "$O/scratch-a" "$O/scratch-b" "$O/scratch-c" "$O/scratch-d"
install -d -m 0755 "$K/fx/nodb" "$K/fx/ro/db"                       # fixture datadirs (root-owned, world-readable)
python3 -I - "$K" <<'PY' || exit 2
import importlib.util, os, stat, sys
k = sys.argv[1]; spec = importlib.util.spec_from_file_location('toe', f'{k}/aux/test_origin_extract.py'); sys.path.insert(0, f'{k}/aux')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)          # the pinned fake `base` (reth db get printer) text
open(f'{k}/fx/base', 'w').write(m.FAKE); os.chmod(f'{k}/fx/base', 0o755); open(f'{k}/fx/db.json', 'w').write('{}'); os.chmod(f'{k}/fx/db.json', 0o644)
PY
FSHA=$(sha256sum < "$K/fx/base" | cut -c1-64)
unit() {  # name extra-props... -- argv : one transient unit, waited on, output to $O/<name>.out (exit status returned)
  local n=$1; shift; local p=(-p "User=$RUNAS" -p MemoryMax=1G -p MemorySwapMax=0 -p RuntimeMaxSec=600 -p NoNewPrivileges=yes
    -p PrivateNetwork=yes -p PrivateMounts=yes -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes -p UMask=0077
    -p "ReadWritePaths=$O" -p "Environment=PYTHONDONTWRITEBYTECODE=1")
  while [ "$1" != -- ]; do p+=(-p "$1"); shift; done; shift
  systemd-run --quiet --wait --pipe --collect --unit "enclave-hsmoke-$ID-$n" "${p[@]}" -- "$@" > "$O/$n.out" 2>&1; local r=$?
  echo "--- $n rc=$r"; tail -c 600 "$O/$n.out"; echo; return $r; }
before=$(sed 's/^[0-9]* [0-9]* //' /proc/self/mountinfo | sort)
# ---- T0 ----
nv=$($NODE --version 2>/dev/null); pv=$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null)
echo "node $nv $(sha256sum < $NODE | cut -c1-64) python $pv systemd $(systemctl --version | head -1)"
[ "$(echo "${nv#v}" | cut -d. -f1)" -ge 18 ] 2>/dev/null && ok "T0 node $nv >= 18" || bad "T0 node '$nv' < 18 or absent"
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' && ok "T0 python $pv >= 3.11" || bad "T0 python $pv < 3.11"
# ---- T1 ----
unit verify -- "$K/bundle/bin/historical-capture" verify && grep -q '"bundleId": "020cc8bf8045cf48441349065c039171fc303783b2fa05dd5fa8f5a45296e22e"' "$O/verify.out" \
  && ok "T1 kit bundle copy verifies (020cc8bf)" || bad "T1 kit bundle copy does not verify"
# ---- T2: the 9 tests (structured TestResult receipt) ----
unit tests WorkingDirectory=$K/tests "Environment=NODE=$NODE AO_SRC=$K/bundle/lib TEST_ORIGIN_EXTRACT=$K/aux/test_origin_extract.py" -- \
  /usr/bin/python3 -B run_all.py "$O/tests.json" "$O/tests.txt" 9 test_anchored_origin
python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); c=d["counts"]; print(json.dumps(c)); sys.exit(0 if d["pass"] is True and c=={"testsRun":9,"failures":0,"errors":0,"skipped":0,"expectedFailures":0,"unexpectedSuccesses":0} else 1)' "$O/tests.json" \
  && ok "T2 test_anchored_origin 9/9 on node $nv (bundle-copy lib, rpcbase, private unit)" || { bad "T2 tests"; tail -40 "$O/tests.txt" 2>/dev/null; }
# ---- T3/T4/T5: the real origin CLI (bundle copy), refusals only ----
HC="$K/bundle/bin/historical-capture"; REC=$K/bundle/receipt/a1-evidence.json
printf '%s' '{"verdict": "A1-authenticated", "N": "52866960", "outputRoot": "0x00"}' > "$K/fx/bad-receipt.json"; chmod 0644 "$K/fx/bad-receipt.json"
unit badreceipt -- $HC origin --base-bin "$K/fx/base" --base-sha256 "$FSHA" --datadir "$K/fx/ro" --scratch "$O/scratch-a" --receipt "$K/fx/bad-receipt.json" --node $NODE --out "$O/o-a.json"
r=$?; [ $r = 2 ] && grep -q 'not the pinned' "$O/badreceipt.out" && [ ! -e "$O/o-a.json" ] && ok "T3 origin refuses a non-pinned receipt (rc 2)" || bad "T3 rc $r"
unit nodb -- $HC origin --base-bin "$K/fx/base" --base-sha256 "$FSHA" --datadir "$K/fx/nodb" --scratch "$O/scratch-b" --receipt "$REC" --node $NODE --out "$O/o-b.json"
r=$?; [ $r = 2 ] && grep -q 'datadir has no db/' "$O/nodb.out" && [ ! -e "$O/o-b.json" ] && ok "T4 origin refuses a datadir without db/ (rc 2)" || bad "T4 rc $r"
unit rwbind "ReadWritePaths=$K/fx/ro" -- $HC origin --base-bin "$K/fx/base" --base-sha256 "$FSHA" --datadir "$K/fx/ro" --scratch "$O/scratch-c" --receipt "$REC" --node $NODE --out "$O/o-c.json"
r=$?; [ $r = 2 ] && grep -q 'not on a read-only mount' "$O/rwbind.out" && ok "T5a datadir writable inside the unit (ReadWritePaths): the CLI refuses 'not on a read-only mount'" || bad "T5a rc $r"
unit robind "BindReadOnlyPaths=$K/fx/ro" -- $HC origin --base-bin "$K/fx/base" --base-sha256 "$FSHA" --datadir "$K/fx/ro" --scratch "$O/scratch-d" --receipt "$REC" --node $NODE --out "$O/o-d.json"
r=$?; [ $r = 2 ] && grep -q 'StageCheckpoints\[Finish\] absent' "$O/robind.out" && ! grep -q 'read-only mount' "$O/robind.out" \
  && ok "T5b with BindReadOnlyPaths (private): the read-only gate passes; stops at the next gate (Finish absent)" || bad "T5b rc $r"
# ---- T6 ----
after=$(sed 's/^[0-9]* [0-9]* //' /proc/self/mountinfo | sort)
[ "$before" = "$after" ] && touch "$K/fx/ro/db/.w" && rm -f "$K/fx/ro/db/.w" && ok "T6 no persistent mount: guest mountinfo unchanged; fixture datadir writable again" \
  || bad "T6 mount table changed or fixture still read-only"
# ---- info: installed production bundle (read-only verify; root install 1318) ----
if [ -x "$PROD/bin/historical-capture" ]; then "$PROD/bin/historical-capture" verify > "$O/prod-verify.json" 2>&1 && echo "INFO production bundle at $PROD verifies" || echo "INFO production bundle at $PROD does NOT verify: $(tail -c 200 "$O/prod-verify.json")"
else echo "INFO production bundle not installed at $PROD (root 1318 pending): not required here"; fi
left=$(units); [ -z "$left" ] || bad "units remain: $left"
[ $rc = 0 ] && echo "SMOKE PASS (runtime qualification only: refusals + private read-only semantics + 9 tests; NOT a positive capture proof)" || echo "SMOKE FAIL"
exit $rc
