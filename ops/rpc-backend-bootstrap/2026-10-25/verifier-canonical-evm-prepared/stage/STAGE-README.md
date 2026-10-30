# verifier-canonical-evm-stage: REAL Node + REAL revm EVM tests for EIP-1898 hash reads (PREPARED, UNCOMPILED, NOT RUN)

**Status:** source and jobs prepared only. Nothing has compiled or run, and no queue was used. This stage does **not**
claim EVM coverage until root's native runs pass.

**What it covers:** `call`, `estimate_gas` and `create_access_list` were previously **not driven** through the real Node
(only a structural check). This stage drives them through the real `helios_core::Node` and the real revm EVM.

## Inputs (frozen, unchanged)

| Input | Value |
| --- | --- |
| Base | Helios `eeffcc9`, tree `2171ad2b…`, `Cargo.lock` `28f4400c…`; pinned `vendor-inspect` `c9301490…` (from `9784e20a…`) |
| `inputs/canonical-block.patch` | `41667ec9…`, the candidate that passed natively (B 35, C 91) |
| `inputs/PATCHED.sha256` | `7e87fad8…` |
| `inputs/INPUT-MANIFEST.base-eeffcc9.sha256` | `df1f198a…` |

These are byte copies from `verifier-canonical-stage/`. That stage, its tests and its caches are not edited.

**`evm-tests.patch`:** adds ONE new file, `core/tests/node_evm_canonical.rs` (`EVM-TESTS.sha256`).
- **No product change:** no product source, dependency or `Cargo.lock` change.
- **Checked:** `git apply` onto base, then the candidate, then this patch, reproduces both manifests (checked).

## What is real, and the trust boundary

**Real:**
- **Node:** the gate pre-check and the `requireCanonical` post-check. That is `client::canonical`: exact hash, a fresh
  head, and parent-hash ancestry with depth ≤ 256, failing closed.
- **The EVM path:** `Ethereum::transact` → helios-ethereum `EthereumEvm` → **revm's mainnet EVM executing real
  bytecode**.
- **`revm-utils` `ProofDB`:** it pins the hash the provider returned. Every account and slot comes through
  `get_account(.., pinned hash)`, and BLOCKHASH through `execution::ancestry`.
- **The block cache:** the real `BlockCache`.

**Mock provider:** account and storage state are **keyed by the exact block hash** it resolved from the real cache.
**Merkle-Patricia proof verification is NOT exercised here.**
- **Why not:** the existing proof fixture (`helios_test_utils::rpc_proof` over a local jsonrpsee server) holds a single
  recorded mainnet account. The EVM needs several proven accounts (caller, contract, coinbase) plus storage.
- **Where it is covered:** the RPC provider's proof checks and exact-hash postcondition are covered by
  `rpc_account_proof`, `rpc_storage_proof` and `rpc_exact_hash_postcondition`, which pass in phase C.
- **The execution hint is empty:** the untrusted RPC access list is not used, so every state read goes through
  `get_account`.

**Contracts (raw bytecode in the test):**

| Contract | Behaviour |
| --- | --- |
| `READ_SLOT0` | returns `SLOAD(0)`: 0xA under A10, 0xB under B10 |
| `BRANCH_ON_SLOT0` | slot0 0 under A means STOP; 1 under B means `SSTORE(1,1)`. Distinct gas and distinct access lists. |
| `PARENT_BLOCKHASH` | returns `BLOCKHASH(NUMBER-1)` |

## Named tests (9, `EXPECTED-CONTROLS-EVM.txt`)

1. `evm_call_executes_exact_block_state_for_every_flag`
2. `evm_call_reorg_during_proof_fetch_refuses_require_canonical_true`: a reorg during the EVM's storage-proof fetch.
   `true` is refused; absent/false answer A's state, never B's.
3. `evm_estimate_gas_binds_state_and_post_check_refuses_reorg`: B's gas is more than A's + 15000, and the same reorg
   rule applies.
4. `evm_create_access_list_binds_state_and_post_check_refuses_reorg`: A gives `[slot0]`, B gives `[slot0, slot1]`, and
   the same reorg rule applies.
