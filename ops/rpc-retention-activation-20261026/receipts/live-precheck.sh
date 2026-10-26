#!/bin/bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
S=base-retention-stage/activation-r2
OUT=logs/root-retention-live-precheck-1047
REMOTE=/run/enclave-retention-precheck-1047
mkdir "$OUT"
SSH=(ssh -F /home/steven/.local/state/enclave-rpc-production/ssh_config -o BatchMode=yes -o ConnectTimeout=10 enclave-rpc)
STAGED=0
cleanup() { if [ "$STAGED" = 1 ]; then "${SSH[@]}" "sudo -n rm -rf -- $REMOTE"; fi; }
trap cleanup EXIT
test "$(sha256sum "$S/SHA256SUMS" | cut -d' ' -f1)" = 409b8ed25a2f5096783c5a8d9acf3e330450d37265850d68d5c4f9a58160bc92
(cd "$S" && sha256sum -c --quiet SHA256SUMS)
"${SSH[@]}" 'systemctl show enclave-rpc-base-snapshot.service enclave-l1-el.service enclave-l1-cl.service -p Id -p MainPID' > "$OUT/pids-before.txt"
"${SSH[@]}" "sudo -n test ! -e $REMOTE && sudo -n mkdir -m 0700 $REMOTE"
STAGED=1
tar -C "$S" -cf - retention_guard.py cached_download_preflight.py | "${SSH[@]}" "sudo -n tar -xf - -C $REMOTE"
printf '%s\n' '3eff725f00e728eeb851429b0b078dd6a17b75274fe62476808209e076d35897  retention_guard.py' 'af70424cf32db44f95be43094180085a41b23f21ee64ccd7aac5eb2f236c3411  cached_download_preflight.py' | "${SSH[@]}" "cd $REMOTE 2>/dev/null || exec sudo -n sh -c 'cd $REMOTE && sha256sum -c -'" > "$OUT/hashes.txt"
set +e
timeout 120 "${SSH[@]}" "sudo -n python3 -I -B $REMOTE/retention_guard.py pre" > "$OUT/pre.json" 2>"$OUT/pre.err"
rc=$?
set -e
echo "$rc" > "$OUT/guard.rc"
"${SSH[@]}" 'systemctl show enclave-rpc-base-snapshot.service enclave-l1-el.service enclave-l1-cl.service -p Id -p MainPID' > "$OUT/pids-after.txt"
cmp "$OUT/pids-before.txt" "$OUT/pids-after.txt"
python3 -I - "$OUT" <<'PY'
import json,pathlib,sys
o=pathlib.Path(sys.argv[1]);j=json.loads((o/'pre.json').read_text());rc=int((o/'guard.rc').read_text())
assert rc==3 and j['admitted'] is False,(rc,j)
assert j['missingArchives']==18,j
assert j['preflight']['missing']['archives']==18
assert j['preflight']['missing']['compressedBytes']==221616054366
assert j['preflight']['missing']['extractedBytes']==409990674216
allowed=('first download enclave-rpc-base-snapshot.service is not inactive/dead','first download marker snapshot-complete absent','processes use the datadir')
unexpected=[r for r in j['refusals'] if not r.startswith(allowed)]
assert not unexpected,unexpected
assert any(r.startswith(allowed[0]) for r in j['refusals'])
print(json.dumps({'readOnlyGuard':'refused running extraction as required','missingArchives':18,'capacityAdmitted':j['preflight']['admitted'],'refusals':j['refusals'],'productionPidsUnchanged':True},indent=1))
PY
