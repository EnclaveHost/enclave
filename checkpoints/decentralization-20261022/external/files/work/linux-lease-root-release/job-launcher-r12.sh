#!/bin/sh
set -eu
L=/home/steven/Documents/Codex/2026-10-18/wo/work/linux-lease-root-release
S=$L/stage
R=$S/metal-c083e27a8
python3 - "$R" "$L/tree" <<'PYCODE'
from pathlib import Path
import os,sys
p=Path(sys.argv[1])/'node_modules'; src=Path(sys.argv[2])/'node_modules'
assert p.is_symlink(), 'expected the identified development-only link'
assert os.readlink(p)==os.readlink(src), 'unexpected dependency link'
p.unlink()
PYCODE
node "$S/launcher-check.mjs" "$R" "$S/extract"
echo RELEASE-OK
