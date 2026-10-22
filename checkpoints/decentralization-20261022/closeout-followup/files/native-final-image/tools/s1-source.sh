#!/usr/bin/env bash
# s1 (queue 512, adapted from measured-image-build/tools/s1-source.sh): a NEW local clone of the EXACT commit 493ee9ee from the
# source repo (only read: --local --no-hardlinks copies its object files; no checkout, lock or write there), its identity, the
# path delta against the previous image commit 6f2c7da4, the install-set precheck (tools/verify-inputs.py) and the
# bundle-currency check (tools/bundle-currency.py). (r1 used a file:// clone: git pack-objects for the full history reached
# 543 MiB and the guard stopped it, exit 99; nothing was checked out.)
set -euo pipefail
. "$(dirname "$0")/env.sh"
R=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/native-front-abort/repo
C=493ee9ee07497c94159ec4f6916e9ea920d31959; TREE=b21163723ea789db13ff84d148e309e2709a89f4; BR=work/native-front-abort
OLDC=6f2c7da466dc26e5f7aac88c574a6b807e1a03df
[ ! -e "$B/src" ] || { echo "src exists"; exit 2; }
git clone -q --local --no-hardlinks --no-tags --single-branch --branch "$BR" --no-checkout "$R" "$B/src"
git -C "$B/src" remote remove origin
git -C "$B/src" cat-file -e "$C^{commit}" || { echo "$C is not reachable from $BR"; exit 4; }
git -C "$B/src" checkout -q --detach "$C"
git -C "$B/src" branch -D -q "$BR"
[ "$(git -C "$B/src" rev-parse HEAD)" = "$C" ] || { echo "HEAD is not $C"; exit 4; }
[ "$(git -C "$B/src" rev-parse HEAD^{tree})" = "$TREE" ] || { echo "tree is not $TREE"; exit 4; }
git -C "$B/src" merge-base --is-ancestor "$OLDC" "$C" || { echo "$OLDC is not an ancestor"; exit 4; }
[ -z "$(git -C "$B/src" status --porcelain --untracked-files=all)" ] || { echo "src not clean"; exit 4; }
git -C "$B/src" log -1 --format='commit %H%ntree %T%nparent %P%nauthor %an %aI%ncommitter %cn %cI%nsubject %s' > "$B/receipts/source-commit.txt"
git -C "$B/src" log --format='%H %s' "$OLDC..$C" > "$B/receipts/commits-since-6f2c7da4.txt"
git -C "$B/src" ls-tree -r HEAD > "$B/receipts/published-ls-tree.txt"
git -C "$B/src" diff --name-status "$OLDC" "$C" > "$B/receipts/source-delta-vs-6f2c7da4.txt"
echo "== install-set precheck"
python3 -u "$B/tools/verify-inputs.py" "$B/src" "$B/receipts/inputs-precheck.json"
rm -rf "$B/src/metal/__pycache__"
echo "== bundle currency"
python3 -u "$B/tools/bundle-currency.py" "$B/src" "$B/receipts/inputs-precheck.json" "$B/receipts/bundle-currency.json"
rm -rf "$B/src/metal/__pycache__"
[ -z "$(git -C "$B/src" status --porcelain --untracked-files=all)" ] || { echo "src not clean after the checks"; exit 4; }
cat "$B/receipts/source-commit.txt"; cat "$B/receipts/commits-since-6f2c7da4.txt"
n=$(( $(wc -l < "$B/stub/invocations.log") - STUB_BASE )); [ "$n" -eq 0 ] || { echo "stub invoked $n times"; exit 5; }
echo "S1-OK; stub invocations: $n"
