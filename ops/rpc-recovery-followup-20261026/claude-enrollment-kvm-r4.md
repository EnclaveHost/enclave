# Enrollment r4: role + private IPC + ReplicaNode composed with the FROZEN KVM r3 (source only; NOT run by Claude)

**Stage:** `accepted-image-enrollment-stage/r4/`, `SHA256SUMS` sha256 **6061969bf98a500cb1cd7c78573781cb184156ab4fee65e2ecbe139caf06622f**.

| file | sha256 |
|---|---|
| `patches/accepted-image-enrollment-r4-vs-r3-kvm3.patch` | `e304f8ab…` |
| `jobs/root-accepted-image-enrollment-r4.sh` | `288f5ebe…` |
| `jobs/kvm-overlay.py` | `90c579ab…`, unchanged from r3 |

- **Trees** (all reproduced with the stage's helper and patches in a clean repo):
  - r3 `f0ba957e` (frozen, `27a9288b…`, still verifies);
  - → + KVM r3 `journal-durability-r3` (SUMS **`14656ef5…`**, verified; stage-root layout) = **`e077a91a`**. Only 4 KVM-owned files change: `enrollment.mjs`, `journal.mjs`, `provider.mjs` and its unit test;
  - → + the r4 patch = **`f1a8216aa2b82928ea4931b27a466a53fe08e8bb`**.
- **Not done:** no tests, builds, queue, network, live actions or commits. The 2560 lane is deferred behind 1394. No KVM module is edited.

## Actual KVM r3 API (read from source; one mismatch, fixed on the role side)
**Matches the r3 role:**
- **Exports:** `provider.mjs` exports `DERIVED_STATE_API`, `enrollDerivedState`, `derivedReaderBinding`, and `derivedEnrollmentFloorDigest` (re-exported from the new `enrollment.mjs`).
- **`enrollDerivedState(config, {anchorJournal, verifyEnrollment, commit, enrollmentFloor = null, commitTimeoutMs, signal})`:**
  - it calls `verifyEnrollment({binding, floorDigest, signal})`, where `floorDigest` = digest(proposed floor from local bytes + `enrollmentFloor`);
  - `planEnrollment` then requires the local manifest to equal `priorFiles` exactly. It also needs `previousBinding`, `previousEnrollmentDigest` (≠ `digest`) and `stateDigest` (= sha256(canonicalJson({rel: sha})), the same as the role's `stateDigestOf`).
- **Rotate:** carries `dominant(reader.floor, bridge 8453)`.
- **Recover:** `enrollmentFloor` must equal the signed `highWater` and dominate the old floors.
- **Same-height fields:** `dominates` compares hash, stateRoot, timestamp, and for Base outputRoot and messagePasserStorageRoot. These are the same as the r3 role's `anchorDominates`.
- `committed: true` is accepted, per KVM's review.

**MISMATCH:** KVM `checkedFloor` accepts only `tier: "l1-finalized-derived"` for enrollment floors. The r3 role also accepted the ASR tier. **r4 aligns:** an enrollment floor or high-water must be a full `l1-finalized-derived` anchor; otherwise `floor_incomparable` or `high_water`.

**Operational constraint (KVM semantics, not a bug):** a second rotate or recover signed **before the previous rebind ran** names an enrollment the saved reader does not belong to. KVM refuses it ("saved reader does not belong to the authenticated previous enrollment"), so the admin must let each rebind complete first. This is fail-closed: derived stays disabled and the relay serves with writer authority refused.

## Real-KVM composition (`test/derived-state-kvm-composition.test.mjs`, 6)
**Setup:** three REAL roles + the real ReplicaNode + private IPC + the real writer adapter + the real runtime module + the ACTUAL KVM r3 `enrollDerivedState` / `planEnrollment` / `openDerivedJournal` / `openLifecycleJournal`. Run on one group, in order:
1. **Declaration and binding:** KVM's own `DERIVED_STATE_API`, `derivedReaderBinding`, and binding independence from paths.
2. **Genesis, crash after ACK 1:** the role retries on committed progress and seeds the committed pending reader. KVM resumes with **only ACK 2 and ACK 3**, the in-flight marker is removed, and every member holds the exact genesis pair.
3. **Complete state:** normal reopen, no enrollment call.
4. **ADVANCED floors:** KVM's own reader journal `accept` and the bridge `acceptAnchor` move the reader floor (Base 200 / L1 100) **ahead** of the bridge's (150 / 90) through the real IPC. Status shows both, and the dominating floor is the reader's. Restart: normal open, no reset, 1 entry kept.
5. **ROTATE to a new binding** (another image: a different `historyMaximumBytes`):
   - the relay is unenrolled for the new image until signed;
   - a rotate naming the bridge floor or null is refused (`wrong_floor`);
   - the signed rotate carries **exactly the reader's floor**;
   - after a **crash after ACK 2** it resumes with **only ACK 3**;
   - the final reader and bridge both hold that floor, with entries reset to the carried floor's empty chain, `previousBinding`/`previousEnrollmentDigest` linked, and a fresh `coverage/<binding2>`. Every member holds the exact bytes.
6. **RECOVER after a restore marker:**
   - refused: null (no archive-only recovery), below the restored floor, a same Base height with another block, the ASR tier, and a rotate (never clears a restore);
   - the signed high-water (300 / 150) is accepted;
   - after a **crash after ACK 3**, the committed scan reconciles the lost ACK: **normal open, no enrollment**, both floors at the high-water, and the dead child's marker discarded by the seed;
   - a later rotate naming the old lower floor is refused (`wrong_floor`): no floor reset.

**Stand-ins, labelled in the file:**
- the reader START (needs live L1/Helios);
- the **synthetic** advance anchors (well-formed, written through KVM's real journal APIs, no derivation);
- the restore marker written as the admin restore bootstrap writes it (the archive restore itself is not exercised);
- co-located members (**not a quorum**).

It needs `DERIVED_READER_INPUTS` (the real checkpoint, expiring 2026-11-01T19:21:59Z).

## Replica exactness (`test/state-replica-exact.test.mjs`, 4; root 370 reviewer)
**Real ReplicaNode members with an injection hook between a member's answer and the sender's continuation:**
1. **Catch-up:** member 2 lags. During the next round, its append answer needs a snapshot, and the hook writes v4 after the scan of v3.
   - **The snapshot is not sent:** that member's answer is not counted, and the majority (0+1) commits v3.
   - **Member 2 never holds v4 under the v3 head.** The next round ships exactly v4 under the matching head, and every member equals the primary's committed scan.
2. **`readAllExact`:** changed or vanished file → `changed`; unchanged bytes exact.
3. **Election:** the new primary's epoch snapshot carries exactly its scanned bytes. The surviving member holds exactly its committed scan.
4. **Interleaved writers and commits** (barrier, credentials and derived files, with delayed transport): every round reaches a majority, and no member holds bytes other than the committed scan of its head.

**No count widening:** each suite has its own exact expected count. The role suite stays at 15 (assertions added).

## Harness (`jobs/root-accepted-image-enrollment-r4.sh`)
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh aie-enroll4-slice  256 unshare -Urnm bash accepted-image-enrollment-stage/r4/jobs/root-accepted-image-enrollment-r4.sh slice
bash jobs/q-exit-status.sh aie-enroll4-check 2560 unshare -Urnm bash accepted-image-enrollment-stage/r4/jobs/root-accepted-image-enrollment-r4.sh check
```
- **`slice` (small; NO build, from source):**
  - **Order:** the same composition and read-only binds, then KVM r3 journal-durability (22), composition (6), replica exactness (4) and the role suite (15), all strictly at exact counts.
  - **Scope:** "NOT release, authority or SNP qualification". 256 MiB is my estimate (test process capped at 128 MiB plus one stand-in child); root decides.
- **`check` (full real closure):**
  - **Composition:** r3 composition, then the pinned KVM r3, then r4. Every tree is exact, and a KVM overlay that changes a non-KVM file refuses.
  - **Build:** the strict build (runtime pin `e12c5baf`); the BUILT runtime must declare KVM's exact API; the guest bundle is regenerated.
  - **KVM's own suites:** from its `expected-counts.json` (**65**), plus the native owner check.
  - **Then:** composition 6, replica 4, role 15, and all earlier suites, startups and the relay group at their counts.
  - The obsolete r2 composition is not run.
- **Safety:** stops and deadlines remain safe. The seed never unlinks lock files, and requests past their deadline write nothing.

## Unresolved (plain)
1. **A never-enrolled group restored from an archive** (root decision): the strict refusal stays. It has **no recovery path**. An explicit admin recovery path is a **separate follow-up**, with no automatic genesis, reset or mode weakening.
   - This does not block the previously-enrolled positive cases above.
   - **The overall goal is not complete.**
2. **Writer authority:** with the fixed 120 s ceiling and L1-finalized anchors, writes stay `stale_snapshot`.
3. **Not covered offline:** a live reader start, actual chain derivation, distinct-host quorum, SNP.
4. **Root runs:** slice and check, then re-measurement and qualification.
