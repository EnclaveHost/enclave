#!/bin/bash
# crypto-key scan + gitleaks (source repo policy) over the new commit and the report repo; D patch-apply tree check
set -uo pipefail
W="$(cd "$(dirname "$0")/.." && pwd)"
cd "$W"; rc=0
echo "== source ae00cd965..HEAD"; git -C repo log --oneline ae00cd965..HEAD
(cd repo && python3 .githooks/scan-crypto-keys.py --range ae00cd965..HEAD) || rc=1
echo "source crypto scan rc=$rc"
gitleaks git --no-banner --log-opts="ae00cd965..HEAD" repo || rc=1
echo "== report repo"; git log --oneline
python3 repo/.githooks/scan-crypto-keys.py --range HEAD || rc=1
gitleaks git --no-banner --config repo/.gitleaks.toml . || rc=1
echo "pre-rewrite literal in the commit's files and the report: $(git -C repo show ae00cd965..HEAD | grep -ci "tin""foil"; grep -rli "tin""foil" --exclude-dir=repo --exclude-dir=tmp --exclude-dir='*-tree' --exclude=bytecode-provenance.mjs . | wc -l)"
echo "== D patch-apply check"
T="$W/tmp/apply-check"; rm -rf "$T"; git clone -q --no-checkout repo "$T"
git -C "$T" checkout -q --detach ae00cd9659e46e3dffe5407bdf34442416a9e69a
git -C "$T" -c user.name=check -c user.email=check@invalid am -q "$W"/exports/patches/*.patch || rc=1
a=$(git -C "$T" rev-parse HEAD^{tree}); b=$(git -C repo rev-parse ff13ebe089f3c18a064892269c55ddca2b4409e9^{tree})
echo "applied tree $a  final tree $b  $([ "$a" = "$b" ] && echo MATCH || echo MISMATCH)"; [ "$a" = "$b" ] || rc=1
git -C repo bundle verify "$W"/exports/site-generated-artifacts-reconcile-ff13ebe.bundle 2>&1 | grep -E "okay|error" || rc=1
rm -rf "$T"; echo "scan rc=$rc"; exit $rc
