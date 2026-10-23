# Source-binding handoff (file interface; root dispatches)

E's transaction checks (`src/forced-inclusion.mjs`, `src/vault-deposit.mjs`) now accept inclusion and finality ONLY as
objects MINTED by two read adapters. Labels and caller JSON are refused by default. Explicit labels are allowed only
as `test-*`.

| adapter | binds to | mints |
|---|---|---|
| `createL1PairSource({execution:{url}, consensus:{url}})` (`src/l1-source-binding.mjs`) | P's reth + Lighthouse pair on loopback | `kind 'l1-receipt'` (`receipt(txHash)`) and `kind 'l1-portal'` (`portalSnapshot(portal)`), trust `local-validated-pair` |
| `createBaseNodeSource({execution:{url}, rollup:{url}, l1})` (`src/base-source-binding.mjs`) | S's Base holder (base-reth + base-consensus) on loopback, bound to that same L1 adapter | `kind 'l2-receipt'`, `verifiedBy 'base-derivation'`, level unsafe / safe / finalized |

**Trust = local full-node validation** (the node executed and validated the chain; the beacon node finalized it). It
is NOT a portable cryptographic proof. A submission-only endpoint cannot mint anything. The validated pair may serve
sends and reads; evidence comes from its validated state.

## To P (rpc-l1-source-package, rpc-l1-binary-closure): the exact RPC surface the L1 adapter calls

All calls are on loopback only, with no fallback. Defaults are reth `127.0.0.1:18645` and Lighthouse
`127.0.0.1:15052`, per `l1pair.example.json`.

**Execution (`eth,net` namespaces; `web3` unused):**

| call | used for |
|---|---|
| `eth_chainId` | must be `0x1` |
| `eth_getBlockByNumber(0x0)` | genesis `0xd4e5…8fa3` |
| `eth_syncing` | must be `false` |
| `net_peerCount` | must be ≥ minPeers (default 1) |
| `eth_getBlockByNumber(latest \| finalized \| safe \| <n>, false)` | head and tag reads |
| `eth_getBlockByHash(h, false)` (`transactions` must list the tx hash) | receipt-block binding |
| `eth_getTransactionReceipt` | receipt read |
| `eth_getTransactionByHash` (nonce/from/blockHash binding) | nonce and sender binding |
| `eth_getStorageAt(portal, EIP-1967 slot, {blockHash})` | portal pin |
| `eth_call(version(), {blockHash})` | portal pin |

EIP-1898 `{blockHash}` must be accepted.

**Beacon:**

| path | used for |
|---|---|
| `/eth/v1/beacon/genesis` | GVR `0x4b36…fe95` |
| `/eth/v1/node/syncing` | `is_syncing` / `is_optimistic` / `el_offline` all false |
| `/eth/v1/node/peer_count` | `connected` ≥ minPeers |
| `/eth/v2/beacon/blocks/finalized` and `/head` | `message.body.execution_payload.{block_number, block_hash}`, `message.slot` |

**Pairing rule the adapter enforces:** CL finalized payload == EL block at that number == EL `finalized`; CL head
payload == EL block at that height. This is the same fact P's `l1pair.py ready` checks.

**Broadcast** (P's opt-in task): E does NOT need P to proxy or allowlist. E's sender check before signing is
`checkPortalPin(adapter.portalSnapshot(portal), pin)`, plus E's chain-1 / portal-only plan. P documents what reth itself
can and cannot enforce. A send reply is never evidence; E reads the receipt back through `receipt(txHash)`.

## To S (Base holder): what the Base adapter calls

**Execution:**

| call | used for |
|---|---|
| `eth_chainId` | must be `0x2105` |
| `eth_getBlockByNumber(0x0)` | genesis `0xf712…73dd` |
| `eth_syncing` | must be `false` |
| `eth_getBlockByNumber(<n>)` | pairing and canonical re-checks |
| `eth_getTransactionReceipt` | receipt read |

**Rollup:** `optimism_syncStatus`, snake_case top level. It needs `current_l1`, `finalized_l1`, and
`unsafe_l2` / `safe_l2` / `finalized_l2` with `hash` / `number` / `timestamp`.

**Rules:**
- The unsafe/safe/finalized hashes must be the EL's blocks at those numbers.
- `current_l1` must be canonical in P's pair.
- `finalized_l1` must be canonical AND final in P's pair. This refuses a holder deriving from another L1 source.
- The holder's rollup RPC port goes in its config; E takes it as `rollup.url`.

## To B (runtime composition)

- **Config:** construct both adapters from root's config, with loopback URLs only, and pass them where E's planners
  and checks run.
- **Calls:**
  - `checkPortalPin(await l1.portalSnapshot(portal), PIN)` before any signing;
  - `matchDepositEvent(plan, undefined, (await l1.receipt(l1Tx)).evidence)`;
  - `classifyL2Outcome({..., source: {evidence: (await base.receipt(l2Tx)).evidence}})`;
  - `classifyFinality({outcome, depositL1BlockHash, l1Evidence, l2Evidence})`;
  - `tracker.resolveFailedL1(key, ev.receipt, ev)`.
- **Helios (B's verifier):** its unsafe-head receipt path needs its OWN minting adapter if B wants it accepted
  (`kind 'l2-receipt'` at level unsafe). A `verifier: 'helios'` label is refused by default.
- **No retry:** a public-RPC outage surfaces as `*-source-not-ready`. There is no hidden retry anywhere.

## To A (CLI / MCP)

- Show the adapter readiness checks verbatim (`readiness().checks`).
- Show the evidence `trust` and `level` verbatim. Never print "finalized" from a send reply or a label.
- Show the gates `classifyFinality` returns.
- `test-fixture` trust must never appear in production output. If it does, treat it as a configuration error.
