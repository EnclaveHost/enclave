#!/bin/bash
# The whole check, one queue job: syntax, python unit tests, node tests (boot-funding against a stub chain + the python gate;
# fee arithmetic), mutation check of the guards, secret/literal scans of every file to be committed.
set -uo pipefail
cd "$(dirname "$0")"
rc=0
for f in *.py tests/*.py; do python3 -m py_compile "$f" || rc=1; done
for f in *.mjs tests/*.mjs; do node --check "$f" || rc=1; done
echo "== python"; python3 -m unittest discover -s tests -v 2>&1 | tail -80; [ "${PIPESTATUS[0]}" -eq 0 ] || rc=1
echo "== node"; node --test --test-concurrency=1 tests/boot-funding.test.mjs tests/attest-price.test.mjs fee-fit.test.mjs || rc=1
echo "== mutants"; python3 mutants.py || rc=1
echo "== scan"; bash scan.sh || rc=1
find . -name __pycache__ -prune -exec rm -rf {} +
echo "== RESULT rc=$rc"; exit $rc
