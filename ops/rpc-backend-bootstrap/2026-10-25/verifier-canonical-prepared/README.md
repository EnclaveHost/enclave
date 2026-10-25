# Verifier canonical block-hash (EIP-1898 requireCanonical): PREPARED source, UNCOMPILED and UNVALIDATED

**Status: source preparation only.**
- **Not yet run:** nothing here has been compiled or run, no native test or mutant has run, and nothing is deployed.
- **Not secure yet:** do not treat this patch as secure until root's native runs of `jobs/canonical-tests.sh` and
  `jobs/canonical-mutants.sh` pass.
- **Custody v2 stays REFUSED.** It needs those runs, a reth forced-reorg end-to-end test, and a reviewed measured
  release.

## Base and pins

**Base:** Helios `eeffcc980a4a9aa092e23e07b1077c1f3fdfc95e`, tree `2171ad2bfd3c97f2e0e029e866b1a8535cbbd187`,
`Cargo.lock` `28f4400c…`. This is the committed tree whose rebuild reproduced the pinned runtime binary `cc962e2b…`
byte-for-byte (native R3x).

| File | sha256 | What |
| --- | --- | --- |
| `INPUT-MANIFEST.base-eeffcc9.sha256` | `df1f198a…` | base file hashes and tree id |
| `canonical-block.patch` | `0bdab7cf…` | 1240 lines, 15 files |
| `PATCHED.sha256` | `89dcb59a…` | the patched files, also under `patched/`; `git apply` onto the base reproduces them exactly (checked) |

There is no dependency, `Cargo.toml` or `Cargo.lock` change.

## What the patch does

1. **`BlockCache` (atomic, branch-invalidating).**
   - Each push holds all four locks in a fixed order.
   - A different block at a height, or a new latest below cached heights, removes that height and every cached
     descendant above it, by hash and by height.
   - A latest that no longer belongs to the chain is cleared (fail closed).
   - A hash lookup returns only a block whose own hash matches.
2. **The provider's exact-hash postcondition.** A `BlockId::Hash` answer, from the cache or EIP-2935, must have exactly
   the requested hash.
3. **`client/canonical.rs`, the gate.**
   - **Every hash request:** requires the exact authenticated block.
   - **`requireCanonical: true`:** takes ONE fresh head snapshot (the unchanged 60 s rule). The requested height must be
     ≤ the head and within 256. It walks exact parent-hash links down from the head, each link from the verified cache
     or the EIP-2935 proof against the trusted latest block. The block reached must be the requested hash.
   - **Never used:** no by-height lookup, and no untrusted RPC is a canonicality authority.
4. **`Node`.** All 11 BlockId methods run the gate **before and after** their read.
5. **BLOCKHASH (`execution/ancestry.rs`, used by `revm-utils` ProofDB).** It follows the pinned block's own parent-hash
   ancestry, never "the canonical block at that height".

## History: the round-2 flaw (retained)

`history/round2-SUPERSEDED-INSECURE.patch` (`ad2dc199…`) is the round-2 patch. **It is INSECURE. Do not use it.**

**Root's counterexample against it:**
- Push A10, A11, A12, then B10 (whose parent A9 exists). The consistency check passes and nothing is cleared, so A11 and
  A12 stay cached.
- The gate saw a fresh head and `get_block(Number(11)) == A11`, so `requireCanonical:true` on A11 **passed**, although
  A11 is above the head and not its ancestor.
- By-height equality is not proof of ancestry, including for a different cached branch below the head.

`history/round2-to-round3.diff` (`96c8370b…`) shows exactly what changed. The cache now drops stale descendants, and
the gate proves ancestry by hash links from one head snapshot. Each half has its own test and negative control (below).

## Tests (35 named tests in 5 binaries, `EXPECTED-CONTROLS.txt`)

**`block_cache_exact_hash` (4):**
- a reorg and an A→B→A flap;
- **root's multi-height scenario** (A10, A11 and A12 gone by hash and by height);
- a finalized block that replaces a cached branch, which drops it and clears latest.

**`canonical_block_gate` (17):**
- `true`/`false`/absent semantics;
- refusals: an unknown hash, a wrong block for a hash, a stale or missing head;
- **no by-height lookup ever**;
- **root's counterexample against a provider that still answers height 11 with A11** (the gate alone refuses);
- another branch below the head;
- a forged ancestry link;
- the depth limit and a missing link;
- the real-cache counterexample;
- a reorg or A→B→A flap during a read;
- a head advance versus a reorg;
- a structural check of the 11-method wiring.

