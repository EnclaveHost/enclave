#!/usr/bin/env bash
# U7 step 2 (7.2): the converged commit 2144fcb3 ALONE onto main as a FAST-FORWARD (main must still be aeb345e6), in a
# quiet window; the Deploy run must be relay-only (detect + relay; relay=true only) and deploy to nan-relay only.
set -euo pipefail; source ~/enclave-bench/u7-20260925/lib.sh
git -C $MAIN fetch -q origin main relay/u7-converged 2>/dev/null || git -C $MAIN fetch -q origin main
[ "$(git -C $MAIN rev-parse origin/main)" = "$BASE" ] || { say "REFUSING: main moved from $BASE: re-cut the converged commit"; exit 2; }
[ "$(git -C $MAIN rev-parse "$U7C^")" = "$BASE" ] && [ -z "$(git -C $MAIN rev-list --merges $BASE..$U7C)" ] || { say "REFUSING: $U7C is not a single child of $BASE"; exit 2; }
[ -z "$(git -C $MAIN diff $U7SRC $U7C -- relay/)" ] || { say "REFUSING: the converged relay/ is not fc90d6b5's"; exit 2; }
bad=$(git -C $MAIN diff --name-only $BASE $U7C | grep -vE '^(relay/|test/)' || true); [ -z "$bad" ] || { say "REFUSING: the converged commit touches more than relay/ and test/: $bad"; exit 2; }
[ "$(git -C $MAIN show $U7C:relay/relay.js | sha256sum | cut -c1-64)" = "$RELAY_SHA" ] && [ "$(git -C $MAIN show $U7C:relay/fleet.mjs | sha256sum | cut -c1-64)" = "$FLEET_SHA" ] || { say "REFUSING: relay.js/fleet.mjs are not 5d's expected hashes"; exit 2; }
probe "$NR" | grep -c 'ELIGIBILITY_API: = https://api.enclave.host' | grep -qE '^[3-9]$' || { say "REFUSING: step 1 is not in place on nan-relay"; exit 2; }
[ -z "$(gh run list --repo EnclaveHost/enclave --workflow deploy.yml --status in_progress --json databaseId --jq '.[].databaseId')" ] || { say "REFUSING: a Deploy run is in progress"; exit 2; }
say "U7 step 2: pushing $U7C to main (fast-forward from $BASE)"
git -C $MAIN push origin "$U7C:refs/heads/main" 2>&1 | tail -3
for i in $(seq 1 60); do run=$(gh run list --repo EnclaveHost/enclave --workflow deploy.yml --json databaseId,headSha --jq ".[] | select(.headSha==\"$U7C\") | .databaseId" | head -1); [ -n "$run" ] && break; sleep 5; done
[ -n "${run:-}" ] || { say "U7 STEP 2: no Deploy run appeared"; exit 3; }
say "U7 step 2: Deploy run $run"; echo "$run" > $U7/deploy-run.txt
gh run watch "$run" --repo EnclaveHost/enclave --exit-status > $U7/deploy-watch.txt 2>&1 || true
jobs=$(gh run view "$run" --repo EnclaveHost/enclave --json jobs --jq '[.jobs[] | "\(.name)=\(.conclusion)"] | sort | join(" ")'); say "U7 step 2: jobs: $jobs"
gh run view "$run" --repo EnclaveHost/enclave --log > $U7/deploy-log.txt 2>&1 || true
flags=$(grep -P '^detect\t[^\t]*\t\S+Z [a-z_]+=(true|false)\r?$' $U7/deploy-log.txt | sed -E 's/.*Z ([a-z_]+=(true|false)).*/\1/' | sort -u | tr '\n' ' '); say "U7 step 2: detect flags: $flags"
grep -q '== data-plane relays: nan-relay$' $U7/deploy-log.txt && ! grep -q 'data-plane relays:.*us-west' $U7/deploy-log.txt && say "WATCH ok: nan-relay only" || { say "WATCH FAILED: STOP"; exit 4; }
[ "$jobs" = "contracts-notice=skipped contracts=skipped detect=success relay=success release=skipped site=skipped" ] || { say "U7 STEP 2: the jobs are not detect+relay: STOP (rollback decision: u7-rollback-code.sh)"; exit 5; }
[ -n "$flags" ] || { say "U7 STEP 2 SCOPE: no detect outputs in the log: STOP"; exit 5; }
grep -qw relay=true <<<"$flags" || { say "U7 STEP 2 SCOPE: detect did not say relay=true: STOP"; exit 5; }
for f in $flags; do case "$f" in relay=true|*=false) ;; *) say "U7 STEP 2 SCOPE: detect says $f: STOP"; exit 5;; esac; done
say "U7 step 2 done: Deploy $run relay-only"
