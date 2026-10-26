#!/usr/bin/env bash
# Compose the RPC runtime production source from EXACT pinned commits (COMMIT-MANIFEST.json) in a PRIVATE new repository.
#   compose.sh <new-out-dir> [--resolutions DIR --resolutions-sha256 SHA] [--seam SHA --seam-repo REPO --seam-receipt FILE --seam-receipt-sha256 SHA]
# Reads the source repos only (git fetch of the pinned branch refs from local paths; no network, no remote, no push).
# Stage 1 (automatic): consumers + leaseRelay + verifier, --no-ff merges on the shared 9fa02e1bc base; trees must equal the
# manifest's; every file changed by exactly ONE component must keep that component's blob. Stage 2 (route) has 124 real
# conflicts and runs ONLY with a reviewed, sha256-pinned resolution set; without it the script stops at the stage-1
# candidate and writes a review bundle. The lease-consumer seam is never included unless its root receipt is given.
# Output: <out>/tree (branch compose/rpc-runtime-20261026), <out>/COMPOSITION.json. A CANDIDATE, never integration-tested here.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); M=$HERE/COMMIT-MANIFEST.json
OUT=${1:?out dir}; shift; RES= RES_SHA= SEAM= SEAM_REPO= SEAM_RCPT= SEAM_RCPT_SHA=
while [ $# -gt 0 ]; do case $1 in --resolutions) RES=$2;; --resolutions-sha256) RES_SHA=$2;; --seam) SEAM=$2;; --seam-repo) SEAM_REPO=$2;;
  --seam-receipt) SEAM_RCPT=$2;; --seam-receipt-sha256) SEAM_RCPT_SHA=$2;; *) echo "unknown argument $1"; exit 2;; esac; shift 2; done
