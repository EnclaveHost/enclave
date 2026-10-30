# accepted-image-enrollment-stage/r4 provenance (prepared; NOT run by Claude)

| tree | how it is made |
|---|---|
| `f0ba957e…` | the frozen enrollment r3 stage (SUMS `27a9288b…`): role r2 `d9a70025` + KVM r2 overlay `9c9cae75` + r3 patch |
| `e077a91a1a3fcd5d072c30b35c1951b72f032b78` | + the FROZEN KVM r3 closure `journal-durability-r3` (SUMS `14656ef5…`, copy in `inputs/kvm-r3-SHA256SUMS`), copied from its stage root by `jobs/kvm-overlay.py`. 4 files changed, all KVM-owned: `derived-reader/enrollment.mjs`, `journal.mjs`, `provider.mjs`, `test/journal-durability.test.mjs`. Every other file is byte-identical |
| **`f1a8216aa2b82928ea4931b27a466a53fe08e8bb`** | + `patches/accepted-image-enrollment-r4-vs-r3-kvm3.patch` (4 files, +209/−20; role and tests only, no KVM module) |

I reproduced all of them with the stage's helper and patches in a clean repo.

**Changes:**
- **`metal/guest/derived-state.mjs`:** an enrollment floor or high-water must be a full `l1-finalized-derived` anchor (= KVM r3 `enrollment.mjs` `checkedFloor`). That was the one API mismatch found.
- **`test/derived-state-kvm-composition.test.mjs` (6):** POSITIVE real-KVM-r3 scenarios:
  - genesis with a crash after ACK1, then prefix resume;
  - normal reopen;
  - floors advanced through KVM's own journals over the real IPC;
  - a binding-changing rotate that carries the dominating floor, with a crash after ACK2;
  - a signed recover high-water with a crash after ACK3, reconciled by the committed scan;
  - stale, same-height and wrong-tier floors refused.
- **`test/state-replica-exact.test.mjs` (4):** the real ReplicaNode catch-up and election exactness for `readAllExact`.
- **`test/derived-state-enrollment.test.mjs` (15):** tier cases added (same count).

**Job:** `jobs/root-accepted-image-enrollment-r4.sh`, with modes `check` (full real closure), `slice` (small, no build) and `image`.
