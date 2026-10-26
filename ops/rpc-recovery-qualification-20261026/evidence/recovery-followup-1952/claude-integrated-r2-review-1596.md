# Review 1596: writer-integrated-stage/r2 (independent, SOURCE ONLY)

**Bytes:**
- **Stage:** `SHA256SUMS` **`748cad34b88e2214066eb9404ff571c4fa9bd9c2330d8b36f779bb0d0dad3bd6`** (`sha256sum -c` OK); patch `c9e230d2…`, job `9a3ed28c…`, PROVENANCE `f282366c…`.
- **Applied tree, inspected directly:** `/tmp/w7`, HEAD tree `d9ff6a91` (history r3 + driver r1) with the r2 patch staged (worktree = index). Every touched file equals PROVENANCE:

  | file | sha256 |
  |---|---|
  | `relay/derived-reader-driver-wiring.mjs` | `8f454e85…` |
  | `relay/derived-reader-runtime.mjs` | `ec5010cd…` |
  | `relay/derived-writer-authority.mjs` | `3af33cd6…` |
  | `network/derived-reader/provider.mjs` | `923dd29d…` |
  | `metal/guest/platform-api-role.mjs` | `fb40bef0…` |
  | `test/derived-reader-driver-integration.test.mjs` | `a1c84ed3…` |

  Unchanged pins: driver `relay/derived-reader-driver.mjs` `689ff934…`, history `backward-history.mjs` `789d67c9…` (= r3), template `metal/derived-reader-config.v3.json` `49ccf144…`.
