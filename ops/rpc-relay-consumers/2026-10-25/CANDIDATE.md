# Relay chain consumers on the verifier authority: result (round 5, after root review)

- **Worktree:** `relay-consumer-source`, branch `fix/rpc-relay-consumers-20261025`, base `9fa02e1bc`.
- **Not done:** no commit, no push, no SSH, no live config or keys, no image build. Every check ran through the shared
  guard: 16 GiB floor; 1024 MiB unless stated, the real-runtime E2E and sessions suites at 1408.

**SCOPE (explicit): a PARTIAL relay migration, NOT a complete RPC replacement. It BLOCKS full relay activation.**
- The relay's reads and sends (R1–R8) go through one verifier authority. Every limit is stated in §5.
- **Storage writer fencing is NOT provided by the relay under the verifier.**
  - The writer-authority path now refuses explicitly (§2).
  - Fencing is still enforced by the guest itself, from its own measured chain reads.
  - So for apps that refer to `ENCLAVE_WRITER_AUTHORITY`, the public-RPC dependency moves to the guest. It is not
    removed.
  - Full parity needs the §6 proposal (finalized + complete verified receipts).

**Untracked, do NOT commit:**
- `node_modules`: symlink to `../control-source/node_modules`.
- `network/node_modules`: symlink to the lock-identical `work/enclave/network/node_modules`.
- `relay/network-runtime.bundle.mjs` and its `.manifest.json`: generated, sha256 `5432bacf…`.
- `contracts/foundry/out`: gitignored. Exactly 7 prebuilt artifacts, from `jobs/forge-prebuild-sessions.sh`.

## 1. Source pins (sha256, first 16 hex)

Review patch: `logs/claude-relay-consumer.patch`, sha256 `c65d4af7f165005f31a7838dd2ad8148b56014a1003fd745ccb9a44f17d2462e`
(13 tracked files plus 5 new).

| file | sha256 | round-5 change |
|---|---|---|
| `relay/relay-chain-env.mjs` (new) | `3841ee30588ce512` | |
| `relay/relay-chain-authority.mjs` (new) | `50a95539fda18c8c` | |
| `relay/store.js` | `4e5e80025f424ef6` | |
| `relay/api-relay.js` | `b9bbffa94fc3724f` | explicit writer-authority refusal under the verifier |
| `relay/lease-generation.mjs` | `8a0831b975ce54ff` | `refusingWriterAuthority(code, message)` |
| `relay/custody-state.mjs` | `b9fcca798bee966d` | |
| `relay/sessions.mjs` | `33e5f2c6fb9aa908` | |
| `relay/host-sponsor.mjs` | `9830b5edb5f8db5d` | proven EntryPoint and Simple7702 code required before simulating |
| `relay/mcp.js` | `63f058d05e801553` | |
| `relay/network-runtime.mjs` | `b000f1ea4e934ece` | |
| `relay/deploy.sh` | `d9befebfb8d5f853` | |
| `metal/guest/platform-api-role.mjs` | `1be7177b95021f7c` | |
| `metal/guest/measured-control.mjs` | `9694071f33d8d8dc` | **bind-time validation composed here** (= `logs/claude-relay-consumer-measured-control.proposal.patch`, `c5c203bc…`). Another worker edits this file independently; root merges |
| `test/relay-chain-consumers.test.mjs` (new) | `5f3cfd80af7410c5` | |
| `test/relay-chain-authority.test.mjs` (new) | `41d155c682d0aa27` | |
| `test/relay-smart-wallet-verifier.e2e.test.mjs` (new) | `2772900005d8162f` | |
| `test/native-relay-chain-authority.test.mjs` | `aac333573072a231` | |
| `test/storage-front-binding-release.test.mjs` | `942dd3c5da8b6cad` | |

## 2. The BLOCKER: what the verifier relay preserves, and what refuses

**Audit (observed source).** Both release paths attach `facts.writerAuthority` only when the config refers to
`ENCLAVE_WRITER_AUTHORITY`: `relay/secrets-release.mjs:601-616` and `relay/shield-secrets.mjs:58-68`.
- The fact is the lease16 fact: the lease's FINALIZED Claimed log, replayed to the row by `relay/lease-generation.mjs`.
- The guest takes it as authoritative: strict parse, bound to its deployment on Base
  (`isolation/m2/front/provision.go:428-438`).
