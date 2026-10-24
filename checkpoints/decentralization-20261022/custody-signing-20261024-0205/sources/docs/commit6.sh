#!/bin/bash
# commit6.sh: the recipient-binding doc update, then patch 0004 appended and both cumulative diffs
# regenerated against the SAME baselines (checkpoint dfb4b55e, main 68b82926); earlier patches 0001/0002 kept byte-identical.
set -euo pipefail
cd "$(dirname "$0")"
W=/home/steven/Documents/Codex/2026-10-18/wo/work; M=$W/source-checkpoint-20261022/main-repo
HOOKS=$W/custody-v2-dashboard-20261023/repo/.githooks; C="git -c core.hooksPath=$HOOKS commit -q"
[ "$(git rev-parse --short=7 HEAD)" = 1b3c261 ]
p1=$(sha256sum patches/0001-*.patch patches/0002-*.patch patches/0003-*.patch)
git add CURRENT-STATE.md SIGNING-AUTHORITY.md TEST-MATRIX.md ROLLBACK.md SOURCES.md RECIPIENT-BINDING-REVIEW.txt docs/security/secret-custody-v2.md commit6.sh \
  logs/commit-5.out logs/commit-5.rc logs/rangescan-5.out logs/rangescan-5.rc logs/scan-6.out logs/scan-6.rc logs/scan-gitleaks.json
$C -F - <<'MSG'
Recipient binding (root-reviewed source review): direct SNP quote gates confidentiality; no value-integrity claim; root 22:56Z facts

Source/documentation only; the review is SOURCE evidence, not production evidence (nothing was run):
- a custody v2 release needs a VCEK-signed SNP report binding the guest-minted recipient key, revisions, committee/epoch,
  challenge, runtime and transport key (report_data[0:32]), the owner's appId ([32:64]) and HOST_DATA = deployment; the
  registry proofKey is not an input, so registering one or holding the operator key cannot forge a release
- the guest does not chain-verify the relay pointer (front/custody.go L116-134, config check L286-287): a malicious relay
  cannot read real values but can make the guest run attacker-chosen values/config; owner-committed value integrity NOT claimed
- root facts (PROVISIONAL): canary top-up target verified 22:47:45 (EOA, 61,654,449,641,751 wei), no human confirmation;
  b007d471 staged 22:49, admitted 37->38 22:50, NOT activated; old ed918e4b re-attached 22:52, no control restart; funding
  refused 22:55:45 (fee 303,866,570,907 vs 376,132,087,579, no 25% headroom; setProofKey nonce 23759); D kit 47 py + 14 node
  pass, 78 mutants running, not production
- secret-custody-v2.md: what attestation gates and what it does not; v1 L3 note on the unverified pointer
MSG
A=$(git rev-list --max-parents=0 HEAD); C2=$(git rev-parse HEAD)
git format-patch -q --full-index --no-renames --start-number 4 -o patches HEAD~1..HEAD -- docs/security
[ "$(sha256sum patches/0001-*.patch patches/0002-*.patch patches/0003-*.patch)" = "$p1" ]
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
(cd "$X" && git init -q && for p in "$OLDPWD"/patches/000[1234]-*.patch; do git apply "$p"; done)
cmp "$X/docs/security/secret-custody-v2.md" docs/security/secret-custody-v2.md && echo "0001..0004 chain reproduces the final docs from dfb4b55e"; rm -rf "$X" "$T"
git add patches
$C -m "patches: append 0004 (recipient-binding conclusions); regenerate cumulative diffs against checkpoint dfb4b55e and main 68b82926"
git log --format='%h %an <%ae> %s' -3; sha256sum patches/*
