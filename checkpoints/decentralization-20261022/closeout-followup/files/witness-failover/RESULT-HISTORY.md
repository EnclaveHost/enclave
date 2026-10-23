# witness-failover: authenticated historical-header recovery (RESULT-HISTORY, 2026-10-23 ~03:30Z)

**Status: SOURCE CANDIDATE + OFFLINE TESTS ONLY.**
- Not deployed, merged, published or pushed.
- Same isolated clones as before. A's, B's and E's trees and jobs were not touched; their fixtures were copied, with
  hashes recorded.
- No live RPC, SSH, production, transactions, new toolchains, node sync or NVMe hosting.
- Root merges after all workers finish.

**Not solved:** fresh witness availability. Recovery still needs an execution-data holder: some source must hold the
headers and proofs. With every fresh source down, only roots already bound and verified cached history remain.

## 1. Gap closed

`RESULT.md` §6 recorded that the gateway refused proofs for any block whose signed head its root store had not seen.
That covered:
- poll gaps (fast blocks between two polls);
- cold starts;
- confirmed blocks older than the first head seen;
- Helios's historical blocks.

Such roots are now recovered by **authenticated ancestry**. Recovery never takes a source's word for a hash or state
root, never asks Helios (that would be a cycle), and never bypasses proof validation.

```
rootFor(H): bound? → done
  poll the head source once (coalesced)                    ── or heads pushed with roots.offer(commitment)
  no bound head at all → refuse, no source asked
  guide = untrusted header for H (helper: hash_slow == H)   ── ONLY its claimed number n is used
  D = the nearest bound block with number > n; none → refuse; D.number − n > maxAncestry (256) → refuse
  walk cur = D down to n+1: each parent header comes from the upstreams in order and is checked by the helper:
        hash_slow == cur.parentHash, number == cur.number − 1, timestamp ≤ cur.timestamp, Base header rules
        → bound as 'ancestor' (boundTo = cur); a forged/tampered header costs its source the try
  cur.parentHash == H ? bind the guide (re-checked with child = cur) : refuse ('not-an-ancestor')
```

- **Refusal reasons** are counted in `stats().ancestryRefused`: `no-bound-head`, `unavailable`, `too-deep`,
  `newer-than-every-bound-head`, `not-an-ancestor`, `mismatched-link`, `deadline`.
- **Concurrency:** concurrent recoveries of one hash share one walk.
- **Bounds:** every header fetch is limited to 1 MiB while reading, and the per-try timeout, request deadline and
  in-flight cap apply.
- **No freshness:** a recovered binding is frozen and carries `via: 'ancestor'` and `boundTo`, but no notion of
  freshness. It is history for that block; Helios's own head checks decide what is fresh.

**Trust argument:**
- An ancestor's state root is bound by recomputing the hash of its header with alloy's maintained `hash_slow`.
- That hash must equal the parent hash of a block that is already bound, by a sequencer signature or by an earlier
  link.
- Only the claimed block number of the requested header is used before it is authenticated, and only to choose where
  the walk starts. A lie about it ends in a refusal.

## 2. Helper changes (Helios fork `enclave-witness-check`, `1ec2c1a5` → **`aca81764`**)

No new dependency, and `Cargo.lock` is unchanged. All of this is maintained code.

- `canonical_head` / `rebuild_header` rebuild the canonical header from a signed head:
  - start from Helios's `payload_to_block`;
  - set the three header fields that Base takes from the envelope, exactly as base/base v1.5.1 does: the L2
    withdrawals root (`BaseExecutionPayloadV4::into_block_raw`), and the parent beacon block root plus
    `EMPTY_REQUESTS_HASH` from Isthmus (`BlockHandler::block_valid`);
  - require alloy `hash_slow()` to equal the signed block hash.
- `verify_header` takes an untrusted header (RPC JSON) and checks:
  - `hash_slow` equals the expected hash and the claimed `hash` field;
  - with a child: exactly one block lower and not later;
  - Base header rules: the post-merge constants, a base fee, and from Isthmus the withdrawals root, parent beacon root
    and `EMPTY_REQUESTS_HASH`.
- New ops: `exportHeader` (taking a commitment, or a raw snappy gossip object whose declared decompressed size is
  checked first, ≤16 MiB) and `header`.
  - `exportHeader {synthetic:true}` is **for test fixtures only** and labelled as such. The gateway never sends it.
