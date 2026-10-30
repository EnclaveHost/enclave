# control-guest cutover r2 (enclave-api-relay -> local verifier): PREPARED, NOEXECUTE, every unimplemented gate HOLDs

The original `../control-guest-cutover-stage/` is FROZEN; root rejected it for execution. Its SHA256SUMS and that file's own
hash are pinned in `FROZEN-ORIGINAL.sha256`. r2 is a NEW stage. In production it cannot mutate anything today: `15-gates.sh`
HOLDs, at the least on the canary protocol. Nothing in r2 was run on the guest, and the tests were not run either.

## Fixes for root's five findings
1. **Canary** (`guest/30-canary.sh`) has no pass path. After its local checks it always exits 3 HOLD: no reviewed
   app/lease/secrets-v1 protocol exists. `CANARY_DEPLOYMENT` and every other variable are ignored. No protocol was invented.
   `15-gates.sh` G4 therefore HOLDs before any mutation, because a cutover could never be accepted.
2. **Release / verifier / backend gates** (`guest/15-gates.sh`) check the following, and nothing passes on a non-empty file or
   variable alone:
   - The staged release must be in relay/deploy.sh's `.deploy-manifest` format (`sha256  relpath`) and pass deploy.sh's own
     checks: path pattern l.287, `sha256sum -c --strict` and no stray files (l.155-156). A staged `node_modules` HOLDs,
     because r2 does no dependency swap.
   - The release receipt is accepted only if its sha256 equals the hash root pinned in
     `/etc/enclave-cutover/ACK-<baseline id>`. It must also end in `## rc=0`, carry `accepted-commit=<40 hex>` and carry
     `deploy-manifest-sha256=` set to this staged manifest's hash.
   - The verifier needs a root-pinned `verifier-identity.receipt` for exactly that URL; `eth_chainId` is necessary but never
     sufficient.
   - The own tx backend needs a root-pinned `backend-readiness.receipt`. It must be a private literal, not port 8190, not a
     caddy upstream and not the verifier.
   - No receipt exists today, so the release gate HOLDs ("no accepted artifact exists").
3. **Phases** (`guest/20-apply.sh`):
   - A, the drift check against the baseline (`10-drift-check.sh`), runs PRE-activation only.
   - B is the gates; C is NOEXECUTE (exit 10).
   - D is ONE activation decision: staged files and the drop-in, one daemon-reload, one restart.
   - E checks the activated-candidate identity against the staged manifest, never against the baseline hashes: a new
     InvocationID, the drop-in hash, salted per-variable env hashes, and the authority line in that invocation's journal.
   - F is the canary.
   - Every step is written to `<run>/phase.journal` before it acts. Any exit before `DECISION committed` (an error, set -e or
     a signal) goes through the EXIT trap and rolls back release AND config. There is no "new release, old config" state.
4. **Strict scripting:**
   - `set -euo pipefail` everywhere, and every copy, install and rename is followed by a hash check.
   - Renames use `mv -fT` after a hash-verified temp copy; `mv -n` is not used.
   - Journal checks use `journalctl _SYSTEMD_INVOCATION_ID=<current InvocationID>`, with no time window.
   - Env values are compared as salted sha256 on the guest. Only names are printed: `X(lost-or-changed)`, `(new)`,
     `(still-set)`, `(not-expected)`.
5. **Rollback** (`guest/90-rollback.sh <baseline> <run>`) replays the journal newest-first:
   - It restores a release file only if its backup equals the baseline hash.
   - It removes only files and dirs that run created, and only the drop-in whose hash that run installed. Other drop-ins are
     never touched, and nothing is broad-deleted.
   - It then runs daemon-reload, restarts only if that run restarted, and verifies the result: a new InvocationID (or the
     unchanged one if there was no restart), release, drop-ins and env values equal to the baseline, and /v1/health 200.
   - Exit 0 means `DECISION rolled-back`; any failure means `DECISION rollback-failed` and **exit 8**. Backups and the journal
     are kept. A decided run is never rolled back twice.

Exit codes: 0 committed (unreachable in r2), 3 HOLD, 5 rolled back and verified, 8 ROLLBACK FAILED, 9 mismatch/drift,
10 NOEXECUTE, 64 usage/test-root refusal, 75 lock held.

## Guest procedure (root, on enclave-control; NOT authorized now)
1. `00-capture-baseline.sh` is read-only and refuses if the box is not EXPECTED-LIVE. It writes a 0700 baseline dir with
   `BASELINE.sha256` and prints only names and hashes.
2. Root reviews and writes `/etc/enclave-cutover/{accepted-release,verifier-identity,backend-readiness}.receipt` and
   `ACK-<baseline id>`. The ACK lines are `baseline=`, `release-receipt=`, `verifier-receipt=` and `backend-receipt=`, each
   followed by a sha256.
3. Run `20-apply.sh <baseline> http://127.0.0.1:<verifier port> http://<own backend> <staged dir>`. Today it ends in HOLD (3).
   Running it mutates nothing until a reviewed canary protocol stage replaces G4 and 30-canary's HOLD.

## Root tests (`tests/run-root-tests.sh`, offline, stub tools, fixtures under /tmp)
    cd work/rpc-production-final-20261025 && ./jobs/q-exit-status.sh control-cutover-r2-tests-1 512 unshare -rn bash control-guest-cutover-stage-r2/tests/run-root-tests.sh
The cases are T0 guard, T1 stale journal, T2 non-empty CANARY env, T3 fake/non-empty receipts, T4 missing release, T5 partial
apply, T6 rollback failure, T7 drift and T8 NOEXECUTE. A final check confirms that no fake secret value appears in any output.
Only the last line `## rc=0` counts as a pass.

The test seam is `CUTOVER_TEST_ROOT`. It is accepted only for a dir under /tmp, and only when systemctl, journalctl, curl and
getent all resolve to stubs inside it. `CUTOVER_TEST_ALLOW_MUTATION=yes` bypasses G4 only inside such a root.
