# REPORT-R5 — ownership/recovery failure closure + usable cold recovery (source only)

Status: **authored, NOT run.** No command, test, compiler, network, Git, wallet or service was used. Root executes the tests. Nothing is
claimed to pass; nothing was migrated to production; no contract, financial record or global book was changed. Inherited `REPORT.md` and
`REPORT-R4.md` are left untouched.

Root's seeded repairs are preserved: the owned-durable-state completion is published before callbacks, the referenced withdrawal-deadline
timer, the caught `owner.release` exception and the truthful deadline diagnostic (`begin()` is byte-identical apart from surrounding code);
the witness `close-abort` newline correction (kept, extended on a new line); the root adoption-ordering overlay (the dispatch generator was
not touched).

## Files written in this run (under `candidate/`)

| File | Change |
|---|---|
| `src/network/owned-durable-state.mjs` | (1) unproven-acknowledgement record, owned boot verification, owned-only recovery with no synthesized intent |
| `src/tools/generate-host-authority-permit-candidates.mjs` | (2)(3)(4) gate failure latch + staged compute + published close; runtime owned serve + staged registration + Stop proof; witness awaited close. Same five pinned inputs, marker and restoration self-proof |
| `src/network/lifecycle-host-owned-authority.mjs` | combined withdrawal/release published before callbacks; optional parent lock; composition refuses uncertain sidecars; NEW `recoverOwnedHostSidecars` cold-recovery entry |
| `test/root-async-ownership-r4.test.mjs` | the 16 executed tests (3 adapted, see delta), root's 3 r8 ROOT tests verbatim, 10 new r5 tests |
| `test/host-authority-permit.test.mjs` | 7b 'dir' branch: reopened handle gets `openOwnedLock(f)` (assertions unchanged) |
| `test/root-completion-protocol.test.mjs` | C6 third sidecar gets `openOwnedLock(f3)` (assertions unchanged) |
| `REPORT-R5.md` | this file |

Not changed: both sidecar journal modules (they already pass `owner` through), dispatch generator, other tests, harnesses.

## 1. Durable ambiguity (double fault) — implemented policy

- **ACK visibility is not proof.** If the acknowledgement rename landed but its final directory sync failed, the fact is recorded
  (a) in-process for that path (every later open in this process refuses) and (b) as an fsynced `unproven` line in `<file>.history`
  (in addition to the retained intent; if that append fails too, the error says so). The r4 retraction rename is still attempted but nothing
  relies on its success. Root's double-fault test (final ACK fsync + failed retraction) therefore reopens `uncertain`.
- **Owned boot verification.** Every open that holds the actual flock of THIS file (`openLocked*`, composition, recovery entry) verifies a
  consistent intent/acknowledgement pair before the state is usable: no in-process/durable `unproven` record newer than a recovery of that
  seq, then fsync of file + directory NOW and an fsynced `open-verified` provenance line; failure latches uncertain.
- **Recovery** requires the actual owner lock of exactly this file (lock path must be `<file>.lock`, inode still ours; caller booleans or
  another file's lock are refused) and refuses on a missing intent, a malformed/non-v2 intent, unclassifiable bytes (neither exact
  `after` nor `before`), a missing marker, or any sync failure. **No intent is ever synthesized from current bytes** (the r4 legacy path was
  removed; a legacy r3 `v1` intent now refuses recovery). Its own acknowledgement uses the same unproven/retraction path, so a recovery
  double fault also reopens uncertain until a later owned recovery succeeds. Nothing is reset; intent, retracted acknowledgements and
  history are retained; parent journal pending/mined payloads are untouched.
