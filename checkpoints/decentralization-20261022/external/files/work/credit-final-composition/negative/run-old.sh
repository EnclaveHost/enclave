#!/usr/bin/env bash
# Negative control: the FINAL test/credit-vault-relay-concurrency.test.mjs against the OLD cli/credit-vault.mjs (the ff9c56a2
# candidate's, sha256 80735bda…). An overlay (negative/old) links every tree entry except a real cli/ and test/ (links
# inside), with real copies of the old module and the final test. Node resolves a module's imports from its realpath, so the
# old module is a real file there; everything else is the tree's. Must exit 0 only if the suite FAILS as expected.
set -euo pipefail
N="$(cd "$(dirname "$0")" && pwd)"; T="$(cd "$N/../tree" && pwd)"; O="$N/old"
want=80735bda3d737d4613391d4aab15145a2aa755d5c0b7cdc64971f96cef54cc57
[ "$(sha256sum "$N/credit-vault.old.mjs" | cut -c1-64)" = "$want" ] || { echo "old module is not the candidate's"; exit 1; }
rm -rf "$O"; mkdir -p "$O/cli" "$O/test"
for e in "$T"/* "$T"/.[!.]*; do b=$(basename "$e"); [ "$b" = cli ] || [ "$b" = test ] || ln -s "$e" "$O/$b"; done
for e in "$T"/cli/*; do ln -s "$e" "$O/cli/"; done
for e in "$T"/test/*; do ln -s "$e" "$O/test/"; done
rm "$O/cli/credit-vault.mjs" "$O/test/credit-vault-relay-concurrency.test.mjs"
cp "$N/credit-vault.old.mjs" "$O/cli/credit-vault.mjs"
cp "$T/test/credit-vault-relay-concurrency.test.mjs" "$O/test/"
cmp -s "$O/test/credit-vault-relay-concurrency.test.mjs" "$T/test/credit-vault-relay-concurrency.test.mjs"
! cmp -s "$O/cli/credit-vault.mjs" "$T/cli/credit-vault.mjs" || { echo "the tree's module is the old one"; exit 1; }
L="$N/old-run.log"; rc=0
bash "$O/test/run-credit-vault.sh" concurrency > "$L" 2>&1 || rc=$?
cat "$L"
[ $rc -ne 0 ] || { echo "[negative] FAILED: the suite passed against the old relay"; exit 1; }
grep -q "^ℹ pass 0$" "$L" && grep -q "^ℹ fail 11$" "$L" || { echo "[negative] FAILED: not the expected 0 pass / 11 fail"; exit 1; }
# every case fails on its own assertion (not on setup): 4 cases x 2 payers
[ "$(grep -c '^    ✖ ' "$L")" = 8 ] || { echo "[negative] FAILED: not 8 failing cases"; exit 1; }
! grep -q "Cannot find module\|ERR_MODULE_NOT_FOUND\|SyntaxError" "$L" || { echo "[negative] FAILED: setup error"; exit 1; }
[ "$(grep -c 'AssertionError' "$L")" -ge 8 ] || { echo "[negative] FAILED: failures are not assertions"; exit 1; }
rm -rf "$O"
echo "[negative] ok: the final concurrency suite fails against the old relay (exit $rc, 0 pass / 11 fail, 8 cases)"
