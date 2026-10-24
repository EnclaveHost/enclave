#!/bin/bash
# commit.sh: build this repository's history in the queue, each commit through the checkpoint's pre-commit key-scan hook:
#   A = the two docs exactly as on checkpoint dfb4b55e; B = the reviewed dashboard doc commits 2d3839c54 + 9d97b4b00 applied unchanged;
#   C = this reconciliation (docs edits + CURRENT-STATE/TEST-MATRIX/ROLLBACK/SIGNING-AUTHORITY/SOURCES); D = patches/ generated from A..C.
set -euo pipefail
cd "$(dirname "$0")"
W=/home/steven/Documents/Codex/2026-10-18/wo/work; M=$W/source-checkpoint-20261022/main-repo; DB=$W/custody-v2-dashboard-20261023/repo
HOOKS=$W/custody-v2-dashboard-20261023/repo/.githooks
[ ! -e .git ] || { echo ".git exists"; exit 2; }
T=$(mktemp -d); cp docs/security/secret-custody-v2.md docs/security/secret-custody-v2-spec.md "$T/"
git init -q; git config user.name SteveDeFacto; git config user.email 5148995+SteveDeFacto@users.noreply.github.com
C="git -c core.hooksPath=$HOOKS commit -q"
for f in secret-custody-v2.md secret-custody-v2-spec.md; do git -C "$M" show dfb4b55e627ebd95b647abebf09627296f099862:docs/security/$f > docs/security/$f; done
[ "$(git hash-object docs/security/secret-custody-v2.md)" = 393f9d31070e3b5f44580689c4a95bff91a3a4d5 ]
[ "$(git hash-object docs/security/secret-custody-v2-spec.md)" = fee422be923dace1e3acfb39bc10cc71db0ea369 ]
git add .gitignore docs/ORIGINS.md docs/security
$C -m "Import custody v2 docs exactly as on checkpoint dfb4b55e (= dashboard base ff13ebe08)"
git -C "$DB" diff ff13ebe08 9d97b4b003661ad4832fe703dc5649ca807739ed -- docs/security/secret-custody-v2.md docs/security/secret-custody-v2-spec.md | git apply
[ "$(git hash-object docs/security/secret-custody-v2.md)" = de1dce4b8c4252a3999bcf20f733bf674c3e3b97 ]
git add docs/security
$C -m "Apply the reviewed dashboard doc commits 2d3839c54 and 9d97b4b00 unchanged (current state, corrected image, who holds x, goals vs current)"
cp "$T"/secret-custody-v2.md "$T"/secret-custody-v2-spec.md docs/security/
git add README.md CURRENT-STATE.md TEST-MATRIX.md ROLLBACK.md SIGNING-AUTHORITY.md SOURCES.md scan.sh q.sh commit.sh docs/security logs/scan-1.out logs/scan-1.rc logs/scan-gitleaks.json
$C -F - <<'MSG'
Reconcile custody v2 docs with the deployed state: code-frozen original committee, proven vs not, rollback and relay limits

Source/documentation only, for root review (root publishes the final). Against the checkpoint dfb4b55e originals plus the
reviewed dashboard doc commits:
- secret-custody-v2.md: deployed vault = original 9d43 source (blob 7a385bbc); committee 0x4774 permanently code-frozen
  (no code-approval signer; a 7-day wait alone cannot upgrade it) -> new committee in the same vault + owner migration
  (new 10.3); hardware proof = startup/503/reopen only, no secret lifecycle test on hardware or production; rollback
  limits (old valid blob, malicious 404, any-failure-as-absent in the running image); relay clear/backups; proof key not
  SNP-bound, quote-only transport key; site r2 unpublished.
- secret-custody-v2-spec.md: the deployed vault's constructor and Enclave rule beside the source proposal.
- CURRENT-STATE / TEST-MATRIX / ROLLBACK / SIGNING-AUTHORITY / SOURCES: exact refs; incident data marked PROVISIONAL with
  timestamps; recovery not asserted; admin rights kept. Original single-seat t=1 custody is NOT decentralized custody.
MSG
A=$(git rev-list --max-parents=0 HEAD)
git format-patch -q --full-index --no-renames -o patches "$A"..HEAD -- docs/security
git -C "$M" show 68b82926968c99503d38ae78dbcb04694cc2c56c:docs/security/secret-custody-v2.md > "$T/main-v2.md"
git -C "$M" show 68b82926968c99503d38ae78dbcb04694cc2c56c:docs/security/secret-custody-v2-spec.md > "$T/main-spec.md"
{ git diff --no-index --full-index "$T/main-v2.md" docs/security/secret-custody-v2.md || true; git diff --no-index --full-index "$T/main-spec.md" docs/security/secret-custody-v2-spec.md || true; } \
  | sed -e "s#a$T/main-v2.md#a/docs/security/secret-custody-v2.md#g" -e "s#a$T/main-spec.md#a/docs/security/secret-custody-v2-spec.md#g" -e "s#b/docs/security/#b/docs/security/#g" > patches/against-main-68b82926.diff
git diff --full-index "$A" HEAD -- docs/security > patches/against-checkpoint-dfb4b55e.diff
# both cumulative diffs must reproduce the final docs from their originals
for base in main:68b82926968c99503d38ae78dbcb04694cc2c56c:against-main-68b82926 ckpt:dfb4b55e627ebd95b647abebf09627296f099862:against-checkpoint-dfb4b55e; do
  rev=$(echo $base | cut -d: -f2); pf=$(echo $base | cut -d: -f3); X=$(mktemp -d); mkdir -p "$X/docs/security"
  for f in secret-custody-v2.md secret-custody-v2-spec.md; do git -C "$M" show $rev:docs/security/$f > "$X/docs/security/$f"; done
  (cd "$X" && git init -q && git apply "$OLDPWD/patches/$pf.diff")
  cmp "$X/docs/security/secret-custody-v2.md" docs/security/secret-custody-v2.md && cmp "$X/docs/security/secret-custody-v2-spec.md" docs/security/secret-custody-v2-spec.md
  echo "$pf.diff reproduces the final docs from $rev"; rm -rf "$X"
done
git add patches
$C -m "patches: the custody doc changes as git format-patch (A..C) and cumulative diffs against checkpoint dfb4b55e and main 68b82926"
rm -rf "$T"
git log --format='%h %an <%ae> %s'
sha256sum docs/security/*.md patches/*