- **Base's own `base-common-rpc-types-engine` was tried first and dropped:**
  - adding it as a path dependency forces `bytes ^1.12.1`;
  - Helios locks 1.12.0, and 1.12.1 is not in the offline cache (`helper-build-test-r3`);
  - the alternative was bumping `bytes` across Helios's whole lock just for fixture export.

  The rebuilt headers are proven equal to Base's anyway: all 52 real ones recompute to their signed hashes.

## 3. Fixtures: exact derivation (no network)

`repo/test/fixtures/derive-base-headers.mjs` runs via `jobs/derive-headers.sh` (offline, helper `fab2f1ce`).

**Real headers: `base-headers-52965055-52965106.json`** (52 blocks, sha256 in `PROVENANCE-HISTORY.json`).
- **Inputs:**
  - the 52 signed v4 gossip objects of head-listener run live-20261023T013719Z, copied from the immutable
    `rpc-priority/fixtures/base-heads-b-live-…`; every name equals its content sha256;
  - B's three listener fixtures for 52965074..76, which are identical objects.
- **Checks:**
  - the real Base unsafe signer;
  - the rebuilt header's `hash_slow` equals the signed block hash for every block;
  - each header equals the listener's own record (hash, parentHash, stateRoot, number), which was accepted by Base's
    `BlockHandler::block_valid`;
  - the 52 form a consecutive parent-linked chain, and the 51 real links verify as authenticated ancestry in the
    helper.

**Correction to the task premise: A's call-fixture commitment does NOT carry the full block payload.**
- `record-base-calls.mjs` signed `blockFields(block)` with `txs: []` and a zero parent beacon root.
- The rebuilt header therefore hashes to `0xd6596e16…`, not the real `0x117db438…`. The strict export **refuses** it,
  and that refusal is recorded in the fixture.
- `base-header-52965249.synthetic.json` keeps the real header fields and **real state root** under that synthetic
  block identity. It is labelled SYNTHETIC: TEST-key authority and a synthetic block hash.
- The real header of 52965249 cannot be derived offline. It is not used as mainnet canonicality evidence.

## 4. Tests (actual terminal results; digest in `TEST-EVIDENCE-HISTORY.txt`)

All runs went through the queue at a 16 GiB floor and offline (`unshare -r -n`, network asserted unreachable).

| Run | Cap | Result |
|---|---|---|
| `helper-build-test-r4` | 1536 | **Rust 8/8**; helper `fab2f1ce`, lock unchanged |
| `derive-headers-2` | 256 | 52 real headers + 1 labelled synthetic; strict refusal of the call fixture recorded |
| `js-ancestry-r1` → `r2` | 256 | 23/24 → **24/24**. r1 showed a needless guide fetch when no head was bound at all; recovery now refuses before asking any source |
| **`js-all-r3`** | 512 | **39 tests: 38 pass, 0 fail, 1 skip** (the stock-0.12.0 comparison test: no binary given, unrelated to the gateway); peak 251 MiB |
| `scan-2` | 256 | both new ranges: crypto 0 findings, gitleaks "no leaks found" |

**Rust** (real gossip object 52965074 and the recorded metadata of its real child 52965075):
- the canonical header rebuilds to the signed hash and its JSON verifies as the parent of 52965075;
- refused: tampered state root, forged hash field, wrong expected hash, a parent-hash/number/timestamp mismatch with
  the child, a malformed header, an unknown chain.

**`witness-ancestry.test.mjs`** (real helper and real data; **header/ancestry binding only**, because these blocks
have no recorded proofs):
1. The fixture re-derives from the signed objects, and 51 real links verify.
2. **Cold start:** only head 106 was seen. Block 80 is recovered, with a **forged first header** source (tampered
   state root) refused 26/26 and the honest source verified 26/26. 26 ancestors are bound, and nothing is fetched
   again afterwards.
3. **Skipped polls:** heads 60 and 106 were seen.
   - Block 70 with `maxAncestry 20` is refused `too-deep`; with 64 it is recovered (36 ancestors).
   - Block 59 is recovered one link below head 60.
   - A block newer than every head is refused.
4. **Fail-closed:**
   - missing history (a hole at block 95) → `unavailable`;
   - forged-only sources → nothing bound;
   - a real header answered for another hash → refused;
   - a hung source and a 200 KB header over a 64 KiB cap → one try each, then the honest source;
   - a hung source alone → refused within the 900 ms deadline.
5. **Fork, number gap, earlier parent** (TEST-key heads, synthetic authority): `not-an-ancestor`, link refused, link
   refused.
6. **Concurrency:** 8 concurrent requests for block 85 share one walk (21 fetches).
7. **Push interface:** a pushed real head anchors recovery; a wrong-signer push is refused; no polling happens.

