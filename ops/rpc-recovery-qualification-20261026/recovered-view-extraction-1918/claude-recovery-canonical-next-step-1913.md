# 1913: the minimum already-implemented path to AUTHENTICATE the recovered Base DB after the structural/state checks (SOURCE-ONLY REVIEW)

**What I read:**
- the HANDOFF's last sections (to 12:39 UTC: 249/265 copied, 241 verified at that time; the user now reports 257 verified);
- the small `l1-a1-live-1958/a1-evidence.json` (3950 B);
- `source/ops/rpc-finality-r13-20261026/candidate/vendor/anchor-bootstrap.mjs` (sha `90a8afba…`);
- `a1-capture-binding-stage/r4/a1gate/a1-anchor.mjs` (`ec92b70f…`);
- `base-reanchor-recovery-stage/r7/harness/a2a4.py` (`5e2658f7…`) and the stage README.

**Not done:** network, RPC, tests, builds, queue jobs, chain/original/backup/part reads, mounts, or commits. No frozen stage was touched.

**What this report is:** a review, not a plan to run anything now. **Nothing here is an authentication result.**

## 1. Facts and the governing rule
**The A1 evidence** (`a1-evidence.json`):
- verdict `A1-authenticated`;
- **N = 52,866,960**, outputRoot `0xa996c517…6700`, game `0x343b3a99…`, ASR `0x909f6cf4…`, respectedGameType 621;
- L1 finalized block 26,271,848 (`0x3762b17e…`), read by `helios-call`.

**The snapshot Finish:** expected **53,048,526**. That is the harness's `SNAPSHOT_HEAD` (manifest pin, `a2a4.py:41`). **It has not been read from the recovered DB.**

**The governing rule, from the existing code's own header** (`anchor-bootstrap.mjs:4-8`): a block hash commits to its parent, never to its children. An authenticated anchor N authenticates **only N and its ancestors**.
- Descendants, including a snapshot head above N, are trusted only after our own EL re-executes them from a state verified at N.
- Any state rebuild must target N itself.

**Applied here:**
- The old A1 (N = 52,866,960 < Finish) can never authenticate Finish, nor the state at Finish.
- The state helper's planned 35 means only "the DB state matches **its own** header(Finish).stateRoot". That header is unauthenticated.

## 2. What actual code implements (reusable interfaces)
**A1: `a1-anchor.mjs` `runA1` / `evaluateA1` (`:181-206`).**
- It reads **only the CURRENT AnchorStateRegistry anchor**: `getAnchorRoot()`, `anchorGame()`, `isGameFinalized/Respected/Blacklisted/Retired`, `status`, `rootClaim`, `l2SequenceNumber` (`:141-157, 187-201`).
- The reads are `helios-call` or `mpt-proof` at a Helios beacon-finalized L1 block.
- A fresh run therefore yields whatever the anchor is **at that time** (a newer N''). It is root-run and network-dependent.
- **There is no interface to select an arbitrary game,** e.g. a game whose `l2SequenceNumber ≥ Finish`. That is not implemented.

**Header authentication: `anchor-bootstrap.mjs`** (pure; keccak injected):
- `authenticateAnchor({rootClaim, l2BlockNumber}, header, keccak)` (`:103-113`): `keccak(RLP(header))` must be recomputed; the header must be Isthmus; OutputRoot v0 = `keccak(0^32‖stateRoot‖withdrawalsRoot‖blockHash)` must equal `rootClaim`.
- `authenticateAncestors(headers, anchor, keccak)` (`:119-136`): a contiguous range ending at N, every `parentHash` linked to the recomputed hash above it.

**State authentication: only at exactly N.**
- **`planBootstrap({anchor, localHead, changesetFloor})`** (`:146-164`) gives:
  - `unwind_to_anchor` when N < localHead;
  - `rebuild_at_anchor` when N == localHead;
  - `sync_past_anchor_then_unwind` when N > localHead;
  - `wait_for_newer_anchor` when N < the floor.
- **`checkRebuild(anchor, {block, stateRoot})`** (`:167-172`) accepts only a rebuild at exactly N whose root equals the anchor's.

**The executable harness: `base-reanchor-recovery-stage/r7/harness/a2a4.py`** (PREPARED, not enabled):

| step | what it does | mutates? |
|---|---|---|
| `plan` | every gate, and the exact commands that would run | no |
| `a2` | `db get static-file headers N` from the datadir, then authenticate | no (read-only) |
| `a3` | chunked `stage unwind … to-block N` | **YES** (needs `inPlaceReviewed`) |
| `a4` | `stage drop merkle` + `stage run merkle --from 0 --to N --commit --skip-unwind` | **YES** |
| `release` | final gates + a fresh A1 recheck | — |

- **Bounds:** `STATE_FLOOR 52,500,000 ≤ N < SNAPSHOT_HEAD 53,048,526` (`:145-146`).
- **A1 modes:** fresh-initial, original-game-recheck, capture-recheck (`:19-21, 175-194`; `gate_a1` `:649+`).
- **The R-A procedure** (README A0–A8) wraps it for a re-anchor.

