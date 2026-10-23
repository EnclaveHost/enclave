# rpc-priority: receipt-source integration (E's adapters in CLI, signer and credit vault) + the two baseline regressions

Written 2026-10-23T14:54Z (UTC clock). Worker: rpc-priority (A).

**Where this work lives:** branch `rpc-priority-receipts`, in the isolated worktree `rpc-priority/repo-receipts`.
- It is cut from the accepted, immutable `554a251cb`. `rpc-priority`, its commits, `RESULT-CONSUMER-GAPS.md` and patches `0001-0018` are untouched, so D can keep exporting them.

**Scope:** source, tests and one rebuilt in-tree artifact.
- **Not done:** no SSH, production, hosts or VMs, wallets or mainnet signatures, funding, contract changes, sync, cache allocation, Wine, toolchains or downloads.
- **Not edited:** B/C/D/E/F/P/S/T trees.
- **Test runs:** everything ran through `work/claude-test-queue.py` at 512, 768 or 1408 MiB, one job at a time.

**This is not RPC independence, and not production readiness:**
- Every receipt in these tests is minted from a LABELLED fixture pair, with trust `test-fixture`. No real L1 pair and no Base holder exists or was used.
- `local-validated-pair` trust (local full-node validation, not a portable proof) appears only in a production config, and that config is shown refusing the fixture.

## 1. Commits, tree, patches

SteveDeFacto is author and committer on every commit. Nothing is pushed.

| Commit | Content | Patch (sha256) |
|---|---|---|
| `1d829457f00ea63bf6543c136ce58ca285ada831` | receipt source in the consumers (§2–§4), unit + E2E tests | `0019` (`2112c28f30720fc6757bf0022793ce4f90b6c6948e8011c4f2fe19e76d250296`) |
| `cdcbdf5924164acea67046ea32f0705d08687887` | the two baseline regressions (§6) | `0020` (`13c19ba57b33831e725115b7fec8b7c462eb43a7c3514c4a875e9365c04532e8`) |
| `23fa880a78360f67d9462b732d2b8fb3dcf0dd70` | rebuilt hosted MCP guest bundle (§8) | `0021` (`8aa0b7f28dd9b3b926617f90e78c96b52d8670139d8fe5939af3820081d99eb1`) |
| `eab4cfac47a00dcbc0161918a2624eed6761bbfb` | keep the stray-flag message's established wording (fix for an r1 regression, §7) | `0022` (`29aad6a5d31ec0bd29cd4c872aebdf8693ee8e10fda9b0d69a6fc7a8eb4d6492`) |

- **Final:** `eab4cfac47a00dcbc0161918a2624eed6761bbfb`, tree `e0e07f21e086c79089d0f953b1f7f031be2b54f2`.
- `git am` of `0001-0022` onto a clean `dfe020abf` reproduces that tree: verified (`e0e07f21…`).
- `0001-0018` and their sums are untouched; the new sums are appended to `patches/SHA256SUMS`.

## 2. What is composed, and what is NOT invented

- **Vendored:** `network/tx-evidence/` holds E's FINAL `evidence-brand.mjs`, `l1-source-binding.mjs`, `base-source-binding.mjs` and `forced-inclusion.mjs` (for `refuse`/`acceptEvidence`) from `c08331e9`, **byte-identical**.
  - Their sha256 and git blob are in `network/tx-evidence/PROVENANCE.json`, and a test recomputes them.
  - E's labelled `pair-stubs.mjs` is vendored the same way, under `test/fixtures/tx-evidence/`.
- **`network/receipt-source.mjs`** is glue, not a verifier:
  - it builds both adapters from one config file;
  - it fixes the accepted trust;
  - it accepts evidence only through E's `acceptEvidence` (minted, right kind, accepted trust);
  - it adds the one thing a receipt does not carry: **which transaction it is** (below).
