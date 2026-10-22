#!/bin/bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/native-front-abort/repo
node scripts/build-platform-api-guest-bundle.mjs
node scripts/build-platform-api-guest-bundle.mjs --check
node --check metal/guest/platform-api.bundle.mjs
set +e
out=$(timeout 20 node metal/guest/platform-api.bundle.mjs --config /nonexistent/enclave-root-smoke-config.json 2>&1); rc=$?
set -e
[ "$rc" = 1 ] && [[ "$out" == '[platform-api] ENOENT'* ]]
printf '%s\n' 'PASS compiled role entry: missing config fails through the platform API entry'
set +e
out=$(timeout 20 node metal/guest/platform-api.bundle.mjs --relay-child 2>&1); rc=$?
set -e
[ "$rc" = 1 ] && [[ "$out" == '[platform-api] the relay child runs only under the platform-api role (IPC)' ]]
printf '%s\n' 'PASS compiled relay entry: missing parent IPC fails through the role barrier'
python3 - <<'PY'
import json,hashlib,pathlib
p=pathlib.Path('metal/guest/platform-api.bundle.mjs');m=json.loads(p.with_name(p.name+'.manifest.json').read_text());assert hashlib.sha256(p.read_bytes()).hexdigest()==m['sha256']
for name in ['metal/guest/platform-api-role.mjs','metal/guest/platform-api-verify.mjs','metal/guest/measured-control.mjs','metal/guest/native-issuer.mjs','metal/guest/native-certificate.mjs']:
 assert hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest()==m['inputs'][name]
assert 'scripts/platform-api-admin.mjs' not in m['inputs']
print(json.dumps({'bundle':m['sha256'],'bytes':m['bytes'],'inputs':len(m['inputs']),'combinedSourceHashesChecked':True,'adminCliNotInBundle':True}))
PY
