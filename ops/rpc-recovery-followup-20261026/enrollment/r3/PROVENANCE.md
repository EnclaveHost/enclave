# accepted-image-enrollment-stage/r3 provenance (prepared; NOT run by Claude)

| tree | how it is made |
|---|---|
| `d9a70025…` | role enrollment r2 (frozen, SUMS `5ffc76a5…`) on r4 + assets r1/r2/r3 + enrollment r1 |
| `9c9cae75a035a61d8d0a6c50d1976bd82300c1f5` | + the FROZEN KVM r2 closure `journal-durability-r2` (SUMS `145d49c1…`, copy in `inputs/kvm-r2-SHA256SUMS`), copied from its stage root by `jobs/kvm-overlay.py`. 39 files, 13 changed, all KVM-owned; every other file is byte-identical to the tree, otherwise refused |
| **`f0ba957eaa63b004e04e66f712c68c26f7bdf545`** | + `patches/accepted-image-enrollment-r3-vs-r2-kvm2.patch` (7 files, +355/−84; role/relay/test only, no KVM module) |

I reproduced all three with the stage's own helper and patch in a clean repo.

**Changes:**
- **`metal/guest/derived-state.mjs`:**
  - `anchorDominates` and `dominatingFloor`: per chain; equal height means the same hash, stateRoot and timestamp, and for Base also outputRoot and messagePasserStorageRoot; never synthesized;
  - rotate binds the dominating floor of BOTH committed journals; a recover needs a non-null, full admin high-water dominating both;
  - safe-integer canonical JSON (= KVM's);
  - the record stores `previousBinding`; the provider result adds `previousBinding` / `previousEnrollmentDigest` / `stateDigest`, and the genesis answer no longer refuses `prior_state` (KVM decides the prefix);
  - the seed removes only working files and keeps every `*.lock`; the cache is `coverage/<binding>`.
- **`metal/guest/platform-api-role.mjs`:**
  - a progress-aware, bounded crash guard (same-genesis resume is never deadlocked);
  - waits for the previous child's exit before seeding;
  - status shows reader, bridge and dominating floors.
- **`relay/derived-writer-authority.mjs`:**
  - checks KVM's export set (including `derivedEnrollmentFloorDigest`);
  - enrolls on missing, pending, or changed binding/digest only;
  - passes `enrollmentFloor` only for recover;
  - checks the coverage directory is the signed binding's.
- **`relay/derived-reader-runtime.mjs`:** re-exports KVM's `DERIVED_STATE_API` and its functions; no local constant.
- **`relay/state-replica.mjs`:** `readAllExact`, so a catch-up snapshot is never sent with bytes other than the scanned ones.
- **Tests:**
  - `test/derived-state-enrollment.test.mjs` (15);
  - NEW `test/derived-state-kvm-composition.test.mjs` (4): real role + IPC + ReplicaNode + ACTUAL KVM `enrollDerivedState` / `openLifecycleJournal` via the real adapter and runtime module. Only the live reader start is a stand-in.

**Job:** `jobs/root-accepted-image-enrollment-r3.sh` with modes `check`, `kvm-check KVM_DIR SUMS` and `image`.

**Inputs:** the r3 contract ACK, root's note, the security review, KVM's r3 contract, KVM r2's API.md and SUMS.
