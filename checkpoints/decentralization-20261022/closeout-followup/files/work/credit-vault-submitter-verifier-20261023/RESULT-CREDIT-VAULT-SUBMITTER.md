# Credit-vault submitter host role: opt-in verified state + locally validated receipt source

Written 2026-10-23T15:50Z (UTC clock).

Worker: A (rpc-priority).

- **Workspace:** `work/credit-vault-submitter-verifier-20261023/repo`, a shared clone with its own `.git`, branch `cv-submitter-verifier` from the accepted, immutable `eab4cfac4`.
- **Untouched:** `rpc-priority/repo-receipts` (still `eab4cfac4`, clean) and `rpc-priority/patches` 0001–0022 (`sha256sum -c` passes).

**Scope:** source, tests and this role's package.
- **Not done:** no SSH, production, restarts, sync, cache allocation, signatures or funds beyond local fixtures, contract changes, toolchains or Wine.
- **Not edited:** B/C/D/E/F/S/T trees.
- **Test runs:** all through the shared queue, unchanged, at 512 or 1408 MiB.

**Not a production claim:**
- Every minted receipt in these tests comes from E's labelled fixture pair, trust `test-fixture`.
- A production receipt source (mainnet identities) against this rig is shown NOT READY.
- No synchronized mainnet node exists here; the validated full-node pair remains the deployment gate.

## 1. Commits, tree, patches, package

| Commit | Content | Patch (sha256) |
|---|---|---|
| `788bc438a07178b1233d34c658d7a98d38e2746d` | role source + tests | `0023` `a86da64446dc4b83f1dd5ac52985f8f7fc30d16b467620a8d80910a4d1a12937` |
| `fd8d58061196c6d089ca21fb7948c6ba640d5c39` | rebuilt credit-vault-submitter package | `0024` `f0aa7998c36820711bebc7f4e493c441fef54a7f43aabff1060e4ffe3185c7fc` |

- **Final:** `fd8d58061196c6d089ca21fb7948c6ba640d5c39`, tree `d8e0ab0656646a1fecbd13a4a2ddd2e19f649b57`.
- `git am` of 0001–0022 (the frozen `rpc-priority/patches`) plus 0023–0024 (`patches/` here, with their own `SHA256SUMS`) onto `dfe020abf` reproduces that tree.
- **Package:** `network/host-services/packages/credit-vault-submitter.mjs`, built by `scripts/build-host-service-packages.mjs` (unchanged).
  - Bundle sha256 `4c25cde6d7f8c726dc2d57f92cf47630f067a6086ee6893d8e57d50f9fb619f6`, 1,374,197 bytes.
  - Manifest sha256 `fa7403b5ef2d2872a40f33b0d42510a9d20dee0d851b665223fb93efaa77ef98`. An operator pins `sha256:fa7403b5…`.
  - **Byte-identical on a second build** (`jobs/build1.out`).
- **Manifest inputs vs the previous package** (`2a4de6d5…`):
  - changed: `cli/credit-vault.mjs`, `cli/independent-signer.mjs`, `cli/independent.mjs`, `network/credit-vault-submitter.mjs`, `network/host-services/credit-vault-submitter.mjs`, `network/lease-reader.mjs`;
  - added: `network/receipt-source.mjs`, `network/verified-chain.mjs`, E's 4 `network/tx-evidence/*`, and 53 `node_modules/viem/_esm/op-stack/*` files of the same viem;
  - removed: none.
  - Manifest field `cold` updated. The builder's forbidden-input check (custody, storage, secrets…) passes.
- **Other roles NOT rebuilt:** `directory-replica`, `policy-mirror` and `route-dns` packages were already stale at `eab4cfac4` (`jobs/base-check3.out`, measured on an untouched base clone). They are not this role's; the build restored them. `bootstrap-replica` is current.
- **Build prerequisite:** `route-dns` needs the gitignored `relay/network-runtime.bundle.mjs` (`relay/build-network.mjs`), generated untracked in this workspace.

## 2. What changed

