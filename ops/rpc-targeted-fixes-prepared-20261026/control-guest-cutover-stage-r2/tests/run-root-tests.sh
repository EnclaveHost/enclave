#!/usr/bin/env bash
# ROOT TEST RUNNER for control-guest-cutover r2. Offline: every case builds a fixture tree under /tmp with stub
# systemctl/journalctl/curl/getent (tests/stubs) and runs the real guest scripts with CUTOVER_TEST_ROOT pointing at it.
# Never touches systemd, /etc, /opt, the network or a real unit (lib.sh refuses a test root whose tools are not stubs).
#   cd work/rpc-production-final-20261025 && ./jobs/q-exit-status.sh control-cutover-r2-tests-1 512 unshare -rn bash control-guest-cutover-stage-r2/tests/run-root-tests.sh
# Last line "## rc=0" only if every check passed (fixture temp dir kept on failure).
set -uo pipefail; export LC_ALL=C
TD=$(cd "$(dirname "$0")" && pwd); G=$TD/../guest
T=$(mktemp -d /tmp/cutover-r2-tests.XXXXXX) || { echo "## rc=99"; exit 99; }
V=http://127.0.0.1:8545 TX=http://127.0.0.1:8547 COMMIT=0123456789abcdef0123456789abcdef01234567
npass=0 nfail=0 ALL=$T/all.out
ok() { npass=$((npass+1)); echo "ok   $*"; }
no() { nfail=$((nfail+1)); echo "FAIL $*"; }
check() { local n=$1; shift; if "$@"; then ok "$n"; else no "$n"; fi; }
run() { OUT=$(env -i PATH="$RT/bin:/usr/bin:/bin" HOME=/tmp CUTOVER_TEST_ROOT="$RT" "$@" 2>&1); RC=$?; printf '%s\n' "$OUT" >> "$ALL"; }
expect() { local want=$1 n=$2; shift 2; run "$@"; if [ "$RC" = "$want" ]; then ok "$n (rc $RC)"; else no "$n: rc $RC, want $want"; printf '%s\n' "$OUT" | sed 's/^/      | /'; fi; }
has() { grep -qF -- "$1" <<<"$OUT"; }
not_has() { ! grep -qF -- "$1" <<<"$OUT"; }
h256() { sha256sum < "$1" | cut -d' ' -f1; }
stub() { env -i PATH="$RT/bin:/usr/bin:/bin" "$RT/bin/$1" "${@:2}" >/dev/null; }
EX=(CUTOVER_EXECUTE=yes CUTOVER_TEST_ALLOW_MUTATION=yes)

