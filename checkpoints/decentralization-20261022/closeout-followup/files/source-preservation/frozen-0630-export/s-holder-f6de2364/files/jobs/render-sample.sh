#!/bin/bash
# Render a SAMPLE package for review (dummy binary pin, example L1 hosts): NOT deployable.
set -eu
cd "$(dirname "$0")/.."
python3 -I - <<'PY'
import json, copy
c = json.load(open('holder/holder.example.json'))
c['binary']['sha256'] = '0' * 63 + '1'          # SAMPLE: not a real pin
c['l1'] = {'executionRpc': 'https://l1-execution.example.invalid/', 'beacon': 'https://l1-beacon.example.invalid/', 'trustRpc': False}
open('evidence/render-sample.config.json', 'w').write(json.dumps(c, indent=1))
PY
rm -rf evidence/render-sample
python3 -I holder/holder.py validate evidence/render-sample.config.json > evidence/render-sample.validate.json
python3 -I holder/holder.py render evidence/render-sample.config.json evidence/render-sample
python3 -I holder/holder.py validate holder/holder.example.json || true
