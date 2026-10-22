> **SUPERSEDED IN PART (2026-10-19, quorum fix).** This report describes the EIP-1271 rule as "one dissent refuses" and
> uses the minimum head. Both were wrong for the censorship-resistance goal and have been replaced. A verdict now needs
> `quorum` identical full snapshots (block plus verdict), and the target is the quorum-th highest head. See
> `claude-app-auth-quorum-result.md`. Everything else here stands.

# App-auth parity: contract wallets in depot and api-mcp-adapter, and jot links over real S3 (2026-10-19)

**Status.** Source and tests are in the `enclave-apps` working tree only: not committed, integrated, published or
activated.

**Constraints observed.**
- No production, config, wallet, chain, SSH, Wine or GUI actions.
- No `sia-s3`, and no model fetched.
- The integrity fix (MAC'd jot link records, compare-and-swap with no deletes) is preserved unchanged.

**Memory discipline.**
- Every cargo run used `systemd-run --user --scope -p MemoryMax=300M -p MemorySwapMax=0` and `CARGO_BUILD_JOBS=1`.
- A unit that exceeded 300 MiB was killed, not swapped, and that work is listed as deferred.
- Available memory was checked before each build. It was 15.0–17.5 GiB throughout. Once it read 15.06 GiB, below the
  floor, from other workloads; that capped build stayed within its 300 MiB.

## Scope (exact files)

**Shared** `*/src/wallet.rs`, byte-identical in eyesoff-ai, jot, depot and api-mcp-adapter (sha256 `41c0a00a…`):
- **Same-chain check.** `check_1271(c, chain_id, …)` now asks each pinned reader, in one batch, for `eth_chainId` and its
  head. A reader not on the wallet block's `chain_id` does not count toward the quorum.
- **Unchanged rules.** Agreement on block number AND hash, a fresh block, every agreeing reader approving, and any
  dissent refusing.
- **New test-only simulator.** `#[cfg(test)] pub mod sim`: an honest wallet contract that reads the real calldata, plus
  readers that are honest, approve-everything, deny-everything, stale, forked, wrong-chain, down or reverting. Clearing
  its `good` set models revocation. Every crate's request-level tests use it.

**api-mcp-adapter:**
- `src/lib.rs`:
  - `rpc_post` (wasi:http, bounded, no redirect);
  - `identify_with(…, rpc)`: readers are attached only when `wallet.contract_wallets` is set;
  - comments separating SIGNER PROOF (`via: "wallet"`) from the `X-User` OWNER OVERRIDE (`via: "key"`);
  - request-level test `contract_wallet_callers_need_a_same_chain_same_block_quorum`.
- `scripts/contract-wallet.e2e.test.mjs`: the component end to end.
- `README.md`.

**depot:**
- `src/routes.rs`:
  - `sign_in` → `sign_in_with(…, rpc)`;
  - `rpc_post` over depot's own client and egress (`send_once`, never resent).
- `src/config.rs`: request-level test `contract_wallet_users_need_a_reader_quorum`.
- `README.md`.

**jot:** `scripts/link-minio.test.mjs`, the real-S3 link test.

**eyesoff-ai:**
- `PLATFORM-sso.md`: contract wallets in all four apps, the chain check, signer proof versus owner override.
- `tests/continuity.e2e.test.mjs`: its fake readers now also answer the batched `eth_chainId` head query.

**Existing behaviour kept.**
- EOA sign-ins never contact a reader.
- EST1, depot tokens, API keys and `X-User` are unchanged.
- depot maps identities to users only through the owner's config.

## What was proven

### Request level

The tests drive the same functions the routes call (`identify_with`, `sign_in_with`), using the shared simulator. Both
api-mcp-adapter and depot cover:
- **Honest quorum.** The contract wallet signs in. In api-mcp-adapter it gets `via: "wallet"`; in depot it maps to the
  owner-bound user `carol` through `accounts: ["wallet_0x<contract>"]`.
- **Revocation.** The contract stops accepting the signature, and the next request is refused.
- **Two honest readers plus one liar.** An approve-everything liar cannot pass a wrong signature. A deny liar refuses a
  good one (deny-biased).
- **No quorum.** Refused for: two readers down; two readers on another chain; a fork that leaves no agreement; all
  readers stale.
- **Outvoted readers.** One reader on another chain, or on another block, is outvoted.
- **Cross-context.** Messages for another audience, another domain, or another act (an account-link message used as a
  sign-in) are refused with ZERO reader calls.
- **Owner override.**
  - api-mcp-adapter: `X-User` with the key gives `via: "key"` and no reader is asked. Without the key it names nobody.
  - depot: depot tokens work without reader calls.

### Component level (api-mcp-adapter)

The built component ran under `wasmtime serve`, with three local JSON-RPC readers running the real contract rule (hashes
from `cast hash-message`). Covered:
- agreeing quorum;
- two honest readers plus one liar, in both directions;
- an outvoted wrong-chain reader, and an outvoted forked reader;
- no quorum (readers down, wrong chain, forked);
- revocation;
- cross-audience, site and act refused with no reader request;
- `X-User` as a key-only owner override.

The component used was a debug wasm built under the cap; it is a test build, not a release artifact.

### jot over real S3

`scripts/link-minio.test.mjs` runs the built jot component against a local minio (`RELEASE.2025-10-15`), through a
recording proxy:
- **The victim's note is sealed at rest** (`JOT1`, no plaintext).
- **The storage operator forges both reciprocal records straight into the bucket**, first unsigned (v1), then v2 MAC'd
  under its own key. Its wallet stays `wallet_0x…` (`via: "wallet"`), lists no notes, and gets 404 on the victim's
  sealed note.
- **Legitimate link** (fresh EST1 plus the wallet's link signature). The proxy log shows:
  - the wallet record PUT with `If-None-Match: *` (200);
  - the operator-forged account record replaced by a PUT with `If-Match: <its ETag>` (200).

  The wallet then acts as the account (`via: "wallet-link"`) and reads the existing sealed note's plaintext. The
  operator's wallet still gets 404.
- **No relink.** Relinking either side returns 409, and a stale EST1 returns 401.
- **minio honours both conditions.** A direct PUT with `If-None-Match: *` over an existing key returns 412, and a stale
  `If-Match` returns 412.
- **Restarts.**
  - Same link key: the link holds.
  - Another link key: the wallet is only itself, and the note returns 404.
  - Back to the original key: works again.
- **No deletes.** No DELETE request was ever made.

The component was a TEST build compiled in a tmpfs scratch copy with stub embedding files (no model fetched). It is NOT
deployable, and search quality is irrelevant to this test. The scratch copy has since been removed. To reproduce, build
jot normally (with `scripts/fetch-model.sh`), or with stub embedding files in a scratch copy, and set `JOT_WASM`.

Correction to my own interim note: a socket hang-up during development was Node reusing a keep-alive socket that minio
closed after a 412. It was not a minio ETag quirk. The raw client now uses one connection per request.

### Mutation checks (isolated scratch, then reverted and removed)

| Mutation | Caught by |
| --- | --- |
| jot `link::verify` skips the MAC | the real-S3 test (fails at the forgery step) and 3 native `link::` tests |
| `check_1271` approves when ANY agreeing reader approves | the shared quorum test and api-mcp-adapter's request-level test |
| `check_1271` ignores `eth_chainId` | the same two tests |

## Test results (this pass)

| Suite | Result |
| --- | --- |
| api-mcp-adapter `cargo test --lib` (300 MiB cap) | 41/41 |
| api-mcp-adapter component e2e | 1/1 |
| depot `cargo test` (300 MiB cap; depot crate built with `opt-level=0` and no debuginfo per-package, because its default test profile exceeds 300 MiB) | 71/71 |
| jot `cargo test --lib`, non-model (scratch, cap, non-incremental) | 41/41; 7 model-dependent tests NOT run |
| jot real-S3 link e2e | 1/1 |
| eyesoff-ai node tests, against the existing component | 36/36 |

## Remaining gates

1. **eyesoff-ai has not been rebuilt** with the new `wallet.rs`.
   - The release build with LTO needs far more than the 300 MiB budget.
   - Its Rust unit tests were not rerun this pass.
   - The shared file's tests pass in the other three crates. eyesoff's own glue is unchanged, and its e2e readers
     already answer the new batched head query.
   - **To do:** rebuild and rerun `cargo test --lib` plus `tests/*.test.mjs` when memory allows.
2. **depot component-level e2e is deferred.** Building depot's wasm in debug needs fresh wasm builds of its
   dependencies, and one (`zerocopy`) exceeded 300 MiB.
   - Request-level coverage runs through the same `sign_in_with` that `who()` uses.
   - **To do:** build the release wasm and run a whoami check against minio (`tests/e2e.py` has the harness) when
     memory allows.
3. **jot:**
   - The model-dependent tests and `scripts/e2e.sh` were not run.
   - No deployable jot wasm was built.
   - The real-S3 test used minio only. R2 and AWS conditional-write behaviour is documented but not exercised here.
4. **EIP-1271 limits:**
   - RPC-quorum trust (not a light client); the readers are the owner's choice, and distinct URLs are not distinct
     organizations;
   - no EIP-6492 (undeployed counterfactual wallets);
   - one check per gated request; there is no state in which to cache a verdict.
5. **Activation, by the owner, in the on-chain config:**
   - `wallet.contract_wallets` with chosen readers;
   - jot `link_key`;
   - then publish and deploy new versions.
6. **Unchanged residuals** from earlier reports: no unlink, no export/import, and links for passkey-only accounts need
   the issuer while it exists.
