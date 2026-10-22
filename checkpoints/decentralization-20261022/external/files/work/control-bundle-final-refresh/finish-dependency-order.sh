#!/usr/bin/env bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/enclave
before=$(sha256sum metal/guest/lease-gas-conduit.bundle.mjs | cut -c1-64)
node scripts/build-metal-lease-gas.mjs
node scripts/build-metal-lease-gas.mjs --check
after=$(sha256sum metal/guest/lease-gas-conduit.bundle.mjs | cut -c1-64)
if [ "$before" != "$after" ]; then node scripts/build-platform-api-guest-bundle.mjs; fi
node scripts/build-platform-api-guest-bundle.mjs --check
python3 - <<'CHECK'
from pathlib import Path
import json,hashlib,datetime
m=Path.cwd();o=m.parent/'control-bundle-final-refresh';p=o/'inventory.json';d=json.loads(p.read_text());h=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
for name in ['metal/guest/lease-gas-conduit.bundle.mjs.manifest.json','metal/guest/platform-api.bundle.mjs.manifest.json']:
 j=json.loads((m/name).read_text()); assert all(h(m/n)==s for n,s in j['inputs'].items())
d.update(at=datetime.datetime.now(datetime.timezone.utc).isoformat(),state='API and Linux conduit bundle closures current; not deployed',after={n:h(m/n) for n in d['before']})
p.write_text(json.dumps(d,indent=2)+'\n');(m.parents[1]/'outputs/decentralization-audit/platform-api-final-bundle-refresh.json').write_text(json.dumps(d,indent=2)+'\n')
print('Linux conduit and API closures verified')
CHECK
