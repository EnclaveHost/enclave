#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
python3 verify-inputs.py
export GOOS=linux GOARCH=amd64 GOAMD64=v1 GOEXPERIMENT=nodwarf5
bash compile.sh
python3 pack.py
python3 - <<'PY'
from pathlib import Path
import json
x=json.loads(Path('initrd-build.json').read_text());e=json.loads(Path('expected-initrd.json').read_text())
assert x['initrdSha256']==e['initrdSha256'], 'Toolchain output differs from the pinned candidate; refusing image build'
PY
node --expose-gc --max-old-space-size=160 build-image.mjs "$PWD/shield-direct.cpio.gz" 22c9666b5817ef651365892bf836c68a5c285b8ff94cdd3ad3e30f2bee1d7eaf "$PWD/image" "$PWD/inputs/kernel-vtpm.elf" "$PWD/inputs/openhcl-shield.cpio.gz"
python3 - <<'PY'
from pathlib import Path
import json,hashlib
expected=json.loads(Path('expected-image.json').read_text());p=Path('image')/('vbs-linux-'+expected['binSha'][:8])/'vbs-linux-candidate.bin'
assert hashlib.sha256(p.read_bytes()).hexdigest()==expected['binSha'],'Final image differs'
print('Verified candidate:',p)
print('Not hardware validated; not approved for production activation.')
PY
