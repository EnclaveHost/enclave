# rpc-priority: consumer parity (contract-wallet owner signatures; independent CLI/MCP reads)

Written 2026-10-23T08:45Z (UTC clock). Worker: rpc-priority. Tree: `rpc-priority/repo`, branch `rpc-priority`.

Scope: source and tests only. No live systems, SSH, wallets, pushes, Wine, toolchains, downloads, production, or other workers' trees. Every test ran through `work/claude-test-queue.py` at 512 or 1408 MiB. No NVMe cache was allocated.

**This is not RPC independence.** The following remain explicit gaps (§5):
* transaction inclusion (E);
* L1, holder and fresh witness supply (P);
* the runtime (B);
* browser verification (S);
* hosted-service role wiring (F);
* custody v2 reads;
* the credit-vault CLI.

## 1. Commits and patches

On `df8fbafae` (the reviewed Windows round). SteveDeFacto author and committer; nothing is pushed.

| Commit | Content | Patch (sha256) |
|---|---|---|
| `c3a61fd1ac3ecfdc0249a50c10fa964d73ef8ae6` | contract-wallet owner signatures under the verifier (§2) | `0015` (`e0c585c8…22c4763`) |
| `e32dd607b55b9c6afd605482a4bc31c9d30528d6` | the local verifier as the state authority of independent CLI/MCP reads (§3) | `0016` (`45a757f0…b6bb3f`) |

* The patches are standalone; `0001-0014` and their sums are untouched, and the new sums are appended to `patches/SHA256SUMS`.
* `git am` of `0001-0016` onto a clean `dfe020abf` reproduces HEAD's tree `079caef6560a130194c1c37795c97aa33a2d988b`.
* No `windows/` file changed this round, so the `windows-on-0757085e` composition aid is still current.

## 2. Contract-wallet (SessionVault / ERC-1271) owner signatures in the Windows network agent

**Problem:** under `ENCLAVE_CHAIN_AUTHORITY=verifier` the agent config has no RPC list. `createNetworkHost` therefore had no provider clients, and without pins it never used its reader. Any owner whose signature needs chain state (a SessionVault, or an ERC-1271 wallet) was refused, so their network policy fell back to the default (a feature regression).

**Fix (`network/enclave-network-host.mjs`):** a verifier-authority LeaseReader is also used for owner verification. The pinned path is unchanged. Each verification:
* runs at one proof-backed block;
* reads the SessionVault factory from the admin's address book at that block, so admin book migration is followed;
* treats any refusal (a stale head, a missing or bad proof) as "not the owner", failing closed.

EOA signatures still need no chain read. The legacy provider path and the pinned path are unchanged.

**Why not carry `authorityPins` into the agent config** (the means first suggested): a pinned LeaseReader reads deployments, registry and connectivity at fixed addresses. That would (a) stop the agent following admin book migration, against the requirement, and (b) freeze connectivity at zero for paid networks, because contract pins carry no connectivity pin. The authenticated reader meets the three conditions without either side effect. Required C/F host-services changes are unaffected: the change is one verification line in a shared module.

**Tests:**
* `test/network-owner-verifier.test.mjs` 1/1. The host consumer with a verifier-authority reader:
  * the vault owner's policy is admitted, with the factory read from the book in every snapshot;
  * book repointed → refused; refusing reader → refused;
  * EOA owner → no snapshot;
  * legacy reader → contract owners refused exactly as before.
* `test/windows-verifier.e2e.test.mjs` case 6, canonical reth + Helios, test-signed head:
  * the enrollment `baseConfig` with the verifier chain section feeds `new LeaseReader({...cfg.chain})`, then `createNetworkHost(...)` exactly as `network/privacy-agent.mjs` builds them, then `policyFor`;
  * a real SessionVault owner (opened through the pinned factory) has its policy admitted;
  * the admin repoints the book's `sessionVaultFactory` → refused; an outsider cannot repoint it back; the admin restores it → admitted;
  * tampered and missing witnesses → refused, while an EOA owner is still admitted;
  * BASE_RPCS gets 0 requests.

  The whole file passed 6/6 (job `parity-r1`).

## 3. Independent CLI/MCP reads: the 43 `QuorumChain`/`sendQuorumTx` references

### Mechanism

`cli/independent.mjs` gains `VerifiedChain` and one factory, `independentChain`, used at every chain construction. `VerifiedChain` implements the `QuorumChain` interface over `network/verified-chain.mjs` `createVerifiedSnapshot`, root's terminal-snapshot version: one confirmed, fresh, monotonic block per snapshot, the header re-checked, one whole-operation deadline, and a closed client afterwards. There is no second verifier and no second quorum design.

Selecting it:
* CLI: `--chain-verifier`.
* MCP: the profile's `chainVerifier`.
* Hosted connector: `registry.chainAuthority: "verifier"` + `registry.chainVerifier`.
* Host-lifecycle plan: `authorities.chainVerifier`, used for that CLI's own checks. The plan's `rpcs` still configure the host it generates (F/D area).

