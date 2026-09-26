#!/usr/bin/env bash
# The owner-grace window (enclave-87's ruling): relay/owner-grace (62469d05 grace + 9aa2f366 bind log, 5d GO; re-cut onto 3212f147
# patch-identical as 9268236f + 64186b97) onto main as ONE fast-forward = ONE relay deploy = ONE api-relay restart. Derived from
# relay-window-20260926c/pace-push.sh (bf GO) with ONLY: the pins (lib.sh), the hv-node row recorded before, and the SOAK gate:
# never before d1's soak loop end (SOAK_END, a hard floor) and only with SOAK_DONE=1 (d1's "soak summary done" received).
# DRY=1 pushes nothing and reports the soak gate instead of enforcing it. Then: og-accept.sh. Rollback: og-rollback.sh.
set -euo pipefail; source "$(dirname "$0")/lib.sh"
gate=$(soak_gate "$(date +%s)" "${DRY:-0}" "${SOAK_DONE:-0}" "$SOAK_END") || { say "$gate"; exit 2; }   # DRY is exactly 0 or 1 from here
soak="now $(date -u +%H:%M:%SZ), floor $SOAK_END, SOAK_DONE=${SOAK_DONE:-unset}"
if [ "$gate" != open ]; then
  [ "${DRY:-0}" = 1 ] && say "DRY: the soak gate is CLOSED ($soak): the live run would refuse here" \
                      || { say "REFUSING: the soak gate is closed ($soak): d1's final soak summary first (enclave-87)"; exit 2; }
fi
git -C $MAIN fetch -q origin main relay/owner-grace
[ "$(git -C $MAIN rev-parse origin/relay/owner-grace)" = "$PC" ] || { say "REFUSING: the branch is not ${PC:0:12} (lib.sh; og-recut.sh after a main move)"; exit 2; }
[ "$(git -C $MAIN rev-parse origin/main)" = "$BASE" ] || { say "REFUSING: main moved from ${BASE:0:12}: run og-recut.sh"; exit 2; }
m=$(context_moved $MAIN); [ -z "$m" ] || { say "REFUSING: main changed relay/site/scripts since $REVIEW_BASE: $(echo $m): re-review"; exit 2; }
[ "$(git -C $MAIN rev-list --count $BASE..$PC)" = 2 ] && [ -z "$(git -C $MAIN rev-list --merges $BASE..$PC)" ] || { say "REFUSING: not 2 plain commits on main"; exit 2; }
got=$(for c in $(git -C $MAIN rev-list --reverse $BASE..$PC); do git -C $MAIN show $c | git patch-id --stable | cut -d' ' -f1; done | tr '\n' ' ' | sed 's/ $//')
[ "$got" = "$PATCHIDS" ] || { say "REFUSING: the patches are not the reviewed ones"; exit 2; }
[ "$(git -C $MAIN diff --name-only $BASE $PC | tr '\n' ' ' | sed 's/ $//')" = "$FILES" ] || { say "REFUSING: the file list is not the reviewed one"; exit 2; }
for f in "${!SHA[@]}"; do [ "$(git -C $MAIN show $PC:relay/$f | sha256sum | cut -c1-64)" = "${SHA[$f]}" ] || { say "REFUSING: relay/$f is not the pinned content"; exit 2; }; done
[ -z "$(git -C $MAIN diff --raw $BASE $PC | awk '$1 ~ /120000/ || $2 ~ /120000/')" ] && ! git -C $MAIN diff --name-only $BASE $PC | grep -q node_modules || { say "REFUSING: a symlink or node_modules path"; exit 2; }
[ -z "$(gh run list --repo EnclaveHost/enclave --workflow deploy.yml --status in_progress --json databaseId --jq '.[].databaseId')" ] || { say "REFUSING: a Deploy run is in progress"; exit 2; }
last=$(gh run list --repo EnclaveHost/enclave --workflow deploy.yml --branch main --status completed --limit 1 --json headSha,conclusion --jq '.[0] | "\(.headSha) \(.conclusion)"')
[ "$last" = "$BASE success" ] || { say "REFUSING: the last completed Deploy on main is '$last', not BASE ${BASE:0:12} success (the push would redeploy a failed diff too)"; exit 2; }
age=$(last_restart_age); [ "$age" -ge 600 ] || { say "REFUSING: the api relay restarted ${age}s ago (< 10 min)"; exit 2; }
# the hv-node box must be attached and serving owner-only BEFORE, so the accept can require the same after
row=$(hv_row); echo "$row" > $B/hv-row-before.txt
[[ "$row" == "hv-node true 0x"* ]] || { say "REFUSING: $HV is not attached serving owner-only before the window ($row)"; exit 2; }
# since cs-3 the cert set is explicit: health in its CERT_SEPARATE mode, ADMIT = the admitted release(s) (after rs-10: 5db18199)
CERT_SEPARATE=1 ADMIT="${ADMIT:-$RF}" bash "$HEALTH" > $B/health-before-og.txt 2>&1 || { cat $B/health-before-og.txt; say "REFUSING: not healthy before the window"; exit 2; }
$NAN "systemctl show enclave-api-relay -p InvocationID --value" > $B/inv0-og.txt
[ "${DRY:-0}" = 1 ] && { say "owner-grace DRY RUN: every pre-push check passed (${PC:0:12} on main ${BASE:0:12}, healthy, last restart ${age}s ago, $HV: $row); nothing pushed"; exit 0; }
say "owner-grace: pushing ${PC:0:12} to main (fast-forward from ${BASE:0:12})"
git -C $MAIN push origin "$PC:refs/heads/main" 2>&1 | tail -2
for i in $(seq 1 60); do run=$(gh run list --repo EnclaveHost/enclave --workflow deploy.yml --json databaseId,headSha --jq ".[] | select(.headSha==\"$PC\") | .databaseId" | head -1); [ -n "$run" ] && break; sleep 5; done
[ -n "${run:-}" ] || { say "OWNER-GRACE: no Deploy run appeared"; exit 3; }
echo "$run" > $B/deploy-run.txt; say "owner-grace: Deploy run $run"
gh run watch "$run" --repo EnclaveHost/enclave --exit-status > $B/deploy-watch.txt 2>&1 || true
jobs=$(gh run view "$run" --repo EnclaveHost/enclave --json jobs --jq '[.jobs[] | "\(.name)=\(.conclusion)"] | sort | join(" ")'); say "owner-grace: jobs: $jobs"
[ "$jobs" = "contracts-notice=skipped contracts=skipped detect=success relay=success release=skipped site=skipped" ] || { say "OWNER-GRACE: not detect+relay success: STOP (rollback decision)"; exit 5; }
say "owner-grace pushed and deployed (run $run); next: og-accept.sh"
