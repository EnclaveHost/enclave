# Credit-vault submitter (verifier mode) — interface handoff (A → B Linux node runtime; F/root for hosted composition)

A owns this role. B and F compose; A edits nothing in their trees. Source: branch `cv-submitter-verifier` at `fd8d58061196c6d089ca21fb7948c6ba640d5c39` (tree `d8e0ab06…`), patches 0023–0024 on top of the frozen 0001–0022.

## Compose

| File | Note |
|---|---|
| `network/host-services/packages/credit-vault-submitter.mjs` + `.package.json` | Pin manifest `sha256:fa7403b5ef2d2872a40f33b0d42510a9d20dee0d851b665223fb93efaa77ef98` (bundle `4c25cde6…`, reproducible). |
| `network/host-services/credit-vault-submitter.mjs` | The runner's intake (`ROLES['credit-vault-submitter'].validate`). |
| `network/credit-vault-submitter.mjs`, `cli/credit-vault.mjs`, `network/receipt-source.mjs`, `network/tx-evidence/*` | Bundled into the package. Only needed as source when composing other bundles. |

## Role config (inside the operator's host-services config, `services[].config`)

```json
{ "port": 8788, "bind": "127.0.0.1", "stateDir": "/var/lib/enclave/host-services/credit-vault-submitter",
  "signer": "http://127.0.0.1:<operator wallet>", "from": "0x<payer>", "chainId": 8453, "confirmations": 2,
  "chainVerifier": "http://127.0.0.1:<helios>/",
  "rpc": ["http://127.0.0.1:<own Base node>"],
  "receiptSource": { "format": "enclave-receipt-source/v1",
    "l1": { "execution": { "url": "http://127.0.0.1:18645" }, "consensus": { "url": "http://127.0.0.1:15052" }, "minPeers": 1 },
    "base": { "execution": { "url": "http://127.0.0.1:<base-reth>" }, "rollup": { "url": "http://127.0.0.1:<base-consensus rollup RPC>" } } },
  "outcomeTimeoutSec": 180 }
```

- **No public provider list** is needed with `chainVerifier`: `rpc` is only the transaction transport.
- **Legacy configs** (`rpc` with 2–8 providers + `quorum`, no `chainVerifier`) are accepted unchanged.
- **Never** put `testFixture` in a production `receiptSource`. The runner refuses it (no harness switch), and so does the role.
- **The runner** writes the validated object as the role's 0600 `config.json` and passes only `PATH`. No other file or environment is involved.

## Runtime expectations

- **`/health`** returns `authority: { mode, state, transactions, receipts }`. Show it, or log it verbatim.
- **Without a ready source,** sends end `{ txHash, unknown: true }` and are held.
  - The operator resolves them with `enclave --independent … --chain-verifier URL --rpc TX --receipt-source FILE signer resolve|rebroadcast <id>`, using the role's journal at `<stateDir>/signer` and the same receipt-source config as a file.
- **The platform host policy gate** (runner) still governs the role. `platformHostPolicy` must not be `off` in production.

## Gates (not met)

- the validated L1 pair (P);
- the Base holder (S);
- a local Helios verifier with fresh witnesses.

NucBox: no deployment and no restart without the human's answer.
