The relay expected-guest slice (aeb345e6) on nan: Codex's next scoped relay stage. The release endpoints stay 503
release_unconfigured (the slice has no U7 eligibility provider). Owner of the execution: enclave-63. Procedure:
enclave-e3's package (docs/security/attested-release-integration/ at 1aeadff4: predict.env, predict.conf, accept.sh)
and enclave-d1's order (source + CI review, PASS): the env and drop-in FIRST on the running old relay (which ignores the
env and only gains MemoryMax 1536M; its PID must not change), then a fast-forward push of main 779e5944 -> aeb345e6, whose
Deploy run is relay-only (nan-relay + nan; EXTRA_RELAY_SSH_HOSTS unset, so not us-west) and restarts the api-relay once.
  scripts/rs-1-config.sh (+ rs-1-remote.sh on nan)  step 1: backup, append the 11 lines, the drop-in, daemon-reload
  scripts/rs-2-push.sh                               step 2: guards (main = base, the 18 files, step 1 in place, no Deploy
                                                     in progress), the push, the Deploy run, WATCH 1 (nan-relay only)
  scripts/rs-3-accept.sh                             step 3: the relay's new invocation up with 0 restarts, /v1/enclaves
                                                     200, the serving-node count back, the KAT PASS of THAT invocation,
                                                     accept.sh, MemoryPeak < 1536M, the canaries' public TLS + keys
  scripts/rs-rollback-config.sh / rs-rollback-code.sh   line-wise env revert + drop-in removal; `git revert` pushed to main
accept-BEFORE.txt: accept.sh against production BEFORE the slice: every check fails (rc 1), so it cannot pass vacuously.
predict.env's 11 setting lines equal nan's staged /opt/enclave-predict/829c09adb176/predict.env (sha 57eb0156...; the
package copy only adds a comment header).

RESULT, 2026-09-25 (times read from the clock):
  20:56:36-37Z step 1 on nan: backup api-relay.env.bak-slice-20260925T205636Z; 11 lines appended (57eb0156...); the
             drop-in predict.conf; daemon-reload; the OLD relay (PID 4016281, NRestarts 0) unchanged; MemoryMax 1536M.
  20:56:47Z  step 2: fast-forward push 779e5944 -> aeb345e6; Deploy run 36188755371 success; jobs exactly detect+relay
             (contracts, contracts-notice, site, release skipped); detect's flags relay=true, everything else false
             (no release, no site, no worker/metal/wasm); WATCH 1: the relay job deployed to nan-relay only.
  20:59:08Z  the api-relay's new invocation (d7a7d487...), NRestarts 0; KAT: "known-answer test at start: PASS: 2 known
             answer(s) reproduced exactly".
  20:59:34Z  step 3 run 1 FAILED ONE check: "/v1/enclaves is not 200". That check was MIS-SPECIFIED (by enclave-d1's list
             and by me): /v1/* is proxied to a full-service enclave and answers 503 no_serving_enclave BY DESIGN while
             none serves (sticky(), api-relay.js:1877 at 779e5944, before the slice; metal-iso0 is fullService:false;
             the pre-deploy baseline accept-BEFORE.txt shows the same no_serving_enclave answer on /v1). Every other
             check passed in run 1 (accept.sh with its cold 503 retries, serving 1 = before, MemoryPeak 731 MB).
             Nothing was rolled back: the deploy itself was healthy.
  21:01:44Z  step 3 run 2 with the corrected check (rs-3-accept.sh 12a226aa: the relay's own /enclaves 200 and /health
             ok, and /v1/enclaves still exactly 503 no_serving_enclave): RELAY SLICE ACCEPTED at 21:02:02Z -
             the 3 canaries' measurements predicted (be6b8644 under 5c3561f9; c068f423 under 6f14ce75, twice); release
             -ticket 503 (release OFF); unknown 404; malformed 422; MemoryPeak 731303936 (< 1536M); the canaries'
             public TLS with their S0 keys; metal-iso0 serving and eligible.
  Rollback kept: rs-rollback-config.sh (line-wise, the backup above) and rs-rollback-code.sh (git revert on main).