new_root() { # fresh fixture: old live release, an operator drop-in, env with fake secrets, baseline captured, staged candidate
  RT=$(mktemp -d "$T/root.XXXXXX"); S=$RT/state; DD=$RT/etc/systemd/system/enclave-api-relay.service.d; P=$RT/etc/enclave-cutover
  mkdir -p "$RT/bin" "$S" "$RT/opt/nan-relay/node_modules/x" "$DD" "$RT/etc/nan-relay" "$P" "$RT/var/lib" "$RT/proc" "$RT/usr/bin" "$RT/etc/enclave-control-tls"
  cp "$TD"/stubs/* "$RT/bin/"; chmod 0755 "$RT"/bin/*
  printf 'old relay (BASE_RPC pool)\n' > "$RT/opt/nan-relay/api-relay.js"; printf 'lib v1\n' > "$RT/opt/nan-relay/lib.js"
  printf 'dep\n' > "$RT/opt/nan-relay/node_modules/x/index.js"
  printf '[Service]\nEnvironment=OPERATOR_FLAG=1\n' > "$DD/10-operator.conf"
  printf 'ADMIN_TOKEN=s3cr3t-admin-value\n' > "$RT/etc/nan-relay/relay.env"
  printf '%s\n' BASE_RPC=http://127.0.0.1:8190 SECRETS_RELEASE_CATALOG_RPCS=https://base-rpc.publicnode.com ADMIN_TOKEN=s3cr3t-admin-value \
    APP_KEY=s3cr3t-app-value BILLING_NETWORK=base SESSIONS_NETWORK=base > "$S/env.base"
  printf 'node\n' > "$RT/usr/bin/node"
  printf '{"upstreams":[{"dial": "127.0.0.1:8100"},{"dial":"127.0.0.1:8190"}]}\n' > "$RT/etc/enclave-control-tls/caddy.json"
  { for p in /opt/nan-relay/api-relay.js /usr/bin/node /etc/enclave-control-tls/caddy.json; do echo "file $p $(h256 "$RT$p" | cut -c1-16)"; done
    echo "unit enclave-api-relay.service 8100"; } > "$RT/expected-live.txt"
  printf '/v1/secrets 401\n' > "$S/http"; : > "$S/journal"; echo inactive > "$S/active"
  stub systemctl restart enclave-api-relay.service; rm -f "$S"/count-*
  run bash "$G/00-capture-baseline.sh"; B=$(sed -n 's/^## baseline \(.*\) BASELINE\.sha256=.*/\1/p' <<<"$OUT")
  [ "$RC" = 0 ] && [ -n "$B" ] && [ -d "$B" ] || { echo "FIXTURE: baseline capture rc $RC"; printf '%s\n' "$OUT" | sed 's/^/      | /'; echo "## rc=99"; exit 99; }
  INV0=$(cat "$S/inv")
  STG=$RT/var/lib/enclave-cutover/stage-1; mkdir -p "$STG"     # candidate in relay/deploy.sh .deploy-manifest format
  printf 'new relay: imports ./relay-chain-authority.mjs\n' > "$STG/api-relay.js"; printf 'lib v2\n' > "$STG/lib.js"
  printf 'export const authority = 1\n' > "$STG/relay-chain-authority.mjs"; printf 'export const env = 1\n' > "$STG/relay-chain-env.mjs"
  ( cd "$STG" && sha256sum api-relay.js lib.js relay-chain-authority.mjs relay-chain-env.mjs > .deploy-manifest )
}
write_ack() { printf 'baseline=%s\nrelease-receipt=%s\nverifier-receipt=%s\nbackend-receipt=%s\n' "$(h256 "$B/BASELINE.sha256")" \
  "$(h256 "$P/accepted-release.receipt")" "$(h256 "$P/verifier-identity.receipt")" "$(h256 "$P/backend-readiness.receipt")" > "$P/ACK-$(basename "$B")"; }
approve() { # stand-in root receipts + approval, all valid for this fixture (the real ones do not exist)
  printf 'accepted-commit=%s\ndeploy-manifest-sha256=%s\n## rc=0\n' $COMMIT "$(h256 "$STG/.deploy-manifest")" > "$P/accepted-release.receipt"
  printf 'verifier-url=%s\n## rc=0\n' "$V" > "$P/verifier-identity.receipt"
  printf 'tx-backend=%s\n## rc=0\n' "$TX" > "$P/backend-readiness.receipt"; write_ack; }
live_is_baseline() { diff <(cd "$RT/opt/nan-relay" && find . -path ./node_modules -prune -o ! -type d -printf '%P\n' | sort | while IFS= read -r f; do sha256sum -- "$f"; done) "$B/release.sha256" >/dev/null; }
dropins_are_baseline() { [ ! -e "$DD/50-chain-authority.conf" ] && diff <(cd "$DD" && find . -maxdepth 1 ! -type d -printf '%P\n' | sort | while IFS= read -r f; do sha256sum -- "$f"; done) "$B/dropins.sha256" >/dev/null; }
no_run_dir() { ! compgen -G "$RT/var/lib/enclave-cutover/run-*" >/dev/null; }
one_run_dir() { RUN=$(compgen -G "$RT/var/lib/enclave-cutover/run-*"); [ "$(wc -l <<<"$RUN")" = 1 ] && [ -d "$RUN" ]; }
decision() { [ "$(grep '^DECISION' "$RUN/phase.journal" | tail -n 1)" = "DECISION $1" ]; }
jhas() { grep -qx -- "$1" "$RUN/phase.journal"; }
no_tmp() { ! find "$RT/opt/nan-relay" "$DD" -name '*-tmp' | grep -q .; }
untouched() { check "$1: live release = baseline" live_is_baseline; check "$1: drop-ins = baseline" dropins_are_baseline
  check "$1: no run dir" no_run_dir; check "$1: unit not restarted" [ "$(cat "$S/inv")" = "$INV0" ]; }