- **Write-free check:** I did not `git write-tree` in `/tmp/w7` (no writes to another agent's scratch). The tree id `a01a3e95` is the author's claim, consistent with the file hashes.
- **Not done:** no tests, builds, live actions, network, USB or edits.

**Test status:** root 1594 (199 tests) is queued and **has not passed**. The history r3 cryptography is reviewed separately (da1592).

## Verdict
**No blocking source defect in the reviewed areas.** Trust is not widened and no new contracts are added.

Business and admin controls are untouched: no admin, enrollment-authority or deny-only verifier code changed. The touched paths are the driver wiring, runtime exports, the startup branch, the provider binding/gate and role composition.

**The driver is NOT activatable yet.** Activation requirements A1–A4 below; A1 is the known witness-placement gap (370), which is not counted as a review blocker.

## Verified correct
**Enrolled-only startup:**
- the writer branches: `driver` in a non-enrolled config is refused (`derived-writer-authority.mjs:515`);
- the driver is started only when `wantDriver = !!state && state.cfg.driver !== undefined` (`:526`);
- it is exclusive with the loopback push API and requires runtime exports (`:527-531`);
- KVM's `startDerivedReader` refuses `driver` on any split-less, self-initialized or uncommitted state (`provider.mjs:588-589`);
- a startup failure closes the reader (`:548`) and is fatal to the relay (`api-relay.js:2539`).

**Signed driver policy v2** (`derived-reader-driver-wiring.mjs:29-43`):
- exact keys; v1 refused;
- the schedule is validated by the driver's `driverConfig` (exact keys and bounds);
- the witness URL is loopback `http` only, with no userinfo, query or hash;
- the template path must be absolute and canonical, and its sha 64 lowercase hex.

The provider binding includes the raw `driver` section only when present (`provider.mjs:488-490`). The default binding is byte-identical, and a driver change is a signed rotation.

**Measured rollupConfig path + sha cross-check:**
- **At composition** (`platform-api-role.mjs:121-130`): a template with `driver` must name the image record's `files.rollupConfig` by an **equal path and sha**, and the file's bytes must hash to it; otherwise `derived_reader_tamper` / `derived_reader_absent`.
- **At driver start** (`wiring:113-119`): the bytes actually read must hash to the **signed** `rollupConfigTemplateSha256` **before** JSON parsing; the result must be ≤ 1 MiB, a JSON object and `l2_chain_id` 8453.
- **Together:** bytes = signed sha = record sha (the record equality is via the role).
- **Defense in depth:** the native also checks `rollupConfigHash`, and the template is never authority.
- **The shipped template has no `driver` and the record no `rollupConfig`** (test 9): disabled by construction.

**Single native, single flight** (driver `:208-215`, `:229-249`):
- `tick` refuses a second in-flight step; the loop is strictly serial;
- the provider itself allows one native run;
- the driver and the push API are mutually exclusive (one scheduler for the one-shot tickets).

**Stop and close order with no call after stop:**
- `stop()` sets `stopping`, aborts the loop sleep and the current step's controller (prepare, witness fetch, submit and hints all take that signal), then awaits the step and the loop;
- `tick` after `stopping` returns without calling the provider;
- the relay closes the driver, then the API, then the reader (`derived-writer-authority.mjs:561`);
- the hint and witness transports clear their timers and listeners in `finally` (`wiring:82`, driver `:83`).

**Finality priority:**
- `decide` (driver `:86-111`) runs urgent finality first: no anchor, recovery below the saved floor, or B_f age at `deadline − margin`;
- urgent finality in backoff **blocks** the provisional track (`blocksOthers`);
- then cold (null here: the provider's own background scan), then routine finality, then provisional, and only under the signed binding (`st.provisional`);
- a lagging or missing hint never blocks a due finalized step (`:185`); recovery never passes the saved floor (`:186`).

**Evidence capacity and backoff:**
- **evidence (`fill`, `:58-68`):** an unreadable or malformed view counts as **full and fenced** (no provisional step); ≥ 75% doubles the provisional cadence; full stops the provisional track until finality confirms;
- **failures (`:113-122`):** "not now" refusals (`busy`, `already running`, `outstanding ticket`, `commit pending`) back off without counting a failure; real failures halve the range and back off exponentially, capped at `maxMs` (still retried, never a silent permanent stop);
- **ranges adapt only to measured durations** (`:124-130`);
- **S counts only if** the provider's `stateThrough` equals the driver's last provisional anchor (`:70`);
- **`cannotMeet120s`** is reported whenever no confirmed S is within 120 s. The writer's own 120 s ceiling is enforced independently, so starvation means no fact, never a stale fact.

**Provider-state binding and rollback:**
- the driver section changes the binding, so enabling, changing or removing it needs a signed rotation;
- rollback protection is the existing enrollment floor / high-water mechanism (`provider.mjs:504-551`), **unchanged by this stage and not re-reviewed here**;
- the history r3 cache, coverage store and journal paths are unchanged.

## Findings (none blocking)
**L1 (LOW, robustness: startup ordering).**
- **What happens:** the driver is **started** (`derived-writer-authority.mjs:541-548`) **before** `createDerivedWriterAuthority` (`:555`), which can still throw on env/config validation (ledger pin, address book, age bounds).
- **Why it is low:** the rejection is fatal (`api-relay.js:2539`). The first tick is suspended on the async hint RPC, so in practice the process exits before any `prepare` or native spawn.
- **The fix:** construct and validate the authority before `startReaderDriver`, or `await driver?.stop(); await service.close()` on any later failure, so no orphaned native run is possible by construction.

**L2 (LOW): unbounded, symlink-following template read.**
- **What happens:** the template is read with `fs.promises.readFile(p)` (`api-relay.js:2538`, used at `wiring:113`), unbounded and following symlinks, before the 1 MiB check.
- **Why it is low:** the path must equal the measured image record path (role) and the bytes must match the signed sha, so this is only a resource hazard for a bad image.
- **The fix:** a bounded `O_NOFOLLOW` regular-file read.

**L3 (INFO): the driver section is not validated on the KVM side.**
- **What happens:** the provider includes the **raw** `config.driver` in the binding without validating it (`provider.mjs:490`). An admin-signed but malformed section fails only at relay start (`driverPolicy`), which is fail-closed.
- **Optional:** validate at enrollment so a bad template is rejected before signing.

**L4 (INFO): the record-path equality is enforced by the role only.** A config started without role composition still has the signed-sha byte pin, but no record-path check. Production composes through the role; keep it that way.

## Activation requirements (explicit; nothing here enables the driver)
1. **A1, witness placement (root 1583; 370's placement r2, not frozen):**
   - **The gap:** the transport is loopback-only (`wiring:26, 45-50`) and **cannot reach a producer on the RPC VM**, so the driver is not deployable.
   - **The next composition must:**
     - apply placement r2 onto `a01a3e95` (3-way);
     - move its URL rule and HOST_DATA `witnessUrl` cross-check to the **v2** `driverPolicy`;
     - add the real role config and schema tests.
   - **The bound:** the producer output bound (root 1589: `prlimit --fsize`, bounded stderr, a real child test) must be merged before activation.
2. **A2, reviewed Base rollup-config bytes:** shipped and pinned in the image record `files.rollupConfig {path, sha256}`, plus a template carrying a validated `driver` v2 section (naming that path and sha) and a `history` v2 section (the real ledgers, floor 52,515,705).
3. **A3, signed rotation and build:** the signed binding rotation (enrollment), KVM review of `network/derived-reader/*` (including this stage's `provider.mjs` hunks and history r3), and root `check` regenerating and verifying the guest bundle (`platform-api-role.mjs` is a manifest input).
4. **A4, measurement:**
   - the M1–M6 timings: native run time versus the 120 s S ceiling; provider exclusivity contention between the driver's prepare/submit and the writer's reads;
   - history r3 F4 event-loop lag in the **relay** process during a scan (shared with the driver timers and request handling);
   - the own-node load with `receiptConcurrency` ≤ 8.

   `cannotMeet120s` reports a miss; it does not prevent one.
5. **A5, tests:** root 1594 `slice` 199 PASS (driver-integration 9, driver 10, backward-history 13, writer-history 9, …), then `check`.
