# Author notes — r2: unavailable manager ≠ dead guest (source only, nothing run)

Nothing was executed: no tests, node, builds or tools beyond Read/Grep/Glob/Edit/Write. **No test outcome is known.** I can't compute hashes here, so the root collector must generate the diff and SHA256 for each file.

## Changed files
- `supervisor.js` (modified)
- `test/isolation-instance-liveness.test.mjs` (new)
- `AUTHOR-NOTES.md` (new)

No helper module was added, and the existing tests were not changed.

## Contract
`classifyInstanceView(r, vmId, name)` / `observeInstance(rec)` return `running | starting | dead | unknown`:
- `dead`: a 404 for the requested id, or a 200 for the same id (and, on the guest tier, the same name) whose state is one of `failed|stopped|exited|terminated`. `preempted` is set only for an authenticated `failed`+`preempted:true`.
- `unknown`: any transport, session, MAC or JSON throw; any non-200/404 status; a non-object body or one without a string `status`; a mismatched id or name; or any other state.
- `starting` is only recognised on the guest tier. It counts as live but not as serving.

`instanceAlive` and `instancePreempted` were removed. They did duplicate reads and interpreted them differently. Every consumer now reads one observation.

## Call-site map
| Site | Before | After |
|---|---|---|
| auditClaims, running branch | transport error = death → `_deaths++`, DELETE, relaunch | Captures `_vmId` before the await and discards a stale result (record replaced, status/vmId changed, restarting, provisioning, release intent). `unknown` → keep everything and observe again next pass. `dead` → the same preemption/death ladder as before; preemption now uses the same observation. The owner-stop, lease-loss, wallet and placement branches run before this, unchanged. |
| auditClaims, claimed branch | false → noteProvisionFailure + release | Paced by `_provisionDeferred.retryAt`; a deferred result skips failure/release. |
| auditClaims, death relaunch | same | Deferred result skips failure/release. |
| billing, on-chain | `healthy && !alive` → respawn | Respawns only on `dead`, and only if the record is still running the same `_vmId`. |
| billing, off-chain | `!alive` → pause + respawn | `unknown` → pause (`instance_unknown`), no respawn and no charge. `dead` → same as before, plus the identity check. |
| tenantServing | isolation: own GET | Only `running` counts as serving. |
| spawnContainer, POST 409 | a non-200 or malformed follow-up was treated as a mismatch → DELETE + POST | A throw or `unknown` raises `instanceUnknownError` with no DELETE or POST. The adoption checks are unchanged. Only an authenticated `dead`, or a matching live record that fails the existing same-record checks, enters replacement. |
| performTenantProvision | catch → status failed, release `_gpu` | For an on-chain record still `claimed` and current, an `instanceUnknown` error → `deferProvision`: status stays `claimed`, `_gpu` and lease are kept, `_vmId` is set to the held id if it was empty, and backoff runs 15 s ×2 up to 5 min (`PROVISION_DEFER_MS`). Returns **false**, so the boolean contract is unchanged. Success clears the deferral. |
| adopt | false → noteProvisionFailure + releaseLease (resume too) | `provisionDeferred(rec)` → log only; the lease, reservation and guest stay. |
| restart route / version switch / envelope edit | false → note + proveAndRelease | Deferred → no note or release (the restart route answers 503 `restart_deferred`). |
| onPaid / forceProvision (off-chain) | unchanged | The 409-unknown case no longer DELETEs; the record is marked failed as before. |

While deferred, the record is `claimed`, which is not terminal. So `vouchesForLease` vouches for it, `orphanInstancePlan` keeps the guest, `considerClaim` returns "already serving" (no new claim), and proofs and billing (running-only) attest nothing. The retry is the audit's existing crash-recovery branch, the same path that adopts after reconnect.

## Test seam (inert unless DIRECT_CLAIM_SELFTEST.lifecycle sets these)
All new keys are opt-in: `vmFaults`, `audit`, `billing`, `rowPatches`, `snapshotAtMs`. The seam wraps `noteProvisionFailure` and `releaseLease` to record calls, then calls through. The output adds `managerCalls`, `provisionFailureNotes`, `releases`, `auditErrors`, `snapshot`, `detail`, `serving`, and the existing fields are unchanged.

## Tests written, not run
`test/isolation-instance-liveness.test.mjs` covers the 15 ROOT-REGRESSIONS cases through the real audit, sweep, adopt, provision, spawn and reconcile chain, and the billing ticker. Root should also run the compatibility tests (isolation-post-adoption-lease, isolation-resume-shield-model, isolation-guest-pool, tenant-lease) and the baseline via `SUPERVISOR_UNDER_TEST`.

## Unresolved / for root
1. **Seam fidelity is unverified.** Running `auditClaims` in lifecycle mode relies on `HOST_WALLET_POLICY` being unset, `needsVersionSwitch(g.ref, d.appRef)` being false for the direct-bootstrap fixture, and `claimSigner()` working with the synthetic key. If any of these is false, `auditErrors` or unexpected deletes will show it.
2. **The eyesoff-shaped case uses `cpuMilli:1000`** to clear `guestMemoryShareRefusal` at 98304 MiB. It uses the fixture's public id and reservation but a synthetic record digest. It is not the live record.
3. **Scripted transport throws are not the real control-client.** A real authenticated 401/handshake-renewal/MAC failure → reconnect run is still required (ROOT-REGRESSIONS requirement).
4. **The baseline outcome under the new seam is unknown.** Baseline doesn't understand the new keys (`vmFaults` and the rest), so the "baseline must fail" comparison only holds if root carries the seam into the baseline or uses an equivalent baseline harness.
5. **Lease renewal while deferred was not changed.** If renewals only cover running records, a long outage lets the held lease lapse. The audit's existing lease-loss path then tears it down, which is bounded but loses the lease. Changing that is lease policy, which is out of scope.
6. **Unchanged by design:** other awaits in the audit (wallet refusal, version switch, envelope edit), and the success path of `performTenantProvision`, which does no identity re-check.
7. Cold controller activation and journal continuity remain unqualified.
