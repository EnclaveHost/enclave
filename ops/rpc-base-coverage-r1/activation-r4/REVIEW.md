# Independent review of coverage verdict r4

Reviewer: a fresh-context, read-only review agent. It was given the code and data, not the gate runner's conclusion.
Decision: **ACCEPT**. Both the image's chain_service.py and the source rpc/guest/chain_service.py validate this
activation set (`coverage_activation`). The 19 gate tests pass against the pinned kzgcheck (00b3eeb9…).

## Findings (none admit unverified data into Base derivation)
1. **Range.** needFrom = safe.l1Origin 26265939 - 3600 = 26262339. 30000 blocks to 26292338, which is below finalized 26327753.
   The safe, tip and finalized origins all fall in range.
2. **Per-block checks.** Header hash, tx root and receipt root are recomputed (kzgcheck/alloy). EL hash == beacon execution_payload.block_hash.
   Blobs: c-kzg commitment -> versioned hash. The 7 patched blobs go through the same check (7/7 rehash OK).
   One gap: beacon SSZ roots are not recomputed. The local Lighthouse is trusted (checkpoint state is pinned by sha256).
3. **Blob patch.** It holds exactly the 7 batch-inbox blobs of slot 15522751. beacon-patch.py serves them only for that slot, and only when
   Lighthouse is short. Base re-verifies each blob hash itself, so a bad patch could stall Base but not inject data.
4. **Missed slots.** All 78 are parent_root-linked gaps with no EL block. A beacon 404 is classed as missingData, not as a missed slot.
5. **History-expired EL identity.** Accepted only with chainId 1, mainnet GVR/genesis_time, the Fulu epoch, and every in-range EL block equal to a
   canonical beacon payload. EL history is retained only from 26150000, a margin of about 112k blocks.

## Conditions on activation
- (a) The image must carry blob-patch.json sha256 8bad515d…. The guest does not check this file. **Follow-up:** coverage_activation
  should require it when verdict.patchedSlots is non-empty, and acceptance.py should copy it. In r4 it was copied by hand and
  checked in IMAGE.json.
- (b) L1 after 26292338 is unverified by the gate. Gaps there would stall Base, not corrupt it.
- (c) **Restart deadline ~2026-11-11 16:50 UTC.** Every Base start checks that Lighthouse still serves blobSlot 15501577,
  and Lighthouse prunes blobs (margin 0). A restart after that date refuses Base until a new verdict and image exist.
- (d) The snapshot's L2 state is a separate trust assumption. The verdict proves L1 data availability for re-derivation.
- (e) README.md gate hash (line 12) and the count-only note (line 161) are stale.
