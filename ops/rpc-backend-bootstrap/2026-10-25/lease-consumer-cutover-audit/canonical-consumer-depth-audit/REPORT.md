# Canonical-gate depth audit: does `MAX_CANONICAL_DEPTH = 256` refuse actual production finalized/safe consumer paths? (2026-10-25)

- **Method:** read-only static audit. No product edits, tests, queue use, SSH, live access, network transactions or commits.
- **Not done:** no live Base measurement. Base 28545 is not ready, and no Base pass is claimed.

## Inputs (exact)

| Input | Pin |
|---|---|
| Helios candidate | base `eeffcc9` + `verifier-canonical-stage/canonical-block.patch` sha256 `41667ec946d2f591498e4ab9d791914a6d5c886221996c5f0c920a0be39dcc31` |
| Patched files | `patched/` verified against `PATCHED.sha256` (`7e87fad8…`); `core/src/client/canonical.rs` `1c1cd484…` |
| Consumer | `relay-consumer-source` HEAD `81ba668531d17151db810e14562c77a672d742e4` |
| Verifier | `attested-verifier-source` HEAD `77d6cc859fbd3dba0fcf28d372e8fe463e5a589c`. Same file contents at every cited line: the grep outputs were identical. |

## Answer

**No: the bound applies only to EIP-1898 hash reads with `requireCanonical: true`.** In the inspected code, no finalized or safe consumer path reaches it.

- **The bound applies only to `BlockId::Hash` + `requireCanonical: true`:**
  - `canonical.rs:74-90` (`check_block_hash`) returns `Ok(())` for any non-hash `BlockId` (line 75), and calls `ancestor_at` only when `require_canonical == Some(true)` (line 84).
  - `ancestor_at` refuses `top - number > 256` (lines 52-55).
  - `node.rs:195-201` sends only hashes there. Tags and numbers go to `check_blocktag_age` (`node.rs:213-221`), which age-checks `Latest` only.
- **Finalized and safe tags never go through the walk.** `block_cache.rs:75-77` answers `Finalized | Safe` from the stored `finalized` block. `utils.rs:14-19` (`should_use_historical_provider`) excludes tags from the historical path.
- **Helios never converts a hash to a number for the read**: `node.rs` doc at `:187-193` and the `canonical.rs` header. It also never converts finalized to a hash.
- **The consumer refuses finalized and safe at the gate itself.** `relay-consumer-source/network/chain-authority.mjs:203-206` throws `refused(...)` for `eth_getBlockByNumber`, `eth_getTransactionCount`, `eth_call` and `eth_getBalance` with `'safe'`/`'finalized'`: *"the local verifier has no safe or finalized tier (its head chain is the sequencer-signed unsafe tier)"*.
  - Finalized and safe through the local verifier are therefore **refused by the consumer adapter, independently of the 256 bound** (a pre-existing safe refusal, not caused by the patch).

## Callers that DO use `{blockHash, requireCanonical: true}` (the only ones affected)

| # | Code | How the block is chosen | Depth vs 256 | Class |
|---|---|---|---|---|
| C1 | `client/lease-executor-authority.mjs:103-131` (`verifiedLeaseAuthority`) | `target = quorum head (eth_blockNumber) − confirmations` (default 2, accepted 0..1024, `:107-108`), fetched **by number** (`eth_getBlockByNumber(hex target)`, `:121-124`), then pinned to its hash with `requireCanonical: true` (`:126`). `assertFresh`: block age ≤ `maxBlockAgeSecs` (default 120, accepted 1..300, `:109-110, :127-131`). | With Helios' own head ≤ 60 s old (`canonical.rs:24, 30-41`) and the block ≤ 300 s old, the depth is about ≤ (300 + clock skew)/block-time. At **2 s** blocks that is about **≤ 150–165 < 256**. A larger `confirmations` fails `assertFresh` first. | **Static: compatible.** Not measured; it depends on Base's block time, which was not re-measured here. |
| C2 | `client/lease-executor-client.mjs:322-324` (relay simulation) | The same `verified.block.hash` as C1 | as C1 | Static: compatible |
| C3 | `client/lease-executor-client.mjs:159-180` (`verifyLeaseReceipt`) | Pins to the **receipt's own block** (`rc.blockHash`, `:179`) | **Right after sending** (`relayLease` `:339`, receipt timeout 120 s): shallow. **Via `resolveSigned` → `findLanded`** (`:622-630, :789-800`; journal-recorded leases from `fromBlock`): the receipt can be **arbitrarily old**. Beyond 256 blocks (about 8.5 min at 2 s), a Helios-gated peer answers `BlockNotCanonical`. | **Static risk, safe refusal (no wrong answer).** `verifyLanded` throws; `findLanded` catches it and returns `null` (`:628`), so `resolveSigned` falls back to the nonce/deadline fences (`consumed`/`expired`/`pending`, `:807-819`) instead of `landed`. Nothing is re-signed. The degradation is that old "landed" evidence becomes unavailable **if** a Helios-gated client is a required quorum peer. That is **unknown** (production quorum composition not traced). |
| C4 | `custody/v2/chain.mjs:95, 141, 151, 206, 209, 233, 264` | `n.blockHash` / `block.blockHash` from `createQuorumReader` (`custody/v2/quorum.mjs:34+`; `confirmations`, `maxAgeSec` = 120 default) | n/a today | **Not reachable through the gate:** `custody/v2/quorum.mjs:42-45` refuses any client with `VERIFIER_MARK` (`chain_verifier_unsupported`). It stays REFUSED pending qualification. When qualified, the same depth analysis is needed. **Unknown** (block-selection details and `POLICY` bounds not read). |

