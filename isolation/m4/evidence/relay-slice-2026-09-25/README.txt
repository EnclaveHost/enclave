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
