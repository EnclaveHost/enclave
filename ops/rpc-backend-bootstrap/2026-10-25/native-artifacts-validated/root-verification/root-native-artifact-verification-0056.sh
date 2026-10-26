#!/bin/bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
python3 - <<'PY'
import json,hashlib,pathlib
p=pathlib.Path('canonical-verifier-binary-stage/run/build-20261026T004633Z/out')
j=json.loads((p/'provenance.json').read_text())
def h(p):
 with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
assert h(p/'helios')==j['artifact']['sha256']=='8250f08a7b0e1f2432ea6262903ca3203b60bca6a8e17abd6d9bccbe0dbfa378'
assert (p/'helios').stat().st_size==j['artifact']['bytes']
for name,digest in j['smoke'].items():assert h(p/name)==digest,name
for name,digest in j['testedBy'].items():assert h(pathlib.Path(name))==digest,name
b=pathlib.Path('../../outputs/rpc-production-final-20261025/m7-m10-release-completed-0055')
r=json.loads((b/'receipt.json').read_text());j=json.loads((b/'provenance.json').read_text())
assert r['pass'] is True and r['systemdRunExit']==0
assert r['artifactSha256']==j['artifact']['sha256']=='4a7c013a510f88166779281ad0108790f25efa07f22f6457d54add709488372f'
assert h(b/'release.out')==r['outSha256']
assert h(b/'SHA256SUMS')==r['outDirSha256sums']
for name,digest in j['smoke'].items():assert h(b/name)==digest,name
assert j['source']['manifest']==j['testedBy']['run2TreeManifest']
assert j['testedBy']['run2OriginalReceiptPass'] is False
assert j['testedBy']['compoundGate']['accepted'] is True
print('PASS: artifact/provenance/evidence hashes; original incomplete receipt retained; actual compound gate accepted')
PY
remote=$(ssh -F /home/steven/.local/state/enclave-rpc-production/ssh_config enclave-rpc 'sudo sha256sum /srv/m10-guest-validation/release/run-1/out/base')
printf '%s\n' "$remote"
[[ ${remote%% *} == 4a7c013a510f88166779281ad0108790f25efa07f22f6457d54add709488372f ]]
