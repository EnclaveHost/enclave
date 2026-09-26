#!/usr/bin/env bash
# Step 2: the pre-warm (73662f6b + dc3a3ede, bf GO; f0759181, 5d GO) and cert-set-separate (6e301b16, 5d GO) onto main as ONE
# fast-forward = ONE relay deploy = ONE api-relay restart. Content-pinned by PATCH: the 4 commits must reproduce the reviewed
# patch-ids exactly, touch exactly FILES, and sit directly on the current main; main must not have changed relay/, site/ or
# scripts/ since REVIEW_BASE (else re-review). >=10 min after the last api-relay restart (the NucBox soak). DRY=1 pushes nothing.
# Then: pc-2-accept.sh. Rollback: a revert of the 4 pushed to main (git revert BASE..PC).
set -euo pipefail; source "$(dirname "$0")/lib.sh"
git -C $MAIN fetch -q origin main relay/prewarm-certset-window
[ "$(git -C $MAIN rev-parse origin/relay/prewarm-certset-window)" = "$PC" ] || { say "REFUSING: the branch is not ${PC:0:12} (lib.sh; pc-recut.sh after a main move)"; exit 2; }
[ "$(git -C $MAIN rev-parse origin/main)" = "$BASE" ] || { say "REFUSING: main moved from ${BASE:0:12}: run pc-recut.sh"; exit 2; }
m=$(context_moved $MAIN); [ -z "$m" ] || { say "REFUSING: main changed relay/site/scripts since $REVIEW_BASE: $(echo $m): re-review"; exit 2; }
[ "$(git -C $MAIN rev-list --count $BASE..$PC)" = 4 ] && [ -z "$(git -C $MAIN rev-list --merges $BASE..$PC)" ] || { say "REFUSING: not 4 plain commits on main"; exit 2; }
got=$(for c in $(git -C $MAIN rev-list --reverse $BASE..$PC); do git -C $MAIN show $c | git patch-id --stable | cut -d' ' -f1; done | tr '\n' ' ' | sed 's/ $//')
[ "$got" = "$PATCHIDS" ] || { say "REFUSING: the patches are not the reviewed ones"; exit 2; }
[ "$(git -C $MAIN diff --name-only $BASE $PC | tr '\n' ' ' | sed 's/ $//')" = "$FILES" ] || { say "REFUSING: the file list is not the reviewed one"; exit 2; }
for f in "${!SHA[@]}"; do [ "$(git -C $MAIN show $PC:relay/$f | sha256sum | cut -c1-64)" = "${SHA[$f]}" ] || { say "REFUSING: relay/$f is not the pinned content"; exit 2; }; done
[ -z "$(git -C $MAIN diff --raw $BASE $PC | awk '$1 ~ /120000/ || $2 ~ /120000/')" ] && ! git -C $MAIN diff --name-only $BASE $PC | grep -q node_modules || { say "REFUSING: a symlink or node_modules path"; exit 2; }
[ -z "$(gh run list --repo EnclaveHost/enclave --workflow deploy.yml --status in_progress --json databaseId --jq '.[].databaseId')" ] || { say "REFUSING: a Deploy run is in progress"; exit 2; }
age=$(last_restart_age); [ "$age" -ge 600 ] || { say "REFUSING: the api relay restarted ${age}s ago (< 10 min: the NucBox soak)"; exit 2; }
bash "$HEALTH" > $B/health-before-2.txt 2>&1 || { cat $B/health-before-2.txt; say "REFUSING: not healthy before step 2"; exit 2; }
$NAN "systemctl show enclave-api-relay -p InvocationID --value" > $B/inv0-2.txt
[ "${DRY:-0}" = 1 ] && { say "step 2 DRY RUN: every pre-push check passed (${PC:0:12} on main ${BASE:0:12}, healthy, last restart ${age}s ago); nothing pushed"; exit 0; }
say "step 2: pushing ${PC:0:12} to main (fast-forward from ${BASE:0:12}): pre-warm + cert-set-separate"
git -C $MAIN push origin "$PC:refs/heads/main" 2>&1 | tail -2
for i in $(seq 1 60); do run=$(gh run list --repo EnclaveHost/enclave --workflow deploy.yml --json databaseId,headSha --jq ".[] | select(.headSha==\"$PC\") | .databaseId" | head -1); [ -n "$run" ] && break; sleep 5; done
[ -n "${run:-}" ] || { say "STEP 2: no Deploy run appeared"; exit 3; }
echo "$run" > $B/deploy-run.txt; say "step 2: Deploy run $run"
gh run watch "$run" --repo EnclaveHost/enclave --exit-status > $B/deploy-watch.txt 2>&1 || true
jobs=$(gh run view "$run" --repo EnclaveHost/enclave --json jobs --jq '[.jobs[] | "\(.name)=\(.conclusion)"] | sort | join(" ")'); say "step 2: jobs: $jobs"
[ "$jobs" = "contracts-notice=skipped contracts=skipped detect=success relay=success release=skipped site=skipped" ] || { say "STEP 2: not detect+relay success: STOP (rollback decision)"; exit 5; }
say "step 2 pushed and deployed (run $run); next: pc-2-accept.sh"
