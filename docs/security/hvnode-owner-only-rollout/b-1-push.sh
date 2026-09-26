#!/usr/bin/env bash
# B step 1: B's two commits onto main as a FAST-FORWARD (main must still be BASE), in the window 63 opens. The Deploy run must
# be detect + relay + site (B touches relay/, test/, scripts/host-delegation.mjs and site/js/core/pricing.js only); the relay
# job deploys nan (api relay) and nan-relay. Then: b-accept.sh 1. Rollback: b-rollback-code.sh (a revert pushed to main).
set -euo pipefail; source "$(dirname "$0")/lib.sh"
git -C $MAIN fetch -q origin main relay/hvnode-owner-only-v2
[ "$(git -C $MAIN rev-parse origin/relay/hvnode-owner-only-v2)" = "$BC" ] || { say "REFUSING: the pushed branch is not ${BC:0:12} (lib.sh)"; exit 2; }
[ "$(git -C $MAIN rev-parse origin/main)" = "$BASE" ] || { say "REFUSING: main moved from B's base ${BASE:0:12}: run b-recut.sh"; exit 2; }
[ "$(git -C $MAIN rev-list --count $BASE..$BC)" = 2 ] && [ -z "$(git -C $MAIN rev-list --merges $BASE..$BC)" ] || { say "REFUSING: B is not two plain commits on main"; exit 2; }
# the EXACT reviewed file list and content (enclave-bf): nothing more, nothing less, every file byte-identical
got=$(git -C $MAIN diff --name-only $BASE $BC | sort); want=$(printf '%s\n' "${!BFILE[@]}" | sort)
[ "$got" = "$want" ] || { say "REFUSING: B's file list is not the reviewed one: $(diff <(echo "$want") <(echo "$got") | grep '^[<>]' | tr '\n' ' ')"; exit 2; }
for f in "${!BFILE[@]}"; do [ "$(git -C $MAIN show $BC:$f | sha256sum | cut -c1-64)" = "${BFILE[$f]}" ] || { say "REFUSING: $f is not the reviewed content"; exit 2; }; done
for f in "${!SHA[@]}"; do [ "$(git -C $MAIN show $BC:relay/$f | sha256sum | cut -c1-64)" = "${SHA[$f]}" ] || { say "REFUSING: relay/$f is not the pinned hash"; exit 2; }; done
# no symlink and no node_modules path may reach main (enclave-bf: the relay/ filter once admitted one)
[ -z "$(git -C $MAIN diff --raw $BASE $BC | awk '$1 ~ /120000/ || $2 ~ /120000/')" ] || { say "REFUSING: B adds a symlink"; exit 2; }
! git -C $MAIN diff --name-only $BASE $BC | grep -q node_modules || { say "REFUSING: B touches a node_modules path"; exit 2; }
[ -z "$(gh run list --repo EnclaveHost/enclave --workflow deploy.yml --status in_progress --json databaseId --jq '.[].databaseId')" ] || { say "REFUSING: a Deploy run is in progress"; exit 2; }
bash "$H/health.sh" > $B/health-before-1.txt 2>&1 || { cat $B/health-before-1.txt; say "REFUSING: the fleet is not healthy before step 1 (not a window)"; exit 2; }
trusted_digest > $B/trusted-before-1.txt; $NAN "systemctl show enclave-api-relay -p InvocationID --value" > $B/inv0-1.txt
[ "${DRY:-0}" = 1 ] && { say "B step 1 DRY RUN: every pre-push check passed (B ${BC:0:12} on main ${BASE:0:12}, healthy, TRUSTED digest $(cat $B/trusted-before-1.txt)); nothing pushed"; exit 0; }
say "B step 1: pushing ${BC:0:12} to main (fast-forward from ${BASE:0:12}); TRUSTED_OPERATORS line digest $(cat $B/trusted-before-1.txt)"
git -C $MAIN push origin "$BC:refs/heads/main" 2>&1 | tail -2
for i in $(seq 1 60); do run=$(gh run list --repo EnclaveHost/enclave --workflow deploy.yml --json databaseId,headSha --jq ".[] | select(.headSha==\"$BC\") | .databaseId" | head -1); [ -n "$run" ] && break; sleep 5; done
[ -n "${run:-}" ] || { say "B STEP 1: no Deploy run appeared"; exit 3; }
echo "$run" > $B/deploy-run.txt; say "B step 1: Deploy run $run"
gh run watch "$run" --repo EnclaveHost/enclave --exit-status > $B/deploy-watch.txt 2>&1 || true
jobs=$(gh run view "$run" --repo EnclaveHost/enclave --json jobs --jq '[.jobs[] | "\(.name)=\(.conclusion)"] | sort | join(" ")'); say "B step 1: jobs: $jobs"
[ "$jobs" = "contracts-notice=skipped contracts=skipped detect=success relay=success release=skipped site=success" ] \
  || { say "B STEP 1: the jobs are not detect+relay+site, all success: STOP (rollback decision: b-rollback-code.sh)"; exit 5; }
say "B step 1 pushed and deployed (run $run); next: b-accept.sh 1"