**`helios-witness-failover.e2e`** (real patched Helios) has a new 4th test for the cold-ancestry path. The authority
and block identity there are SYNTHETIC, and labelled.
- Helios adopts 249′ (the real header fields and real state root under its recomputed hash). The head then moves to a
  TEST-signed child, 250′.
- A **cold gateway** sees only 250′ (`verified: 1`). Helios's pinned calls make it recover 249′ by ancestry
  (`ancestors: 1`, `via: ancestor`, `boundTo: 250′`). The **liar's forged header was tried first and refused**
  (`headerInvalid: 1`).
- **All 49 real recorded proofs** then verified; the liar was judged invalid 49 times and accepted 0. **All 5 real
  calls match the providers.**
- The earlier real-replay and poisoning tests are unchanged and still pass: the liar was judged invalid 49/49, all 49
  pre-poisoned entries were quarantined, and cache-only served 49 hits. The real-Base replay (5/5) and the Anvil E2E
  (5/5 + 1 skip) also pass.

## 5. Exact inventory

| Item | Pin |
|---|---|
| Enclave `witness-failover` | `bfbd649d` → `cf5cc363` (root store ancestry + push + gateway headers/`root()`) → **`ce7c1b73`** (fixtures, derivation, tests) |
| Helios `enclave-witness-check` | `1ec2c1a5` → **`aca81764`** |
| Incremental patches | `patches/history/enclave/0001-0002`, `patches/history/helios/0001`. Earlier stage: `patches/enclave`, `patches/helios` |
| witness-check | **`fab2f1ce`** (debug; not preserved) |
| Helios under test | `helios-eeffcc9` `cc962e2b` (copy of A's r4 build) |

Fixture input and output hashes are in `PROVENANCE-HISTORY.json`.

## 6. Integration interface (root coordinates; nothing applied to other trees)

- **A (consumer wiring):**
  - Construction is unchanged: `proofs: {checker, roots}`.
  - New:
    - `createRootStore({..., maxAncestry})`;
    - `roots.offer(commitment)`;
    - `g.root(hash)`, which returns the authenticated binding the gateway uses, or null. LeaseReader may use it, but
      it must not treat the result as fresh: check `via` and use Helios's head for freshness.
  - Upstreams should serve `eth_getBlockByHash` for headers. They are untrusted, as before.
  - New stats: per-upstream `headerOk`/`headerInvalid`, and `roots.stats().ancestors` / `ancestryRefused`.
- **B (native gossip bridge):** call `roots.offer(commitment)`, using the `{data, signature}` form Helios's consensus
  API serves, for every head the bridge accepts. The store re-verifies each push with the pinned signer, so the
  bridge is not trusted, and pushed heads close poll gaps without polling.
  - To push raw gossip objects instead, add an `offerObject` that calls the helper's
    `exportHeader {object}` → `commitment`. That is a small, not-yet-written addition.
- **E (Sia-S3 cache):** no change beyond `RESULT.md` §5 (`put` content-addressed, `candidates(w)`).
  - Optional: persisting verified headers in E's store would let a restarted gateway recover without header sources.
    It is NOT implemented; any such store must be re-verified by the same `header` op chain.
- **Helios:** unchanged. The fork only adds helper code.

## 7. Limits (not claimed)

- **Fresh witness availability is NOT solved.** Recovery needs some execution-data holder (headers + proofs). With
  every source down, only already-bound roots and verified cached history remain.
- **History depth:**
  - Recovery reaches at most `maxAncestry` (default 256, cap 8191) below the nearest bound head; that is about
    8.5 min of Base blocks today at the default, and far less at Denim's 200 ms.
  - Deeper history and blocks older than every bound head beyond that depth are refused.
  - Helios's EIP-2935 historical path (one storage proof instead of a walk) is not mirrored.
  - Roots live in memory only, so a restarted gateway must walk again.
- **Signed heads are bound by signature, as Helios binds them.** Their canonical hash is not recomputed, so that A's
  Anvil-based E2E keeps working; real Base heads do recompute, as `exportHeader` shows. Ancestors are bound by
  recomputation.
- **Unsafe tier:** the sequencer signer is an admin pin, with no L1 finality or rotation.
- **Synthetic authority:**
  - The only real-proof E2E uses a synthetic block identity and TEST-key authority.
  - Real-hash ancestry is shown on 52 real headers without proofs.
  - A real proof at a real recovered block was not possible offline: no recorded data has both.
- **Builds:** debug only. No release build, clippy or full workspace tests.