5. `evm_aba_during_proof_fetch_answers_a_for_every_method_and_flag`
6. `evm_head_advance_during_proof_fetch_still_answers`
7. `evm_stale_head_refuses_require_canonical_true_only`
8. `evm_unknown_hash_and_wrong_upstream_block_refused`: an upstream answers A's hash with B. Every flag is refused and
   0 EVM state reads happen.
9. `evm_blockhash_is_pinned_parent_not_height_lookup`: BLOCKHASH at A11 is A10 even though a by-height read answers
   B10, and 0 by-height reads happen.

## Jobs (root, from `work/rpc-production-final-20261025`; shared queue, cap 2560 MiB after review)

```
./jobs/q-exit-status.sh canonical-evm-tests   2560 unshare -rn bash verifier-canonical-evm-stage/jobs/evm-tests.sh
./jobs/q-exit-status.sh canonical-evm-mutants 2560 unshare -rn bash verifier-canonical-evm-stage/jobs/evm-mutants.sh   # after tests PASS
```

**Optional cache reuse of the ENDED run:** prefix the command after `unshare -rn` with
`env CANONICAL_CACHE_FROM=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/verifier-canonical-stage/run/tests-20261025T234358Z`.
- **Guards:** the same ones as the canonical jobs — ended per its queue log, no process using it, an exclusive lock,
  and cargo-home content equal to CH0.
- **Still fresh:** the clone, patches, checks and logs. **Never run two jobs on that cache at once:** the lock refuses
  the second with exit 23.

**`jobs/common.sh`:** derived from the canonical `common.sh`.
- **Same:** offline, clone and tree checks, the lock, the base manifest, pinned `vendor-inspect`, toolchain 1.96.0,
  `RUSTFLAGS`, `--offline --locked` and `CARGO_BUILD_JOBS=1`; the A0 closure; `Cargo.lock` unchanged.
- **Added:** it applies `inputs/canonical-block.patch` (hash-pinned) plus `PATCHED.sha256`, then `evm-tests.patch`
  plus `EVM-TESTS.sha256`.

**`jobs/evm-tests.sh`:**
- **A:** `cargo build -p helios-core --tests --keep-going` (supported; every target's errors in one run).
- **B:** the 9 named tests, exact names, 0 ignored/filtered.
- **C:** all `helios-core` tests (the 91 plus 9).

Exit codes 20–23 are never verdicts.

**`jobs/evm-mutants.sh`** (each mutant must compile, and its named test must fail with its own panic):

| Control | Change | Killed by |
| --- | --- | --- |
| E1 | `call` post-check removed | test 2 |
| E2 | `estimate_gas` post-check removed | test 3 |
| E3 | `create_access_list` post-check removed | test 4 |
| E4 | ProofDB BLOCKHASH by height (the base lookup) | test 9 |
| E5 | `call` pre-check removed | test 8 (the EVM would pin the upstream's B) |

All 5 anchors were checked unique against the candidate tree.

**`jobs/check_cargo_output.py`:** the canonical parser with the **mutant compiler-error rule corrected**. It no longer
treats cargo's `error: test failed, to rerun pass …` as a compiler error.
- **Self-test (Python only, read-only):** on root's real mutants-0006 outputs, M1 and M7 are now `KILLED`. Synthetic
  `error[E0308]` and `error: could not compile` are still `INVALID`.

## Limits (honest)

- **Not compiled.** Phase A reports every compile error, never as a verdict.
- **No MPT proof verification** inside the EVM tests (see the trust boundary above).
- **One-shot provider lie:** a provider that lies about a hash only on the EVM's own block fetch, after an honest gate
  read, is outside the trust model. `EthereumEvm` pins whatever the provider returns, so this relies on the provider's
  exact-hash postcondition (`rpc.rs`, tested). No EVM-side re-check was added (no product change). Root may decide on
  that defence in depth.
- **Not yet:** no reth forced-reorg E2E, no full chain, no network, no measured release. Custody v2 stays refused.


Root review correction (2026-10-26 00:30 UTC): before any native execution, the fault runner now records the actual Cargo exit and uses the already validated r2 classifier be0d73f3. A timeout, signal, missing binary, ignored/filtered case, arbitrary error, or missing assertion is INVALID. One test binary is selected, so its exact single-target Cargo footer is accepted. Original prepared runner and manifest are preserved in prior-prepared-mutant-runner. Product and test bytecode/assertions are unchanged.