**Local L1 derivation as an authentication input: NOT found.**
- `planBootstrap` only lists "restart derivation at N from authenticated L1 (M7)" as a step **after** authentication, performed by the node.
- **Uncertainty:** I searched by name only (`derivation`/`batchInbox`/`frame` in `source/ops`); I found no local L1-derivation verifier. I do not claim that none exists elsewhere.

## 3. The two authentication branches and their exact missing evidence
**(A) Implemented: R-A at an anchor N < Finish. It authenticates the state at N, NOT at Finish.**

**Needs:**
- an A1 for N in [52.5M, 53,048,526): either the old N = 52,866,960 through `original-game-recheck` (pinned receipt + a fresh root recheck), or a fresh A1 whose current anchor is still below Finish;
- the recovered DB's stage checkpoints ≥ N, and changesets held from ≤ N. The state helper reports the checkpoints; the prune config in the extracted `data/reth.toml` must show `[prune.segments] before ≤ 52,500,000` (`gate_static`);
- the A2 read of header N.

**Blocker: A3 and A4 MUTATE the datadir.**
- The recovered DB is exposed only read-only (composite r6 view over the 265 parts, which must be preserved).
- R-A therefore needs a **separate writable materialized copy** of the full DB. This is a capacity, ownership and authorization question I cannot resolve; nothing in the existing code makes the copy.
- **The result** would be authenticated state at N. Blocks N+1..Finish are discarded and later re-executed by our own EL.

**(B) Authenticating Finish itself (and so the read-only state helper's 35). The pieces exist; the composition does NOT.**

**The method:**
1. Take an L1-finalized game at **M ≥ Finish**.
2. `authenticateAnchor` on header M.
3. `authenticateAncestors` over headers (Finish..M], linking down to Finish.
4. Require the authenticated hash of Finish == the state report's `tipHeader.hash`, and number == `finish`.

The helper's 35 then binds the DB state to an authenticated `stateRoot`, with **no mutation**.

**Missing:**
- **(i) An anchor ≥ Finish.** The existing A1 reads only the current anchor. That anchor must have advanced past 53,048,526.
  - My rough estimate, not verified: the anchor was 52,866,960 at about 2026-10-25 12:57; at about 2 s per L2 block it would pass Finish around 2026-10-29. That needs a fresh root A1 to confirm.
  - The alternative is to select a specific finalized game ≥ Finish, which is not implemented.
- **(ii) Headers (Finish, M].** They are not in the snapshot or the extracted static files, so they come from an L2 source. That needs authorization; an untrusted source is acceptable only because every header is hash-linked to the authenticated M.
- **(iii) A reviewed integration** that takes a fresh A1 at M > Finish, the headers and the state report. **No existing harness does this:** `a2a4.py` refuses N ≥ `SNAPSHOT_HEAD`, and it is built around unwinding.

**If the anchor is ALREADY > Finish when this happens,** branch (A) is impossible for that anchor, and `planBootstrap` returns `sync_past_anchor_then_unwind`, which needs a network sync. Branch (B) is the read-only route.

## 4. Next safe read-only evidence acquisition step (after the structural CLEAN and the state 35; no network)
**From the state run's bound report (already produced by the helper):**
- record `finish`, `tipHeader.{number, hash, parentHash, stateRoot, withdrawalsRoot}`, and the 5 checkpoints;
- confirm `finish == 53,048,526` (or record the actual value).

**From the extracted `data/reth.toml`** (extractor allowlist, read-only): record `[prune.segments]` and `stateHistoryFromBlock`. This shows whether changesets reach back to any candidate N (branch A feasibility).

**Optional consistency evidence (read-only; it does NOT authenticate Finish or the state):**
- read header **52,866,960** from the recovered snapshot's header segment (`static_file_headers_52500000_52999999`);
- run the pure `authenticateAnchor` against the old A1's `rootClaim`/N.

A pass shows the snapshot contains the canonical block 52,866,960, nothing more.

**Uncertainty:** no reviewed read-only tool decodes an arbitrary header N from the extracted static files. The only existing reader is the harness's `db get static-file headers N`, which needs a reth datadir and the pinned base binary (whether that CLI path opens MDBX strictly read-only on the FUSE view is unverified). The state helper reads only the Finish header.

**Then a decision for root (needs authorization; not now):** a fresh A1 (existing `a1-capture-binding-stage/r4` / the `l1-a1-live` runner with Helios) to learn the current N'', and compare it to Finish:
- **N'' < Finish:** branch (A), which needs a writable copy;
- **N'' ≥ Finish:** branch (B), which needs the header range and the small reviewed integration in §3 B(iii).

## 5. Bottom line
**Implemented and reusable:**
- A1 (current anchor only);
- `authenticateAnchor`/`authenticateAncestors`/`planBootstrap`/`checkRebuild`;
- the R-A harness, which authenticates state at N < Finish only by **mutating unwind + rebuild**.

**Not implemented:**
- selecting a specific finalized game ≥ Finish;
- composing an anchor above Finish with ancestor headers and the read-only state report;
- any local L1-derivation verifier.

**The old A1 (N 52,866,960) authenticates only that block and its ancestors.** It never authenticates Finish 53,048,526 or a newer L2 head. Administrator rights are preserved: no action was taken.
