# writer-driver-stage/r1: single-native-slot driver (EARLY INTERFACE CONTRACT; source-only; nothing run)

**Base:** the frozen `writer-two-anchor-stage/r3` (source tree `5f141c3f`; its provider API is r2's, read from the reconstruction in `/tmp/w3r/r3`).

**Scope:**
- **New files only:** `relay/derived-reader-driver.mjs` and `test/derived-reader-driver.test.mjs`. **No KVM-owned file and no existing file is changed.**
- **Not touched:** Claude50's `writer-cold-recovery-stage` (backward header/receipt history); the driver only **calls** it through the `cold` hook below.
- **No positive history authority:** the driver decides nothing about authority. Every derived result is accepted or refused by the provider and the native binary.

## Provider API used (exact, r2/r3 `network/derived-reader/provider.mjs`)
| call | used for | notes from source |
|---|---|---|
| `status()` | every decision | `{busy, closed, hasDerivedAnchor, baseAgeSec, verifiedThrough, savedFloor, nativeRunning, provisional: null \| {segments, stateThrough, hasPendingWitness, fenced}}`. `provisional` is non-null **only** when the signed binding carries the policy. |
| `prepare({blockNumber, rollupConfigTemplate, signal})` | finalized ticket | Bootstraps `agreed` from ASR **before** range validation. Range must satisfy `agreed < blockNumber ≤ agreed + maxBlocks (≤1800)`. While `agreed < savedFloor`, it must not pass the floor. |
| `submit({ticket, witness, signal})` | finalized native run | → `{status:'verified', anchor}` \| `{status:'recovering', …}`. Native runs outside the lock; a concurrent one refuses. |
| `prepareProvisional({blockNumber, rollupConfigTemplate, signal})` | provisional ticket | Needs the signed policy, no fence or durable marker, a current served B_f; `blockNumber − tip ≤ policy.maxBlocks`, span and segment bounds. |
| `submitProvisional({ticket, witness, signal})` | provisional native run | → `{status:'provisional', anchor}`. Voided if the chain changed meanwhile. |

**Busy and single-native refusals** (`derived provider busy`, `a native derivation is already running`) are treated as **retry later**, never as failure evidence.

## Driver contract
```js
import { createDerivedReaderDriver, DRIVER_FORMAT, MAX_STATE_AGE_SEC /* 120, never relaxed */ } from './derived-reader-driver.mjs';
const driver = createDerivedReaderDriver({
  provider,                 // the in-process reader (above); never an HTTP endpoint
  targets,                  // async ({signal}) => ({ finalized: int|null, safe: int|null }): UNTRUSTED hints (own node sync status)
  witness,                  // async ({ track:'final'|'provisional', ticket, trusted, agreedL2BlockNumber, maximumWitnessBytes, signal }) => Uint8Array|string
                            //   untrusted producer; its answer is only input to submit (an ack is never proof); size-checked before submit
  evidence,                 // () => ({ states, facts, bytes, fenced:boolean }): read-only view of the anchor journal's provisional section
  cold = null,              // optional (Claude50): { needed(): boolean, step({signal}): Promise<{done:boolean}> }: top priority, same single flight
  clock = { now: () => Date.now() },
  timers = { sleep: (ms, signal) => Promise<void> },
  rollupConfigTemplate,
  config,                   // exact keys, validated; see below
});
driver.start();             // the loop: one decision at a time (single flight across cold, final and provisional)
await driver.tick();        // ONE scheduling decision (tests and injection); refuses while a step is in flight
await driver.stop();        // stops scheduling, aborts the OWNED step's signal, awaits it (the provider's own abort path ends a native run; never a kill)
driver.status();            // see below; never reports "complete"
```

**`config` (exact keys; integers):**
- `finalizedDeadlineSec`: ≤ the reader's `maxAnchorAgeSec`.
- `finalMarginSec`.
- `finalIntervalSec`, `minFinalStep`.
- `stateRefreshSec`: < 120.
- `minStateIntervalSec`.
- `budgetSec: {final, provisional}`: time budget per native run.
- `minRange`.
- `maxRange: {final ≤ 1800, provisional ≤ policy.maxBlocks}`.
- `retry: {baseMs, maxMs, maxConsecutive}`.
- `idleMs`.
- **There is no key that enables the provisional track:** it runs only when `provider.status().provisional !== null` (signed binding).

**Priority, one step at a time:**
1. **Cold:** `cold?.needed()` → `cold.step()`.
2. **Finality first:** a finalized step when there is no served anchor, during recovery (`savedFloor > verifiedThrough`), when `baseAgeSec ≥ finalizedDeadlineSec − finalMarginSec`, or when (hint − verifiedThrough ≥ `minFinalStep` and the time since the last finalized step ≥ `finalIntervalSec`).
   - **Target** = min(verifiedThrough + range, hint.finalized, savedFloor while recovering).
   - **Unknown agreed root:** the first `prepare` bootstraps it.
3. **Provisional:** only if all of the following hold:
   - the policy is on, with no fence (provider) and no durable marker (`evidence().fenced`);
   - evidence is not full (`states < 128`, `facts < 512`, `bytes < 196,608`; the constants are imported from `network/deployment-lifecycle-journal.mjs`);
   - S age > `stateRefreshSec`;
   - the time since the last provisional step ≥ `minStateIntervalSec`, **doubled at ≥ 75 %** fill of any evidence bound.
   - **Target** = min(tip + range, hint.safe), where tip = `stateThrough ?? verifiedThrough`.
4. **Otherwise idle** (`idleMs`).

**Range adaptation (no assumed speed):**
- each track starts at `minRange`;
- after a successful run, range = clamp(floor(measured blocks/s × `budgetSec`), `minRange`, `maxRange`), measured with `clock`;
- on a timeout, refusal or wrong hint, the range is halved and an exponential backoff applies (`retry`, capped);
- after `maxConsecutive` failures the track pauses for `retry.maxMs` (reason in `status`).
- **Witness size:** a witness larger than `maximumWitnessBytes` is never submitted.

**`status()` fields:**
- `format`, `slot` (`idle|cold|final|provisional|stopping|stopped`);
- `bfAgeSec`, `sAgeSec`;
- `cannotMeet120s` (true whenever the policy is on and **no provider-confirmed S ≤ 120 s** exists; cleared only by a fresh S that the provider's `stateThrough` confirms);
- `staleReason`;
- `ranges`, `lastRun{track, blocks, ms}`, `failures`, `backoffUntil`;
- `evidenceFill`;
- `starvation` (time provisional has waited behind finality or cold recovery).
- **S age comes only from a `submitProvisional` result whose block number equals `status().provisional.stateThrough`.** A fixture or caller cannot make S look fresh, and the writer's own 120 s check is independent anyway.

**Wiring:** **not wired in r1**, so startup defaults are unchanged.
- **Intended later:** the role or relay constructs it only with `ENCLAVE_WRITER_AUTHORITY_SOURCE=derived` **and** the role's enrolled state. There is no env or CLI enable and no unsigned path, and contracts and admin controls are untouched.

(Implementation, tests, frozen hashes and root commands follow below.)

---

## Implemented and frozen (2026-10-26 18:56Z; source-only, NOT run)
`writer-driver-stage/r1/SHA256SUMS` sha256 **`05c3dc7d1861f071bd7f858096bc03ee109e95662f7ba4a857ddab81e05130c7`** (files `a-w`)

| file | sha256 |
|---|---|
| `PROVENANCE.md` | `00f6f761aa895341f46337977d1d011e78a6a8ecf0a5ae966543c2c0c0218770` |
| `patches/writer-driver-r1-vs-writer-two-anchor-r3.patch` | `bb7f0bce16b3e4fd1a296028cadfe54bf0ba270dcb94d24e03487f3ae84e1d45` |
| `jobs/root-writer-driver-r1.sh` | `0eb3c1191465bab4173c68384c745ff5fac53d5387b9948525c132189fa3eaac` |

**The patch adds two NEW files to r3** (tree `5f141c3f` → **`e5260035d70f057fb0237e773f58b70f63210674`**, computed in a scratch repo that borrows r9's objects; no existing file changes, and the job asserts it):
- `relay/derived-reader-driver.mjs` `689ff934…6ffa` (252 lines);
- `test/derived-reader-driver.test.mjs` `d35dec97…9c0b` (183 lines, **10 tests**).

**Implementation details beyond the contract:**
- **Priority as implemented:**
  1. finality whose deadline is due (no served anchor, recovery to the saved floor, or B_f age ≥ deadline − margin) pre-empts everything;
  2. then cold recovery;
  3. then routine finality;
  4. then provisional.
  - A due but backing-off finality blocks provisional, and that wait is counted in `starvationMs`.
- **Untrusted hints:**
  - `targets` is bounded by `idleMs` (its signal is aborted), and invalid values become null;
  - a lagging hint never blocks a **due** finalized step (the provider and native refuse an underivable target, which only halves the range);
  - a routine step stays clamped to the hint.
- **Bootstrap:** the first `prepare` uses the finalized hint. A `candidate range exceeds reader bounds` refusal after `verifiedThrough` became non-null is recorded as `bootstrapped`, not as a failure.
- **Evidence:**
  - an unreadable or malformed view counts as full **and** fenced (no provisional step);
  - the limits are imported from `network/deployment-lifecycle-journal.mjs` (128 / 512 / 196,608).
- **Shutdown** aborts the owned step's signal and awaits it; a cancelled step is not counted as a failure. **No kill, and no "ack" is ever proof:** only a provider `submit`/`submitProvisional` result advances anything.

**The 10 tests** (fake provider, clock and timers):
1. exact config; no enable key; 120 s cannot be raised;
2. finality first, with starvation reported and then cleared;
3. recovery never passes the saved floor; ranges start at `minRange` and adapt to the measured duration (10 → 60 → 360; a slow run shrinks to `minRange`);
4. single flight; urgent finality before cold before routine finality;
5. provisional gating (tier off, full states, facts or bytes, durable marker, provider fence, unreadable evidence) and the doubled cadence at 75 % fill;
6. `cannotMeet120s` (only a provider-confirmed S produced by this driver counts; 120 s meets it, 121 s does not; a foreign or fixture tip never counts);
7. bounded failures (oversized or unknown witness never submitted; halved range; exponential backoff; busy treated as retry-later; pause after `maxConsecutive`);
8. shutdown aborts and awaits the owned run, with nothing afterwards;
9. bootstrap;
10. untrusted hints.

**Root command (not run by me):**
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh writer-driver-r1 512 unshare -Urnm bash writer-driver-stage/r1/jobs/root-writer-driver-r1.sh
```
- **What the job does:**
  - verifies this stage, r3, r2, r1, r9 and the r9 qualified check verdict;
  - composes r9 + r1 + r2 + r3 + driver, asserting all five trees and that only two files were added;
  - binds the pinned `node_modules` read-only;
  - runs the driver suite.
- **PASS** = exactly 10/10, nothing skipped.
- **Checks I made:** `bash -n` only. The tests are traced by hand, not executed.

**Honest limits:**
- **Fixtures only.** Nothing here measures native, witness or Helios time, or shows that S ≤ 120 s is achievable (M1-M5). `status().cannotMeet120s` stays true whenever it is not met.
- **Not wired into any startup.** Wiring later (role or relay) must construct it only under `ENCLAVE_WRITER_AUTHORITY_SOURCE=derived` with the role's enrolled state, supplying `evidence` from the anchor journal's `readProvisional()` and the journal byte length, and `cold` from Claude50's stage. There is no env or CLI enable.
- **The provider's own refusals remain the authority** (range, policy, marker, chain change). The driver adds no history, no persisted state and no trust.
