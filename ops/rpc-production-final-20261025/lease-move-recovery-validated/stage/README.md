# lease-deep-recovery r2: root-review corrections (PREPARED, NOT RUN; r1 preserved unchanged in ../)

**Not done:** nothing executed, committed, queued, built or networked. Only `node --check` / `bash -n` were run.

**r1 is superseded.** Root found correctness issues in it. In addition, `QuorumChain.snapshot` returns `blockNumber` as a
**bigint**, so r1's `Number.isSafeInteger(block)` would have failed **every real read**, and every move would have
ended as `quorum-unavailable`.

| Root finding | r2 |
| --- | --- |
| 1. Unvalidated `runner` / `held` | `validateMoveSnapshot` checks the exact `moveSnapshot(id, null)` shape, traced from `cli/enclave.mjs:5468-5479` + `cli/independent.mjs:126-151` + `DEPLOYMENT_TUPLE` (details below). Anything else is a failed read (`malformed`), never an absence. |
| 2. `definite` = `!outcomeUnknown` | Definite **only** when the error is a `ManagementError`/`ManagementBrowserError` (the real classes set `name`) with `outcomeUnknown === false`. An ordinary Error, a thrown non-Error, or a `ManagementError` without the field is outcome-**unknown**. |
| 3. Refusal + zero reads gave "refused / still held" | `refused` needs a **validated** read showing the source's lease. With zero valid reads the result is `quorum-unavailable`. |
| 4. `receiptVerified` | Replaced by `sourceReport` (`released`/`refused`/`unknown`) and `sourceReportedReleased`, the **host's claim**. No field or label claims a locally verified receipt; the CLI says "(the host's claim, not verified here)". |
| 5. A "reorg guard" claim | Removed. Two validated snapshots at increasing blocks are an **observation confirmation only**, not reorg protection or finality. The runner-zeroed label is now "no runner on the ledger", not "lease released". |

**The snapshot schema `validateMoveSnapshot` enforces:**
- **`block`:** a bigint ≥ 0, or a non-negative safe-integer number, normalized to bigint.
- **`runner`:** lowercase bytes32. **`held`:** a boolean. **`blockTime`:** a safe integer ≥ 0.
- **`d.runner`:** must equal `runner`. **`d.leaseUntil`:** a bigint ≥ 0. **`d.balance6`:** a bigint ≥ 0.
- **Consistency:** `held` must equal moveSnapshot's own derivation, `runner ≠ 0 && leaseUntil > blockTime`.

**Unchanged from 81ba66853:**
- every refusal before release (same operator, rate cap, balance, target, confirm);
- exactly ONE release, never resent;
- the hint loop and the `clearedBlock` gating;
- the host side: nonce handling, the hold-off and floor, and admin/scope (`api.restart`).

## Files (`SHA256SUMS` covers all)

| File | What |
| --- | --- |
| `candidate/cli/move-release-confirm.mjs` | the r2 module |
| `candidate/cli/enclave.mjs` | a patched private copy (base: `../base/cli/enclave.mjs`, blob `4ef7f7a1`) |
| `candidate/test/move-release-confirm.test.mjs` | **20** tests on the REAL module and the REAL `ManagementError` |
| `move-release-recovery-r2.patch` | 347 lines. Applies to `git archive 81ba66853` and reproduces exactly `CANDIDATE.sha256` (checked). |
| `EXPECTED-TAP.txt` | the exact counts: 20 new tests; `management-move-unit` 3 on the candidate and 3 on the base |
| `jobs/lease-move-r2-tests.sh` | the root job (below) |

**What the tests cover:**
- 19 malformed or stale snapshot shapes, which all fail closed;
- a malformed read between valid absences;
- the host claim against the owner's observation;
- a deep `release_unconfirmed`, and a late landing within 90 s;
- taken and lapsed leases;
- a reset when the source's lease is observed again; clear-unconfirmed; same-block or lower-block reads;
- an outage, and an outage then recovery; still-held;
- a definite refusal, a refusal with all reads down, and a refusal with only malformed reads;
- an ordinary or forged error treated as unknown;
- exactly one release in every outcome.

## Root job (after review)

```
./jobs/q-exit-status.sh lease-move-r2 1024 unshare -rn bash lease-deep-recovery-solution-stage/r2/jobs/lease-move-r2-tests.sh
```

**Setup:** offline. It checks `SHA256SUMS`, makes fresh `--no-local` clones of `relay-consumer-source` at `81ba66853`
(base and candidate), checks the base blob, `git apply`s the patch, and checks `CANDIDATE.sha256`. Then it runs
`node --check` and `node --test --test-reporter=tap` per file.

**Strict per-file checks:** `# tests` = `# pass` = the expected count, with 0 fail, cancelled, skipped and todo, and
node rc 0.

**Dependencies:** it links the source checkout's existing `node_modules` read-only, and only if `package-lock.json` is
identical. That is a reused install, not a reproducible one.

**Exit codes:**

| Code | Meaning |
| --- | --- |
| 0 | PASS |
| 1 | FAIL |
| 30 | INCOMPLETE |
| 20 | SETUP (never a verdict) |

**Status:** NOT RUN and NOT approved. Lease consumers stay on HOLD, and Custody v2 stays refused.
