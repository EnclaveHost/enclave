# postdelete-bitmap-stage/r4: precise coalesced rules (review 1701 + root's r3 review), tree blocks in the no-reuse masks. Source only - 2026-10-26

**Not done by me:** no build, test, live action, mount or USB; only AST/`bash -n` syntax checks. Root executes the queue.

**Frozen stages preserved and verified:** r1 `f5c89089…`, r2 `51c393bf…`, **r3 `5ecd6a6d…`** (not yet tested; unchanged).

## Stage: `postdelete-bitmap-stage/r4`, FROZEN
**`SHA256SUMS` = `0f1f81effaa6a88cdd57fc49cac3004d57267c3f55616d5409992ab2bc69b8e3`** (files `a-w`).

| file | sha256 |
|---|---|
| `postdelete_bitmap.py` | `09dcdd7e03fb967669c59465459f161456a749455b4e4fe10de4f63c941a76b6` |
| `tests/test_postdelete_bitmap.py` (**22 tests**) | `28ee73871acf7a485db4855c5771225c6f27874b4bd572b2ba4e5a13f6e518d1` |
| `jobs/tests.sh` | `612e324813c3404968ba639cd719d12d5555dd34b54378f9d0f56cb6a170e224` |
| `jobs/root-check.sh` | `96becba9a761c0d014f6f02aa1ee4ed5057b4f354bd83a79a24fc61d2ffd75a1` |
| `README.md` | `fdc1fa321a1a5161a62e7d22666750cce16a880a6c88a7fe949971cc8b33632a` |
| `jbd2_verify.py` / `case/base-1626.json` | = r1 (`d3cfa34e…` / `f952b1f8…`) |
| real vectors (fs-stats header, inode slot, leaf 499155437) | = r3 |

## What changed against r3 (root's review points)
1. **Explicit adjacency.** r3 accepted any new generation in the next slot image. r4's coalesced model requires **T == P + 1**.
   - **Otherwise BLOCKED:** "coalesced model refused: … not P + 1".
   - **Gaps:** a gap or uncommitted T can never be bridged. T must itself be a proven transaction (a slot image exists only in proven transactions), and the window from the oldest bound tree image must be contiguous.
2. **The T slot image** must be inode-checksum valid with **links ≥ 1**, otherwise BLOCKED.
   - **The inode bit must be SET at T** (the existing R check).
   - **NEW:** it must stay set at every later tid while that new generation is live.
   - **NEW:** no old-generation image may appear at or after T.
3. **No fabricated deletion start.** In the coalesced model the output has `deletionStartTid: null`, `deletionStartReason: "coalesced: no committed intermediate unlinked image; deletion start NOT observed"`, and `firstObservedCompletionTid = completionTid = slotReuseTid = T`.
   - **Internal vs output:** internally the bitmap rules evaluate the free at T (S0 = C = R = T). That is an internal evaluation boundary only, never reported as a deletion start.
   - **Classic model:** it keeps reporting its observed `deletionStartTid`.
4. **Per-group proof in T.** EVERY covered group must have a proven block-bitmap image **with tid == T**.
   - **What "covered" means:** the old data groups plus the groups of the bound extent-tree blocks.
   - **Missing →** BLOCKED: "N covered groups have no proven block-bitmap image in the coalesced transaction T: completion not provable".
   - **Any old data/tree bit SET in a T image →** BLOCKED: "N old data/tree bits SET in the coalesced transaction T".
   - **Reported fields:** `bitmaps.coalesced = {T, groupsWithTImage, groupsWithoutTImage[], groupsWithoutTImageTotal, oldBitsSetInT}`.
5. **Tree metadata bits in the masks (both models).** Every BOUND extent-tree block joins the per-group masks from its proven image tid: the real index `499155449` plus the 27 leaves = 28. Before r4 the masks covered data only.
   - **The tree-block group bitmaps become verifier targets:** leaf groups in phase 1, and index groups in the index phase.
   - **The same rules then apply to tree blocks:** SET after their tid before the deletion; seen CLEAR by C (or in T); any set at or after C (or T) = reuse.
   - **Reported fields:** `treeBlocksInMasks`, `groupsChecked`.
6. **Later reuse.** An old data or tree bit SET in any proven image after T (or C) → **REUSE_OBSERVED** (rc 4).
   - **It is a rejection, never a pass**, and is reported with tid and sample.
   - **Why not BLOCKED:** review 1701 asked for BLOCK, but r4 keeps the more specific REUSE verdict. Both are non-passing.
7. **Not acceptance.**
   - **Top level:** `recoveryAcceptance: false` is always set.
   - **LIMITS** state that NO_REUSE reflects only the current flags of proven bitmap images.
   - **LIMITS** state that the coalesced model infers nothing about intermediate states; the speculative r3 wording ("all happened in ONE transaction") is removed.
   - **LIMITS** keep allocate+free inside T (a very large transaction) or any later single transaction as leaving no trace.
8. **Classic mode** (explicit unlinked → freed → reused) is unchanged apart from the tree bits; it is renamed from r3's "separate-images" to **"classic"**.

