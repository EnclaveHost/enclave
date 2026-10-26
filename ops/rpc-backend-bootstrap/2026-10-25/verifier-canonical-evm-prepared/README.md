# Canonical block-hash: REAL Node + REAL revm EVM tests. Native tests PASSED (root run 0031); 5/5 EVM critical mutants KILLED (root run 0032)

**Scope of this record:** the EIP-1898 hash-read behaviour of `call`, `estimate_gas` and `create_access_list` through
the real Helios `Node` and the real revm EVM, on the canonical candidate `41667ec9`.

**This is NOT:**
- **not the end of production RPC work:** not a production release, a measured release, a deployment or an
  independent reproduction;
- **Custody v2 stays REFUSED.**

## Current status (actual root results, 2026-10-26 UTC)

### Native tests: `root-canonical-evm-native-0031`, rc 0, `RESULT: PASS`, first native attempt

**Run:**
- **Queue:** `[queue] EXIT 0`; peak 832 MiB tree RSS, minimum host available 22667 MiB.
- **Run dir:** `verifier-canonical-evm-stage/run/evm-tests-20261026T003007Z`.
- **Pre-checks:** all `[ok]`.
  - **Base:** `eeffcc9`, a fresh clone with tree `2171ad2b`, lock `28f4400c` and the base manifest.
  - **Patches:** candidate patch pin `41667ec9` plus `PATCHED.sha256` `7e87fad8`, then `evm-tests.patch` plus
    `EVM-TESTS.sha256`.
  - **Pinned `vendor-inspect`:** `c9301490`.
  - **Cache:** every cache-reuse guard.
- **Phase A0:** the locked closure and `cargo fetch --offline --locked` passed; `fetch.out` and `metadata.err` are empty.
- **`Cargo.lock`:** unchanged.

**Phase A** (`cargo build -p helios-core --tests --keep-going`): ok.

**Phase B** (`b.out`): **9 passed, 0 failed, 0 ignored, 0 measured, 0 filtered**, in exactly one binary,
`node_evm_canonical`; the named check passed.
1. `evm_call_executes_exact_block_state_for_every_flag`
2. `evm_call_reorg_during_proof_fetch_refuses_require_canonical_true`
3. `evm_estimate_gas_binds_state_and_post_check_refuses_reorg`
4. `evm_create_access_list_binds_state_and_post_check_refuses_reorg`
5. `evm_aba_during_proof_fetch_answers_a_for_every_method_and_flag`
6. `evm_head_advance_during_proof_fetch_still_answers`
7. `evm_stale_head_refuses_require_canonical_true_only`
8. `evm_unknown_hash_and_wrong_upstream_block_refused`
9. `evm_blockhash_is_pinned_parent_not_height_lookup`

**Phase C** (`c.out`, every `helios-core` test): **100 passed, 0 failed, 0 ignored, 0 filtered** over **21** summaries.

| Summary | Passed |
| --- | --- |
| lib unit tests | 18 |
| `ancestor_block_hash` | 4 |
| `block_body` | 2 |
| `block_cache_exact_hash` | 4 |
| `canonical_block_gate` | 17 |
| `execution` | 0 |
| `historical_request` | 1 |
| `log_metadata` | 9 |
| `node_canonical_methods` | 8 |
| `node_evm_canonical` | 9 |
| `receipt_forks` | 6 |
| `receipt_metadata` | 2 |
| `rpc_account_proof` | 1 |
| `rpc_exact_hash_postcondition` | 2 |
| `rpc_request_budget` | 4 |
| `rpc_storage_proof` | 1 |
| `submitted_hash` | 1 |
| `sync_readiness` | 5 |
| `transaction_lookup` | 1 |
| `transaction_metadata` | 5 |
| doc-tests | 0 |

**Cache:** reused in place from the ended `verifier-canonical-stage/run/tests-20261025T234358Z`
(`CACHE-REUSED-FROM`). **This is not an independent reproduction.**

### EVM mutants: `root-canonical-evm-mutants-0032`, rc 0, `RESULT: ALL CRITICAL MUTANTS KILLED`

**Captured** only after its `.rc` (`0`) and the final `[queue] EXIT 0`.
- **Run:** peak 717 MiB tree RSS, minimum host available 22722 MiB. Run dir
  `verifier-canonical-evm-stage/run/evm-mutants-20261026T003119Z`.
- **Checks:** all pre-checks `[ok]` (candidate pin `41667ec9`, `PATCHED.sha256`, `EVM-TESTS.sha256`, every cache
  guard), and `Cargo.lock` unchanged.

| Control | Mutation | Named test | cargo rc | Strict verdict |
| --- | --- | --- | --- | --- |
| E1 | `call` post-check removed | `evm_call_reorg_during_proof_fetch_refuses_require_canonical_true` | 101 | **KILLED** |
| E2 | `estimate_gas` post-check removed | `evm_estimate_gas_binds_state_and_post_check_refuses_reorg` | 101 | **KILLED** |
| E3 | `create_access_list` post-check removed | `evm_create_access_list_binds_state_and_post_check_refuses_reorg` | 101 | **KILLED** |
| E4 | BLOCKHASH by height | `evm_blockhash_is_pinned_parent_not_height_lookup` | 101 | **KILLED** |
| E5 | `call` pre-check removed | `evm_unknown_hash_and_wrong_upstream_block_refused` | 101 | **KILLED** |

