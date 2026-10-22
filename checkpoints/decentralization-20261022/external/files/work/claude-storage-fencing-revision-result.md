# sia-s3 writer fencing: revision 2 result (Claude)

Date: 2026-10-20.

**Scope.** I wrote models and a specification in `work/storage-writer-fencing/` and
`work/storage-writer-fencing-proposal.md`, and an interface entry [W2] in `work/storage-final-review-interface.txt`.

**Not done:**
- no edits to shared indexd, SDK, sia-s3, contract or relay source;
- no commits, production, SSH, real keys, wallet, GUI or Wine;
- no Rust or Go build: nothing here is implemented in product code.

**Resources.** Each model ran in the foreground under `ulimit -v ≤ 256 MB`. Peak RSS was 141 MiB, and host
MemAvailable was about 19 GiB throughout.

## Decision

- **Revision 2 is an implementable protocol:**
  - an additive indexd patch: exact-ballot fence, commit-ordered sequence listing;
  - a vendored SDK change;
  - sia-s3 boot, write and read rules;
  - a relay binding.
- **Within the stated assumptions and model bounds it closes all six review points.** It is **not implemented**, so
  nothing here is activation evidence.
- **Activation stays blocked** on implementing it, plus real-indexd tests (the indexd owner holds the PostgreSQL
  fixture).

## The six review points: what changed, and the evidence

### 1. Complete listing

- **Problems confirmed by interleaving** (`listing_model.out`):
  - 0.6.0 misses an unpublished commit;
  - the rejected "published, then NULL tail" listing misses a row published between the end of the traversal and the
    NULL query (5 steps, no concurrent writes);
  - it also misses a pre-listing re-pin (6 steps).
- **New source evidence:** routine slab repair (`RecordSlabMigrated`, `sectors.go` 1147–1160) and admin unblock also
  unpublish events, so objects vanish without any app write.
- **Chosen:** a commit-ordered per-account `seq` assigned under the account row lock, and a stateless
  `GET /objects/seq` that flags blocked objects instead of omitting them.
  - L2 is complete and snapshot-consistent in every interleaving (exhaustive within bounds):
    10 / 2,656 / 12,901 states, up to 3 concurrent re-pins and deletes.
  - At boot the exact fence freezes the account, so the traversal reaches the install `head`. That listing is the
    committed state at install, including every acknowledged pre-fence write, tombstone, ceiling and record.
- **Resource bounds:** no server-side cursor, expiry or transaction across requests; limit ≤ 1000; resumable.

### 2. Exact token

- The specification:
  - a 32-byte token `gen‖counter‖iid` with top bits 0;
  - a canonical `sf` query (one occurrence, 64 lowercase hex), signed only when present;
  - all 9 account mutations listed;
  - a check and assignment in the mutation's own transaction (`FOR UPDATE` on the account row, shared with the raise).
- **Honest model result:** ≥ acceptance showed **no** violation for writers that write only after readiness
  (`fence_v2_geq.out`, 9 configurations). Exact equality is required by the frozen-after-install snapshot argument and
  for replica-local authority, not by that model.

### 3. Same-nonce contenders and quorum intersection

- **Counterexamples without a unique id** (`fence_v2_traces.out`):
  - DOUBLE put-if-absent, 16 steps;
  - STALE read *with* confirmation, 16 steps: confirmation cannot tell identical ballots apart;
  - DOUBLE also at N=3 W=3.
- **Fix:** a 128-bit iid in every ballot. Assumption A2 is that running instances cannot be cloned (SNP/TDX).
- **Two new contenders under one lease with the same observed maximum (S4), proposed rules:**

  | Config | States | Result |
  |---|---|---|
  | N=3 W=1 | 15,387 | ✓ |
  | N=3 W=2 | 672,387 | ✓ |
  | N=3 W=3 (fence sets need not intersect) | **11,398,071** | ✓ |

  All exhaustive within bounds.
- **Readiness does not permit reads.** Without confirmation there is a stale 412 (N=2 W=2, 15 steps) and a stale read
  by the old writer (9 steps).
- **A fence quorum one smaller:** DOUBLE (9 steps).

### 4. Read freshness

- Every read-type answer, including 412, needs a confirmation round started after the request arrived: W voters
  report exactly the instance's ballot. Otherwise the answer is 503 (fail closed).
- **Guarantee:** linearizable per account for single-key S3 operations, conditional PUTs and multipart, under A1–A3.
- **Cost:** one parallel metadata round trip per read batch, and reads need W voters reachable.

### 5. Generation and churn

- **Safety needs no gen.** gen only orders preemption:
  - gen is the finalized `Claimed` ordinal, delivered in the relay's signed release (**a relay change**);
  - the relay must limit releases to k per (deployment, lease ordinal) per window. Today it rate-limits only per IP
    or endpoint and binds no gen (`relay/secrets-release.mjs` 36, 362, 418).