- **Compatibility delta (deliberate):** unowned (caller-owned primitive) reopens of a consistent, never-unproven file stay clean as before
  (root's denial-boundary reopen depends on it); they can neither verify nor recover. Production entry points are owned and always verify.
  Residual: a cross-process unowned reopen after a double fault whose durable `unproven` append ALSO failed is not detectable by the
  primitive; owned opens still re-sync before use.

## 2. Failed withdrawals never forgotten

Generated gate `#withdrawal(id, p)` records a rejection in `failedWithdrawals` (per app) BEFORE removing it from the pending set; every later
`close()` completion rejects while any record remains, so owner/combined release stays fenced (root's "settled withdrawal failure" test).
`close()` publishes its memoized completion before any callback (re-entrant close returns it; the settle loop yields once so close's own
synchronous withdrawals are registered first). Only `withdrawalProven(id, {absent:true, held:true})` clears a record; the generated runtime
calls it only at the end of authenticated `stop()` after confirmed manager absence and an acknowledged boundary hold. A fenced owner handle
stays fenced for its process lifetime (clearing a record does not re-release a lock). Composition: `withdrawAll` and `release` are
published before callbacks; both sidecar flocks (and the optional parent lock) wait on the same combined completion and stay held if it fails.

## 3. Staged compute is owned

v2 `ensureStaged`, once live after readiness, registers `gate.stage(id, () => removeConfirmed(id, instance))` — no serving permit, no
ingress/storage/secret grant. `close()` withdraws staged compute (removal + confirmed absence) and awaits it; failure is recorded/fenced.
`serve` transfers ownership to the tracked serving resource (`unstage` right after `track`); `stop` clears it after proof. v1 unchanged.

## 4. Serve/allow and witness in-flight work

v2 `serve` is an owned operation registered with the gate before its first await; owner release cannot complete while collect/install/allow
is in flight. A late allow success is refused by the final `gate.assert` and withdrawn by an awaited, acknowledged `fence` before the
operation ends; if that fence fails or times out (bounded `boundaryCall`), the operation fails and the owner stays fenced, while compute
removal had already started independently through the tracked `revokeInstance`. Generation/host/deadline checks are unchanged.
Witness `close()` now returns a completion that settles only after every in-flight request settled; owner release awaits it. An aborted
request is treated only as "this witness returned no signature".

## Tests authored, not run (`test/root-async-ownership-r4.test.mjs`)

- Kept: A1-A4, D1, G1-G8 unchanged. **Adapted** (documented in the file header): D2 selects the `recovered` history line (the durable
  `unproven` line precedes it); D3 runs both recoveries under `openOwnedLock` and counts `recovered` lines; D4 asserts the refusal on an
  owned handle.
- Root's three ROOT tests copied verbatim (world gains root's `allowGate` exactly).
- New r5: R1 store double fault + unowned/other-file/same-file lock checks + owned recovery; R2 recovery double fault; R3 missing/malformed
  intent refusal (no synthesis); R4 owned boot verification + failing verification; R5 settled failure cleared only by proven Stop, then
  release; R6 late allow with failing boundary hold → fenced, compute removed; R7 hung allow (3 s default timeout) → acknowledged fence then
  release; R8 witness release awaits in-flight signing; C1 actual composition fenced by failed staged withdrawal: both sidecar locks + parent
  lock held, scoped read works, guarded write refuses, no second owner; C2 cold restart: unacknowledged sidecar refuses composition,
  `recoverOwnedHostSidecars` under parent + both locks, composition stages again, release withdraws staged compute.
- SYNTHETIC doubles are labelled in the file (manager, boundary, readiness, plans, witness reader/transport, canonical adapter stand-in,
  in-memory parent journal in C1/C2). Real: flock, files, generated gate/runtime/witness, typed signatures, composition entry.

Harness needs (root): the r5 generator output (new hashes) overlaid in the native tree, `owned-durable-state.mjs`,
`lifecycle-host-owned-authority.mjs`, `runtime-lock.mjs`, and `test/helpers/lifecycle-fixture.mjs` copied as `test/helpers/ownership-fixture.mjs`.

## Remaining gaps (not waived)

Durable-unproven residual above; serve's acknowledged fence relies on the bounded boundary timeout (≤5 s) rather than a separate deadline;
the owner `withdrawDeadlineMs` is optional (unset = wait indefinitely while fenced). Later work as stated by root: installed-manager per-app
deadman, live Base proof composition, zero-ETH unlisted paid capacity + fresh attestation, measured capacity, paid-work/provisioner
sponsorship, protected independent Offline gas, event-driven refill/top-up, fenced production migration, independent-host refusal and
cold-recovery demonstrations on real hosts. Local tests (once run) would not show the overall goal complete.
