# Control-guest cutover r2: PREPARED, NOEXECUTE, all unimplemented gates HOLD (nothing run)

Stage: `control-guest-cutover-stage-r2/` (NEW; SHA256SUMS `0bca2cc7245c1ec5…`, 16 files, about 510 script lines).
- **Original frozen:** `control-guest-cutover-stage/` was not modified. Its SHA256SUMS `723af5b5…` still checks clean and is
  pinned in `FROZEN-ORIGINAL.sha256`.
- **Nothing run:** no tests, build, queue job, SSH, network, live change or commit. The only checks were `bash -n` on every
  script.

## Status
- **Production run today:** `20-apply.sh` stops at the gates with **HOLD (3)** and mutates nothing. Each HOLD is a missing
  input:
  - **Approval:** no root `/etc/enclave-cutover/ACK-<baseline>`.
  - **Release:** no accepted release artifact or receipt.
  - **Verifier:** no verifier identity receipt.
  - **Backend:** no own-backend readiness receipt.
  - **Canary:** no reviewed app/lease/secrets-v1 canary protocol.
- **Canary script:** `30-canary.sh` has no pass path. No protocol was invented, and no CANARY_* variable changes the result.
- **Not claimed:** no v2, production or SNP qualification. Custody v2 stays REFUSED; lease consumers stay on HOLD; the
  activation flags were not touched.

## Root's findings → r2
1. **Canary:**
   - It runs its local checks, then always exits HOLD (3).
   - The local checks are:
     - the current InvocationID equals the activated one;
     - that invocation's own journal has the authority line from api-relay.js:336;
     - env values are preserved;
     - health is 200 and unauthenticated /v1/secrets returns 4xx;
     - egress observation.
   - Gate G4 HOLDs *before* any mutation, so no run can only end in rollback.
2. **Release / verifier / backend gates:**
   - The staged release must pass deploy.sh's `.deploy-manifest` rules (12b41d459 l.287 and l.155-156) and must list
     api-relay.js, relay-chain-authority.mjs and relay-chain-env.mjs.
   - Each receipt must:
     - match the sha256 root pinned in ACK-<baseline>;
     - end in `## rc=0`;
     - for the release: carry `accepted-commit=<40hex>` and the staged manifest's hash;
     - for the verifier and backend: name exactly that URL.
   - `eth_chainId` 0x2105 is required but never sufficient.
   - The backend must be a private literal, not port 8190, not a caddy upstream and not the verifier.
3. **Phases** (A drift vs baseline (pre-activation only) → B gates → C NOEXECUTE (10) → D one activation → E candidate
   identity → F canary):
   - Phase D: back up and hash-check every file, swap with temp + hash + `mv -fT`, install the drop-in, one daemon-reload,
     one restart.
   - Phase E checks against the staged manifest, never the baseline hashes: new InvocationID, drop-in hash, env, and the
     invocation's journal line.
   - `phase.journal` is written before each step. An EXIT trap rolls back release and config together on any exit before
     `DECISION committed`.
4. **Strict scripting:**
   - `set -euo pipefail`, and every install, copy and rename is checked by hash; there is no `mv -n`.
   - Journal checks are keyed on `_SYSTEMD_INVOCATION_ID`.
   - Env values are compared as salted per-variable sha256 on the guest. Only names are printed. The systemd volatile names
     INVOCATION_ID, JOURNAL_STREAM and SYSTEMD_EXEC_PID are excluded.
5. **Rollback:**
   - It replays the journal and restores only backups whose hash equals the baseline.
   - It removes only the files and dirs that run created, and only the drop-in whose hash that run installed. There are no
     broad deletes and other drop-ins are untouched.
   - It then runs daemon-reload, restarts if that run restarted, and verifies the release, drop-ins, env values, the
     InvocationID and /v1/health.
   - On failure it writes `DECISION rollback-failed`, keeps everything, and exits **8**.

## Root job (written, NOT run)
    cd work/rpc-production-final-20261025 && ./jobs/q-exit-status.sh control-cutover-r2-tests-1 512 unshare -rn bash control-guest-cutover-stage-r2/tests/run-root-tests.sh
- **Setup:** each case builds a /tmp fixture with stub systemctl, journalctl, curl and getent. The stub systemctl composes the
  env from drop-ins, issues a new InvocationID on each restart, and supports fault injection and one-shot hooks.
- **Cases** (about 90 checks):
  - T0: the test-root guard refuses real tools or a root outside /tmp.
  - **T1 stale journal:** an old invocation's line → FAIL. The test also reproduces the defect that the r1 `--since` grep
    accepts it.
  - **T2 non-empty CANARY_\* env:** still HOLD, never PASS.
  - **T3 fake/non-empty RCPT:** each of these gives a MISMATCH or HOLD:
    - a hash that is not pinned;
    - a fake receipt that is pinned;
    - another manifest;
    - a tampered or stray staged file;
    - a wrong verifier URL;
    - the backend down;
    - port 8190.
  - T3 also has a positive control: everything valid plus the test-only bypass passes. Without the bypass, or with
    CANARY_DEPLOYMENT set, the canary HOLD is the only HOLD.
  - **T4 missing release:** HOLD, and nothing changes.
  - **T5 partial apply:**
    - daemon-reload fails;
    - the restart fails;
    - full activation, then the canary HOLDs;
    - an admin value changes.
    Each case → rolled back (5) and the drift check is clean again. The operator drop-in and node_modules are kept, and no
    run can be rolled back twice.
  - **T6 rollback failure:**
    - the rollback restart fails;
    - the backup is corrupted, so it is not restored and there is no restart;
    - a foreign drop-in edit, which is not removed;
    - no journal.
    Each → exit 8 with backups kept.
  - T7: drift in files or in an env value → 9 before any change. T8: NOEXECUTE → 10.
  - Finally, no fake secret appears in any output.
- **Accept** only a last line of `## rc=0`. The checks have never been run, so fixture fixes may be needed on the first run;
  report a FAIL as it is.

## Limits / open
- **Receipt fields are r2's requirement, not an existing standard.** Root must decide what qualifies as verifier identity
  (for example the pinned Helios digest or a measurement) and as backend readiness.
- **Unconfirmed manifest paths:** that relay-chain-authority.mjs and relay-chain-env.mjs sit at the release root, as deploy
  manifest paths, is an assumption. If it is wrong, the gate MISMATCHes, which is the safe direction.
- **No dependency swap:** a staged `node_modules` HOLDs.
- **The canary stays HOLD by design.** Lifting it needs a separate reviewed protocol stage: an operator test app and
  authenticated evidence that binds app, lease, verifier and release.