- When it is absent, the guest establishes the authority itself (`isolation/m2/bootstrap/leasegen.go`), bound to
  `facts.runner`, from its own measured chain reads, with the app not started.
- The release itself never waits on the fact, by design. A 503 there would be counted an app death and the lease
  released.

**Implemented (fail closed at the point that needs the history):** under the verifier, the writer-authority source is
`refusingWriterAuthority("writer_authority_unproven", …)`.
- Every request refuses with that code. **No fact is ever made from history the verifier cannot prove** (no finality on
  the unsafe tier; `eth_getLogs` proves inclusion, never completeness).
- Each affected release logs the refusal by code and goes out with `facts.runner` only. That is the existing contract
  for any refusal.
- The startup log states the refusal and the narrower scope.
- It is **not** put into the predictor-problems list, because that list turns any entry into a 503 for **every** release
  (`secrets-release.mjs:277-285`). That would kill guests rather than fail closed.
- **Preserved:** binding to the lease holder (`facts.runner`), the guest's own fencing, and every other release check.
- **Not preserved:** the relay-supplied fact, and with it the guest's independence from its own chain reads for these
  apps.

**Test** (real release path, real anvil ledger, `test/storage-front-binding-release.test.mjs`, new case): even for a
FINAL claim, the verifier relay's release is 200 with `facts == { runner }` and logs `writer_authority_unproven`.

## 3. Test results (actual; the runner fails any skip)

| suite | result | where |
|---|---|---|
| `relay-chain-consumers` (new; adds the bind-time measured-config test and two sponsor codeless refusals) | **10/10** | `logs/rc5-a.out` |
| `relay-chain-authority` | **11/11** | `logs/rc5-a.out` |
| `native-relay-chain-authority` | **8/8** | `logs/rc5-a.out` |
| `storage-front-binding-release` (adds the verifier refusal case) | **5/5** | `logs/rc5-a.out` |
| `storage-front-binding-shield` | **4/4** | `logs/rc5-a.out` |
| `storage-front-binding` | **8/8** | `logs/rc5-a.out` |
| `relay-deploy-closure` | **2/2** | `logs/rc5-a.out` |
| `api-relay` | **20/20** (peak 621 MiB) | `logs/rc5-a.out` |
| `session-api-auth` | **14/14** at 1408 (peak 611) | `logs/rc5-session-api-auth.out` |
| `sessions-attest` | **10/10** at 1408 (peak 469) | `logs/rc5-sessions-attest.out` |
| `relay-smart-wallet-verifier.e2e` (real pinned `helios-eeffcc9`, reth `--dev`, offline `unshare -n`, required artifacts) | **5/5** (peak 800) | `logs/relay-sw-rc5b.summary` |

Notes on these runs:
- **Sessions suites:** after the serial artifact prebuild, they no longer start an unbounded `forge build`, and neither
  hits the guard. Root's earlier 1536 run (stopped at 1541 MiB, exit 99) is superseded, not counted.
- **Sponsor estimate assertion corrected after a real observation.** The first rc5 E2E run failed my over-strict
  assertion "verifier estimate ≥ reth estimate" (observed 25 392 vs 25 450). Both are searches to within about 1.5% of the
  least succeeding limit, so neither is a floor. The corrected test asserts:
  - the chain accepts the verifier's limit;
  - the delegated code executed (> 21 000 gas);
  - the two estimates agree within 2%.
- **Unchanged since round 4 and not rerun:** `relay-network-bundle`, `relay-chain-sources`, `chain-authority`,
  `vaultsvc`, `provisioner-plan`, `network-api`, `secrets`, `custody-relay`, `mcp`, `mcp-sessions`,
  `platform-api-forward`, `platform-api-native-issuer` (`logs/rc4-reg*.out`).
- **Pre-existing at base, unchanged:** `platform-api-hosted` (5 failures) and `lease-gas-fixtures` (1). Both are proven
  on a pristine `git archive 9fa02e1bc` (`logs/base-hosted.full.out`).

**Real pinned-runtime observations (`logs/relay-sw-rc5b.summary`):**
- **Smart wallets:** addressed ERC-1271 equals the chain. viem's **deployless** ERC-6492 validator runs exactly as on
  the chain, so smart-wallet sign-in works on the verifier.
