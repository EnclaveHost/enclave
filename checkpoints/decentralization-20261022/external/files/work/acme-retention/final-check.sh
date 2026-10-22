#!/bin/bash
# FINAL (reviewer 9d): the full suite ONCE on the revised tree; then ONLY the newly added targeted tests on base; then
# ONE targeted mutant (M6: a 4xx counted as uncertain) against only the non-JSON 400 test. Isolated copies only.
cd "$(dirname "$0")"
P='non-JSON|NON-JSON|ANOTHER NAME|survives a relay restart|authz read timeout BEFORE the finalize'
echo "== TREE full suite"; (cd tree && timeout 420 node --test test/certs.test.mjs 2>&1 | grep -E "^# (tests|pass|fail)|^not ok")
echo "== BASE e15802cf, new targeted tests only"; (cd base && timeout 300 node --test --test-name-pattern="$P" test/certs.test.mjs 2>&1 | grep -E "^# (tests|pass|fail)|^(not )?ok ")
rm -rf mut; mkdir mut; cp -r tree/relay tree/test tree/package.json mut/; ln -sfn ../../enclave/node_modules mut/node_modules
python3 - <<'PY'
p='mut/relay/certs.js'; s=open(p).read(); a=' && !(e.status >= 400 && e.status < 500)'; assert s.count(a)==1; open(p,'w').write(s.replace(a,''))
PY
echo "== M6 (4xx counted uncertain), non-JSON 400 test only"; (cd mut && timeout 300 node --test --test-name-pattern='NON-JSON 400' test/certs.test.mjs 2>&1 | grep -E "^# (tests|pass|fail)|^(not )?ok ")
rm -rf mut