restored() { check "$1: decision rolled-back" decision rolled-back; check "$1: live release = baseline" live_is_baseline
  check "$1: drop-ins = baseline (operator drop-in kept)" dropins_are_baseline; check "$1: new files removed" [ ! -e "$RT/opt/nan-relay/relay-chain-authority.mjs" ]
  check "$1: no temp leftovers" no_tmp; check "$1: node_modules untouched" [ "$(cat "$RT/opt/nan-relay/node_modules/x/index.js")" = dep ]; }

echo "# T0 test-root guard + positive control"
new_root
OUT=$(env -i PATH=/usr/bin:/bin HOME=/tmp CUTOVER_TEST_ROOT="$RT" bash "$G/10-drift-check.sh" "$B" 2>&1); check "T0 real systemctl on PATH is refused in a test root" [ $? = 64 ]
OUT=$(env -i PATH="$RT/bin:/usr/bin:/bin" HOME=/tmp CUTOVER_TEST_ROOT=/etc bash "$G/10-drift-check.sh" "$B" 2>&1); check "T0 a test root outside /tmp is refused" [ $? = 64 ]
expect 0 "T0 fresh baseline has no drift" bash "$G/10-drift-check.sh" "$B"

echo "# T1 stale journal"
OLD=0123456789abcdef0123456789abcdef
echo "$OLD [chain] relay chain authority: local verifier $V (unsafe tier, no L1 finality); tx backend set" >> "$S/journal"
expect 1 "T1 authority line only from an OLDER invocation -> canary FAIL" bash "$G/30-canary.sh" "$B" "$V" "$TX" "$INV0"
check "T1 ... names the current invocation" has "current invocation $INV0 did not report"
run journalctl -u enclave-api-relay --since "-10 min" --no-pager
check "T1 (frozen r1 defect reproduced) its time-window grep would accept that stale line" has "[chain] relay chain authority: local verifier"
expect 1 "T1 expected activated InvocationID is not the current one -> FAIL" bash "$G/30-canary.sh" "$B" "$V" "$TX" "$OLD"

echo "# T2 non-empty CANARY env"
new_root
cp "$STG"/api-relay.js "$STG"/lib.js "$STG"/relay-chain-authority.mjs "$STG"/relay-chain-env.mjs "$RT/opt/nan-relay/"
printf '[Service]\nEnvironment=ENCLAVE_CHAIN_AUTHORITY=verifier\nEnvironment=ENCLAVE_CHAIN_VERIFIER=%s\nEnvironment=ENCLAVE_CHAIN_TX_BACKEND=%s\nUnsetEnvironment=BASE_RPC RPC_FALLBACKS SECRETS_RELEASE_CATALOG_RPCS CUSTODY_RPCS CUSTODY_MIN_AGREE SESSIONS_RPC\n' "$V" "$TX" > "$DD/50-chain-authority.conf"
stub systemctl restart enclave-api-relay.service; INV1=$(cat "$S/inv")
expect 3 "T2 every local canary check passes -> still HOLD" bash "$G/30-canary.sh" "$B" "$V" "$TX" "$INV1"
check "T2 ... the local checks really passed" has "local checks passed for invocation $INV1"
expect 3 "T2 CANARY_DEPLOYMENT and other CANARY_* set -> still HOLD" CANARY_DEPLOYMENT=demo-app CANARY_APP=demo CANARY_LEASE=0x01 CANARY_RELEASE=ok CANARY_PASS=1 CANARY_EVIDENCE=signed bash "$G/30-canary.sh" "$B" "$V" "$TX" "$INV1"
check "T2 ... never reports PASS" not_has "PASS"

