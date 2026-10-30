# writer-two-anchor-stage/r2: FINAL REPORT. Source frozen, NOT run, NOT an activation

**Status:** the source fixes and their regressions are complete and frozen. Nothing was run, and the stage is not an activation.
- **Stage:** `writer-two-anchor-stage/r2/`, `SHA256SUMS` sha256 **`3dba09e6700a4a8d6cbfb00b6ee70630b1318e5e3822a537d5e3e585e2922fe2`**.
- **Patch:** `patches/writer-two-anchor-r2-vs-r1.patch` (`6ee01917…`), on the frozen r1 tree `f22d554c`, gives **`20d0d76a98da84622b98991547dc07fb2fe39e3e`**.
  - Re-applying r9 + r1 + r2 to a fresh archive reproduces both trees.
- **Other contents:** `jobs/root-writer-two-anchor-r2.sh` (slice | check), `PROVENANCE.md` (r1→r2 hashes, expected counts) and the review as an input.
- **Not done by me:** no tests, builds, `node --check`, network, VM, live actions or commits. I ran only `bash -n` on the job and sha256 sums.
- **Untouched:** r1, r9, the KVM r3 closure, the KVM chat files and the main checkout.
- **Not changed:** no new replica, IPC or role API; the schedule reader pin is r1's.
- **Root runs qualification.** The `slice` total is **158** (13 + 12 + 12 + KVM 65 + 23 + 6 + 8 + 19).

## A. FINISHED SOURCE (written, hand-reviewed, untested)
| item | change | regression (file: test) |
|---|---|---|
| **A1** native outside the lock | **Lock:** `exclusive` is a bounded FIFO wait, `LOCK_WAIT_MS` 30 s, then `derived provider busy`. A pending durable write still refuses at once, as before.<br>**Submit:** `submit` and `submitProvisional` consume the ticket and claim the **single native slot** (either track, so memory is bounded) under the lock. They run `invokeDerivation` **outside** it, then re-lock to bind and merge with revalidation: finalized needs `agreed` unchanged; provisional needs the root, tip, `latest` and the L1 head unchanged and no marker.<br>**Refusals:** a second submit while a run is in flight refuses **without consuming its ticket**.<br>**Close:** `close()` aborts and awaits the run. | `two-anchor-r2`: "A1: a native run holds no provider lock…" (B_f, S and logs served during a run; replay refused; the refused ticket stays valid; a reorg during the run voids the merge) and "A1: close aborts…" |
| **A2** durable marker + evidence | **Carrier:** an optional `provisional` section of the **existing role-committed bridge anchor journal** (`deployment-lifecycle-journal.mjs`, same exact-bytes commit path as `acceptAnchor`). The section is absent by default (bytes unchanged) and never read as a floor.<br>**Writer:** commits `{at, fact, finalized, state:{number, hash, l1}}` **before** returning a fact. If it is not recorded, there is no fact (`evidence_unrecorded`).<br>**Reconciliation:** every finalized result (serving or catch-up), over the last ≤ 4 contiguous finalized segments, confirms (prunes) each recorded S, or writes a **durable marker** (`contradiction`, or `unverifiable` when coverage passed S uncovered). A RAM contradiction is also written as the marker. Journal contention is retried for ≤ 15 s, not turned into a disable.<br>**Marker:** it refuses the bridge `twoAnchor` (checked before the reads and again before returning), `prepareProvisional`/`readStateAnchor` and fact recording. **Restart keeps it.** The relay logs it **once** at error level (`provisional_disabled`). | `two-anchor-r2`: journal (optional section, dedup, validation, not a floor), reconcile (confirm / contradiction / unverifiable / reopened marker), bounds, provider (confirm, contradiction, marker survives restart and stops the bridge; unverifiable), no tier without evidence.<br>`derived-writer-two-anchor`: "A2: … recorded BEFORE the fact…", "A2: the durable disable marker … logged ONCE" |
| **A2 clear** | **The only clear is the existing admin-signed `derived-enroll` rotation** (it may keep the same binding). The role's `checkEnrollment` requires the signed `stateDigest` to equal the committed (fenced) state. KVM's `planEnrollment` requires `priorFiles`/`stateDigest` of the exact local bytes, rewrites the anchor journal **without** the section (the floor is carried, never reset), and the new reader record keeps `previousManifest[bridge]` = sha256 of the fenced bytes. | "A2 clear: ONLY an admin-signed rotation that binds the exact fenced prior bytes…": the KVM plan clears and keeps the digest; a package over the pre-fence bytes refuses in KVM (scan and state) **and** in the role gate (`wrong_state`) |
| **S1** | KVM `startDerivedReader` refuses the policy unless the state is split, not self-initialized, and has `requireJournalCommit` with a commit function. The relay's no-state branch refuses a config carrying `provisional` and closes and refuses any service offering `stateSnapshot`. A two-anchor capability without `recordStateFact` refuses. | r1 reader suite "lifecycle wiring" (rewritten: self-initialized refuses with nothing created; enrolled without commits refuses; enrolled + committed works); relay "selector" (enrolled branch; unsigned paths refuse) |
| **S2** | `readStateAnchor` returns S with `finalizedRoot {number, hash}`; the bridge pairs S only with that exact B_f. | "S2: … a finalized advance between the two reads refuses, a fresh snapshot then succeeds" |
| **S3** | The coverage validator records each checked segment's native-bound agreed output root in a module WeakMap (persisted chunks are unchanged). The overlay must link persisted tail → segment → … by those roots. | "S3: the overlay links … by native-bound output root" (a forged agreed root with an equal tail number refuses; the real one serves) |

