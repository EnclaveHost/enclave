#!/bin/bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
test "$(sha256sum derivation-client-stage/combined-r1/SHA256SUMS | cut -d' ' -f1)" = 69160868712324190a95e06cef91dd30526c7afe79896838ca8d1dae2bc32da1
if pgrep -x cargo >/dev/null || pgrep -x rustc >/dev/null; then echo 'REFUSED: native build already active'; exit 9; fi
bash derivation-client-stage/combined-r1/jobs/build-test.sh all
python3 -I - <<'PY'
from pathlib import Path
import hashlib,re
c=Path('derivation-client-stage/combined-r1')
runs=sorted((c/'logs').glob('run-*'),key=lambda p:p.stat().st_mtime)
o=runs[-1]
text=(o/'harness-test.txt').read_text()
assert re.search(r'^test result: ok\. 9 passed; 0 failed; 0 ignored;',text,re.M), 'expected exactly9 actual native tests'
assert (o/'lock.txt').read_text().strip()=='Cargo.lock unchanged f122da76'
lock=c/'build/deps-43698236e9186750/base/Cargo.lock'
assert hashlib.sha256(lock.read_bytes()).hexdigest()=='f122da76b80d5df44c9dc0c6fc4efc335abe295280fa49325f367ddcfc7b6a8f'
assert len((o/'binaries.sha256').read_text().splitlines())==2
print('ROOT checked native test count, unchanged lock and both binary receipts')
print('Config hash/serde tests from r4 still require separate native validation; real witness/SNP/provider not yet qualified')
PY
