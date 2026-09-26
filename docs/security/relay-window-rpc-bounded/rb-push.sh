#!/usr/bin/env bash
# The rpc-bounded window, step 1: relay/rpc-bounded (bf GO) onto main as ONE fast-forward = ONE relay deploy = ONE api-relay
# restart. relay-window-20260926c/pace-push.sh (bf GO, run 06:40Z) with ONLY: the pins (lib.sh), 1 commit instead of 2, the names,
# DRY must be exactly 0 or 1 (enclave-5d's gate finding on owner-grace: DRY=true must never read as a live run), and nucbox-k11's
# row recorded before. DRY=1 pushes nothing. Then: rb-accept.sh. Rollback: rb-rollback.sh.
set -euo pipefail; source "$(dirname "$0")/lib.sh"
case "${DRY:-0}" in 0|1) ;; *) say "REFUSING: DRY must be exactly 0 or 1 (got '${DRY:0:12}')"; exit 2;; esac
git -C $MAIN fetch -q origin main relay/rpc-bounded
[ "$(git -C $MAIN rev-parse origin/relay/rpc-bounded)" = "$PC" ] || { say "REFUSING: the branch is not ${PC:0:12} (lib.sh; rb-recut.sh after a main move)"; exit 2; }
[ "$(git -C $MAIN rev-parse origin/main)" = "$BASE" ] || { say "REFUSING: main moved from ${BASE:0:12}: run rb-recut.sh"; exit 2; }
m=$(context_moved $MAIN); [ -z "$m" ] || { say "REFUSING: main changed relay/site/scripts since $REVIEW_BASE: $(echo $m): re-review"; exit 2; }
[ "$(git -C $MAIN rev-list --count $BASE..$PC)" = 1 ] && [ -z "$(git -C $MAIN rev-list --merges $BASE..$PC)" ] || { say "REFUSING: not 1 plain commit on main"; exit 2; }
got=$(for c in $(git -C $MAIN rev-list --reverse $BASE..$PC); do git -C $MAIN show $c | git patch-id --stable | cut -d' ' -f1; done | tr '\n' ' ' | sed 's/ $//')
[ "$got" = "$PATCHIDS" ] || { say "REFUSING: the patches are not the reviewed ones"; exit 2; }
[ "$(git -C $MAIN diff --name-only $BASE $PC | tr '\n' ' ' | sed 's/ $//')" = "$FILES" ] || { say "REFUSING: the file list is not the reviewed one"; exit 2; }
for f in "${!SHA[@]}"; do [ "$(git -C $MAIN show $PC:relay/$f | sha256sum | cut -c1-64)" = "${SHA[$f]}" ] || { say "REFUSING: relay/$f is not the pinned content"; exit 2; }; done
[ -z "$(git -C $MAIN diff --raw $BASE $PC | awk '$1 ~ /120000/ || $2 ~ /120000/')" ] && ! git -C $MAIN diff --name-only $BASE $PC | grep -q node_modules || { say "REFUSING: a symlink or node_modules path"; exit 2; }
[ -z "$(gh run list --repo EnclaveHost/enclave --workflow deploy.yml --status in_progress --json databaseId --jq '.[].databaseId')" ] || { say "REFUSING: a Deploy run is in progress"; exit 2; }
last=$(gh run list --repo EnclaveHost/enclave --workflow deploy.yml --branch main --status completed --limit 1 --json headSha,conclusion --jq '.[0] | "\(.headSha) \(.conclusion)"')
[ "$last" = "$BASE success" ] || { say "REFUSING: the last completed Deploy on main is '$last', not BASE ${BASE:0:12} success (the push would redeploy a failed diff too)"; exit 2; }
age=$(last_restart_age); [ "$age" -ge 600 ] || { say "REFUSING: the api relay restarted ${age}s ago (< 10 min: the NucBox soak)"; exit 2; }
hv_row > $B/hv-row-before.txt   # the NucBox's row before (rb-accept requires it back)
# since cs-3 the cert set is explicit: health in its CERT_SEPARATE mode, ADMIT = the admitted release(s) (after rs-10: 5db18199)
CERT_SEPARATE=1 ADMIT="${ADMIT:-$RF}" bash "$HEALTH" > $B/health-before-rb.txt 2>&1 || { cat $B/health-before-rb.txt; say "REFUSING: not healthy before the window"; exit 2; }
$NAN "systemctl show enclave-api-relay -p InvocationID --value" > $B/inv0-rb.txt
[ "${DRY:-0}" = 1 ] && { say "rpc-bounded DRY RUN: every pre-push check passed (${PC:0:12} on main ${BASE:0:12}, healthy, last restart ${age}s ago); nothing pushed"; exit 0; }
say "rpc-bounded: pushing ${PC:0:12} to main (fast-forward from ${BASE:0:12})"
git -C $MAIN push origin "$PC:refs/heads/main" 2>&1 | tail -2
for i in $(seq 1 60); do run=$(gh run list --repo EnclaveHost/enclave --workflow deploy.yml --json databaseId,headSha --jq ".[] | select(.headSha==\"$PC\") | .databaseId" | head -1); [ -n "$run" ] && break; sleep 5; done
[ -n "${run:-}" ] || { say "RPC-BOUNDED: no Deploy run appeared"; exit 3; }
echo "$run" > $B/deploy-run.txt; say "rpc-bounded: Deploy run $run"
gh run watch "$run" --repo EnclaveHost/enclave --exit-status > $B/deploy-watch.txt 2>&1 || true
jobs=$(gh run view "$run" --repo EnclaveHost/enclave --json jobs --jq '[.jobs[] | "\(.name)=\(.conclusion)"] | sort | join(" ")'); say "rpc-bounded: jobs: $jobs"
[ "$jobs" = "contracts-notice=skipped contracts=skipped detect=success relay=success release=skipped site=skipped" ] || { say "RPC-BOUNDED: not detect+relay success: STOP (rollback decision)"; exit 5; }
say "rpc-bounded pushed and deployed (run $run); next: rb-accept.sh"
