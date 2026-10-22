#!/usr/bin/env bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/enclave
node scripts/build-platform-api-guest-bundle.mjs
node scripts/build-platform-api-guest-bundle.mjs --check
python3 - <<'CHECK'
from pathlib import Path
import json,hashlib,datetime
m=Path.cwd();o=m.parent/'control-bundle-final-refresh';d=json.loads((o/'inventory.json').read_text());h=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
manifest=json.loads((m/'metal/guest/platform-api.bundle.mjs.manifest.json').read_text())
assert all(h(m/n)==sha for n,sha in manifest['inputs'].items())
assert all(h(m/v['source'])==v['sha256'] for v in manifest['sidecars'].values())
d.update(at=datetime.datetime.now(datetime.timezone.utc).isoformat(),state='generated bundle and manifest refreshed; all inputs match main; not deployed',after={n:h(m/n) for n in d['before']},inputs=len(manifest['inputs']))
(o/'inventory.json').write_text(json.dumps(d,indent=2)+'\n');(m.parents[1]/'outputs/decentralization-audit/platform-api-final-bundle-refresh.json').write_text(json.dumps(d,indent=2)+'\n')
print('API bundle closure verified',d['inputs'],'inputs')
CHECK
