# anchor-bootstrap-review: a bounded verifier for an authenticated Base start state (SOURCE-ONLY, accepted for review, NOT production)

**Read `REVIEW.md` first.** It covers the audit, the A1–A7 procedure, the trust assumptions and root's decisions.

## What `anchor-bootstrap.mjs` proves, and what it does NOT

**What it does:** given its inputs, the pure functions (keccak injected, no I/O):
- **Header hashes:** recompute keccak(RLP(header)). A `hash` field is only a claim and is never used.
- **The anchor header:** check that the anchor header N reproduces the supplied `rootClaim` (OutputRoot v0 from the
  header's stateRoot, its Isthmus `withdrawalsRoot` and its recomputed hash).
- **Ancestors:** authenticate ONLY ancestors of N. Any header above N is refused.
- **Planning:** plan the DB action, never accepting a height above N. The rebuild must be at exactly N (`checkRebuild`).

**Every input is UNTRUSTED or caller-supplied:**
- **The anchor `{ rootClaim, l2BlockNumber }` is INJECTED by the caller. The module does not read L1 and does not check
  the game.**
  - Obtaining it is the caller's step **A1**: AnchorStateRegistry `getAnchorRoot/anchorGame/isGameFinalized/Respected/
    Blacklisted/Retired/paused`, and the game's `status==DefenderWins/rootClaim/l2SequenceNumber`.
  - It must be **proof-verified at L1 `finalized`** (`finality-stage/l1-authority` Helios: own reth plus own Lighthouse
    plus a WS checkpoint with recorded provenance).
  - The registry address must be bound by config and cross-checked from the portal.
- **Headers** may come from the untrusted DB. That is the point: they are checked, never believed.
- **The rebuild result** `{ block, stateRoot }` is the caller's report of reth `stage run merkle --to N`. The module
  cannot see that reth ran.
- **Receipts roots** are not computed here; an OP receipt-trie encoder is still needed (REVIEW §4 B-RCPT).

## Tests: `node --test test/anchor-bootstrap.test.mjs`

**6 tests, all required. No test is ever skipped:** a missing or mismatched dependency is an error.
- The published mainnet genesis header hash.
- Byte-equality with viem's independent `toRlp`.
- Forged anchor fields; invented descendants above N refused; tampered ancestors; every planner branch; rebuild height.
- The dependency pins.

**They do NOT verify:** any game, proof system, L1 read, finality, readiness, a real Base header, or the reth rebuild.

**Dependencies** (`test/deps.mjs`, resolved by package name; the versions must equal `source/package-lock.json`):
`@noble/hashes` 1.8.0 (keccak) and `viem` 2.53.1 (`toRlp`). Nothing is installed.
- **From a source checkout:** run from this directory. Node resolves `<repo>/node_modules`.
- **Elsewhere:** `ANCHOR_DEPS_ROOT=<source checkout> node --test test/anchor-bootstrap.test.mjs`.

Root status update (2026-10-25 19:25 UTC): runtime retention guard `713b0ddf` and both policy fields are now installed (`historyFromBlock=48000000`, `stateHistoryFromBlock=52500000`). Base remains disabled, coverage unapproved and the additional historical download pending. This does not complete authenticated bootstrap.
