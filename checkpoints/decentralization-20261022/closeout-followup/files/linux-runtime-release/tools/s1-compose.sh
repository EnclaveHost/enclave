#!/usr/bin/env bash
# s1 (queue 512): compose the Linux runtime release source from EXACT immutable commits, then the relay-mode install-set
# precheck. Nothing outside linux-runtime-release is written: both source repos are only read.
#  1. a NEW local clone of 493ee9ee (the reviewed native image commit, native-final-image) from native-front-abort/repo
#     (--local --no-hardlinks copies its object files; full-history file:// clones OOM at 512);
#  2. root's four exact commits 2bbea898..1086cf23 (D 09ff3ed5, b744ba19, f1d0666b + ROOT 1086cf23) exported from the root
#     review repo's Git objects with format-patch --full-index --no-renames, applied by git am with a fixed committer identity
#     and --committer-date-is-author-date, so the composed commit ids are reproducible from these inputs alone;
#  3. proofs: the composed HEAD/tree are the expected ids; every file the four commits touch, except supervisor.js, is
#     byte-identical to 1086cf23; supervisor.js is the exact union: (composed - 493ee9ee) == (1086cf23 - 2bbea898) and
#     (composed - 1086cf23) == (493ee9ee - 2bbea898) line for line (the C2 attestation-paths hunks);
#  4. the relay-mode install-set precheck (tools/verify-inputs-relay.py).
set -euo pipefail
. "$(dirname "$0")/env.sh"
NR=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/native-front-abort/repo; BR=work/native-front-abort
RR=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/linux-adopt-stop-review
N=493ee9ee07497c94159ec4f6916e9ea920d31959; NTREE=b21163723ea789db13ff84d148e309e2709a89f4
CK=2bbea8987ddc3d127c15e9709b5db2f867eae30d; ROOTC=1086cf2346b913177e38cf02e0b2b571628cc758
WANT_RANGE="09ff3ed5 b744ba19 f1d0666b 1086cf23"
C=fec43a6a08da2ac287fb3a5c42de89f096f4f678; TREE=13e18b0895e37a7baa5bc9e11ad1fdcf337daac0
S=$B/src
need() { local what=$1; shift; if "$@"; then echo "[ok] $what"; else echo "[FAIL] $what"; exit 9; fi; }
[ ! -e "$S" ] || { echo "src exists"; exit 2; }
[ -z "$(ls -A "$B/patches")" ] || { echo "patches/ not empty"; exit 2; }
echo "== 1 base clone"
git clone -q --local --no-hardlinks --no-tags --single-branch --branch "$BR" --no-checkout "$NR" "$S"
git -C "$S" remote remove origin
git -C "$S" cat-file -e "$N^{commit}" || { echo "$N not reachable from $BR"; exit 4; }
git -C "$S" -c advice.detachedHead=false checkout -q --detach "$N"
git -C "$S" branch -D -q "$BR"
need "base HEAD $N" [ "$(git -C "$S" rev-parse HEAD)" = "$N" ]
need "base tree $NTREE" [ "$(git -C "$S" rev-parse HEAD^{tree})" = "$NTREE" ]
echo "== 2 root's exact commits"
need "root repo head is $ROOTC" [ "$(git -C "$RR" rev-parse refs/heads/fix/adopt-pending-stop)" = "$ROOTC" ]
need "checkpoint base is $CK" [ "$(git -C "$RR" rev-parse "$CK^{commit}")" = "$CK" ]
got=$(git -C "$RR" log --reverse --format=%h --abbrev=8 "$CK..$ROOTC" | tr '\n' ' ' | sed 's/ $//')
need "range $CK..$ROOTC = $WANT_RANGE (got $got)" [ "$got" = "$WANT_RANGE" ]
need "range is linear" [ "$(git -C "$RR" rev-list --min-parents=2 --count "$CK..$ROOTC")" = 0 ]
need "range authored+committed by SteveDeFacto" [ -z "$(git -C "$RR" log --format='%an <%ae>|%cn <%ce>' "$CK..$ROOTC" | grep -v '^SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com>|SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com>$' || true)" ]
need "root's supervisor.js is 7389d613" [ "$(git -C "$RR" show "$ROOTC:supervisor.js" | sha256sum | cut -c1-8)" = 7389d613 ]
need "f1d0666b's supervisor.js is e50da21d" [ "$(git -C "$RR" show f1d0666b9fc80d25a7c4cbacf4025f3a33152111:supervisor.js | sha256sum | cut -c1-8)" = e50da21d ]
git -C "$RR" format-patch -q --full-index --no-renames --no-signature -o "$B/patches" "$CK..$ROOTC"
( cd "$B/patches" && sha256sum *.patch ) | tee "$B/receipts/patches.sha256"
echo "== 3 compose"
GIT_COMMITTER_NAME=SteveDeFacto GIT_COMMITTER_EMAIL=5148995+SteveDeFacto@users.noreply.github.com \
  git -C "$S" -c core.hooksPath=/dev/null am -q --no-3way --committer-date-is-author-date "$B"/patches/*.patch
need "composed HEAD $C" [ "$(git -C "$S" rev-parse HEAD)" = "$C" ]
need "composed tree $TREE" [ "$(git -C "$S" rev-parse HEAD^{tree})" = "$TREE" ]
need "composed parent chain ends at $N" [ "$(git -C "$S" rev-parse HEAD~4)" = "$N" ]
need "src clean" [ -z "$(git -C "$S" status --porcelain --untracked-files=all)" ]
changed=$(git -C "$S" diff --name-only "$N" HEAD); want=$(git -C "$RR" diff --name-only "$CK" "$ROOTC")
need "composed delta paths == root range paths" [ "$changed" = "$want" ]
for f in $changed; do
  [ "$f" = supervisor.js ] && continue
  need "$f == 1086cf23 bytes" [ "$(git -C "$S" rev-parse "HEAD:$f")" = "$(git -C "$RR" rev-parse "$ROOTC:$f")" ]
done
T=$(mktemp -d "$B/tmp/union.XXXX")
git -C "$RR" show "$CK:supervisor.js" > "$T/ck"; git -C "$RR" show "$ROOTC:supervisor.js" > "$T/root"
git -C "$S" show "$N:supervisor.js" > "$T/nat"; git -C "$S" show HEAD:supervisor.js > "$T/comp"
body() { diff -U0 "$1" "$2" | grep -E '^[-+]' | grep -vE '^(\+\+\+|---) ' || true; }
need "union: (composed - 493ee9ee) == (1086cf23 - 2bbea898)" cmp -s <(body "$T/nat" "$T/comp") <(body "$T/ck" "$T/root")
need "union: (composed - 1086cf23) == (493ee9ee - 2bbea898)" cmp -s <(body "$T/root" "$T/comp") <(body "$T/ck" "$T/nat")
echo "[union] D+root hunks: $(body "$T/ck" "$T/root" | wc -l) lines; C2/comment hunks: $(body "$T/ck" "$T/nat" | wc -l) lines"
need "composed supervisor.js is 4939dc68" [ "$(sha256sum < "$T/comp" | cut -c1-8)" = 4939dc68 ]
rm -rf "$T"
git -C "$S" log -5 --format='commit %H%ntree %T%nparent %P%nauthor %an <%ae> %aI%ncommitter %cn <%ce> %cI%nsubject %s%n' > "$B/receipts/source-commits.txt"
git -C "$S" ls-tree -r HEAD > "$B/receipts/composed-ls-tree.txt"
git -C "$S" diff --stat "$N" HEAD > "$B/receipts/composed-delta-vs-493ee9ee.txt"
echo "== 4 relay-mode install-set precheck"
python3 -u "$B/tools/verify-inputs-relay.py" "$S" "$B/receipts/inputs-precheck.json"
rm -rf "$S/metal/__pycache__"
need "src clean after the checks" [ -z "$(git -C "$S" status --porcelain --untracked-files=all)" ]
cat "$B/receipts/source-commits.txt"
n=$(( $(wc -l < "$B/stub/invocations.log") - STUB_BASE )); [ "$n" -eq 0 ] || { echo "stub invoked $n times"; exit 5; }
echo "S1-OK; stub invocations: $n"
