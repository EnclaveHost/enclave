# Receipt-source handoff (A → B runtime, F Windows/hosted composition; root dispatches)

A composes worker E's FINAL source-binding adapters into the independent consumers. B and F own their trees: this file is the interface; A edits nothing there.

## Files to compose (branch `rpc-priority-receipts` at `eab4cfac47a00dcbc0161918a2624eed6761bbfb`, tree `e0e07f21`; patches 0019-0022)

| Path | What it is |
|---|---|
| `network/tx-evidence/{evidence-brand,l1-source-binding,base-source-binding,forced-inclusion}.mjs` | E's adapters at `c08331e9`, **byte-identical** (`network/tx-evidence/PROVENANCE.json`: sha256 + git blob). Never edit; re-vendor from E. |
| `network/receipt-source.mjs` | Builds both adapters from ONE config file, fixes the accepted trust, accepts evidence only through E's `acceptEvidence`, and binds a minted receipt to the intended transaction (hash = keccak256 of the signed bytes; sender recovered; nonce from the bytes). Not a verifier. |
| `cli/independent.mjs` | `VerifiedChain` `receiptSource` option, `sourceReceipt`, `settleFromSource`, `verifyOutcome`/`sendQuorumTx` source path, `receiptLine`, `shownEvidence`. |
| `cli/independent-signer.mjs` | `resolveWithSource` (resolve, attach, wallet-send, rebroadcast); journals keep facts only. |
| `cli/credit-vault.mjs` | `--receipt-source`: reconcile's executing transaction verified; `mint`/`submit`/`relay` sends verified. |
| `cli/enclave.mjs` | `--receipt-source FILE`, `receipt-source status`. |

## Config (`enclave-receipt-source/v1`)

```json
{ "format": "enclave-receipt-source/v1",
  "l1":   { "execution": { "url": "http://127.0.0.1:18645" }, "consensus": { "url": "http://127.0.0.1:15052" }, "minPeers": 1 },
  "base": { "execution": { "url": "http://127.0.0.1:<base-reth port>" }, "rollup": { "url": "http://127.0.0.1:<base-consensus rollup RPC port>" } } }
```

- **URLs:** loopback only (E's adapters refuse anything else).
- **L1:** P's validated reth v2.8.0 + Lighthouse v8.3.2 pair.
- **Base:** S's holder (base-reth + base-consensus deriving from that same L1 pair).
- **Trust:** `local-validated-pair` = local full-node validation, NOT a portable cryptographic proof.
- **`testFixture`:** identities mint `test-fixture` trust. They are accepted only when `ENCLAVE_TEST_RECEIPT_FIXTURE=1` is set by a test harness. **Never set this in a host role or installer.**

## To B (runtime composition)

- **Construction:** `createReceiptSource(loadReceiptSourceConfig(file))` once per process, then `independentChain({ chainVerifier, rpcs, …, receiptSource })`.
  - A receipt source requires the local state verifier (`--chain-verifier`); `independentChain` refuses it otherwise.
  - The source makes no hidden retry. `sendQuorumTx`/`verifyOutcome` poll it until their own deadline; a not-ready source ends as UNKNOWN (with E's failed readiness checks), never as success.
- **Display:**
  - Print `receiptLine(r)` / `evidence.receipt` verbatim (trust and level as minted).
  - Print `readiness()` checks verbatim (`enclave … receipt-source status`).
  - Persist `shownEvidence(ev)`, never the minted object.
- **Helios:** E's adapters do not accept Helios receipts. Helios stays the STATE verifier (read-your-writes and nonce); inclusion and status come from the Base node source only.

## To F (Windows final baseline / hosted roles)

- The credit-vault submitter role (`network/credit-vault-submitter.mjs` → `cli/credit-vault.mjs createRelay`) takes its chain from the role config.
  - To verify outcomes there, the role needs a `receiptSource` built from a config file naming the host's local L1 pair and Base node.
  - Without it, the relay keeps today's behaviour (labelled transport receipts).
- **Rebuild needed:** `network/host-services/packages/credit-vault-submitter.mjs` embeds `cli/independent.mjs`. It needs a rebuild once composed (A did not rebuild C/F packages).
- **Windows:** no `windows/` file changed. The Windows node does not send these transactions.

## Hardware prerequisites (not met here)

- A synchronized, validated Ethereum L1 pair (P): reth + Lighthouse, peers ≥ 1, finalized fresh.
- A synchronized Base holder (S) deriving from that L1 pair, with its rollup RPC exposed on loopback.
- Neither exists in production today. Until then, `--receipt-source` cannot become ready, so sends stay UNKNOWN rather than confirmed. Leaving it unset keeps the explicit-transport labels.
