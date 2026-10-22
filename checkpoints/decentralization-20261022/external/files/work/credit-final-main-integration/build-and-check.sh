#!/usr/bin/env bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/enclave
node scripts/build-host-service-packages.mjs
node scripts/build-host-service-packages.mjs --check
node scripts/build-windows-lease-runtime.mjs
node scripts/build-windows-lease-runtime.mjs --check
python3 - <<'CHECK'
from pathlib import Path
import hashlib,json,datetime
base=Path.cwd().parent/'credit-final-main-integration';p=base/'inventory.json';d=json.loads(p.read_text())
for g in d['generated']:
 actual=hashlib.sha256(Path(g['path']).read_bytes()).hexdigest()
 assert actual==g['regenerated'],(g['path'],actual,g['regenerated'])
d.update(state='30 source + 7 regenerated files integrated; exact tested artifacts; not deployed',generatedVerifiedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
p.write_text(json.dumps(d,indent=2)+'\n');(Path.cwd().parents[1]/'outputs/decentralization-audit/credit-final-source-integration.json').write_text(json.dumps(d,indent=2)+'\n')
print('Generated7 all exactly match tested finalcandidate; checks pass')
CHECK
