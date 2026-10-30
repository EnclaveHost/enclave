# Independent design review: A3 lease index + H1 historical game + driver (`logs/claude-writer-a3-driver-plan.md`) (2026-10-26 18:43-18:46Z)

## What was reviewed
- **The design:** `logs/claude-writer-a3-driver-plan.md` sha256 `0c4cfce0e56a7e8ec8a45916edf6247b604e74f170b2f7a33dd1eb674484b599` (122 lines). It is an early checkpoint; Claude50 is implementing and **its files were not opened or edited**.
- **Source checked (pinned):**
  - r9 `release.git` `296a5833`: `network/derived-reader/journal.mjs` `1ba1738a…`, `enrollment.mjs` `31639250…`, `vendor/a1-anchor.mjs` `ec92b70f…`, `metal/guest/derived-state.mjs` `796e3e2a…`;
  - r2 (reconstructed earlier, tree `20d0d76a`): `relay/derived-writer-authority.mjs` (`replayToRow`) and `provider.mjs`.
- **Not done:** no tests, builds, network or live actions. No messages sent to the other chat.

**Facts confirmed in source:**
- **The durable files:** exactly `STATE_FILES` = the bridge anchor journal and the reader journal, ≤ 1 MiB at the role (`derived-state.mjs:27-30`).
- **The KVM reader journal limits:** ≤ 128 entries and ≤ 262,144 bytes, enforced at open (`journal.mjs:23`, `:54`).
- **A1's checks:**
  - ASR not paused;
  - the game respected, finalized, not blacklisted, not retired, and `DEFENDER_WINS`;
  - the root and number equal;
  - the game names this ASR;
  - **`gameType == respectedGameType` (current)**;
  - code present for portal, ASR and game (`a1-anchor.mjs:180-200`).

## Verdict (early)
The goal is sound: serve claims older than the start-time ASR anchor without forced re-claims. The implementation should not go further until the four blockers below are addressed, especially **B1**: the design turns replicated state into **positive authority** without a cryptographic link to chain data, and a lower-trust alternative exists (§Alt).

## Blockers (address before code goes far)
**B1. The security boundary change: a committed index becomes positive authority, unauthenticated against chain data.**
- **The design's argument** (§3.3) covers a **host** that can only withhold or roll back AEAD bytes. Then the index is safe: an older X either joins or gives `index_gap`.
- **What it does not cover:** every replica member (and every past measured release in the same K group) can **write** index bytes that all members then accept as lease history ≤ X. The join checks only `hash(block X) == through.hash`; **the logs ≤ X are never re-verified.**
- **The attack:** a faulty or compromised member, or an older release with a fold bug, can omit a `Released` and a later same-runner `Claimed`. The fact then carries the **older** claim's generation, which is exactly the split-brain the lease16 `gen` fencing exists to prevent. It can also fabricate claim positions that still replay to the row at S.
- **Before this change,** replicated state was only a floor (rollback refusal), never positive evidence.
- **Required before implementation, one of:**
  - (a) **§Alt** (no new trust);
  - (b) an explicit, admin-reviewed acceptance of "group members are trusted to author lease history", **plus** a `foldVersion` (and the signed `ledgers`) bound into the binding, so an index written by other code or policy is discarded, never carried.
- **With (b):** rotation and recover carry (§3.1) re-authorise bytes the admin signs **by digest only**. Say so in the admin UX, because the signature does not attest to their correctness.

**B2. A single overflow poisons the whole reader.**
- **The design:** `overflow: true` makes the index refuse for **all** deployments (§3.1). With a cap of 64 active leases (R3 unmeasured), one busy ledger disables writer authority for every deployment: a global availability cliff.
- **Safe per-deployment alternative:** entries are independent per deployment. A deployment **without** an entry can never get a fact (no `Claimed`, so `claim_not_covered`).
- **Fix:**
  - keep a deterministic entry set (evict deterministically, for example by the oldest `through`-relative expiry);
  - record a `dropped` count;
  - refuse with `index_overflow` **only** for deployments absent from the index while `dropped > 0`.
