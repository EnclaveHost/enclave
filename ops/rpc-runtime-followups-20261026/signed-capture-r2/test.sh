#!/bin/bash
# Root-coordinated shared guard 512MiB -> unshare -Urn bash test.sh BINARY
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
sha256sum -c --quiet SHA256SUMS
python3 -I - <<'CHECK'
import json,hashlib
from pathlib import Path
for name,digest in json.loads(Path('INPUTS.json').read_text())['runtimeInputs'].items():
    if hashlib.sha256(Path(name).read_bytes()).hexdigest()!=digest:
        raise SystemExit('runtime changed: '+name)
CHECK
: "${1:?supply qualified native binary path}"
export CANDIDATE_BINARY="$1"
exec env -i PATH=/usr/bin:/bin LANG=C CANDIDATE_BINARY="$CANDIDATE_BINARY" /usr/bin/node --test capture.test.mjs