Under the verifier:

| Capability | Source |
|---|---|
| `snapshot`/`read`/`readMany`/`balance`, `quorumPublicClient` (the SDK-facing view: sessions `prepareCall`/`prepareSessionOpen`/…) | the verifier. A verifier `eth_call` revert (code 3 / "execution reverted") is a fact (an agreed revert); anything else is an outage |
| `sendQuorumTx` / signer `preflight` precondition simulation | the verifier, via an **opt-in** proof-backed `call` on the pinned client. The default pinned client still refuses `call`, as root's test requires |
| pending nonce, gas, fees, broadcast, receipts (`each`, `peers`, `receiptSnapshot`, `historySnapshot`: signer `lookHash`/`findByNonce`) | **only** the explicit `--rpc` transport. All configured endpoints must agree, and it is untrusted for state. Without one, each refuses by name. After a transport receipt, the **verifier must reach that block** before the send returns (read-your-writes); otherwise the outcome is unknown, never "done" |
| `getLogs`/`eth_getLogs` inside a snapshot (CLI login discovery, MCP session scans) | discovery hints from the explicit transport only, clamped to the verified block. Every candidate is verified by state reads (`sessionSnapshot`/`describeSession`). Without a transport they refuse |
| the `--rpc` list | optional, and **never** the public default list. The CLI fix: `RPCS` used to default to the public set when `--rpc` was absent |
| custody v2 reads (`leaseReaderClients`: `cli/custody-independent.mjs`, `mcp/independent-secrets.mjs`) | **refuses** under the verifier rather than quietly using the transaction transport as a state source |
| MCP `Scope` | one verified block per tool call. Later reads resume that exact block through a floor-free snapshot (the hash must still be canonical and fresh), so concurrent calls don't refuse each other. `summary()` reports `local-verifier`/`unsafe` |

Admin controls, session revocation and coherent authorization are the existing code. Only the snapshot source changes: every read inside one snapshot is at one verified block.

### Inventory: the 43 references at `df8fbafae`, by file

| File | Refs | What they are | Status under the verifier |
|---|---|---|---|
| `cli/independent.mjs` | 4 | the class, `sendQuorumTx`, `quorumWriter`, the external-signer hook | `VerifiedChain` + `independentChain` + `historySnapshot`; sends simulate at the verified block, transact via the explicit transport |
| `cli/enclave.mjs` | 10 | 1 construction (`INDEPENDENT.chain`), 7 `sendQuorumTx` writes (deploy, fund, gas, session ops, owner ops), 2 comments | the construction uses the factory; the writes follow the send rules above |
| `cli/host-independent-lifecycle.mjs` | 3 | import + 2 constructions (plan check, referral) | factory; optional `authorities.chainVerifier` |
| `cli/independent-signer.mjs` | 8 | external signer: preflight, broadcast, receipt and nonce look-ups | preflight simulation verified; `each`/`peers`/`historySnapshot` → transport |
| `cli/independent-login.mjs` | 1 | doc (it takes `INDEPENDENT.chain`) | state via the verifier; log discovery = transport hints |
| `cli/independent-capacity.mjs` | 1 | doc (it takes the chain) | follows the chain given |
| `cli/lease-gas.mjs` | 2 | comment + `sendQuorumTx` | send rules |
| `cli/custody-independent.mjs` | 1 | comment | **gap**: custody v2's own reader refuses under the verifier |
| `cli/credit-vault.mjs` | 7 | its own `chainFor` QuorumChain + 3 `sendQuorumTx` + 3 comments; reads via custody/v2 `createQuorumReader` | **gap, unchanged**: credit-vault payment flow (its own reader and transaction design) |
| `mcp/independent.mjs` | 4 | comment, import, `Authority` construction, `Scope.pickBlock` | factory; `Scope` verifier branch |
| `mcp/hosted-connector.mjs` | 2 | import + registry construction | factory; `registry.chainVerifier` |

## 4. Tests

All runs were offline, inside `unshare -r -n`.

**New:**
* `test/independent-verified-chain.test.mjs` **5/5**. Real loopback HTTP stand-ins for the verifier and for the transport, counting methods:
  * state reads, revert facts, `readMany` with an optional revert, balance, block pinning by hash, the SDK view;
  * transaction/history refusal without a transport, use of only the transport with one, log hints clamped, `sendQuorumTx` revert and no-transport refusals;
  * the custody extraction refusal;
  * a stale verifier with no fallback;
  * the MCP `Scope` single block under concurrency, and reorg refusal;
  * trust and factory semantics.