- **Compact encoding:** store `{blockNumber, logIndex, blockHash, txHash, topics[1..3], data}` without repeating the address and topic0 (roughly 250-300 B per log instead of about 450). That gives about 200-300 leases in 96 KiB.
- **The honest scalability plan:**
  - the cap is a function of the KVM 256 KiB reader-journal limit (shared with ≤ 128 anchor entries of about 100 KB);
  - measure R3;
  - beyond about 300 active leases, Option C does not scale without a KVM file-size change. §Alt has no such cap.

**B3. A byte-bound failure must never fail the finalized `accept`.**
- **The risk:** the index is written in the same bytes as `journal.accept` (§3.1). A serialized journal over 262,144 bytes would make the **next open fail** (`journal.mjs:54`), or the write would fail, stalling the finalized floor and the whole reader.
- **Fix:** compute the full serialized size **before** commit, and degrade the index (deterministic eviction plus `dropped`) so the journal is always ≤ 256 KiB − margin. **Never let the index break `accept`.**
- **Test:** an index at its cap plus anchor entries at 128 opens, and `accept` still succeeds.

**B4. H1 and retirement versus "no forced re-claims".**
- **The dependency:** if every finalized game at or below the ledger floor (52,515,705) is **retired**, H1 cannot authenticate a backfill root (design §3.4, R2). Existing deployments' claims then stay unrecoverable without re-claims.
- **The requirement:** no forced re-claims. **R2 must be measured before committing to H1, and §Alt should be the primary path.**
- **H1 check gaps against A1** (if H1 is kept):
  - `paused()` is missing from the list;
  - **the game type rule must be explicit.** A1 requires the *current* `respectedGameType`, while an old game may have a different type. Use `isGameRespected` (`wasRespectedGameTypeWhenCreated`) **plus** a signed policy allowlist of game types; never silently accept any type;
  - `gameAtIndex(i)` must match `proxy == game` **and** `type == game.gameType()`;
  - the output root must be bound to the Base header (`authenticateAnchor`), as A1 does;
  - the game's `l2SequenceNumber` must be ≤ `backfillFrom`;
  - code presence for the factory and game;
  - the `l1-finalized-game-anchor` tier must be **refused** by `journal.mjs` `validateAnchor`, the bridge journal and the coverage manifest (never a floor). Test it.

## §Alt: authenticated backward log scan (recommended; no new trust, no H1, no 64 cap)
- **The mechanism:** from the start-time **ASR-authenticated** anchor N (its block hash is bound by the ASR output root through `authenticateAnchor`: outputRoot = keccak(version, stateRoot, messagePasserStorageRoot, blockHash)), walk headers **backward** by `parentHash` to the ledger floor (52,515,705).
  - Each header's keccak(RLP) must equal its child's `parentHash`, so every older header is authenticated by N.
  - For each header whose **`logsBloom`** may contain the signed ledger address (and lease topic0), fetch that block's receipts and verify them against `receiptsRoot`.
  - **Completeness follows from the authenticated bloom:** a block whose bloom excludes the address has no such log.
- **What it yields:** the lease logs `[ledgerFloor, N]`, authenticated, with **no native execution, no committed positive state, no game retirement dependency and no per-lease cap.**
- **Cost:** about (N − ledger floor) headers (roughly 0.6 KB each) plus a few receipts, read from the operator's own node (untrusted, verified). This is unmeasured (it depends on the block distance), but it is linear I/O, not native derivation.
- **Use:** run it at start (bounded, before serving the cold path). Optionally cache the result in RAM only.
- **Combination:** if it is too slow, combine with Option C **only as a cache that §Alt re-verifies** (store per-entry block hashes and re-check them against the backward chain), which removes B1.
- **Code:**
  - a header and receipt verifier (header hashing `headerHash` and RLP/MPT code already exist in `vendor/anchor-bootstrap.mjs` / `vendor/a1-anchor.mjs`; a receipts-trie and logsBloom check must be added and reviewed);
  - a `readLeaseHistory` that serves `[floor, N]` from the scan plus the existing coverage `(N, anchor]`.