## Expected real-run meaning (root 1698 data; not run)
- **The shape:** P = 17169 and T = 17170 = P + 1, the new generation 3941633993, links 1, inode bit set at 17170.
- **For rc 0 or 4 rather than 5,** all of the following must hold:
  - every one of the ~8,748 data groups plus the tree-block groups (group 15233 for index 499155449 / leaf 499155437, and the other leaves' groups) has a proven bitmap image **in 17170**;
  - all 276,959,557 data bits and the 28 tree bits are clear there;
  - the tree binds (the 27 leaves and the index are the newest proven images before 17170, window 14665…17669 contiguous).
- **Otherwise BLOCKED** with the exact group count and sample.
- **Later set bits** (for example by the new generation's file) → REUSE_OBSERVED.

## Tests: 22
**Changes to r3's tests:**
- r3's `test_single_transaction_deletion_and_slot_reuse` is replaced by the two `Coalesced` tests below.
- Fixtures: the tree blocks 70/71 (and the index 72) live in group 0, block bitmap 10. They are SET from their leaf/index tids and freed at C (classic) or T (coalesced).
- Expectations updated by addition only: group 0 rows, 162 = 160 data + 2 tree observed, 110/52.
- One fixture now removes only group 2's image (no longer the tree group's too), so its 52-block expectation is unchanged.

**`Coalesced.test_coalesced_positive_and_classic_preserved`:**
- **PC1 + PC3 (the real 17170 shape):**
  - mode `coalesced`; P 12; `deletionStartTid` null with "NOT observed"; first-observed completion = slot reuse = 13;
  - inode bit rows `[[13, 1]]`; `coalesced` = {T 13, 3 / 3 groups imaged, 0 set};
  - 2 tree blocks in the masks; 3 groups checked;
  - group 1 imaged again at 14 (another file, other bits) with no reuse.
- **PC2:** the classic run is unchanged (mode `classic`, start 13, reason null).

**`Coalesced.test_coalesced_negatives`** (subtests):

| case | input | expected |
|---|---|---|
| NC1 | a covered group without a T image | 5, "no proven block-bitmap image in the coalesced transaction" |
| NC2 | 2 old data bits set in T | 5, "2 old data/tree bits SET in the coalesced …" |
| NC3 | a proven tid between P and T (T = P + 2) | 5, "not P + 1" |
| NC4 | an old data bit set in a later image (tid 15) | 4, reused group 2 at 15 with the exact sample |
| NC5 | the T slot inode checksum is invalid | 5, "coalesced model refused" |
| NC6 | the old generation reappears after T | 5, "seen again" |
| NC7 | the inode bit is clear at T | 5, "without an inode-bitmap image setting the bit" |
| **NC8** | **a tree bit (leaf 70) set in T** | 5, "1 old data/tree bits SET in the coalesced …" |
| **NC9** | **T's commit invalid (gap after P)** | 5, and 13 ∈ window gaps |
| NC10 | the new generation at T has links 0 | 5, "coalesced model refused" |
| classic tree reuse | a tree bit (70) set after C | 4, reused group 0 at 15, sample [70] |

**r3's tests kept:** the real inode, leaf and fs-stats vectors; the parsers; the classic scenarios; tree binding (depth 1/2 and its negatives); the window from the oldest leaf (gap before P); clear-only ownership; S0 orphan dtime plus tree-block revokes; bounds; pins.

## Root jobs (queue 512, as the unprivileged owner)
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh pdb-r4-tests 512 unshare -Urn bash postdelete-bitmap-stage/r4/jobs/tests.sh       # PASS = "## PASS (22)", rc 0
bash jobs/q-exit-status.sh pdb-r4-check 512 unshare -Urn bash postdelete-bitmap-stage/r4/jobs/root-check.sh  # needs the bound r4 receipt
```
**Both jobs:**
- refuse real root;
- verify that frozen postdelete r1/r2/r3 and verifier r1/r3 are unchanged;
- `cmp` the runtime and case against r1;
- hash inputs with nofollow, caller-owned opens.

**`root-check.sh`** prints the boundary (mode, P, deletionStart = null, first-observed completion, R, reason), `coalesced`, `treeBlocksInMasks` and `recoveryAcceptance`.

**Bounds:** ≤ 24 verifier calls; r2 needed 5, and r4 adds the leaf targets, their group bitmaps and one index phase. ≤ 262144 image reads (r2 read 2501; the T-image check adds one read per covered group, about 8.7k). Limits: 3600 s CPU / 5400 s wall.

## Not claimed / unverified
- **Not executed:** nothing has run. The fixture expectations and the real verdict are unverified until root runs the jobs.
- **Not acceptance:** the results cover journal history and current flags only, never acceptance.
- **Still unproven:**
  - allocate/free inside T or any single later transaction;
  - discard/TRIM;
  - userspace or non-journaled writers;
  - image-layer writes.
- **Separate gates still required:** full MDBX, plain-vs-hashed/trie and canonical L1-authenticated root.