- **Minted evidence is used by reference.** It is never spread, cloned or annotated. Display and journals get `shownEvidence(ev)`: text and numbers, never the minted object.
- **Helios stays the STATE verifier** (read-your-writes, the verified nonce). E's adapters do not accept a Helios receipt, and none is labelled as one.
- **Not claimed:**
  - that the same-process brand is cryptographic authority (E's own limit: any code in the process can mint);
  - that local full-node validation is a portable proof.

### Identity binding (before any "confirmed" / "reverted" / "mismatch")

1. **Hash = transaction.** The receipt's hash must be keccak256 of the signed bytes. These are either the bytes this client holds, or the transport's transaction object re-encoded with its own signature. A transport can supply bytes but cannot forge a signature that hashes to the receipt's hash. It can never supply inclusion or status.
2. **Sender.** The sender is recovered from that signature. It must equal the minted receipt's `from` and the intended sender.
3. **Nonce.** The nonce comes from those signed bytes and must equal the intent's nonce.
4. **Inclusion, status and level** come only from the minted receipt (`verifiedBy 'base-derivation'`, `trust`, `level` unsafe/safe/finalized), shown verbatim.
5. **Read-your-writes.** The state verifier must then reach the inclusion block and show the nonce consumed. If the two local authorities disagree, nothing is decided.
6. **Not proof alone:** a consumed nonce or a post-state.

## 3. Outcome semantics with a receipt source

| Situation | Result |
|---|---|
| minted receipt, bound, status success | `confirmed` (signer journal), `receiptVerified: true` |
| minted receipt, bound, status reverted | `reverted` with no transport caveat |
| minted receipt for this hash, but changed fields (wallet-send/handoff) | `mismatch` (mined) |
| hash of another sender, or another nonce (attach) | `unknown`: "not provably this intent's transaction" |
| not included yet | open, if the verified nonce is unused |
| a candidate from the transport's nonce search, minted and bound | `replaced` (verified) |
| source not ready / deriving from another L1 / altered receipts / foreign trust | UNKNOWN (final for this send), with E's checks or refusal code; never confirmed |
| no `--receipt-source` | unchanged: the explicit-transport labels (`nonce-consumed`, "UNVERIFIED") |

## 4. Real configuration and run paths

- **Config file `enclave-receipt-source/v1`** (loopback only):
  - `l1.execution`/`l1.consensus`: P's reth v2.8.0 + Lighthouse v8.3.2;
  - `base.execution`/`base.rollup`: S's base-reth + base-consensus;
  - optional `minPeers` and lag limits.
  - `testFixture` identities are refused unless `ENCLAVE_TEST_RECEIPT_FIXTURE=1`, which a test harness sets. Answers from them are labelled TEST FIXTURE.
- **`enclave --independent … --chain-verifier URL [--rpc TX] --receipt-source FILE <command>`**
  - Every independent send (ledger writes, custody, lease gas, the signer) goes through `sendQuorumTx`/`verifyOutcome` with the source.
  - The startup banner names the source and its trust.
  - `enclave … receipt-source status` prints both adapters' readiness checks verbatim.
  - The source requires `--chain-verifier`.
- **`enclave credit-vault … --chain-verifier URL --receipt-source FILE [--rpc TX]`**
  - mint, submit and relay sends are verified the same way.
  - reconcile's executing transaction is bound, and its inclusion and status are minted.
  - The outcome says `TEST FIXTURE - success in block N: receipt minted by the local Base node source (verifiedBy 'base-derivation', trust '…', level '…'); …; its signed bytes call this vault with exactly the signed request`.
- **MCP:** no MCP tool waits on, or reports, a transaction outcome. The independent MCP returns UNSIGNED transactions that the owner's wallet sends. So there is no outcome path to verify, and no profile key was added; adding one would only look like coverage.
  - The hosted credit-vault submitter role (C/F) is the server-side path that sends. See `HANDOFF-RECEIPT-SOURCE.md`.

## 5. Tests (final runs; the logs sit beside each job file in `jobs/`)

### Unit: `test/receipt-source.test.mjs` — 6/6 (`rcpt-b1`; again 6/6 in `rcpt-r1`)

Setup: anvil L1 (static, chain 1) and anvil L2 (chain 8453), with E's labelled beacon and rollup fixtures. Covered:
- byte-identical vendoring;
- config gating;
- **a production config refuses the fixture** (`el.genesis`, `el.peers`, `cl.genesis`, `l2.genesis`) and mints nothing;
- binding a real transaction (status and level verbatim; finalized only from the node's heads);
- copied, JSON-parsed and production-trust evidence refused;
- sender, nonce and hash mismatches;
- a transport transaction with altered value/to/nonce/input refused;
- a Base node deriving from another L1 not ready;
- an execution node answering another transaction refused.

### E2E: `test/receipt-source.e2e.test.mjs` — **5/5** (`rcpt-e2`, peak 749 MiB)

Setup: the rig's reth `--dev` as the Base EXECUTION node (it executes every block), patched Helios as the state verifier, an anvil L1 (static), and E's labelled beacon/rollup fixtures. Every receipt has trust `test-fixture`.

1. **CLI real config path:**
   - `receipt-source status` shows readiness verbatim;
   - `stop` is reported from the minted receipt;
   - the fixture config is refused without the harness switch, and nothing is sent;
   - a production config is not ready, naming `el.genesis`/`el.peers`/`cl.genesis`/`l2.genesis`;
   - the source is refused without `--chain-verifier`.
2. **External signer:**
   - success → `confirmed`, with the minted evidence by reference; the journal file holds facts only;
   - **a REAL on-chain revert**: after the verified simulation, an allowance holder drains the balance before the wallet answers. The intent's exact bytes are mined and revert, giving `reverted` from the minted receipt with no caveat, the nonce consumed, and the chain agreeing.
3. **Unknown outcomes and untrusted sources:**
   - a swallowed send → unknown → still open → **rebroadcast of the same bytes** → `confirmed`;
   - a rollup node deriving from another L1, a Base node altering receipts (`receipt-sender`), and a not-ready source (`l2.syncStatus`) each → unknown, never confirmed;
   - the good source then decides each case.
4. **Identity:**
   - wallet-send with changed value → `mismatch` (mined) from the minted receipt;
   - attach with another sender's hash (`receipt-sender`) or the same sender's other nonce (`receipt-nonce`) → unknown.
5. **Credit-vault CLI with `--receipt-source`:**
   - mint is verified, with its effect checked;
   - submit's outcome names the minted, bound executing transaction;
   - exact funds (30/70);
   - reconcile is none.

**Earlier run kept on record:** `rcpt-e1` was 4/5. Test 2 failed on MY assertion: the journal legitimately stores the description text containing the word "verifiedBy". It now checks that no minted object, `receiptEvidence` or `l2-receipt` object is persisted. The rest of that test first ran in `rcpt-e2`.

### No-source regressions on the new branch

- `consumer-closure.e2e` 5/5 (`rcpt-e1`): the UNVERIFIED labels still hold without a source.
- `cli-mcp-verifier.e2e` 4/4 (`rcpt-e2`).

### Focused regressions (`rcpt-r1`, aggregated exit)

| Suite | Result |
|---|---|
| receipt-source | 6/0 |
| consumer-closure | 5/0 |
| **cli-independent** | **14/0** |
| **lease-gas-fixtures** | **3/0** |
| **credit-vault-relay-concurrency** | **11/0** |
| cli-independent-signer | 13/0 |
| cli-independent-signer-cli | 3/0 |
| credit-vault-independent | 10/0 |
| credit-vault-core | 9/0 |
| credit-vault-reserve | 7/0 |
| custody-cli-independent | 11/0 (+1 skip, pre-existing) |
| custody-secrets-cli-independent | 4/0 |
| lease-gas-owner-cli | 12/0 |
| lease-gas-runtime | 7/0 |
| independent-verified-chain | 5/0 |
| mcp-independent-unit | 10/0 |
| mcp-guest-bundle | 2/0 |
| caller-verifier-wiring | **4/1** |

- The `caller-verifier-wiring` failure is a regression this branch caused: my stray-flag message reworded a phrase the test matches.
- Fixed in `eab4cfac4` (wording restored). `rcpt-r2`: `caller-verifier-wiring` 5/0, guest bundle `--check` verified, CLI candidate rebuilt, exit 0.
- **Not run:** the slow anvil suite `mcp-independent` (it does not touch the changed paths beyond `cli/independent.mjs`, whose verifier paths the E2Es cover).

## 6. The two baseline regressions (root's diagnosis followed, not timing assumed)

### credit-vault-relay-concurrency

Root narrowed this to one leaf plus its parents. That leaf is the receipt read after the operator's rebroadcast.

- **Measurement:** an instrumented, uncommitted copy (`jobs/rcpt-b1-logs/relay-diag2.log`) captured the state at both receipt reads:
  - the hash returned equals the signed bytes' hash;
  - the receipt is absent at the first read, **and the transaction is already out of `txpool_content`**;
  - the receipt appears **22 ms** later, in one block, status success.
- **Cause:** anvil answers a submission before its automined block is sealed.
- An earlier run (`rcpt-d1`) hit the same gap in the owner's own wallet send (`deploymentOf`) under queue load.
- **Ruled out:** no submission was lost, and there was no nonce, journal or exactly-once defect.
- **Fix:** wait for the mined receipt at those two reads (`waitForTransactionReceipt`). Every exactly-once assertion is unchanged: one signature, one broadcast per RPC, payer nonce, balances, the same hash, and the journal's `confirmed` after resolution.
- **Result:** 11/11 (`rcpt-r1`); the instrumented run was also 11/11.

### cli-independent line 71 (registry schema-4 source digest)

- **The published fixture is the rewritten copy.** It is the published (history-rewritten) copy of the manifest's pinned original (`b17db9a3`, blob `d7fb9740`, sha256 `e81f5d51`).
- **Offline proof** (`jobs/rcpt-b1-logs/registry-prov.log`; script and original in `test-scratch/registry-prov/`, not published). With the original blob read from the local pre-rewrite history (`work/enclave`):
  - applying the rewrite's exact byte replacement yields the published file byte for byte (sha256 `771a22d3`);
  - the three changed lines are all **comments** (8 and 64 are `//` comments; 294 is inside `/* */`);
  - with the manifest's compiler (0.8.35) and settings:
    - the **original compiles to the live runtime exactly**, `0x39911d6f…` including metadata;
    - the published file's **5,839 executable bytes are identical**, and only its CBOR metadata hash differs;
    - the published code + the original metadata tail equals the live codeHash;
    - the metadata settings are equal.
- **Published change** (no removed text restored; the manifest is NOT edited):
  - `test/fixtures/registry-schema4/PROVENANCE.json` ties the published copy (sha256/blob) to the pinned original and states what changed.
  - The test recomputes what the published repository can prove:
    - the fixture's digests;
    - that its recorded original equals the manifest pin;
    - **the published file's executable + the deployed CBOR metadata rebuilt from the manifest's `metadataIpfs` = runtime keccak `39911d6f`**;
    - that its own metadata differs (so the rewritten text is never claimed as the deployed source).
  - `lease-gas-fixtures` (same root cause) accepts the fixture only through that provenance.
  - The production registry pin and its admin rights are untouched.
- **Result:** `cli-independent` 14/14, `lease-gas-fixtures` 3/3.

## 7. Job status now equals the logs

- **Old jobs:** `gaps-r1/r3/r4` ended in a `[ $rc -ne 0 ] && …` line, so a fully passing job exited 1. `gaps-r2` exited 0 despite failing suites. Those job files stay as records.
- **This round's jobs:**
  - `rcpt-b1`, `rcpt-e1/e2`, `rcpt-r1/r2` print one `RC[...]`/`rc=` line per suite;
  - `rcpt-r1` also prints `FAILED=`;
  - they exit nonzero exactly when a suite failed: `rcpt-e1` exit 1 with one failing suite, `rcpt-r1` exit 1 with `FAILED= caller-verifier-wiring`, `rcpt-e2` exit 0.
- **The baseline failures** were never accepted as release completion. Both are fixed above, with evidence.

## 8. Artifacts (no install, no image, no deployment)

- **`metal/guest/mcp-server.bundle.mjs`** (in-tree, `23fa880a7`):
  - sha256 `17cfb64f1388607ff0043f7dab8b024802efbca915e1e211b2e7d15dc93225fe`, 5064161 bytes; manifest `1e55bf34c8a5df3606e5584be8c4e2919230c7fb4b509ec2974f645c6b78cb95`.
  - The scratch-vs-tracked manifest diff shows:
    - source: `cli/independent.mjs` changed; `network/receipt-source.mjs` and `network/tx-evidence/*` added;
    - dependencies: **53 added, 0 changed, 0 removed**, all `node_modules/viem/_esm/op-stack/*` of the same viem (imported by E's `forced-inclusion.mjs`).
  - `--check` verifies; the bundle test passes 2/2.
- **CLI candidate** `artifacts/rcpt-enclave-cli.mjs` (untracked; `cli/dist` is not versioned): sha256 `137c93ca2129b8c903348263505f1cfab67fd0b3bb520c3a38ff8cd32e6e3c8f` (rebuilt after `eab4cfac4`). Its help names `--receipt-source`.
- **Not rebuilt (owned by C/F):** `network/host-services/packages/credit-vault-submitter.mjs`, which embeds `cli/independent.mjs`.

## 9. Supported deployment configuration, prerequisites, rollback

- **Supported (once the hardware exists):**
  - `--chain-verifier http://127.0.0.1:<helios>/` + `--receipt-source /etc/enclave/receipt-source.json` naming:
    - the local reth + Lighthouse pair, `minPeers ≥ 1`;
    - the local base-reth + base-consensus rollup RPC, deriving from that same L1;
  - optionally `--rpc <self-hosted transport>`.
  - Trust shown: `local-validated-pair` (local full-node validation).
- **Hardware prerequisites (not met):**
  - a synchronized, validated Ethereum L1 pair (P: rpc-l1-source-package; D1 HDD / D2 RAM still open);
  - a synchronized Base holder (S) exposing its rollup RPC on loopback.
  - Until both are ready, a configured source answers not-ready, and sends end UNKNOWN (resolvable later) rather than confirmed. NucBox is untouched; the restart approval there is still unanswered.
- **Handoff:** `HANDOFF-RECEIPT-SOURCE.md` (to B and F; no edits there).
- **Rollback:**
  - remove `--receipt-source`: every path returns to its explicit-transport labels;
  - or use branch `rpc-priority` (`554a251cb`), which is unchanged.