- **Join:** N is the bootstrap block, so this is contiguous by construction.

## Must-fix details if Option C proceeds
1. **Fold equivalence** (checked against `replayToRow`):
   - Keeping the last `Claimed`, the last same-runner `Renewed` and **at least one** refusing event (`Released`, or an other-runner `Renewed`) after it gives the same pass/fail and `until` as the full history.
   - Abnormal can be capped at **1** (any one refuses), so "> 4 poisons" is unnecessary.
   - **Released deletion** is equivalent (both refuse, with different codes).
   - **Fold idempotence:** after a restart, the recovering re-derivation passes blocks ≤ X again. The fold must start **strictly at X+1** (no double events). Test it.
2. **The 30-day expiry pruning:**
   - `through` has no timestamp in the schema; add `through.timestamp`.
   - Prune only if the contract **forbids `renew()` on an expired lease**. Otherwise, a renewal of an expired lease with no new `Claimed` would be refused (availability, not safety).
   - Cite rev 16d's rule, or prune only on `Released`.
3. **Join off-by-one:**
   - for X == `availableFrom − 1` (= the bootstrap block N), block X is **not** in the verified coverage (it starts at N+1), so `blockAt(X)` cannot serve it. Compare against the **authenticated bootstrap anchor** (hash **and** outputRoot);
   - for X ≥ `availableFrom`, compare `blockAt(X)` hash **and** outputRoot;
   - require X ≤ the asked anchor and ≤ B_f;
   - require `index.from` ≤ the ledger floor (or ≤ the signed `backfillFrom`); otherwise the index is incomplete, so refuse.
4. **Carry rules:**
   - carry only if `through` ≤ the new floor **and** the index's `ledgers` / `foldVersion` equal the new signed policy;
   - otherwise discard (backfill again);
   - recover with a high-water may carry an older index (the join decides).
5. **The writer:** use the index only if the ledger resolved at B_f ∈ `index.ledgers`. Every unchanged gate stays: 120 s on S, claim ≤ B_f, the deny-only verifier, A2 evidence.

## Driver (I3): honest limits
- **One native slot shared by finalized, recovery, backfill and provisional runs.** Therefore:
  - every restart re-derives N → the saved floor before serving. N may be days behind (ASR lag), so that is hours at unmeasured native speed; **writer authority is unavailable meanwhile (R1)**. Option C does not change this;
  - an H1 backfill blocks provisional for its whole duration.
- **S ≤ 120 s is unproven (M1-M5).** The driver must never report "complete". `status()` should carry `sAgeSec`, `bfAgeSec`, `slot`, `staleReason` and an explicit `cannotMeet120s` flag whenever the observed S age exceeds 120 s.
- **The finality-first rule is right** (it avoids starving finality), but it implies provisional starvation during catch-up. Document that as an availability property, not a defect.

## Non-negotiables confirmed in the design (keep them)
- No public-RPC authority: hints are untrusted and the native binary or verification decides.
- No admin removal; no contract change.
- No forced re-claims (this depends on B4/§Alt).
- A2 marker semantics unchanged.

## Requested from root / Claude50 next
1. Choose §Alt, or B1(b) with an explicit admin acceptance.
2. Measurements:
   - R2: the oldest non-retired finalized game;
   - R3: active leases;
   - the backward-scan cost: N − ledger floor headers, and bloom hits.
3. Apply B2/B3 if Option C stays.
4. The KVM boundary review of every `journal.mjs`/`enrollment.mjs` change before merge.
