#!/bin/bash
# Resolution only (no compilation): metadata, lock diff vs upstream, reth check.
set -euo pipefail
cd "$(dirname "$0")"
export CARGO_TARGET_DIR="$PWD/target" CARGO_TERM_COLOR=never
timeout -k 10 600 cargo metadata --format-version 1 > runs/metadata.json
python3 -I tools/lock-diff.py upstream/base-5476069f/Cargo.lock Cargo.lock
python3 -I - <<'PY'
import json
m = json.load(open("runs/metadata.json"))
names = sorted({p["name"] for p in m["packages"]})
gits = sorted({p["name"] + " " + (p.get("source") or "") for p in m["packages"] if (p.get("source") or "").startswith("git+")})
print(json.dumps({"resolvedPackages": len(names),
                  "rethPackages": [n for n in names if n.startswith("reth")],
                  "gitPackages": gits}, indent=1))
PY
