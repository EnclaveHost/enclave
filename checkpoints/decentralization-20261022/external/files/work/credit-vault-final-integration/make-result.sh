#!/usr/bin/env bash
# The LAYERED patch (on top of main + the frozen prior patch 1187bf5c…) and RESULT-MANIFEST.txt with base / result / main-now
# sha256 per file. Verifies the declared change set and that the patch reproduces the tree from its bases.
set -euo pipefail
C="$(cd "$(dirname "$0")" && pwd)"; cd "$C"
PRIOR=../credit-vault-independence/tree          # the frozen prior patch's result (its patch reproduces these bytes)
MAIN_MOD="network/lease-gas-owner.mjs cli/lease-gas.mjs test/lease-gas-owner-cli.test.mjs"
PRIOR_MOD="cli/credit-vault.mjs site/credit/credit.js site/credit/index.html site/credit/credit-config.json docs/credit-vault-independence.md test/credit-vault-browser.test.mjs test/run-credit-vault.sh"
NEW="site/js/core/credit-vault-reserve.js network/host-services/credit-vault-submitter.mjs network/credit-vault-submitter.mjs scripts/build-credit-vault-submitter-package.mjs
network/host-services/packages/credit-vault-submitter.package.json test/credit-vault-reserve.test.mjs
test/fixtures/credit-vault-older-848a.json test/fixtures/credit-vault-reserve-proposal.json"
# generated, deterministic, NOT in the patch (its manifest, which pins its sha256, is): node scripts/build-credit-vault-submitter-package.mjs
GENERATED="network/host-services/packages/credit-vault-submitter.mjs"
changed=$(cd tree && find . -newer ../BASE.stamp -type f -not -path "*/node_modules/*" | sed 's#^\./##' | sort)
# the frozen prior patch's own files were written AFTER the stamp too (it was applied after): they are its, unchanged
prior_files=$(grep -E '^\+\+\+ b/' ../credit-vault-independence/patches/credit-vault-independence.patch | sed 's#^+++ b/##' | sort)
# the prior patch's result for a file: base/after-prior (main files it modified, as applied to THIS main) or its new file
priorof() { if [ -e "base/after-prior/$1" ]; then echo "base/after-prior/$1"; else echo "$PRIOR/$1"; fi; }
mine=$(comm -23 <(echo "$changed") <(for f in $prior_files; do if cmp -s "tree/$f" "$(priorof $f)"; then echo "$f"; fi; done | sort))
want=$(printf "%s\n" $MAIN_MOD $PRIOR_MOD $NEW $GENERATED | sort)
[ "$mine" = "$want" ] || { echo "tree changes differ from the declared set:"; diff <(echo "$want") <(echo "$mine"); exit 1; }
for f in $prior_files; do case " $PRIOR_MOD " in *" $f "*) ;; *) cmp -s "tree/$f" "$(priorof $f)" || { echo "prior-patch file changed but not declared: $f"; exit 1; };; esac; done
P=patches/credit-vault-final-integration.patch; : > "$P"
for f in $MAIN_MOD; do diff -u --label "a/$f" --label "b/$f" "base/src/$f" "tree/$f" >> "$P" || true; done
for f in $PRIOR_MOD; do diff -u --label "a/$f" --label "b/$f" "$PRIOR/$f" "tree/$f" >> "$P" || true; done
for f in $NEW; do diff -u --label /dev/null --label "b/$f" /dev/null "tree/$f" >> "$P" || true; done
{
  echo "CREDIT-VAULT FINAL INTEGRATION: base/result manifest ($(date -u +%FT%TZ))"
  echo "base: $(head -1 BASE.txt)"
  echo "      $(sed -n 2p BASE.txt)"
  echo "patch (LAYERED: apply AFTER the prior patch): $P sha256 $(sha256sum "$P" | cut -c1-64) ($(wc -l < "$P") lines)"
  echo; echo "MODIFIED main files  base-sha256  result-sha256  main-now-sha256"
  for f in $MAIN_MOD; do echo "$f  $(sha256sum base/src/$f | cut -c1-64)  $(sha256sum tree/$f | cut -c1-64)  $(sha256sum ../enclave/$f | cut -c1-64)"; done
  echo; echo "MODIFIED prior-patch files  prior-result-sha256  result-sha256"
  for f in $PRIOR_MOD; do echo "$f  $(sha256sum $PRIOR/$f | cut -c1-64)  $(sha256sum tree/$f | cut -c1-64)"; done
  echo; echo "NEW  result-sha256"
  for f in $NEW; do m=""; [ -e "../enclave/$f" ] && m="  MAIN-HAS:$(sha256sum ../enclave/$f | cut -c1-64)"; echo "$f  $(sha256sum tree/$f | cut -c1-64)$m"; done
  echo; echo "GENERATED (not in the patch; regenerate with node scripts/build-credit-vault-submitter-package.mjs, --check verifies):"
  for f in $GENERATED; do echo "$f  $(sha256sum tree/$f | cut -c1-64)"; done
  echo; echo "ISOLATED (not in the patch): proposal/ (source-only reserve proposal + README + reserve.diff), forge/, live/ (read-only scans), fixtures/"
  for f in proposal/EnclaveLeaseGasReserveSig.sol proposal/reserve.diff proposal/README.md forge/test/VaultSigReserve.t.sol forge/test/CreditVaultReserveGap.t.sol forge/test/Base.sol forge/foundry.toml live/scan.json live/owners.json; do echo "$f  $(sha256sum $f | cut -c1-64)"; done
} > RESULT-MANIFEST.txt
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/r"; for f in $MAIN_MOD; do mkdir -p "$T/r/$(dirname $f)"; cp "base/src/$f" "$T/r/$f"; done
for f in $PRIOR_MOD; do mkdir -p "$T/r/$(dirname $f)"; cp "$PRIOR/$f" "$T/r/$f"; done
(cd "$T/r" && patch -s -p1 < "$C/$P")
for f in $MAIN_MOD $PRIOR_MOD $NEW; do cmp -s "$T/r/$f" "tree/$f" || { echo "patch does not reproduce $f"; exit 1; }; done
echo "[make-result] ok: $(wc -l < "$P") patch lines"