* `test/network-owner-verifier.test.mjs` **1/1**.
* `test/cli-mcp-verifier.e2e.test.mjs` **4/4** (job `parity-r2`, canonical reth + Helios, peak 745 MiB). The CLI runs as a process behind the network guard, and the rig's three logged RPC fronts stand for providers:
  1. `ls`, `hosts --all` and `status` read through the verifier with **no `--rpc`**: 0 front requests, no Enclave or non-loopback connections.
  2. Writes:
     * `stop` with no transport refuses by name after the verified simulation, and the ledger is unchanged;
     * a non-owner's `setActive` is reverted by the real ledger in the verified simulation before any transport use (0 front requests);
     * with **one explicit `--rpc` front**, `stop` lands and `resume` restores. Only that front was used: `eth_sendRawTransaction` present, **no `eth_call`**.
  3. MCP `Authority` with a `chainVerifier` profile and empty `rpcs`:
     * `bindings()` (pinned factory → book → ledger/catalog) and `read(count)` equal the chain at the scope's block;
     * **session revocation**: a real session reads live, and after the owner's `terminate` a new call reads it ended;
     * 0 front requests.
  4. Tampered and missing witnesses → CLI refuses with 0 transport requests. A stale head → refused ("out of sync").
* `test/windows-verifier.e2e.test.mjs` 6/6 (§2).

**Changed:** `caller-verifier-wiring` 5/5 (the RPC list is now optional under the verifier).

**Regression** (job `parity-r1`, same source except the two test files fixed in r2). These pass:

| Suite | Result |
|---|---|
| verified-chain | 9/9 |
| verified-chain-lifecycle | 3/3 |
| network-authority-pins | 4/4 |
| cli-capacity | 3/3 |
| cli-host-independent-lifecycle | 10/10 |
| cli-independent-login | 8/8 |
| cli-independent-signer | 13/13 |
| cli-independent-signer-cli | 3/3 |
| cli-independent-sessions | 13/13 |
| cli-independent-move | 6/6 |
| cli-signed-liveness | 1/1 |
| custody-cli-independent | 11/12, rc 0 |
| custody-secrets-cli-independent | 4/4 |
| mcp-independent-unit | 10/10 |
| mcp-independent | 13/13 |
| enclave-network-host-canary | 5/5 |
| local-byo-config | 3/3 |
| network-policy-outage | 1/1 |
| provider-bootstrap | 5/5 |
| host-egress | 9/9 |
| sessions (SDK) | 14/14 |
| mcp-guest-bundle | 2/2 |

**Baseline failures,** recorded separately. Each fails identically on `df8fbafae` (`parity-base`):

| Suite | Result | Cause |
|---|---|---|
| cli-existing-contract-sessions | 4/7 | |
| cli-independent | 13/14 | schema-4 bytecode hash from the local compiler |
| credit-vault-relay-concurrency | | external-signer "unknown outcome held" subtest |
| host-liveness | 7/8 | no relay runtime bundle in-tree |
| mcp-hosted-control | 6/7 | gsup source-text check |
| independent-name-routing | 0/1 | |
| privacy-agent-lifecycle | 0/3 | missing `@libp2p/crypto` package |

## 5. Remaining method gaps and integration

**Under the verifier, without an explicit transport these refuse by name:**
* pending nonce, gas and fee estimates, broadcast;
* receipts, transactions, nonce counts at a block (signer journal recovery, `findByNonce`, which needs an archive-capable transport for old ranges);
* log scans (MCP session listing, CLI login discovery).

With a transport they run but are **not state authority**. A withholding transport can hide log candidates (visibility, not authorization), and receipts are trusted only once the verifier reaches their block. Proof-backed receipt and inclusion verification is E's (transaction inclusion) and P's (L1/holder). An existing self-hosted full RPC is a valid explicit transport.

**Other gaps:**
* **External signer:** its own receipt-wait flows (`independent-signer.mjs` journal/handoff paths) have no read-your-writes `awaitBlock` step; `sendQuorumTx` does.
* **Custody v2 reads** (CLI custody, MCP secrets): refuse under the verifier, and work unchanged without it.
* **`cli/credit-vault.mjs`:** unchanged; its own custody/v2 reader and transaction design.
* **Non-independent CLI mode** (relay/public defaults): legacy, out of scope.
* **Unchanged from earlier rounds:**
  * Windows: no installer flag; lease-gas sends; history methods without a transport;
  * no native Windows Helios;
  * native control `quorumRegistry`;
  * api-relay `BASE_RPC` reads;
  * lease executor and owner nomination;
  * browser (S);
  * fresh witness supply and L1.

**Release copies to rebuild** (none rebuilt here):

| Copy | Embeds |
|---|---|
| the `enclave` CLI bundle (`cli/build.mjs`) | `cli/*` |
| `metal/guest/mcp-server.bundle.mjs` | `cli/independent.mjs` |
| `network/host-services/packages/credit-vault-submitter.mjs` | `sendQuorumTx` (default behaviour unchanged) |
| privacy-agent copies | `network/enclave-network-host.mjs`: the Windows network-agent stage via the deploy closure, and the Linux privacy agent; C/F's host-services composition must carry this one-line change |

**Activation:** add `--chain-verifier http://127.0.0.1:PORT/` (CLI), or `chainVerifier` (MCP profile, hosted-connector registry, host plan). Optionally add an explicit self-hosted `--rpc` as the transaction transport. **Rollback:** remove the setting; the RPC quorum path is unchanged.