**`node_canonical_methods` (8), a REAL `helios_core::Node`:**
- **Harness:** a mock consensus, as in the existing `sync_readiness.rs`, over a mock execution provider. Its blocks are
  the real `BlockCache`, its state is keyed by the exact resolved hash, and the chain is moved **during** each read.
- **Methods driven:** `get_balance`, `get_nonce`, `get_code`, `get_storage_at`, `get_proof`, `get_block`,
  `get_block_receipts`, `get_transaction_by_block_and_index`.
- **The tests:**
  - every flag binds the exact block;
  - a reorg during each method's own read is refused;
  - A→B→A answers A's state;
  - a head advance still answers;
  - root's counterexample through the node;
  - a stale head is refused for `true` only;
  - an unknown hash is refused.

**`rpc_exact_hash_postcondition` (2):** the real `RpcExecutionProvider` refuses a different block for a hash.

**`ancestor_block_hash` (4):** BLOCKHASH ancestry.

## Jobs (root runs these from `work/rpc-production-final-20261025`)

The `jobs/` copies here are byte-identical to `verifier-canonical-stage/jobs/`.
```
./jobs/q-exit-status.sh canonical-tests   2560 unshare -rn bash verifier-canonical-stage/jobs/canonical-tests.sh
./jobs/q-exit-status.sh canonical-mutants 2560 unshare -rn bash verifier-canonical-stage/jobs/canonical-mutants.sh   # after tests PASS
```

**Setup checks (`common.sh`):**
- the network is offline (loopback brought up);
- the source repo is clean at `eeffcc9`, and a fresh clone has the tree, `Cargo.lock` and base files from the manifest;
- `git apply --check`, then `PATCHED.sha256`;
- a hash-verified **copy** of the existing cargo-home;
- toolchain 1.96.0, `--offline --locked`, one compiler job.

**`canonical-tests.sh`:**
- **A:** compile preflight. A failure gives exit **20, COMPILE-FAILURE, never a verdict**.
- **B:** `check_cargo_output.py named` requires exactly the 5 binaries, exactly the 35 names all `ok`, and each summary
  `N passed; 0 failed; 0 ignored; 0 measured; 0 filtered out`. There is no `--include-ignored`, and any unexpected name
  fails.
- **C:** all `helios-core` tests. `regression` requires 0 failed **and 0 ignored and 0 filtered**; anything ignored or
  filtered gives exit **30, INCOMPLETE, never a pass**. Plus the `revm-utils` build.
- **D:** the `helios-cli` build.
- **Finally:** `Cargo.lock` unchanged.

**`canonical-mutants.sh`:**
- each mutant must compile (`--no-run`);
- **each named test must report `FAILED` with its own `---- name stdout ----` block containing `panicked at`**;
- a compiler error is INVALID, never a kill.

**The controls:**
- **M0:** the cache tests on the **unpatched** base, which must fail.
- **M1–M12:** including M7 (no descendant drop), **M8 (the round-2 by-height gate)**, M10 (no per-link check), M11 (no
  provider postcondition), and M6/M12 (node post-checks, killed **behaviourally** by the real-Node test).
- **I1–I3:** reported, expected to survive (defence in depth).

**Parser:** `check_cargo_output.py` was self-tested on synthetic cargo output (pass, ignored, filtered, unexpected,
missing, panic versus non-panic, compiler error). No product code has run.

## Limitations

- **UNCOMPILED.** The largest unverified piece is the new real-Node harness (mock execution provider and consensus).
  Phase A separates compile failures from verdicts.
- **Cache dev-dependencies not proven.** The existing cargo-home is not proven to contain every dev-dependency.
- **Depth 256.** `requireCanonical:true` is refused more than 256 blocks below the head. Proving deeper would need a
  per-link proof budget decision.
- **Historical walk cost.** A cold-cache walk costs one EIP-2935 fetch per link, within the existing budget. A walk that
  exceeds the budget refuses; it never answers wrongly.
- **No full EVM tests.** `call`, `estimate_gas` and `create_access_list` are **not driven** through the real `Node`.
  They rely on the shared gate, the tested provider postcondition, the tested BLOCKHASH ancestry and the structural
  check.
- **`requireCanonical` absent or false.** A read already bound to A returns A's own state when a reorg races it (no
  canonicality claim); later requests for a dropped A are refused.
- **Not yet:** no reth `--dev` forced-reorg E2E and no measured release.
