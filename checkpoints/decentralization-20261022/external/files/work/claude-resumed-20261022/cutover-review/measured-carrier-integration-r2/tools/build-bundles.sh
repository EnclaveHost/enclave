#!/usr/bin/env bash
# build-bundles.sh: the platform API guest bundle with the changed measured-control.mjs, with provenance.
#   1. OLD: a real staged tree of the CURRENT manifest's exact inputs; the unchanged builder's --check must reproduce the current
#      bundle 2a903c36 and its manifest BYTE FOR BYTE (the recipe and the baseline are the ones that made the shipped file).
#   2. NEW: the same staging with ONLY metal/guest/measured-control.mjs replaced by src (f2648d65); the same builder writes
#      bundle/new/platform-api.bundle.mjs + its manifest.
#   3. The manifest diff must be exactly: that one input hash, the bundle sha256 and its byte count.
set -euo pipefail; P=$(cd "$(dirname "$0")/.." && pwd); W=$(mktemp -d /tmp/pa-bundle-XXXXXX); trap 'rm -rf "$W"' EXIT
L=/home/steven/Documents/Codex/2026-10-18/wo/work/lease-readiness-20261022/tree
python3 "$P/tools/stage-bundle-tree.py" "$W/old" > "$P/bundle/stage-old.json"
( cd "$W/old" && node scripts/build-platform-api-guest-bundle.mjs --check )
python3 "$P/tools/stage-bundle-tree.py" "$W/new" --measured-control "$P/src/metal/guest/measured-control.mjs" > "$P/bundle/stage-new.json"
rm -rf "$P/bundle/new"; ( cd "$W/new" && node scripts/build-platform-api-guest-bundle.mjs --out "$P/bundle/new" )
mkdir -p "$P/bundle/old"; cp "$L/metal/guest/platform-api.bundle.mjs" "$L/metal/guest/platform-api.bundle.mjs.manifest.json" "$P/bundle/old/"
python3 - "$P" <<'PY'
import json, sys, hashlib
P = sys.argv[1]; o = json.load(open(f'{P}/bundle/old/platform-api.bundle.mjs.manifest.json')); n = json.load(open(f'{P}/bundle/new/platform-api.bundle.mjs.manifest.json'))
diff = sorted(k for k in set(o['inputs']) | set(n['inputs']) if o['inputs'].get(k) != n['inputs'].get(k))
other = sorted(k for k in set(o) | set(n) if k != 'inputs' and o.get(k) != n.get(k))
assert diff == ['metal/guest/measured-control.mjs'], diff
assert other == ['bytes', 'sha256'], other
assert n['inputs']['metal/guest/measured-control.mjs'] == hashlib.sha256(open(f'{P}/src/metal/guest/measured-control.mjs', 'rb').read()).hexdigest()
assert n['sha256'] == hashlib.sha256(open(f'{P}/bundle/new/platform-api.bundle.mjs', 'rb').read()).hexdigest()
print(json.dumps({'old': {'sha256': o['sha256'], 'bytes': o['bytes']}, 'new': {'sha256': n['sha256'], 'bytes': n['bytes']}, 'inputsChanged': diff}, indent=1))
PY
