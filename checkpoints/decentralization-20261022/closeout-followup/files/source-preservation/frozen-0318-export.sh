#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
date -u +%FT%TZ
python3 -I manifest-drift.py | python3 -I -c 'import json,sys; d=json.load(sys.stdin); print("drift", len(d["drift"]), "missing", len(d["missing"]), [x["source"] for x in d["drift"]][:20], d["missing"][:20])'
python3 -I export-frozen-0318.py
python3 -I verify-frozen-0318-export.py
date -u +%FT%TZ
