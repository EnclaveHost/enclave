#!/usr/bin/env bash
# Writes patches/credit-vault-independence.patch (against the BASE snapshot in base/src + new files) and RESULT-MANIFEST.txt
# (base sha256, result sha256, and main's CURRENT sha256 for every touched file, so drift since the snapshot is visible).
set -euo pipefail
C="$(cd "$(dirname "$0")" && pwd)"; cd "$C"
MOD="cli/enclave.mjs scripts/build-site.mjs site/js/core/wallet.js"
NEW="site/js/core/credit-vault-independent.js site/credit/index.html site/credit/credit.js site/credit/credit-config.json site/vendor/credit-vault.js
site/vendor/credit-vault.MANIFEST.json scripts/vendor/credit-vault-entry.mjs scripts/build-credit-vault-vendor.mjs cli/credit-vault.mjs docs/credit-vault-independence.md
test/credit-vault-core.test.mjs test/credit-vault-independent.test.mjs test/credit-vault-browser.test.mjs test/credit-vault-fixture.mjs test/run-credit-vault.sh
test/fixtures/credit-vault-independence-chain.json"
# the tree must hold exactly these changes
changed=$(cd tree && find . -newer ../BASE.txt -type f -not -path "*/node_modules/*" -not -path "./.claude/*" | sed 's#^\./##' | sort)
want=$(printf "%s\n" $MOD $NEW | sort)
[ "$changed" = "$want" ] || { echo "tree changes differ from the declared set:"; diff <(echo "$want") <(echo "$changed"); exit 1; }
P=patches/credit-vault-independence.patch; : > "$P"
for f in $MOD; do diff -u --label "a/$f" --label "b/$f" "base/src/$f" "tree/$f" >> "$P" || true; done
for f in $NEW; do diff -u --label /dev/null --label "b/$f" /dev/null "tree/$f" >> "$P" || true; done
{
  echo "CREDIT-VAULT INDEPENDENCE: base/result manifest ($(date -u +%FT%TZ))"
  echo "base: $(head -1 BASE.txt)"
  echo "patch: $P sha256 $(sha256sum "$P" | cut -c1-64) ($(wc -l < "$P") lines); apply from the repo root: git apply --3way (or patch -p1)"
  echo; echo "MODIFIED  base-sha256  result-sha256  main-now-sha256"
  for f in $MOD; do echo "$f  $(sha256sum base/src/$f | cut -c1-64)  $(sha256sum tree/$f | cut -c1-64)  $(sha256sum ../enclave/$f | cut -c1-64)"; done
  echo; echo "NEW  result-sha256  (main-now: absent unless shown)"
  for f in $NEW; do m=""; [ -e "../enclave/$f" ] && m="  MAIN-HAS:$(sha256sum ../enclave/$f | cut -c1-64)"; echo "$f  $(sha256sum tree/$f | cut -c1-64)$m"; done
  echo; echo "ISOLATED (not in the patch): forge/ (gap proof + candidate tests), proposal/ (optional unapproved reserve), make-chain-fixture.mjs, build-site.sh, run-forge.sh"
  for f in proposal/EnclaveLeaseGasReserve1271.sol proposal/reserve.diff forge/test/Base.sol forge/test/CreditVaultReserveGap.t.sol forge/test/CandidateReserve1271.t.sol forge/foundry.toml; do echo "$f  $(sha256sum $f | cut -c1-64)"; done
} > RESULT-MANIFEST.txt
# the patch must reproduce the tree from the base
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/r"; for f in $MOD; do mkdir -p "$T/r/$(dirname $f)"; cp "base/src/$f" "$T/r/$f"; done
(cd "$T/r" && patch -s -p1 < "$C/$P")
for f in $MOD $NEW; do cmp -s "$T/r/$f" "tree/$f" || { echo "patch does not reproduce $f"; exit 1; }; done
echo "[make-result] ok: $(wc -l < "$P") patch lines; manifest RESULT-MANIFEST.txt"
