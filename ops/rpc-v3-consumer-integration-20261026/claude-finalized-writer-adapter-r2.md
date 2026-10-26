# Finalized writer adapter r2: the 120 s lease-authority freshness ceiling restored; derived activation BLOCKED (real limitation)

**Stage:** `finalized-writer-integration-stage/r2/`, `SHA256SUMS` **fab96a8f0743352f2f32a55c42ab7d6ea5b38330c5d9203c97d45b6c9c60f5b2**.
- **r1 is frozen and unmodified:** `SHA256SUMS` `beb4ec4a…`, re-verified, with its receipts tests-1/2/3.
- **Prepared, NOT run:** no queue job was launched (KVM's reserved window). The only check run was a parse-only `node --check` of the r2 files.
- **Not done:** no live activation, no admin change, no SSH, no commits.

## The regression (r1) and its fix (r2)
**r1 weakened freshness, and this was not authorized.**
- `createDerivedWriterAuthority` defaulted to `maxAnchorAgeSec = 1800` (allowing 20..3600).
- The selector passed the reader config's `maxAnchorAgeSec`.
- The original lease authority (`relay/lease-generation.mjs`, `maxBlockAgeSec` 120, used at its default by `relay/api-relay.js`) refuses any snapshot older than 120 s.

**r2 restores exactly the original rule:**
- **Ceiling:** `MAX_ANCHOR_AGE_SEC = 120`. Construction refuses any `maxAnchorAgeSec` outside 1..120; it can be lowered, never raised.
- **Selector:** it no longer reads the reader config's age bound. That bound limits KVM's reader only. No env knob exists.
- **Check:** `stale_snapshot` if `anchorTime > now + 5` or `anchorTime < now − ceiling`, the same expression as `lease-generation.mjs`. An age of exactly 120 s is accepted and 121 s is refused.
- **Ordering:** the stale refusal happens before the unsafe verifier is consulted, so it cannot rescue an old anchor (tested).
- **The unsafe local verifier is relabelled:** it is an **additional deny-only check, not a freshness authority**. Its silence never proves the absence of a release, re-claim or admin change; it can only refuse.

**Unchanged:**
- the pre-bootstrap refusal (`claim_not_covered`, no automatic re-claim or signature);
- the lease16 format and replay;
- the admin book/pin handling;
- the legacy reader and the existing `writer_authority_unproven` refusal when unset;
- custody's 120 s guard (not touched);
- no public fallback counts toward completion.

**Files:**
| File | sha256 |
|---|---|
| `r2/patches/finalized-writer-adapter-r2.patch` (to 64156dcd; same `api-relay.js`/`deploy.sh` hunks as r1) | `eb804950…` |
| `r2/relay/derived-writer-authority.mjs` | `5072531d…` |
| `r2/test/derived-writer-authority.test.mjs` | `4f22e647…` |
| `r2/test/derived-writer-authority-kvm-store.test.mjs` (fixture anchor times moved inside 120 s; nothing else changed: diff-checked) | `a972ccce…` |
| `r2/test/derived-writer-authority-abi.test.mjs` (= r1) | `ad216c9a…` |
| `r2/jobs/adapter-tests-r2.sh` | `000e4ce2…` |

**New tests (r2 unit file):**
- **The 120 s boundary:** age 120 accepted; 121, 600 and 1800 refused; +5 s future accepted, +6 refused. A stale anchor never reaches the deny-only check.
- **Ceiling never raised:** `maxAnchorAgeSec` values 121/600/1800/3600/0/−1/1.5/"120"/null throw at construction; 120 and 30 are accepted, and 30 is then enforced.
- **The production selector:** with a reader config of `{maxAnchorAgeSec: 1800}` plus `ENCLAVE_WRITER_AUTHORITY_MAX_AGE_SEC=1800` and `MAX_BLOCK_AGE_SEC=1800` in the environment, a 600 s-old anchor is still `stale_snapshot`.
- **Every r1 test kept**, with the default fixture anchor moved from 600 s to 60 s old.

**Expected result:** **23 tests**: this file's 16 (r1's 14 + 2 new) + 2 ABI + 5 KVM-store. The job requires `tests == pass > 0`, with no fail, skip or cancel, plus **5/5 entrypoint checks**.

