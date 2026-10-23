#!/bin/bash
# Second export (must reproduce INVENTORY.json byte-identically), offline tree verification, pins, append-only capture.
set -euo pipefail
cd "$(dirname "$0")"
M=../../source-checkpoint-20261022/main-repo/checkpoints/decentralization-20261022/closeout-followup/MANIFEST.json
date -u +%FT%TZ
python3 -I export-frozen-1639.py
first=$(sha256sum frozen-1639-export/INVENTORY.json | cut -d' ' -f1)
python3 -I export-frozen-1639.py
[ "$(sha256sum frozen-1639-export/INVENTORY.json | cut -d' ' -f1)" = "$first" ] || { echo 'INVENTORY changed between exports'; exit 4; }
echo "INVENTORY byte-identical across two exports: $first"
python3 -I verify-frozen-1639-export.py | tail -1
python3 -I - <<'PY'
import hashlib, json
fx = 'frozen-1639-export/'
pins = {n: hashlib.sha256(open(fx + n, 'rb').read()).hexdigest() for n in ('INVENTORY.json', 'REBUILD.md', 'REPRODUCE-CHECK.txt')}
open('frozen-1639-pins.json', 'w').write(json.dumps(pins, indent=1) + '\n'); print(pins)
PY
cp "$M" /tmp/frozen-1639-manifest-before.json
python3 -I capture-frozen-1639.py
python3 -I - "$M" <<'PY'
import json, sys
old = json.load(open('/tmp/frozen-1639-manifest-before.json')); new = json.load(open(sys.argv[1]))
assert new['entries'][:len(old['entries'])] == old['entries'], 'an existing entry changed'
for k in ('unchangedAlreadyPreserved', 'status', 'exclusions', 'supersessions', 'capturedAt'):
    assert new[k] == old[k], k
added = new['entries'][len(old['entries']):]
EXP = 'source-preservation/frozen-1639-export/'   # exact commit content (S committed its own logs/evidence): only /logs/ is allowed there
# whole path COMPONENTS (frozen-1639-capture-2 refused a B source FILE named cargo-home-from-lock.py on a bare substring match):
# a build/cache DIRECTORY anywhere on the path, or logs/ outside the exact-commit-content export
def bad_path(src):
    dirs = src.split('/')[:-1]
    return (any(d in ('target', 'node_modules', 'artifacts', '__pycache__', 'tmp') or d.startswith('cargo-home') for d in dirs)
            or ('logs' in dirs and EXP not in src))
bad = [e['source'] for e in added if bad_path(e['source'])]
print(json.dumps({'before': len(old['entries']), 'after': len(new['entries']), 'added': len(added),
                  'bytes': sum(e['bytes'] for e in added), 'forbiddenAdded': bad, 'appends': new['appends']}, indent=1))
assert not bad and len(new['entries']) == len(old['entries']) + len(added)
PY
date -u +%FT%TZ
