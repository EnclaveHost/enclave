# Does witness-check 4fe0cd3b need canonical-block.patch 41667ec9? READ-ONLY source audit (2026-10-25)

**Verdict: NOT AFFECTED. Reuse 4fe0cd3b unchanged.** No witness-check function reaches any code the patch changes. No HOLD is needed for this fix. This is a source-reachability result only: nothing was compiled or run, and no "rebuilt binary would be identical" claim is made. `EVIDENCE.txt` lists every blob and hash used.

## Pinned source (checked before reading)
- **Pin:** 4fe0cd3b was REPRODUCED from committed **ef320298**, tree `eec339e1`, at the original paths (native-provenance r2b, receipt `r2.sha256`).
  - The audit notes the original build came from a dirty aca8176, with ef320298 later committing exactly those 2 files.
  - The r2b reproduction makes ef320298 the binding source.
- **Repository state:** `witness-failover/helios` HEAD = ef320298, tree eec339e1, clean (0 status lines). All reads used `git show ef320298:<path>`.
- **eeffcc9..ef320298 changes only `opstack/`:**
  - `Cargo.toml` adds the `[[bin]]` entry and serde_json;
  - `lib.rs` adds `pub mod witness_check`;
  - `consensus.rs` makes `payload_to_block` `pub(crate)`;
  - plus the two witness files and a fixture.
- **`core/`, `revm-utils/`, `common/`, `ethereum/`, `cli/`, Cargo.lock and the workspace are byte-identical** to eeffcc9 (`git diff --quiet`). So the helper's helios-core is exactly the UNPATCHED base the canonical fix applies to.

## What the patch changes
- `core/src/client/{canonical.rs new, mod.rs (+pub mod canonical), node.rs}`: Node / requireCanonical.
- `core/src/errors.rs`: a new `ClientError::BlockNotCanonical` variant.
- `core/src/execution/{ancestry.rs new, mod.rs (+pub mod ancestry)}`.
- `core/src/execution/providers/block/block_cache.rs`: BlockCache.
- `core/src/execution/providers/rpc.rs`: RpcExecutionProvider.
- `revm-utils/src/proof_db.rs`: EVM BLOCKHASH, which now uses ancestry.
- `core/tests/*`.
- **Not touched:** `core/src/execution/proof.rs` (blob 4afe02d7, identical at both commits), `execution/errors.rs` (8748cd5e), and anything under `opstack/` or `common/`.

## Function-level reachability from `opstack/bin/witness-check.rs`
`main` reads bounded stdin lines into `answer`, which dispatches 8 ops. It imports only `helios_opstack::witness_check::{canonical_head, export_block, rebuild_header, verify_block, verify_get_code, verify_get_proof, verify_head, verify_header, Child}` and `SequencerCommitment`.

| op | functions (ef320298) | Helios code reached | in patch? |
|---|---|---|---|
| head | `verify_head` → `SequencerCommitment::verify`, `ExecutionPayload::try_from`, `consensus::payload_to_block` | opstack lib.rs / types / consensus.rs. The payload_to_block body decodes OpTxEnvelope and builds the alloy Block, with no helios_core call | no |
| exportHeader | `canonical_head`/`rebuild_header` → `verify_head`, `payload_to_block`, base `ChainUpgrades`, alloy `hash_slow` | as above | no |
| header | `verify_header`: serde, `hash_slow`, constant checks, child linkage | none (alloy and base only) | no |
| block | `verify_block` → `verify_header`, `<OpStack as NetworkSpec>::validate_block` (opstack spec.rs: `is_hash_valid`, `encode_transaction`, keccak) | opstack spec.rs (no helios_core reference) | no |
| exportBlock | `export_block` → `canonical_head`, `payload_to_block`, `validate_block` | as above | no |
| getProof | `verify_get_proof` → `check_block`/`pinned_hash` (by-hash only; `BlockId::Number` refused), `helios_core::execution::proof::{verify_account_proof, verify_storage_proof}` | core `execution/proof.rs` → `verify_mpt_proof`, `execution/errors.rs` | **no** (both blobs unchanged) |
| getCode | `verify_get_code` → `check_block`, `verify_account_proof`, `verify_code_hash_proof` | the same proof.rs / errors.rs | **no** |
| version | constants | none | no |

- **The only `helios_core` names in witness code** are `execution::proof::{verify_account_proof, verify_code_hash_proof, verify_storage_proof}` (witness_check.rs:30).
- **Other opstack `helios_core` users are not reached by the helper:**
  - `builder.rs` (client builder);
  - `consensus.rs:28-30` (`Consensus`/`TrustedBlockRef`/`time`; the consensus client loop);
  - `evm.rs` (`ExecutionError`, the EVM);
  - `lib.rs` (the `HeliosClient` alias).
- **Patched components never reached:**
  - **BlockCache, Node and canonical**: the helper constructs no client, Node or BlockCache.
  - **RpcExecutionProvider**: no RPC provider and no network.
  - **EVM / `proof_db.rs`**: no execution.
  - **`ancestry.rs`**: the helper's ancestry is `verify_header` with `Child`, its own hash-linkage check, not helios-core's.
- **Linkage:** the binary links helios-core and revm-utils through the `helios-opstack` crate. That alone shows neither vulnerability nor safety. The verdict above rests on the call graph, not on linkage.

## Why the fixed bug class does not apply to the helper
The fix makes Helios bind answers to an EXACT verified hash and to the verified canonical chain, instead of trusting a cached or RPC block chosen by number or tag. The helper is stateless:
- every op is bound to a signature-verified commitment or to a caller-supplied `expectHash`/`blockHash`, by recomputing `hash_slow`;
- `pinned_hash` refuses number-pinned proof requests.

**Open question for the CALLER (not a reason to rebuild the helper):** the helper does NOT decide whether a verified hash is on the current canonical chain. That decision belongs to the gateway code in `network/rpc-runtime.mjs`, which is outside this audit. Root should confirm the gateway only feeds it hashes from canonical heads, or treats ancestors accordingly.

## The six unchanged native files (old chain-verifier-inputs PINS.sha256)

| file | reuse? | why |
|---|---|---|
| `witness-check` 4fe0cd3b | **yes** | Source-level: no reachable function is in the patch (table above); reproduced from ef320298 (r2b) |
| `enclave-base-head-listener` 9ca75047 | **yes** | Its Cargo.lock contains **0** `helios*` packages (base/base crates only), so the patch cannot reach it |
| `ld-linux-x86-64.so.2` f5e11cc6, `libc.so.6` 02c8c3d0, `libm.so.6` 96510670, `libgcc_s.so.1` e618cb9c | **yes** | Arch glibc / gcc-libs runtime files, not built from Helios. The new helios ABI fit is checked by the build job (NEEDED subset plus the pinned-runtime smoke), not assumed here |

**Not established:**
- no rebuild of witness-check with the patch;
- no binary diff;
- no runtime test of the helper against a patched helios;
- no gateway-side canonical audit;
- no SNP or production qualification.