**Root command (when KVM's window allows):**
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
jobs/q-exit-status.sh <name> 512 unshare -Urn bash finalized-writer-integration-stage/r2/jobs/adapter-tests-r2.sh
```
**What the job checks first:**
- r1's `SHA256SUMS` is `beb4ec4a` and its files are intact;
- r2's own SUMS;
- the 64156dcd archive plus the generated bundle;
- `git apply --check` of the r2 patch.

**It then runs the same checks as r1:**
- `node --check`;
- the 3 test files;
- the 5 real `api-relay.js` startup checks.

**KVM inputs:** the frozen KVM in-progress inputs (`../KVM-INPUTS.sha256`) are required byte-exact. If KVM commits or changes R3 first, the job stops with "re-review", and the hashes must be re-pinned to the committed blobs.

## Real limitation: a FINALIZED derived anchor cannot meet 120 s
The arithmetic, no measurement needed:
- An Ethereum block is finalized about 2 epochs later: 64 slots × 12 s ≈ **12.8 min**, longer under any finality delay.
- A Base block becomes derivable only after the batcher posts its batch to L1, which is later still.
- So `now − anchorTime` for an `l1-finalized-derived` anchor is **always well above 120 s**.

**Consequence:** with r2, `ENCLAVE_WRITER_AUTHORITY_SOURCE=derived` would refuse every release with `stale_snapshot` (retryable; the release goes out with `facts.runner` only). This is **correct and fail-closed, but useless for production**. **Activation stays BLOCKED.** I did not add any wider default.

## Investigated: an authenticated SAFE (latest-L1) derivation freshness path (document only; no implementation)
**Basis: the existing owned-L1 authority, nothing else.**
- KVM's reader runs its own pinned L1 light client (`l1-runtime.mjs`: `L1_BUILDS`, a checkpoint pinned in source). Today it asks only for `eth_getBlockByNumber('finalized')` (`finalized()`; `prepareProof` takes that header as `l1Head`).
- The native derivation (v3 binary `49f4d7e3…`) derives and executes Base from **whatever** `l1Head` it is given. It reaches the latest Base block whose batch data is included at or below that head, which is OP's **safe** head for that L1 head.

**The SAFE path:** take `l1Head` = the light client's **latest sync-committee-attested header** instead of `finalized`, and derive to the safe Base head for it.
- **Avoided:** no sequencer unsafe head or gossip, no mempool/pool, no HTTP status trust, no public RPC. The witness producer stays untrusted, as now.
- **Freshness budget (all UNMEASURED):**
  - the batcher's posting delay (Base unsafe→safe lag);
  - one or two L1 slots for inclusion plus the light client's optimistic update;
  - witness collection;
  - one native run of about 1–60 blocks.
- **Whether p99 stays at or under 120 s is unknown. It must be measured before any decision:**
  - Base mainnet safe-lag distribution from root's own nodes (`optimism_syncStatus` safe vs unsafe timestamps over days);
  - light-client optimistic-update latency;
  - the 1/30-block native and witness timings.
  
  If p99 is above 120 s, the safe path also cannot preserve the ceiling, and the feature stays blocked.

**Consensus assumptions this path adds (each is a policy decision for the user/root):**
1. **Sync-committee honesty, not finality.** A non-finalized L1 head is authenticated by ≥ 2/3 of the 512-member sync committee, rather than by Casper finality backed by ≥ 2/3 of all stake. This is weaker: a colluding super-majority of one sync committee period (~27 h) could sign a non-canonical head.
2. **L1 re-orgs before finality.** The L1 block carrying the batch can re-org; usually only 1–2 blocks, but there is no hard bound before finality. A Base block derived from it may then be replaced: a released or re-claimed lease could appear or disappear. A writer fact issued from a safe anchor could later name a claim that is no longer canonical; the guest's fence is only as final as that claim. Policy must decide whether such facts are acceptable, and whether they need a later finalized re-confirmation, or revocation if the claim is re-orged away.
3. **KVM API changes, not speculation here.**
   - The reader's durable journal floors and its coverage store (append-only, no eviction, rollback refusal) assume FINALIZED segments.
   - A safe tier needs a separate provisional layer: e.g. tier `l1-safe-derived`, never persisted as a floor, coverage segments held provisionally and promoted only on finalization, and reorg handling. **KVM-owned. Not designed further here.**
4. **The 120 s ceiling is unchanged in this path.** The safe tier would have to pass the same `anchorTime ≥ now − 120` check. Nothing in it relies on the unsafe verifier for freshness.

**Decisions needed before any implementation:**
- (a) accept assumption 1 and the L1 re-org window for writer facts, or not;
- (b) accept the measured safe-lag distribution;
- (c) KVM's provisional-tier design;
- (d) the guest-side consequence of facts from a non-final claim.

## Integration status (unchanged from r1; no claim beyond it)
**Not claimed:** any integration with KVM's committed R3. It is not committed yet. KVM has been asked whether a `readDerivedLogs` call inside the bridge's `snapshot` callback can contend with the provider's `exclusive()` lock. The bridge's `readAnchor` finishes before the callback, but this is unverified until the committed R3 is tested.

**Production gates (all open):**
1. KVM commits R2/R3; re-pin and run the r2 job.
2. A minimal closure composition: R3 plus a regenerated relay `network-runtime.bundle.mjs` exporting `startDerivedLifecycleReader`/`openLifecycleJournal`/`serveDerivedReader`.
3. A real v3 witness run.
4. **A freshness path that can actually satisfy 120 s** (the SAFE path above, after measurement and the policy decisions), or the source stays blocked.
5. Root activation, which is not done.
