#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/portable"
bash compile.sh
python3 pack.py
python3 - <<'PY'
from pathlib import Path
import json
actual=json.loads(Path('initrd-build.json').read_text());expected=json.loads(Path('expected-initrd.json').read_text());assert actual['initrdSha256']==expected['initrdSha256'],(actual['initrdSha256'],expected['initrdSha256']);print('Portable compiled initrd matches original candidate')
PY
node --expose-gc --max-old-space-size=160 build-image.mjs "$PWD/shield-direct.cpio.gz" 22c9666b5817ef651365892bf836c68a5c285b8ff94cdd3ad3e30f2bee1d7eaf "$PWD/image" "$PWD/inputs/kernel-vtpm.elf" "$PWD/inputs/openhcl-shield.cpio.gz"
python3 - <<'PY'
from pathlib import Path
import json,hashlib
expected=json.loads(Path('expected-image.json').read_text());p=Path('image')/('vbs-linux-'+expected['binSha'][:8])/'vbs-linux-candidate.bin';assert hashlib.sha256(p.read_bytes()).hexdigest()==expected['binSha'];print('Portable final image matches original candidate')
PY
