#!/bin/bash
# commit3.sh: the rollback-review corrections (root ROOT-ROLLBACK-REVIEW.txt), then patch 0003 appended and both cumulative diffs
# regenerated against the SAME baselines (checkpoint dfb4b55e, main 68b82926); earlier patches 0001/0002 kept byte-identical.
set -euo pipefail
cd "$(dirname "$0")"
W=/home/steven/Documents/Codex/2026-10-18/wo/work; M=$W/source-checkpoint-20261022/main-repo
HOOKS=$W/custody-v2-dashboard-20261023/repo/.githooks; C="git -c core.hooksPath=$HOOKS commit -q"
[ "$(git rev-parse --short=7 HEAD)" = a257c0e ]
p1=$(sha256sum patches/0001-*.patch patches/0002-*.patch)
git add CURRENT-STATE.md ROLLBACK.md SOURCES.md docs/security/secret-custody-v2.md commit3.sh logs/commit-2.out logs/commit-2.rc logs/rangescan-2.out logs/rangescan-2.rc logs/scan-3.out logs/scan-3.rc logs/scan-gitleaks.json
$C -F - <<'MSG'
Correct rollback docs against the actual vault semantics (factory, committee switch-back, site/IPNS) and root's 22:25Z state

Per root's rollback review; source/documentation only:
- factory: unset only while no policy relies on it (live inventory); once SessionVault-held policies exist do NOT unset -
  beneficialOwnerOf reads the factory live while the owner is pinned at first write, so updates revert NotOwner and the
  custodian refuses owner_mismatch; claimPolicy destroys the bundle and is not a routine recovery
- committee switch-back: one current bundle per deployment; going back needs a new owner update with a FRESH bundle to
  0x4774 (re-entry or reverse rewrap, untested) while 0x4774 keeps serving; revisions and issuer rotation cannot be undone
- site rollback: capture and verify the exact pre-cutover front release and IPNS sequence/CID at deployment time; never
  reset or lower the IPNS sequence; no hardcoded CID; r2 unpublished
- CURRENT-STATE: root 22:20:34Z read (block 53002331, unchanged vault/committee/zero book entries); 7dd3acd approved,
  build started 22:25, NOT activated; control NOT restored
- secret-custody-v2.md 10.2: the factory entry is not symmetric; committee moves are one-way per step
MSG
A=$(git rev-list --max-parents=0 HEAD); C2=$(git rev-parse HEAD)
git format-patch -q --full-index --no-renames --start-number 3 -o patches HEAD~1..HEAD -- docs/security
[ "$(sha256sum patches/0001-*.patch patches/0002-*.patch)" = "$p1" ]
T=$(mktemp -d)
for f in secret-custody-v2.md secret-custody-v2-spec.md; do git -C "$M" show 68b82926968c99503d38ae78dbcb04694cc2c56c:docs/security/$f > "$T/main-$f"; done
{ git diff --no-index --full-index "$T/main-secret-custody-v2.md" docs/security/secret-custody-v2.md || true; git diff --no-index --full-index "$T/main-secret-custody-v2-spec.md" docs/security/secret-custody-v2-spec.md || true; } \
  | sed -e "s#a$T/main-secret-custody-v2.md#a/docs/security/secret-custody-v2.md#g" -e "s#a$T/main-secret-custody-v2-spec.md#a/docs/security/secret-custody-v2-spec.md#g" > patches/against-main-68b82926.diff
git diff --full-index "$A" HEAD -- docs/security > patches/against-checkpoint-dfb4b55e.diff
for base in 68b82926968c99503d38ae78dbcb04694cc2c56c:against-main-68b82926 dfb4b55e627ebd95b647abebf09627296f099862:against-checkpoint-dfb4b55e; do
  rev=${base%%:*}; pf=${base##*:}; X=$(mktemp -d); mkdir -p "$X/docs/security"
  for f in secret-custody-v2.md secret-custody-v2-spec.md; do git -C "$M" show $rev:docs/security/$f > "$X/docs/security/$f"; done
  (cd "$X" && git init -q && git apply "$OLDPWD/patches/$pf.diff")
  cmp "$X/docs/security/secret-custody-v2.md" docs/security/secret-custody-v2.md && cmp "$X/docs/security/secret-custody-v2-spec.md" docs/security/secret-custody-v2-spec.md
  echo "$pf.diff reproduces the final docs from $rev"; rm -rf "$X"
done
# the chained format-patches 0001..0003 on the checkpoint originals give the same final docs
X=$(mktemp -d); mkdir -p "$X/docs/security"
for f in secret-custody-v2.md secret-custody-v2-spec.md; do git -C "$M" show dfb4b55e627ebd95b647abebf09627296f099862:docs/security/$f > "$X/docs/security/$f"; done
(cd "$X" && git init -q && for p in "$OLDPWD"/patches/000[123]-*.patch; do git apply "$p"; done)
cmp "$X/docs/security/secret-custody-v2.md" docs/security/secret-custody-v2.md && echo "0001..0003 chain reproduces the final docs from dfb4b55e"; rm -rf "$X" "$T"
git add patches
$C -m "patches: append 0003 (rollback-review corrections); regenerate cumulative diffs against checkpoint dfb4b55e and main 68b82926"
git log --format='%h %an <%ae> %s' -3; sha256sum patches/*