**`network/host-services/credit-vault-submitter.mjs`** (the runner's intake; the role holds no secret). Two state authorities:
- **Provider quorum (legacy, compatible):** `rpc` = 2–8 distinct providers + `quorum`. Unchanged behaviour, now labelled "agreement between providers, not proof".
- **`chainVerifier` (opt-in):** the operator's loopback proof-backed verifier answers every state read and simulation.
  - `rpc` = 1–8 **explicit transaction-transport** endpoints (sends and tx/receipt lookups only, never state), so **no public provider list is required**.
  - `quorum` is refused here.
- **`receiptSource` (optional, `chainVerifier` only):** the inline `enclave-receipt-source/v1` object.
  - It is parsed AND built at intake with the same glue as the CLI (`network/receipt-source.mjs`). Building does no I/O, but E's adapters refuse non-loopback endpoints at intake.
  - `testFixture` identities are refused unless `ENCLAVE_TEST_RECEIPT_FIXTURE=1` is in the validating process's environment. The host-service runner gives the role only `PATH`.
- **`outcomeTimeoutSec`** (10–600, default 180): how long a send waits before it is held as unknown.

**Config-file handling** (inspected, unchanged, no controller authority):
- The runner validates the operator's own local host-services config with `role.validate` and writes the role's `config.json` itself (0600, the validated object only).
- The role re-validates it at start. The receipt-source config travels inside that validated object, with no extra file or remote fetch.

**`network/credit-vault-submitter.mjs`:**
- The reader and chain come from the CLI's own creation path (`cli/credit-vault.mjs` `readerFor` / now-exported `chainFor`). The source is built from the validated inline config (`receiptSourceOf` honours a prebuilt source).
- The operator's external signer journals against the SAME chain. With a source, its intents settle confirmed or reverted only on minted receipts bound to their signed bytes (the receipts-round rules).

**`cli/credit-vault.mjs`:**
- `relayAuthority(o)`: the state / transactions / receipts description, shown on `/health` and in the role's log. Also used by `enclave credit-vault relay`. Endpoint URLs are counted, not printed, except the loopback verifier.
- `createRelay({…, authority, timeoutMs})`. Under the verifier, a success answer adds the verified `outcome` text. The answer stays a hint; clients reconcile from the chain.

**Preserved:**
- exact bytes, one flight per digest, idempotent repeats;
- verified simulation before signing; one payer nonce at a time;
- a definite refusal is forgotten; an unknown outcome is held and never re-signed;
- the reserve path, the DigitalOcean placement refusal, the platform host policy gate (runner), and administrator book migration.

## 3. Tests (final runs; job `t1`, aggregated exit 0, peak 948 MiB)

| Suite | Result |
|---|---|
| `credit-vault-submitter-config` (new, offline) | 4/4 |
| `receipt-source` | 6/6 |
| `credit-vault-submitter-runner` (existing LEGACY runner test, against the rebuilt package) | 6/6 |
| `credit-vault-reserve` | 7/7 |
| `credit-vault-relay-concurrency` | 11/11 |
| `credit-vault-independent` | 10/10 |
| **`credit-vault-submitter-verifier.e2e`** | **6/6** |

**Config unit:**
- legacy accepted and labelled;
- the verifier config needs no provider list;
- remote verifier, empty transport and `quorum` under the verifier refused;
- a remote L1/Base node in `receiptSource` refused at intake;
- fixture refused without the switch;
- through `validateHostServicesConfig`: fixture refused, `platformHostPolicy` kept.

**E2E**, run against the PACKAGED bundle with the runner's argv (`node --max-old-space-size=128 <bundle> <0600 config>`). Setup: reth `--dev` as Base execution, patched Helios as the state verifier, a static anvil L1, and E's labelled beacon/rollup fixtures.
1. **Packaged role:**
   - without the harness switch it refuses the fixture source;
   - `/health` states state/transactions/receipts verbatim;
   - a deploy executes once from a **minted receipt**: exact funds, signer journal `confirmed`, the client's reconcile naming the minted, bound executing transaction;
   - **the transport never answered a state read**;
   - the same bytes are idempotent (no new signature or broadcast).
2. **A REAL on-chain revert:** the vault nonce is used between the role's verified simulation and inclusion (the owner lands a competing request while the operator's wallet signs).
   - The relay answers 409 "reverted … receipt minted"; the journal says `reverted` with no caveat; the operator's nonce is used once; the chain agrees.
   - Only the landed request moved funds; the client decides `superseded`.
3. **Tampered verifier proofs:** refused before anything is signed. Then the same bytes execute exactly once.
4. **Admin migration:** the admin repoints the book's `deployments`; a new deployment through the role lands on the ledger the book names.
5. **Unknown outcome:** the transport swallowed the send, so the relay holds `{txHash, unknown}` and repeats answer the same thing, never re-signed. The operator's `rebroadcast` of the SAME bytes then confirms from a minted receipt, exactly once.
6. **Through `runHostServices`:**
   - the role's environment is exactly `PATH`;
   - a fixture source is refused by the runner's validator;
   - a **production source** (mainnet identities) is NOT READY against this rig, so the send ends `unknown`, never confirmed. The transaction did land, and a working source later decides it;
   - the platform host policy gate stops the role on refusal and restarts it on admission.

**Not re-run:** journal facts parsed back from JSON cannot carry trust. `receipt-source` (6/6) already proves JSON-parsed and copied evidence is refused.

## 4. Limits

- **Receipt trust:** `local-validated-pair` means the local full nodes validated the chain. It is not a portable cryptographic proof. E's in-process brand is not cryptographic authority.
- **Helios** stays the state verifier only (unsafe tier); Helios receipts are never accepted.
- **Legacy mode** still trusts provider agreement for state and receipts, and says so.
- **Not on hosts:** no runtime or installer wiring on any host (B/F own composition: `HANDOFF-CREDIT-VAULT-SUBMITTER.md`). The package is a candidate, not installed.
- **Other roles:** the stale packages listed above remain stale.

## 5. Deployment configuration, prerequisites, rollback

- **Role config (verifier mode)** in the host-services config (`services[].config`):
  - `chainVerifier: "http://127.0.0.1:<helios>/"`;
  - `rpc: ["<operator's own Base node or chosen transport>"]`;
  - `receiptSource: { format: "enclave-receipt-source/v1", l1: { execution, consensus, minPeers }, base: { execution, rollup } }`, all loopback;
  - optionally `outcomeTimeoutSec`;
  - plus the existing `signer`/`from`/`pins`/`stateDir`/`port`/`bind`;
  - package pin `sha256:fa7403b5…`.
- **Hardware prerequisites (not met):**
  - a synchronized, validated Ethereum L1 pair (P: reth v2.8.0 + Lighthouse v8.3.2);
  - a synchronized Base holder (S) deriving from it, with a loopback rollup RPC;
  - a local Helios verifier with a fresh witness supply.
  - Until then, a configured `receiptSource` is not ready, and sends end UNKNOWN (held, resolvable) rather than confirmed. NucBox is untouched; its restart approval is still unanswered.
- **Rollback:**
  - drop `chainVerifier`/`receiptSource` from the role config (the legacy provider quorum, unchanged); or
  - pin the previous package manifest; or
  - use `eab4cfac4`.
