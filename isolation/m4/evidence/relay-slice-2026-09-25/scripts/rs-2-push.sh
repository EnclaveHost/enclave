#!/usr/bin/env bash
# Step 2: push the reviewed slice to main as a FAST-FORWARD (main must still be the base the scope was judged on), then
# follow the Deploy run: detect must say relay=true and nothing else; the relay job must deploy to nan-relay only
# (enclave-d1's WATCH 1: "== data-plane relays: nan-relay"; us-west appearing = stop and investigate).
set -euo pipefail; source ~/enclave-bench/relay-slice-20260925/lib.sh
git -C $MAIN fetch -q origin main
[ "$(git -C $MAIN rev-parse origin/main)" = "$BASE" ] || { say "REFUSING: main moved from $BASE: the CI scope must be judged again"; exit 2; }
[ "$(git -C $MAIN rev-parse "$SLICE^")" = "$BASE" ] || { say "REFUSING: the slice is not a child of $BASE"; exit 2; }
want="relay/api-relay.js relay/deploy.sh relay/measurement-predict.mjs relay/secrets-release.mjs relay/secrets.js relay/snp-verify.mjs relay/tunnel.js relay/vendor/enclave-verifier-node.MANIFEST.json relay/vendor/enclave-verifier-node.mjs test/fixtures/secrets-release-guest-vectors.json test/fixtures/secrets-release-vectors.json test/measurement-predict.test.mjs test/secrets-release.test.mjs test/tunnel.test.mjs verifier/consumer.mjs verifier/dist/MANIFEST.json verifier/dist/enclave-verifier-node.mjs verifier/web/dist/MANIFEST.json"
[ "$(git -C $MAIN diff --name-only $BASE $SLICE | tr '\n' ' ' | sed 's/ $//')" = "$want" ] || { say "REFUSING: the slice's files are not the reviewed 18"; exit 2; }
$NAN "tail -n 11 $ENVF | sha256sum | cut -c1-64; test -f $DROPIN && echo dropin" | tr '\n' ' ' | grep -q "^$LINES_SHA dropin" || { say "REFUSING: step 1 is not in place on nan"; exit 2; }
[ -z "$(gh run list --repo EnclaveHost/enclave --workflow deploy.yml --status in_progress --json databaseId --jq '.[].databaseId')" ] || { say "REFUSING: a Deploy run is in progress"; exit 2; }
say "step 2: pushing $SLICE to main (fast-forward from $BASE)"
git -C $MAIN push origin "$SLICE:refs/heads/main" 2>&1 | tail -3
for i in $(seq 1 60); do run=$(gh run list --repo EnclaveHost/enclave --workflow deploy.yml --json databaseId,headSha --jq ".[] | select(.headSha==\"$SLICE\") | .databaseId" | head -1); [ -n "$run" ] && break; sleep 5; done
[ -n "${run:-}" ] || { say "STEP 2: no Deploy run appeared for $SLICE"; exit 3; }
say "step 2: Deploy run $run"; echo "$run" > $RS/deploy-run.txt
gh run watch "$run" --repo EnclaveHost/enclave --exit-status > $RS/deploy-watch.txt 2>&1 || true
gh run view "$run" --repo EnclaveHost/enclave --json conclusion,jobs --jq '.conclusion, (.jobs[] | "\(.name): \(.conclusion)")' | tee $RS/deploy-jobs.txt
gh run view "$run" --repo EnclaveHost/enclave --log > $RS/deploy-log.txt 2>&1 || true
# enclave-d1: ASSERT the scope, not just print it. The jobs: detect + relay succeed, every other job is skipped; and the
# detect job's own outputs (tee'd into its log): relay=true, and every other deploy/release flag it prints false
jq_ok=$(gh run view "$run" --repo EnclaveHost/enclave --json jobs --jq '[.jobs[] | "\(.name)=\(.conclusion)"] | sort | join(" ")')
say "step 2: jobs: $jq_ok"
[ "$jq_ok" = "contracts-notice=skipped contracts=skipped detect=success relay=success release=skipped site=skipped" ] \
  || { say "STEP 2 SCOPE: the jobs are not exactly detect+relay (the rest skipped): STOP and investigate"; exit 4; }
# the detect job's OUTPUT lines only ("detect<TAB>step<TAB><ts> key=value" with nothing else: the log also echoes the
# workflow's script source, in ANSI colour, which contains "relay=true" as text; verified on run 36113605121)
flags=$(grep -P '^detect\t[^\t]*\t\S+Z [a-z_]+=(true|false)\r?$' $RS/deploy-log.txt | sed -E 's/.*Z ([a-z_]+=(true|false)).*/\1/' | sort -u | tr '\n' ' ')
[ -n "$flags" ] || { say "STEP 2 SCOPE: no detect outputs found in the log: STOP and investigate"; exit 4; }
say "step 2: detect flags: $flags"
grep -qw 'relay=true' <<<"$flags" || { say "STEP 2 SCOPE: detect did not say relay=true"; exit 4; }
for f in $flags; do case "$f" in relay=true|*=false) ;; *) say "STEP 2 SCOPE: detect says $f: STOP and investigate"; exit 4;; esac; done
grep -q '== data-plane relays: nan-relay$' $RS/deploy-log.txt && ! grep -q 'data-plane relays:.*us-west' $RS/deploy-log.txt \
  && say "WATCH 1 ok: the relay job deployed to nan-relay only" || { say "WATCH 1 FAILED: the data-plane relay line is not 'nan-relay' alone: STOP and investigate"; exit 4; }
say "step 2 done: Deploy run $run, relay job success"