echo "# T3 fake / non-empty receipts"
new_root
expect 3 "T3a no receipts, no approval -> HOLD" CUTOVER_TEST_ALLOW_MUTATION=yes bash "$G/15-gates.sh" "$B" "$V" "$TX" "$STG"
check "T3a ... names the missing approval" has "no root approval"
approve; printf 'fake receipt\n' > "$P/accepted-release.receipt"
expect 9 "T3b non-empty fake release receipt, not the pinned hash -> MISMATCH" CUTOVER_TEST_ALLOW_MUTATION=yes bash "$G/15-gates.sh" "$B" "$V" "$TX" "$STG"
write_ack
expect 9 "T3c fake receipt even when its hash is pinned (no rc=0/commit/manifest) -> MISMATCH" CUTOVER_TEST_ALLOW_MUTATION=yes bash "$G/15-gates.sh" "$B" "$V" "$TX" "$STG"
printf 'accepted-commit=%s\ndeploy-manifest-sha256=%064d\n## rc=0\n' $COMMIT 0 > "$P/accepted-release.receipt"; write_ack
expect 9 "T3d well-formed receipt bound to another manifest -> MISMATCH" CUTOVER_TEST_ALLOW_MUTATION=yes bash "$G/15-gates.sh" "$B" "$V" "$TX" "$STG"
check "T3d ... says not bound" has "does not bind this staged .deploy-manifest"
approve
expect 0 "T3e positive control: valid receipts + approval + test-only bypass -> gates pass" CUTOVER_TEST_ALLOW_MUTATION=yes bash "$G/15-gates.sh" "$B" "$V" "$TX" "$STG"
expect 3 "T3f the same valid receipts WITHOUT the test bypass -> HOLD" bash "$G/15-gates.sh" "$B" "$V" "$TX" "$STG"
check "T3f ... names the missing canary protocol" has "no reviewed app/lease/secrets-v1 canary protocol"
expect 3 "T3f valid receipts + CANARY_DEPLOYMENT set -> canary-protocol gate still HOLDs" CANARY_DEPLOYMENT=demo-app CANARY_PASS=1 bash "$G/15-gates.sh" "$B" "$V" "$TX" "$STG"
check "T3f ... the only HOLD is the canary protocol" [ "$(grep -c '^\[HOLD\]' <<<"$OUT")" = 1 ]
printf 'tampered\n' >> "$STG/lib.js"
expect 9 "T3g staged file changed after its manifest -> MISMATCH" CUTOVER_TEST_ALLOW_MUTATION=yes bash "$G/15-gates.sh" "$B" "$V" "$TX" "$STG"
printf 'lib v2\n' > "$STG/lib.js"; printf 'stray\n' > "$STG/extra.js"
expect 9 "T3h stray file outside the manifest -> MISMATCH" CUTOVER_TEST_ALLOW_MUTATION=yes bash "$G/15-gates.sh" "$B" "$V" "$TX" "$STG"
rm -f "$STG/extra.js"; printf 'verifier-url=http://127.0.0.1:9999\n## rc=0\n' > "$P/verifier-identity.receipt"; write_ack
expect 9 "T3i verifier identity receipt for another URL -> MISMATCH" CUTOVER_TEST_ALLOW_MUTATION=yes bash "$G/15-gates.sh" "$B" "$V" "$TX" "$STG"
approve; touch "$S/rpc-down-127.0.0.1:8547"
expect 3 "T3j own backend not answering -> HOLD" CUTOVER_TEST_ALLOW_MUTATION=yes bash "$G/15-gates.sh" "$B" "$V" "$TX" "$STG"
rm -f "$S/rpc-down-127.0.0.1:8547"
expect 9 "T3k tx backend = public gateway 8190 -> MISMATCH" CUTOVER_TEST_ALLOW_MUTATION=yes bash "$G/15-gates.sh" "$B" "$V" http://127.0.0.1:8190 "$STG"
check "T3k ... names the public gateway" has "public gateway"

