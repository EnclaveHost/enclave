"""Read-only: report which existing closeout-followup MANIFEST entries no longer match their source bytes."""
from pathlib import Path
import hashlib
import json
import sys

root = Path(__file__).resolve().parents[3]
manifest = root / 'work/source-checkpoint-20261022/main-repo/checkpoints/decentralization-20261022/closeout-followup/MANIFEST.json'
m = json.loads((Path(sys.argv[1]) if len(sys.argv) > 1 else manifest).read_text())
drift, missing = [], []
for e in m['entries']:
    p = root / e['source']
    if 'capturedFromUnmutatedBackup' in e:
        p = root / e['capturedFromUnmutatedBackup']
    if not p.is_file():
        missing.append(e['source'])
        continue
    h = hashlib.sha256(p.read_bytes()).hexdigest()
    if h != e['sha256']:
        drift.append({'source': e['source'], 'manifest': e['sha256'][:8], 'now': h[:8]})
print(json.dumps({'entries': len(m['entries']), 'unchangedAlreadyPreserved': len(m['unchangedAlreadyPreserved']),
                  'drift': drift, 'missing': missing}, indent=1))
