# Lease deep-recovery r2 (2026-10-26 UTC): root-review corrections. PREPARED, NOT RUN

**Where:** `lease-deep-recovery-solution-stage/r2/`. r1 (`../`) is preserved unchanged, and its `SHA256SUMS` still
verifies.

**Not done:** no tests, queue use, network, SSH, build or commit. Only `node --check` and `bash -n` were run.

## Corrections (all 5 root findings, plus one found while tracing)

0. **A new finding while tracing:** `QuorumChain.snapshot().blockNumber` is a **bigint** (`cli/independent.mjs`
   `pickBlock` → `BigInt`). r1 would have rejected every real read. r2 accepts a bigint, or a safe integer
   normalized to bigint.
1. **Strict `validateMoveSnapshot`** against the traced `moveSnapshot` shape:
   - a bytes32 lowercase `runner`, a boolean `held`, a bigint `block` ≥ 0 and an integer `blockTime`;
   - `d.runner` equal to `runner`, a bigint `d.leaseUntil` and a bigint `d.balance6`;
   - `held` consistent with `runner` and `leaseUntil`.

   Anything else is a `malformed` failed read, never an absence. The tests cover 19 malformed or stale shapes.
2. **Definite** only for a real `ManagementError`/`ManagementBrowserError` with `outcomeUnknown === false`. Every other
   throw is unknown.
3. **No "refused/still held" without a validated read.** A refusal with all reads down or malformed gives
   `quorum-unavailable`.
4. **`receiptVerified` becomes `sourceReport` + `sourceReportedReleased`:** the host's claim, labelled "not verified
   here".
5. **No reorg or finality claim.** "Observation confirmation" on two increasing blocks only. The runner-zeroed label
   is "no runner on the ledger".

**Preserved:** every pre-release refusal, the single never-resent release, the hint loop, and the host-side nonce,
hold-off and admin behaviour.

## Pins

| File | sha256 |
| --- | --- |
| `move-release-recovery-r2.patch` | 347 lines; applies to `81ba66853` and matches `CANDIDATE.sha256` (checked) |
| `cli/enclave.mjs` | `35878448…` |
| `cli/move-release-confirm.mjs` | `559ca2d8…` |
| `test/move-release-confirm.test.mjs` | `23aa051b…` (20 tests) |

**Expected strict TAP (`EXPECTED-TAP.txt`):** the new file passes 20 of 20; `management-move-unit` passes 3 of 3 on the
candidate and 3 of 3 on the base; 0 skip, todo or cancelled.

**Hashes:** the r2 `SHA256SUMS` and the job hashes are printed in `r2/README.md`. `SHA256SUMS` covers all files.

## Root command (after review; offline)

```
./jobs/q-exit-status.sh lease-move-r2 1024 unshare -rn bash lease-deep-recovery-solution-stage/r2/jobs/lease-move-r2-tests.sh
```

**Exit codes:**

| Code | Meaning |
| --- | --- |
| 0 | PASS |
| 1 | FAIL |
| 30 | INCOMPLETE |
| 20 | SETUP (never a verdict) |

**Dependencies:** it reuses the source checkout's existing `node_modules` (read-only, only if `package-lock.json` is
identical). That is not a reproducible install.

## Limits

- **Not run.** This is an observation confirmation, not finality.
- **A quorum outage still stops the move** (exit 4, unknown).
- **Not approved.** Lease consumers stay on HOLD, and Custody v2 stays refused.