Each verdict reads: `KILLED (1 named tests failed by their own assertion; cargo exit 101; binaries ['node_evm_canonical'])`.
Every mutant's `.build`, `.out`, `.rc` and `.verdict` are in `actual/run-evm-mutants-20261026T003119Z/`.

- **Runner:** root fixed the mutant runner **before** execution.
  - **`jobs/check_cargo_mutant.py`** (`be0d73f3…`): the validated strict r2 parser. It records the actual cargo exit,
    requires exit 101, checks the exact binaries and `EXPECTED-CONTROLS-EVM.txt`, and requires each named test's own
    panic.
  - **`jobs/evm-mutants.sh`:** now `0d035f1d…`.
  - **The originally prepared runner** (`eb6e288e…`) and its SHA are kept in `stage/prior-prepared-mutant-runner/`.

## What the 9 EVM tests exercise, and what they do NOT

**Real:**
- the `Node` gate pre- and post-checks over the real `BlockCache`;
- `Ethereum::transact` → `EthereumEvm` → **revm executing raw bytecode**;
- `revm-utils` `ProofDB` pinning the block, fetching state through `get_account`, and serving BLOCKHASH through
  `execution::ancestry`.

**Contracts:**

| Contract | Behaviour |
| --- | --- |
| `READ_SLOT0` | returns slot 0: 0xA under A10, 0xB under B10 |
| `BRANCH_ON_SLOT0` | distinct gas and access lists for A and B |
| `PARENT_BLOCKHASH` | returns the parent's block hash |

**Scenarios:** a reorg, an A→B→A flap and a head advance, each scripted **during the EVM's storage-proof fetch**; a
stale head; `requireCanonical` true versus false/absent; an unknown hash; a wrong upstream block for a hash; and the
pinned parent for BLOCKHASH. The tests count fetches and by-height reads.

**NOT exercised by these 9 tests:**
- **No cryptographic Merkle-Patricia verification inside the EVM fixture.** The `ExecutionProvider` is a **mock** that
  returns state keyed by the exact block hash it resolved. The RPC provider's real proof checks and exact-hash
  postcondition are separate actual tests in the same full regression (`rpc_account_proof`, `rpc_storage_proof`,
  `rpc_exact_hash_postcondition`, all passed in C).
- **No real chain:** no reth forced-reorg run, no network and no full chain.
- **No qualification:** no SNP or hardware qualification, and no measured release.

**One residual trust assumption:** `EthereumEvm` pins whatever block the provider returns. Exactness relies on the
provider's exact-hash postcondition (tested). No EVM-side re-check exists, and no product change was made.

## Contents (all bounded text; no binaries, caches, `metadata.json`, helios or vendor trees)

**`stage/`:** a byte copy of `verifier-canonical-evm-stage/` without `run/`.
- **The two top-level stage files are renamed:** the stage README is `stage/STAGE-README.md`, and the stage manifest
  is `stage/STAGE-SHA256SUMS` (`87382b91…`).
- **Inputs:** `inputs/canonical-block.patch` (`41667ec9`), `inputs/PATCHED.sha256` (`7e87fad8`) and
  `inputs/INPUT-MANIFEST.base-eeffcc9.sha256` (`df1f198a`).
- **The test patch:** `evm-tests.patch`, `EVM-TESTS.sha256`, and `tests/core/tests/node_evm_canonical.rs`
  (`6c2bec94…`).
- **Expected names:** `EXPECTED-CONTROLS-EVM.txt` (9 names).
- **Jobs:** `jobs/` and `prior-prepared-mutant-runner/`.

**`actual/`:**
- `root-canonical-evm-native-0031.{out,rc,guard}`;
- `run-evm-tests-20261026T003007Z/{b.out,c.out,fetch.out,metadata.err,CACHE-REUSED-FROM}`;
- `root-canonical-evm-mutants-0032.{out,rc,guard}`;
- `run-evm-mutants-20261026T003119Z/`: for each of E1–E5, its `.build`, `.out`, `.rc` and `.verdict`, plus
  `fetch.out`, `metadata.err` and `CACHE-REUSED-FROM`. `metadata.json` is excluded.

**Verify:** `sha256sum -c SHA256SUMS` covers every file here. In `stage/`, `STAGE-SHA256SUMS` verifies the stage copy
once its README entry is read as `STAGE-README.md`.

## Root commands (unchanged)

```
./jobs/q-exit-status.sh canonical-evm-tests   2560 unshare -rn bash verifier-canonical-evm-stage/jobs/evm-tests.sh
./jobs/q-exit-status.sh canonical-evm-mutants 2560 unshare -rn bash verifier-canonical-evm-stage/jobs/evm-mutants.sh
```

## Related evidence

- **Canonical candidate:** `../verifier-canonical-prepared/`. Native tests passed in run 0000: B 35, C 91.
- **Canonical required controls:** `../canonical-controls-repair-prepared/`. **12/12 required controls KILLED**, by
  corrected reevaluation of the actual outputs (receipt `93c65ee9…`, `"nativeRerun": false`).