**Tag users found (not EIP-1898):** `availability/chain-observation.mjs:14` uses `getBlock({blockTag:'finalized'})`, then **block numbers** for all reads (`:18-27`). It never uses `requireCanonical`, so the 256 bound is irrelevant. If its client is the chain-authority adapter, `'finalized'` on `eth_getBlockByNumber` is refused by `chain-authority.mjs:205-206` (a pre-existing refusal). Which client it uses in production is **unknown** (not traced).

## Helios-side facts relevant to "Base finalized lags far behind"

1. **Cache size and eviction:** the cache holds **256 blocks by count** (`block_cache.rs:33`; trim at `:194-200` removes the lowest heights). When finalized lags latest by more than 256, the finalized block's **hash entry is evicted**, while the `finalized` tag still answers (`:75-77`).
   - A **hash** read of that block **without** `requireCanonical` falls back to EIP-2935 (`rpc.rs:303-336`, `eip2935.rs:58-136`): the untrusted block is accepted only if the storage proof at the **trusted latest** state gives exactly its hash, within 8191 blocks. That is authenticated and exact.
   - **With `requireCanonical: true` it is refused** (`BlockNotCanonical`) beyond 256.
   - **No inspected consumer converts finalized into hash + `requireCanonical`.** A future one would be systematically and safely refused on Base. That is a refusal, not a wrong answer.
2. **What "canonical" means here:** on opstack it means "on the verified head chain", and that head is the **sequencer-signed unsafe tier** (the chain-authority comment). It is **not** finalized or safe. Consumers that need finality must not read `requireCanonical: true` as "finalized".
3. **Walk cost** (`ancestor_at`, ≤ 256 links, run before **and** after each read): cached links are free. An uncached link goes to EIP-2935: one untrusted full-block fetch plus one `eth_getProof`. The worst case is about 512 own-RPC calls per check, about 1024 per read. This is bounded but **not measured**.

## Findings

| Class | Finding |
|---|---|
| **Confirmed blockers** | **None found** in the inspected paths. The bound does not touch tag or number reads, and finalized/safe through the local verifier are already refused by the consumer (`chain-authority.mjs:205-206`). |
| **Static risk (safe refusal)** | **C3:** deep lease-receipt verification during `resolveSigned` is refused beyond 256 by a Helios-gated peer. The outcome is fenced (`consumed`/`expired`/`pending`), never a wrong `landed`. |
| **Static risk (semantics)** | Helios "canonical" means the unsafe head chain. Any custody, fee or lease logic that needs finality cannot get it from this gate. Today it is refused rather than mis-answered. |
| **Not measured** | Base block time and the Helios head lag versus C1's freshness window. Walk RPC cost under cache gaps. |
| **Unknown (not traced in budget)** | **Production quorum composition:** which of the lease/custody clients are Helios-gated, and whether a gated peer is required for agreement. **The client behind `availability/chain-observation.mjs`.** **Custody v2 block selection.** The route-composition consumer config and secrets-v2 code was **not inspected**, and no secret configs were read. |

## The ONE test needed before relying on it

Run a native/integration test on the actual candidate (`eeffcc9` + `41667ec9`): the real `Node` and `BlockCache`, a fixture chain with 2 s timestamps, and a head ≤ 60 s old. It must assert:

1. **C1 passes:** the lease-authority read pattern (`eth_getBlockByNumber(head−2)`, then `eth_call`/`eth_getCode` at `{blockHash, requireCanonical:true}`, with the block exactly `maxBlockAgeSecs = 300` s old, about 150 deep) **passes** the gate.
2. **C3 refuses safely:** the same read at depth **257** returns **`BlockNotCanonical`**. A receipt check at that depth must surface as a refusal, never as a value.

This one test turns the C1 "static: compatible" and the C3 "safe refusal" into measured facts.

## If deeper canonical reads become required (proposal only; not implemented; needs its own tests)

**The idea:** a single **EIP-2935 canonical-ancestor proof** instead of a 256-link walk.
- For a requested hash at height `h`, with `0 < head − h ≤ 8191`, take one `eth_getProof` of the EIP-2935 contract slot `h mod 8191` at the trusted (fresh, ≤ 60 s) head's state root.
- Equality with the requested hash proves that it is the head chain's block at `h`.
- **Cost:** O(1) RPC calls. **Window:** the same 8191-block window `eip2935.rs` already trusts for exact reads.

**Preconditions to verify first:**
- EIP-2935 is active on Base at the target fork;
- the head is the unsafe tier (so "canonical" still means unsafe-canonical);
- the read is re-checked after it completes, as today.

**Do not use** "raise `MAX_CANONICAL_DEPTH`" or "walk to 384 over RPC" without that analysis. Each makes the unbounded cost worse and adds no authentication.

## Next root action

1. **Run the one test above.**
2. **Before activation, record the production quorum composition** for the lease clients: is a Helios-gated client a required voter? Decide whether the C3 degradation is acceptable. It is a safe refusal, and admin controls are unchanged.
3. **Keep custody v2 refused** (`quorum.mjs:42-45`) until it is qualified with its own depth analysis.
