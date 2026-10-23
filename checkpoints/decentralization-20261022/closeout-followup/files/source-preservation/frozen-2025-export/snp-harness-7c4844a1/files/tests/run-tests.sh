#!/bin/bash
# ONE queued 256 MiB job: syntax, unit tests, node tests, transformed-copy hashes, secret scans. Wall-clock bounded inside;
# no QEMU, no ports, no hardware. Run from q.sh only.
set -u
cd "$(dirname "$0")/.."
export PYTHONDONTWRITEBYTECODE=1
rc=0
step() { local name=$1; shift; echo "== $name"; "$@"; local c=$?; [ $c = 0 ] || { echo "!! FAIL $name ($c)"; rc=1; }; }
step "python syntax" timeout -k 5 30 python3 -c 'import ast,sys; [ast.parse(open(f).read(), f) for f in sys.argv[1:]]' canary/recovery_canary.py tests/test_recovery_canary.py
for f in canary/resolve-register.mjs canary/resolve-as-original.mjs tests/canary-node.test.mjs; do step "node --check $f" timeout -k 5 30 node --check "$f"; done
step "bash -n" bash -n tests/run-tests.sh
step "transformed copy sha256 (a5eae96c fixture and repo-r2 host.mjs)" timeout -k 5 30 python3 -c '
import sys, pathlib, hashlib; sys.path.insert(0, "canary"); import recovery_canary as rc
for p in ("tests/fixtures/host-a5eae96c.mjs", "../custody-v2-release-20261023/repo-r2/custody/v2/host.mjs"):
    src = pathlib.Path(p).read_bytes(); out = rc.transform_host(src, hashlib.sha256(src).hexdigest(), rc.INJECT_FILE.read_text())
    print(p, "source", hashlib.sha256(src).hexdigest(), "copy", hashlib.sha256(out).hexdigest(), "inserted", len(out) - len(src))'
step "python unit tests" timeout -k 5 180 python3 -m unittest -v tests/test_recovery_canary.py
step "node tests" timeout -k 5 180 node --test --test-force-exit --test-concurrency=1 tests/canary-node.test.mjs
step "gitleaks (working tree, no git)" timeout -k 5 120 gitleaks dir . --no-banner --redact --exit-code 1
step "crypto-key scan (staged)" timeout -k 5 120 python3 ../custody-v2-durability-20261023/repo/.githooks/scan-crypto-keys.py --staged
echo "== RESULT rc=$rc"
exit $rc
