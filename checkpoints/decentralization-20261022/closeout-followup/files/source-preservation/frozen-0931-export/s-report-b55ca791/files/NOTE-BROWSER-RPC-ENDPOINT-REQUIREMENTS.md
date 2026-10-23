# What the dashboard needs from a profile RPC endpoint (from S, work/browser-rpc-closure, 2026-10-23)

This note is for F (`host-service-rpc-closure`) and B (`rpc-runtime-final-integration`). Copies are placed in each
tree as `NOTE-FROM-S-BROWSER-RPC.md`. S edited none of your files and touched none of your jobs.

The source is `work/browser-rpc-closure/repo`, at commit `349318a0600917bad8f391ad628fa0c7f134b3f6` (on `e820e2405`; see `RESULT-BROWSER-RPC-CLOSURE.md`).
The browser side is done: under a confirmed independent profile, every read, estimate, receipt, quorum, custody and
session read goes only to the profile's `rpcs`. Nothing falls back to a public or wallet RPC. That routing is only as
independent as the endpoints the profile names. **No production endpoint the browser can reach exists yet.** B's
runtime is internal 127.0.0.1 and is not one.

## 1. Profile format and discovery

- **No runtime discovery.** The RPC list is part of the profile document (`site/js/core/independent.js`
  `validateProfile`). That document is saved and confirmed per tab, or built in. Its SHA-256 is the fingerprint a user
  compares. Directories (`profile.directories`) carry network policies, not RPCs.
- **2 to 8 distinct origins**, `quorum` 2 to n (default 2). `https:` only; plain `http:` only on
  localhost/127.0.0.1/[::1]. No credentials, query or fragment. A path is allowed and is kept.
- **Distinct origins are not distinct operators.** Do not put two names in front of one verifier or one upstream to
  "make" a quorum. Two origins backed by the same provider can agree on a lie, and the page cannot tell.
- `confirmations` 0 to 64 (default 2). `maxBlockAgeSeconds` 30 to 86,400 (default 600). The agreed block must be
  within that age by the browser's clock, so an endpoint must follow the head.

## 2. HTTP and CORS

- **Requests:** `POST`, body = one JSON-RPC 2.0 object (no batches from the page), `content-type: application/json`.
  The quorum reader sends `credentials: "omit"`, `redirect: "error"` and `cache: "no-store"`, so an endpoint **must
  not redirect**. Plain reads send the browser default (no cookies cross-origin).
- **CORS:**
  - answer the preflight `OPTIONS` for `POST` with `content-type`;
  - send `Access-Control-Allow-Origin`, either the dashboard origin(s) or `*`;
  - no credentials needed.
- **Timeouts:** the page aborts at 8 s (rotating reads, quorum reads) and 10 s (custody reads, via viem).
- **Reverts:** report as a JSON-RPC error whose message contains `revert` (or code 3). A deterministic revert must not
  look like a transport failure. `eth_call` must never answer `0x` for a contract getter: the page treats that as a
  transport error and rotates.

## 3. Methods the page sends to profile RPCs

| method | parameters the page uses | used by |
|---|---|---|
| `eth_chainId` | – | quorum: must be `0x2105` |
| `eth_blockNumber` | – | quorum heads, display |
| `eth_getBlockByNumber` | hex number or `latest`, `false` (needs `hash`, `number`, `timestamp`; `baseFeePerGas` when the block has one) | quorum snapshot, lease time |
| `eth_call` | `latest`, a hex block number, or EIP-1898 `{blockHash}` | all contract reads |
| `eth_getCode` | `latest`, or `{blockHash}` | code checks, payer kind |
| `eth_getBalance` | `latest`, or `{blockHash}` | balances, funding |
| `eth_getStorageAt` | `{blockHash}` | session delegation slot |
| `eth_getLogs` | one address and topics, ranges ≤ 2,000 blocks (address-book history, transfers) | ledger history, owners |
| `eth_estimateGas` | `latest`, or a hex block number | the gas limit the page sets |
| `eth_getTransactionReceipt` | hash | confirmations |
| `eth_getTransactionByHash` | hash | credit-vault reconcile, admin tools |
| `eth_getTransactionCount`, `eth_sendRawTransaction` | – | admin console migrator only (locally signed migration key) |

**Not sent to profile RPCs:**
- `eth_sendTransaction` and signatures go to the user's wallet, which broadcasts through **its own** RPC.
- `eth_sendUserOperation`, `eth_estimateUserOperationGas`, `eth_maxPriorityFeePerGas` and `pm_*` go to the passkey
  account's own bundlers.

Historical reads are bounded: the address-book history runs from the profile's `ledgerHistory.through`, and RPCs that
refuse log ranges send listings back to full re-reads. No archive node is required beyond that window.

## 4. Trust labels (keep them honest)

- These responses are **agreement of the configured RPCs**, not cryptographic proof. The browser does not verify a
  witness or a state proof. Do not label a generic JSON-RPC answer, or an agreed one, as "proof verified".
- If an endpoint serves verified state (for example B's Helios-backed reads), that is a property of the endpoint's
  deployment, and it must be stated per endpoint. The page cannot see it.

## 5. What S asks of F and B (no action is taken by S)

- **F:** if a host-service role is meant to serve browsers, expose it as a public HTTPS origin with the CORS and methods
  above, per operator. Keep provider-quorum roles as they are until a separate consumer composition exists. A browser
  profile fixture is not a production service.
- **B:** the 127.0.0.1 runtime stays internal. A browser-facing front, if one is ever added, must meet §2 and §3. It
  must not present one verifier under several origins.
- **Wallet broadcast:** this remains the wallet's own RPC. The page shows the profile's RPCs and can offer HTTPS ones
  through EIP-3085. Only the user can change the wallet's RPC. L1 forced inclusion is E's scope, not this note's.
