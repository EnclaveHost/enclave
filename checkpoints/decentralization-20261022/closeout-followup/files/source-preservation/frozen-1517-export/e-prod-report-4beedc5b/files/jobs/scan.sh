#!/bin/bash
# crypto-key scan + gitleaks (source repo policy) over the new source commits and the report repo; the D patch-apply check
set -uo pipefail
W="$(cd "$(dirname "$0")/.." && pwd)"
cd "$W"
rc=0
echo "== source dc2e5d740..HEAD"; git -C repo log --oneline dc2e5d740..HEAD
(cd repo && python3 .githooks/scan-crypto-keys.py --range dc2e5d740..HEAD) || rc=1
echo "source crypto scan rc=$rc"
gitleaks git --no-banner --log-opts="dc2e5d740..HEAD" repo || rc=1
echo "== report repo"; git log --oneline
python3 repo/.githooks/scan-crypto-keys.py --range HEAD || rc=1
gitleaks git --no-banner --config repo/.gitleaks.toml . || rc=1
echo "== D patch-apply check: patches/*.patch on dc2e5d740 -> tree of ae00cd965"
T="$W/tmp/apply-check"; rm -rf "$T"; git clone -q --no-checkout repo "$T"
git -C "$T" -c user.name=check -c user.email=check@invalid checkout -q --detach dc2e5d7402327bdd376cf3b90cfa23a551a37ba8
git -C "$T" -c user.name=check -c user.email=check@invalid am -q "$W"/exports/patches/*.patch || rc=1
a=$(git -C "$T" rev-parse HEAD^{tree}); b=$(git -C repo rev-parse ae00cd9659e46e3dffe5407bdf34442416a9e69a^{tree})
echo "applied tree $a  final tree $b  $([ "$a" = "$b" ] && echo MATCH || echo MISMATCH)"; [ "$a" = "$b" ] || rc=1
git -C repo bundle verify "$W"/exports/rpc-wallet-production-build-ae00cd9.bundle 2>&1 | tail -1
rm -rf "$T"
echo "scan rc=$rc"; exit $rc