echo "# T4 missing release"
new_root; approve
expect 3 "T4a staged release absent -> HOLD" CUTOVER_TEST_ALLOW_MUTATION=yes bash "$G/15-gates.sh" "$B" "$V" "$TX" "$RT/var/lib/enclave-cutover/stage-absent"
check "T4a ... no accepted artifact" has "no accepted artifact exists"
expect 3 "T4b apply with EXECUTE but no staged release -> HOLD" "${EX[@]}" bash "$G/20-apply.sh" "$B" "$V" "$TX" "$RT/var/lib/enclave-cutover/stage-absent"
untouched T4b
mv "$STG/.deploy-manifest" "$STG/.m"
expect 3 "T4c stage without .deploy-manifest -> HOLD" CUTOVER_TEST_ALLOW_MUTATION=yes bash "$G/15-gates.sh" "$B" "$V" "$TX" "$STG"
mv "$STG/.m" "$STG/.deploy-manifest"; rm -f "$P/accepted-release.receipt"
expect 3 "T4d no release receipt file -> HOLD" CUTOVER_TEST_ALLOW_MUTATION=yes bash "$G/15-gates.sh" "$B" "$V" "$TX" "$STG"

echo "# T7 drift / T8 NOEXECUTE"
new_root; approve; printf 'hand edit\n' >> "$RT/opt/nan-relay/lib.js"
expect 9 "T7a live release changed after the baseline -> MISMATCH, before any change" "${EX[@]}" bash "$G/20-apply.sh" "$B" "$V" "$TX" "$STG"
check "T7a ... no run dir" no_run_dir
new_root; approve; sed -i 's/^APP_KEY=.*/APP_KEY=s3cr3t-rotated-value/' "$S/env.base"; stub systemctl restart enclave-api-relay.service
expect 9 "T7b an env VALUE changed after the baseline -> MISMATCH" "${EX[@]}" bash "$G/20-apply.sh" "$B" "$V" "$TX" "$STG"
check "T7b ... names APP_KEY" has "APP_KEY"
new_root; approve
expect 10 "T8 every gate passes but CUTOVER_EXECUTE unset -> NOEXECUTE" CUTOVER_TEST_ALLOW_MUTATION=yes bash "$G/20-apply.sh" "$B" "$V" "$TX" "$STG"
untouched T8

