#!/bin/bash
# ROOT-RUN, READ-ONLY operator preflight for the private Base state holder. It changes nothing: no install, no unit,
# no mount, no allocation, no network. Usage:
#   operator-preflight.sh CONFIG RENDER_DIR [RELEASE_TARBALL]
# 1. (optional) the downloaded release tarball matches BINARY.json (size + sha256)
# 2. the installed binary matches the pin, prints the reviewed --version, and lists every rendered flag in its help
# 3. holder.py validate (a --review config is refused) and preflight: placement (HDD-backed datadir, or an HDD origin
#    plus NVMe cache), the download-generated reth.toml, free space, CURRENT MemAvailable >= limits.memoryMaxBytes, ports
# 4. the rendered storage script's measured aggregate NVMe cap check (verify-cap; needs the shared inventory)
set -euo pipefail
H=$(dirname "$(readlink -f "$0")")
CFG=${1:?config}; RENDER=${2:?render dir}; TB=${3:-}
if [ -n "$TB" ]; then
  python3 -I - "$H/BINARY.json" "$TB" <<'PY'
import hashlib, json, os, sys
b = json.load(open(sys.argv[1]))['tarball']; p = sys.argv[2]
h = hashlib.sha256(open(p, 'rb').read()).hexdigest()
assert os.path.getsize(p) == b['size'] and h == b['sha256'], f'tarball {os.path.getsize(p)} {h} != {b["size"]} {b["sha256"]}'
print(json.dumps({'tarball': 'matches BINARY.json', 'sha256': h}))
PY
fi
python3 -I "$H/holder.py" validate "$CFG" > /dev/null
python3 -I "$H/holder.py" preflight "$CFG"
[ -x "$RENDER/holder-storage.sh" ] || { echo "render the package first: holder.py render CONFIG RENDER_DIR" >&2; exit 2; }
"$RENDER/holder-storage.sh" verify-cap
echo "operator preflight: PASS (nothing was changed)"
