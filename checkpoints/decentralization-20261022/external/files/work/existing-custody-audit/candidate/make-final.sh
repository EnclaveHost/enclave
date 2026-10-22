#!/bin/bash
# Regenerate the FINAL patches against the CURRENT main working tree (root keeps merging; nothing here writes to main):
#   1. final/main     : a real copy of main, including real copies of its installed node_modules
#   2. core.patch     : the custody + platform-host-policy core from candidate/tree, ONLY where main still has the base this
#                       candidate was written against (BASE-CHECK.txt); a file root changed since is reported, never overwritten
#   3. callsites.patch: apply-host-policy-callsites.py (anchored edits) + the call-site tests + the rebuilt shipped bundles
# Both patches are `git apply --check`ed in order on a fresh copy of main.
set -euo pipefail
C=/home/steven/Documents/Codex/2026-10-18/wo/work/existing-custody-audit/candidate; E=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave
F=$C/final; rm -rf $F; mkdir -p $F
rsync -a --exclude=node_modules --exclude=.git --exclude=contracts/foundry/out --exclude=contracts/foundry/cache --exclude=/cache $E/ $F/main/
# REAL copies of the exact installed deps (same lockfiles/versions): the custodian build's committed-source check correctly
# rejects any bundle input outside the tree, which a symlink to main's node_modules would be
for d in . relay network windows/node e2e sdk/sessions; do [ -d $E/$d/node_modules ] && cp -a $E/$d/node_modules $F/main/$d/node_modules; done
ln -s $E/contracts/foundry/out $F/main/contracts/foundry/out   # read-only compiled artifacts some suites load
{ date -Is; git -C $E rev-parse HEAD; git -C $E status --short | sha256sum; } > $F/MAIN-SNAPSHOT.txt
cp -r $F/main $F/pristine

# ---- 2. core
CORE_MOD="custody/v2/chain.mjs custody/v2/member.mjs custody/v2/governance.mjs custody/v2/custodian.mjs custody/v2/daemon.mjs custody/v2/build-config.mjs
 scripts/build-custodian-v2.mjs cli/custody-v2.mjs network/route-record.mjs network/service-index.mjs test/route-record.test.mjs"
CORE_NEW="network/custody-vaults.mjs network/session-factories.mjs network/platform-host-policy.mjs network/host-policy-mirrors.mjs network/host-policy-adapters.mjs
 network/host-policy-runtime.mjs network/platform-host-policy-config.mjs network/host-service-gate.mjs contracts/deployments/contract-pins-production-base.json
 docs/network/platform-host-policy.md test/custody-v2-book-vault.test.mjs test/custody-v2-original-vault-e2e.test.mjs test/helpers/original-vault-rig.mjs
 test/fixtures/EnclaveRegistry.schema4.sol test/platform-host-policy.test.mjs test/host-policy-enforcement.test.mjs"
: > $F/core.report
for f in $CORE_MOD; do
  base=$( (grep -E "  $f( |$)" $C/BASE-CHECK.txt || true) | head -1 | cut -c1-64)
  [ -z "$base" ] && { echo "NO-BASE $f: NOT overwritten" >> $F/core.report; continue; }
  now=$(sha256sum $F/main/$f | cut -c1-64)
  if [ "$now" = "$(sha256sum $C/tree/$f | cut -c1-64)" ]; then echo "already-merged $f" >> $F/core.report; continue; fi
  if [ -n "$base" ] && [ "$base" != "$now" ]; then echo "BASE-CHANGED $f (candidate base $base, main now $now): NOT overwritten" >> $F/core.report; continue; fi
  cp $C/tree/$f $F/main/$f; echo "patched $f" >> $F/core.report
done
for f in $CORE_NEW; do
  if [ -e $F/main/$f ]; then
    if cmp -s $F/main/$f $C/tree/$f; then echo "already-merged $f" >> $F/core.report; else echo "EXISTS-DIFFERENT $f: NOT overwritten" >> $F/core.report; fi
    continue
  fi
  mkdir -p $(dirname $F/main/$f); cp $C/tree/$f $F/main/$f; echo "added $f" >> $F/core.report
done
cp -r $F/main $F/after-core

# ---- 3. call sites
python3 $C/apply-host-policy-callsites.py $F/main > $F/callsites.report
# call-site tests: new files, plus the management-plane case appended (anchored on the file's end, never a replacement)
for f in test/host-policy-callsites.test.mjs test/helpers/platform-policy-world.mjs test/platform-host-policy-process.test.mjs test/windows-node-platform-policy.test.mjs; do
  cp $C/callsite-tests/$f $F/main/$f; done
python3 - "$F/main/test/management-plane.test.mjs" "$C/callsite-tests/test/management-plane.test.mjs" <<'PY'
import sys
main, cand = sys.argv[1], sys.argv[2]
marker = "test('platform host policy: a runner the policy refuses receives nothing; an admitted runner is served as before'"
c = open(cand).read(); block = c[c.index("\n" + marker):]
m = open(main).read()
if marker not in m: open(main, "a").write(block if block.startswith("\n") else "\n" + block)
PY
echo "bundles: build in the queue with: (cd $F/main && bash /tmp/build-bundles.sh)"