echo "# T5 partial apply"
new_root; approve; echo 1 > "$S/fail-daemon-reload"
expect 5 "T5a daemon-reload fails after release files + drop-in written -> rolled back" "${EX[@]}" bash "$G/20-apply.sh" "$B" "$V" "$TX" "$STG"
check "T5a one run dir" one_run_dir; check "T5a journal: release files were activated" jhas "release-files-activated -"
restored T5a; check "T5a no restart happened (same invocation)" [ "$(cat "$S/inv")" = "$INV0" ]
new_root; approve; echo 1 > "$S/fail-restart"
expect 5 "T5b the one restart fails -> rolled back and restarted on the baseline" "${EX[@]}" bash "$G/20-apply.sh" "$B" "$V" "$TX" "$STG"
check "T5b one run dir" one_run_dir; restored T5b
check "T5b unit active" [ "$(cat "$S/active")" = active ]; check "T5b rollback restarted it (new invocation)" [ "$(cat "$S/inv")" != "$INV0" ]
new_root; approve
expect 5 "T5c full activation, identity ok, canary HOLD -> rolled back, never committed" "${EX[@]}" bash "$G/20-apply.sh" "$B" "$V" "$TX" "$STG"
check "T5c one run dir" one_run_dir; check "T5c candidate identity was verified" grep -q '^identity-ok ' "$RUN/phase.journal"
check "T5c canary rc 3 journaled" jhas "canary 3"; check "T5c never committed" bash -c '! grep -q "DECISION committed" "$1"' _ "$RUN/phase.journal"
restored T5c; expect 0 "T5c drift check after rollback: baseline exactly" bash "$G/10-drift-check.sh" "$B"
expect 8 "T5c a decided run is never rolled back twice" bash "$G/90-rollback.sh" "$B" "$RUN"
new_root; approve; echo 'ADMIN_TOKEN=s3cr3t-changed-value' > "$S/mutate-env"
expect 5 "T5d activation changed an admin VALUE -> identity fails, rolled back" "${EX[@]}" bash "$G/20-apply.sh" "$B" "$V" "$TX" "$STG"
check "T5d ... names ADMIN_TOKEN only" has "ADMIN_TOKEN(lost-or-changed)"; check "T5d one run dir" one_run_dir; restored T5d

echo "# T6 rollback failure"
new_root; approve; echo 2 > "$S/fail-restart"
expect 8 "T6a rollback's restart fails -> ROLLBACK FAILED, explicit rc" "${EX[@]}" bash "$G/20-apply.sh" "$B" "$V" "$TX" "$STG"
check "T6a one run dir" one_run_dir; check "T6a decision rollback-failed" decision rollback-failed; check "T6a says ROLLBACK FAILED" has "ROLLBACK FAILED"
check "T6a backups kept" [ -f "$RUN/files/api-relay.js" ]
new_root; approve; echo 1 > "$S/fail-daemon-reload"
printf 'for f in %s/var/lib/enclave-cutover/run-*/files/api-relay.js; do printf "corrupt\\n" >> "$f"; done\n' "$RT" > "$S/hook-daemon-reload"
expect 8 "T6b corrupted backup -> not restored, ROLLBACK FAILED, no restart" "${EX[@]}" bash "$G/20-apply.sh" "$B" "$V" "$TX" "$STG"
check "T6b one run dir" one_run_dir; check "T6b names the bad backup" has "backup of api-relay.js does not equal the baseline hash"
check "T6b decision rollback-failed" decision rollback-failed; check "T6b candidate file left in place, not overwritten" cmp -s "$RT/opt/nan-relay/api-relay.js" "$STG/api-relay.js"
check "T6b backup kept" [ -f "$RUN/files/api-relay.js" ]; check "T6b unit not restarted" [ "$(cat "$S/inv")" = "$INV0" ]
new_root; approve; printf 'printf "# edited by someone else\\n" >> %s/50-chain-authority.conf\n' "$DD" > "$S/hook-restart"
expect 8 "T6c drop-in changed by someone else -> NOT removed, ROLLBACK FAILED" "${EX[@]}" bash "$G/20-apply.sh" "$B" "$V" "$TX" "$STG"
check "T6c names the foreign drop-in" has "is not the file this run installed: NOT removed"
check "T6c foreign drop-in still present" [ -f "$DD/50-chain-authority.conf" ]; check "T6c operator drop-in kept" [ -f "$DD/10-operator.conf" ]
expect 8 "T6d rollback of a run without a journal" bash "$G/90-rollback.sh" "$B" "$RT/var/lib/enclave-cutover/run-none"

check "no fake secret value appears in any output" bash -c '! grep -q s3cr3t "$1"' _ "$ALL"
echo "## $npass passed, $nfail failed (fixtures $T)"
[ $nfail = 0 ] && { rm -rf "$T"; echo "## rc=0"; exit 0; }
echo "## rc=1"; exit 1