- **Old leases cannot preempt.**
- **Churn within the current lease** is bounded by k, and adds no power beyond that host stopping its VM.
- **Cold owner mode** uses the same gen with counter + 1, so it never starves later leases.
- **Unmeasured app-key holders** have full authority by design (A3).

### 6. Membership

- **Algorithm changes:**
  - "loaded" means installed and listed;
  - all records, copies, ceilings, floors and parts are fenced;
  - admission requires the member's fence to be installed;
  - quorums are taken over the acting set each rebuild;
  - B4 reservations are fenced and counted over voters;
  - B3 re-lists through seq;
  - B2 is unchanged.
- **`member_model.out`** (C={0,1} → T={1,2}, the old writer committing while a contender boots, delayed late acks):
  - proposed rules: 294,909 and 8,837 states, ✓;
  - unfenced commit records: DOUBLE (29 steps).
  - The "loaded" readiness variant found no counterexample in this configuration, where rq is 1 for both sets.

## Exact model bounds and failures (not proof)

**Proposed rules, `fence_v2.py`:**
- **Exhaustive, no violation:**
  - S1 for N=1, N=2 W=1, N=2 W=2 and N=3 W=1;
  - S2 for the same four;
  - S3 for N=1, N=2 W=1 and N=2 W=2;
  - S4 for N=3 W=1, 2, 3;
  - S5 and S6 for N=3 W=1, 2.
- **Not exhaustive** (stopped at 5.87M or 11.7M states, no violation in the explored part): S1 and S2 at N=3 W=2/3,
  S3 at N=3 (all W), S5 and S6 at N=3 W=3.
- An earlier BFS of `same S1 N=2 W=2` exceeded the 250 MB cap (MemoryError). Its violation was found by DFS in 2,805
  states.
- **Model scope:** one key, put-if-absent and read, at most 3 writers, all replicas voters (`fence_v2`). Membership
  only for C={0,1} → T={1,2} with W=2.
- `fence_v2_proposed.out` (S1–S3) was produced before S4–S6, BFS mode and the BITS parameter were added. Those
  additions did not change the S1–S3 rules.

## Hashes (sha256)

Source read:

| file | hash |
|---|---|
| indexd HEAD | `ddaf24b999800651af5aee7575a68ae543506fd9` (clean) |
| indexd `api/app/auth.go` | 69d72d91e1c2aa0d5d3f88b39e92c8a96c2ec2263a642b63775d696040d77bc4 |
| indexd `persist/postgres/objects.go` | e32e2d294c793ad0aa075266c9430c6e799c2cdd139bf6aa0e14f0c77d29d99d |
| sia-s3 `src/replica.rs` | e45eb2f0e3fe0e392a13254060fc7f2a378a213da7384c4368543248380bdb0e |
| sia-s3 `src/store.rs` | 225c09b42eed019fe883caf2dc7c8525c470edc55579fb04885f1e6eb9b1ee49 |
| sia-s3 `src/main.rs` | ed6abf7f587319c62a99a3f32de4a78dab4ac11d0697fbfd0ebc48876cd8ed5a |
| sia-s3 `src/config.rs` | 0926f0cf0402b9fb32a9bfa0b6048693b6f1ab179c21c61abc99da9b32d6f11f |
| SDK `app_client/http.rs` | 7572c138fe441b4e19c9a06ebe75257dd15f391ccd75a5817c5c2d25cdcaa977 |

The Enclave repo was observed at `abe86262`. Read-only.

Models:

| file | hash |
|---|---|
| fence_v2.py | 5a7c7331458b15feee3e706c4c06b1999bd6ce8529df52e5f384c1916effcd75 |
| member_model.py | 8097946c1c378b6031a9abd7df019d28a8439596b48b2627b0b3d9358aa2390a |
| listing_model.py | 3bcfa5f99fafa95e7c29d9b9eaf1e7eec2c0ea016b96946c0aff0bda50f1467c |

Outputs: `listing_model.out`, `fence_v2_proposed.out`, `fence_v2_proposed_n3.out`, `fence_v2_s4_n3w3.out`,
`fence_v2_s56_n3.out`, `fence_v2_bad_summary.out`, `fence_v2_geq.out`, `fence_v2_traces.out`, `member_model.out`,
all in `work/storage-writer-fencing/`.

## Remaining blockers

1. **indexd patch** (proposal §2): not written. The owner is the storage-indexd worker, and the contract is in [W2].
   It needs Go tests against the real PostgreSQL fixture.
2. **SDK and sia-s3 implementation** (§3, §6, §8): not written. It needs mock `Net` support for fence and seq, and the
   native regression tests listed in §8.
3. **Relay:** a lease ordinal in the signed release, plus a per-lease release limit.
4. **Real-indexd validation** of the raise/mutation serialization, seq commit order, and U1, including the
   slab-repair path.
5. **Assumptions to accept explicitly:**
   - A1: fail-stop indexers, not Byzantine;
   - A2: no cloning of running instances, which holds on SNP/TDX but not on plain VMs or owner processes;
   - A3: measured code.
6. **Read availability** becomes W voters (a design cost).
7. **Model scope limits** as listed above.
