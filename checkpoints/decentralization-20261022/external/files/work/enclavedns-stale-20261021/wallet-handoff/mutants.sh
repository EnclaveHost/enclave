#!/usr/bin/env bash
# Negative controls: each mutant disables one vault safeguard in a scratch copy; the handoff tests must FAIL for each.
set -u; cd "$(dirname "$0")/.."; base=wallet-handoff; rc=0
run() { name=$1; expr=$2; d=$(mktemp -d "$PWD/mut-XXXX"); cp -a $base/. "$d/"; rm -rf "$d/journals"/*; sed -i "$expr" "$d/chain.mjs"
  if ! grep -q "MUTANT" "$d/chain.mjs"; then echo "MUTANT $name NOT APPLIED"; rc=1; rm -rf "$d"; return; fi
  (cd "$d" && TMPDIR=$(mktemp -d) timeout 300 node --test --test-concurrency=1 test/handoff.test.mjs >/dev/null 2>&1); r=$?
  [ $r -ne 0 ] && echo "mutant $name KILLED" || { echo "mutant $name SURVIVED"; rc=1; }; rm -rf "$d"; }
run vault-owner 's#eq(vaultOwner, t.admin, "the SessionVault.s owner is not the admin: its ownerCall would revert; refused");#/*MUTANT*/#'
run held       's#  const \[env, promoted, createdBy\] = h;#  return; /*MUTANT*/ const [env, promoted, createdBy] = h;#'
run dep-owner  's#eq(d.owner, t.vault.address, "the deployment.s owner is not the pinned SessionVault");#/*MUTANT*/#'
exit $rc