- **Sponsor mechanism**, on the canonical Base EntryPoint v0.8 and Simple7702 code (`test/fixtures/base-code`) placed in a
  derived genesis:
  - the verifier proves the code;
  - the designator override makes the key answer its EntryPoint, identically to reth;
  - **without the override it answers `0x`**, so the vacuity probe refuses;
  - the estimate under the override is accepted by the chain.
- **Not real-runtime-tested:** the full sponsor `submit` with the platform paymaster and registry deployed. Its relay
  logic is scripted-tested only (`relay-chain-consumers`: success, nonce 409, vacuous 503, revert 422, codeless EntryPoint
  or delegate 503).

## 4. Other round-5 changes

- **Bind-time guest validation** (now in this tree's `measured-control.mjs`): `ENCLAVE_CHAIN_TX_BACKEND` is accepted only
  with the verifier and only as a loopback or private literal (the copy equals `checkOwnBackend` over 13 URLs). Provider
  names beside the verifier are refused at bind. The relay-child start check stays as a second line.
- **Sponsor:** it refuses (503, nothing sent) unless the EntryPoint and Simple7702Account have proven code. Otherwise a
  call to a codeless EntryPoint would "succeed" vacuously.

## 5. Remaining limits (exact)

1. **Writer fencing:** refused by the relay under the verifier (§2). The guest's own chain reads carry it, so this is not
   provider-free for fencing apps. **Blocks full relay activation.**
2. **Logs are inclusion-only** for the payment indexer, provisioner orphan adoption and the sessions index.
   - Payment indexer: liveness only.
   - Provisioner: a possible extra unfunded ledger row.
   - Sessions index: display only.
   - Billing: an unmined top-up goes to review after 15 min.
3. **No finality** (sequencer-signed unsafe tier). Submissions go through the own node to the hosted sequencer.
4. **Measured images NOT rebuilt.** `platform-api.bundle.mjs` and the MCP guest bundle embed relay modules and are stale
   vs this source; the MCP guest server keeps its public list. A rebuild means new measurements (root's decision).
5. **`measured-control.mjs` is edited in two trees;** root composes.
6. **The full sponsor `submit` is not run on a real chain** (§3).
7. **Not migrated:** custody v2 frozen image (`MEASURED_RPCS`), Windows, site, lease relay. R1 `NETWORK_CHAIN_RPCS` is
   still ignored beside the verifier. MCP `versionFee6` shows `0n` on a failed read (pre-existing).

## 6. Proposal: full writer-authority parity from finalized AND complete VERIFIED history (not built)

No own-node assertion and no public fallback. Each step is a proof checked by the relay's own verifier stack.

1. **Finality from L1, proven:**
   - Add a FINALIZED tier to the verifier: an L1 light client (or the own L1 pair, reth v2.8.0 + lighthouse v8.3.2,
     verified through beacon sync-committee signatures).
   - It proves, by `eth_getProof` against a finalized L1 state root, Base's anchor state on L1: the AnchorStateRegistry
     / DisputeGameFactory resolved output root.
   - The output root = keccak(version, stateRoot, messagePasserStorageRoot, **blockHash**). It names one L2 block hash as
     finalized.
   - The claim block is then finalized iff its hash is an ancestor of that block, proven by the verified `parentHash`
     chain.
2. **Completeness per block, proven:**
   - For every block in the scanned range, take its header from that same verified ancestry.
   - The header's `logsBloom` is committed. A bloom that excludes (ledger address, Claimed/Renewed/Released topics,
     deployment id) PROVES absence for that block.
   - For each bloom-positive block, `eth_getBlockReceipts` is checked against the header's `receiptsRoot` (already a
     verifier method), which gives every log of that block.
   - The union over a contiguous header range is complete. That is exactly the "contiguous FINALIZED coverage [lo, hi]"
     the existing store keeps.
3. **Integration:**
   - A verifier-mode reader in `relay/lease-generation.mjs` uses (1) and (2) in place of its two-RPC agreement.
   - It keeps the same store, the same lease16 fact and the same deadline/abort semantics.
   - `refusingWriterAuthority` is removed only when that reader passes the existing `storage-front-binding*` suites on
     the verifier.
   - Cost: one verified header per block (Base: 43 200/day) plus receipts for bloom-positive blocks. Coverage is
     incremental and persisted.
   - The same primitives would make the payment indexer and the provisioner's orphan scan complete.