die() { echo "[FAIL] $*"; echo "RESULT: COMPOSITION-REFUSED"; exit 9; }
j() { python3 -I -c 'import json,sys; m=json.load(open(sys.argv[1])); v=m
for k in sys.argv[2].split("."): v=v[k]
print(v if not isinstance(v,(list,dict)) else json.dumps(v))' "$M" "$1"; }
[ ! -e "$OUT" ] || die "$OUT exists (fresh dir only)"
[ -z "$RES" ] || [ -n "$RES_SHA" ] || die "--resolutions needs --resolutions-sha256 (the reviewed pin)"
[ -z "$SEAM" ] || { [ -n "$SEAM_REPO" ] && [ -n "$SEAM_RCPT" ] && [ -n "$SEAM_RCPT_SHA" ]; } || die "--seam needs --seam-repo, --seam-receipt and --seam-receipt-sha256"
MSHA=$(sha256sum < "$M" | cut -c1-64)
mkdir -p "$OUT/home"; OUT=$(cd "$OUT" && pwd)
export HOME=$OUT/home GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 GIT_AUTHOR_NAME=SteveDeFacto GIT_COMMITTER_NAME=SteveDeFacto \
  GIT_AUTHOR_EMAIL=5148995+SteveDeFacto@users.noreply.github.com GIT_COMMITTER_EMAIL=5148995+SteveDeFacto@users.noreply.github.com \
  GIT_AUTHOR_DATE=2026-10-26T00:00:00Z GIT_COMMITTER_DATE=2026-10-26T00:00:00Z
T=$OUT/tree; git init -q -b compose/empty "$T"; G="git -C $T -c core.hooksPath=/dev/null -c commit.gpgsign=false -c merge.conflictStyle=diff3"
for k in consumers leaseRelay verifier route; do
  repo=$(j heads.$k.repo); br=$(j heads.$k.branch); want=$(j heads.$k.commit)
  $G fetch -q --no-tags "$repo" "refs/heads/$br:refs/src/$k" || die "fetch $k ($br) from $repo"
  [ "$($G rev-parse refs/src/$k)" = $want ] || die "$k: $br is $($G rev-parse refs/src/$k), not the reviewed $want (the head moved: re-review)"
  [ "$($G rev-parse refs/src/$k^{tree})" = "$(j heads.$k.tree)" ] || die "$k tree"
  echo "[ok] $k $want ($br)"
done
B=$(j lineages.9fa02e1bc6.commit)
for k in consumers leaseRelay verifier; do [ "$($G merge-base refs/src/$k refs/src/consumers)" = $B ] || [ $k = consumers ] || die "$k is not on $B"; done
$G checkout -q -b compose/rpc-runtime-20261026 refs/src/consumers
msg() { printf 'compose: merge %s %s (rpc-runtime-composition stage %s)\n\nComposed-From: %s %s %s\nComposition-Manifest-Sha256: %s\n' "$(j heads.$1.branch)" "$(j heads.$1.commit | cut -c1-12)" $2 $1 "$(j heads.$1.branch)" "$(j heads.$1.commit)" $MSHA; }
$G merge -q --no-ff -m "$(msg leaseRelay 1)" refs/src/leaseRelay || die "stage 1 leaseRelay merge"
[ "$($G rev-parse HEAD^{tree})" = "$(j stages.1.expectedTreeAfterLeaseRelay)" ] || die "stage 1 tree after leaseRelay differs from the manifest"
$G merge -q --no-ff -m "$(msg verifier 1)" refs/src/verifier || die "stage 1 verifier merge"
[ "$($G rev-parse HEAD^{tree})" = "$(j stages.1.expectedTree)" ] || die "stage 1 tree differs from the manifest"
S1=$($G rev-parse HEAD); echo "[ok] stage 1 $S1 tree $($G rev-parse HEAD^{tree})"
# invariant: a file changed by exactly one component keeps that component's blob; the rest are listed for review
python3 -I - "$T" "$B" "$OUT/STAGE1-INVARIANT.txt" <<'PY' || die "stage 1 changed a single-owner file"
import subprocess, sys, collections
t, b, out = sys.argv[1:]; g = lambda *a: subprocess.run(["git", "-C", t, *a], check=True, capture_output=True, text=True).stdout
own = collections.defaultdict(list)
for k in ("consumers", "leaseRelay", "verifier"):
    for f in g("diff", "--name-only", "-z", b, f"refs/src/{k}").split("\0"):
        if f: own[f].append(k)
blob = lambda c, f: subprocess.run(["git", "-C", t, "rev-parse", f"{c}:{f}"], capture_output=True, text=True).stdout.strip() or "-"
bad, multi = [], []
for f, ks in sorted(own.items()):
    if len(ks) == 1:
        if blob("HEAD", f) != blob(f"refs/src/{ks[0]}", f): bad.append(f)
    else: multi.append(f"{f} {','.join(ks)} composed={blob('HEAD', f)[:12]}")
open(out, "w").write(f"single-owner files: {sum(len(v) == 1 for v in own.values())}, kept exactly: {not bad}\nauto-merged (REVIEW): \n" + "\n".join(multi) + "\n")
print(open(out).read()); sys.exit(1 if bad else 0)
PY
status="STAGE-1 CANDIDATE (route not composed: resolutions required)"; S2=
if [ -z "$RES" ]; then
  echo "== stage 2 not run: writing the review bundle ($OUT/review)"
  bash "$HERE/tools/review-bundle.sh" "$T" refs/src/route "$OUT/review" "$(j lineages.routeSnapshot.commit)"
else
  [ "$(sha256sum < "$RES/RESOLUTIONS.tsv" | cut -c1-64)" = "$RES_SHA" ] || die "RESOLUTIONS.tsv is not the reviewed $RES_SHA"
  set +e; $G merge -q --no-ff --no-commit refs/src/route >/dev/null 2>&1; set -e
  python3 -I "$HERE/tools/apply-resolutions.py" "$T" "$RES" || die "resolutions do not cover exactly the conflicts or a resolved file is not its reviewed sha256"
  $G commit -q -m "$(msg route 2)
Resolutions-Sha256: $RES_SHA" || die "stage 2 commit"; S2=$($G rev-parse HEAD); status="STAGE-2 CANDIDATE (route composed with reviewed resolutions $RES_SHA)"
fi
if [ -n "$SEAM" ]; then
  [ -n "$S2" ] || die "the seam is merged only after stage 2"
  [ "$(sha256sum < "$SEAM_RCPT" | cut -c1-64)" = "$SEAM_RCPT_SHA" ] && grep -q "$SEAM" "$SEAM_RCPT" && tail -n 3 "$SEAM_RCPT" | grep -q '^## rc=0' || die "the seam receipt is not the pinned root pass for $SEAM"
  $G fetch -q --no-tags "$SEAM_REPO" "$SEAM:refs/src/seam" 2>/dev/null || die "fetch seam $SEAM"
  $G merge -q --no-ff -m "compose: merge lease-consumer seam ${SEAM:0:12} (root receipt $SEAM_RCPT_SHA)" refs/src/seam || die "seam merge conflicts: review"
  status="$status + seam $SEAM"
fi
python3 -I - "$OUT/COMPOSITION.json" <<PY
import json; json.dump({"format": "rpc-runtime-composition/v1", "manifestSha256": "$MSHA", "branch": "compose/rpc-runtime-20261026",
 "stage1": "$S1", "stage2": "$S2" or None, "head": "$($G rev-parse HEAD)", "headTree": "$($G rev-parse HEAD^{tree})", "seam": "$SEAM" or None,
 "status": "$status", "claims": "composed source CANDIDATE only: not integration-tested, not built, not imaged, not committed upstream or pushed"},
 open("$OUT/COMPOSITION.json", "w"), indent=1)
PY
echo "## rc=0 ($status; head $($G rev-parse HEAD); NOT integration-tested)"