**Unchanged:**
- admin contracts and controls;
- enrollment and recovery;
- the 120 s expression on S (byte-identical);
- finalized-only claims and floors (journals refuse the attested tier);
- the default-disabled signed policy;
- custody gates;
- legacy single-anchor behaviour.

**The r1 suites are kept and adapted:**
- the reader suite moved to the shared `two-anchor-fixtures.mjs` with real durable evidence, plus the S2 and S1 updates;
- the relay suite gained `recordStateFact`, `state.l1` and the enrolled-branch selector.

## B. A2 capacity: bound, rate and dedup (analysis; nothing measured)
**Entry model:** an entry is a **distinct (S, fact)** pair, grouped by S.
- **Dedup:** the same fact from the same S again is `duplicate`, with **no write and no capacity used**.
- **Fail-closed bounds:**
  - ≤ **128** distinct unconfirmed S;
  - ≤ **512** (S, fact) pairs;
  - ≤ **192 KiB** journal. This keeps the clearing rotation below KVM's 256 KiB enrollment read; the fact bound is reached first (about 125 KB).
- **Past a bound:** `evidence_unrecorded`, so no fact is issued until finality confirms.

**Entry lifetime W:** from issuance until a finalized result covers S's number. That is roughly the Base finalized lag (L1 finality plus batch posting) minus the S lag, plus the driver's finalized cadence. It is **unmeasured (M1)**; plausibly 15–30 min.

**Worst case for the 11-app fleet:** N = 11 distinct facts, each requested under every new S. The driver produces a new S every c_S seconds.
- **Pairs** ≈ 11·W/c_S. They exhaust 512 when **W/c_S > 46.5**.
- **States** exhaust 128 when **W/c_S > 128**.
- **Example W = 30 min:**
  - c_S < 39 s exhausts the pair bound, if every app asks under every S;
  - c_S = 12 s (one L1 slot) gives 150 S, which exceeds both bounds → fail closed.
- **Sustained new-pair rate:** ≤ 512/W, i.e. **≈ 17/min at W = 30 min, ≈ 26/min at W = 20 min.**

**Real issuance rate:** writer facts are requested on secret releases (`leaseGeneration`). That rate is **not measured**, so **no production availability is claimed** from fixtures. The bound can bite precisely when S is fresh enough to meet 120 s (small c_S).

**Dedup opportunities (not implemented; each needs review):**
1. **Cadence lever:** limit distinct S by driver cadence. For example c_S = 60 s gives W/c_S = 30, i.e. 30 states and 330 pairs: under both bounds. This trades against the S ≤ 120 s budget (S lag + c_S + derivation, M3).
2. **Chain compression:** S values on one unbroken provisional chain are nested. A confirmed newer S confirms its ancestors on that chain, and a contradiction at block b affects only S ≥ b. Recording a chain id (the segment link hashes) plus per-fact first and last S would cut entries from "facts × S" to roughly "facts × chains". This is a design item, not coded.
3. **Writer S reuse:** keep answering from the S already in evidence while it is ≤ 120 s old, instead of the newest tip. This bounds distinct S to about one per 120 s, at the cost of up to 120 s more staleness within the unchanged ceiling. **It is a policy decision.**

## C. UNRESOLVED ACTIVATION REQUIREMENTS (not fixed by r2)
1. **A3: coverage of pre-existing claims. A real requirement; the regression and runbook are not a fix.** Coverage after **any** start (restart, rotation or new group) begins at the ASR bootstrap anchor, because persisted coverage is never restored authority. Rotating the binding to add the policy is no worse than a restart; the r2 regression shows both, and shows that a later ASR bootstrap makes a claim at 101 unservable.
   - **Effect:** a lease whose current Claimed predates the start-time ASR anchor (on the order of days) is `claim_not_covered` (retry = false). Renewals do not re-claim, so it **stays** uncovered for long-lived apps. This is **pre-existing since r9**, not introduced by Option B.
   - **The code never forces or triggers re-claims.** It refuses, with no fact.
   - **Required, needing a KVM/root decision (not implemented):**
     - (a) **a historical authenticated bootstrap:** a finalized dispute-game output root at or below the oldest active claim, read at Helios-verified L1. Deriving forward from it on every start costs an unmeasured amount;
     - (b) **committed coverage:** replicate the coverage-manifest head digest through the existing anchor journal so persisted segments can be re-verified after a restart. This is a trust change to "persisted coverage is never authority";
     - (c) **an explicit, operator-scheduled, per-app re-claim plan.** It is destructive and **not proposed** without a concrete drain/hand-off design.
2. **Driver integration (unimplemented):** schedule finalized and provisional prepare/submit around the single native slot, with cadence and back-pressure. That includes the evidence bounds above and aligning finalized targets to segment boundaries, plus external witness production. Without it, S never exists.
3. **Enabling:** a measured reader template with the policy, KVM review of the changed `network/` closure, and a signed binding rotation (plus the A3 decision).
4. **Audit retention after a clear:** the cleared bytes are authenticated only by digest. The admin must archive them before signing, and no export tool exists.
5. **Open policy decisions (§7 a/b):**
   - revocation or alarm for facts issued from a contradicted S (the evidence now identifies them);
   - consumer tier visibility.
6. **Owned-node feasibility is unmeasured (M1–M5):**
   - **S may be unable to meet 120 s.** If p99 S age > 120 s, B cannot ship and writer authority stays `stale_snapshot`;
   - the evidence bounds may also bite at the cadence that 120 s needs.
7. **Separately open:** never-enrolled restored-group admin recovery.
