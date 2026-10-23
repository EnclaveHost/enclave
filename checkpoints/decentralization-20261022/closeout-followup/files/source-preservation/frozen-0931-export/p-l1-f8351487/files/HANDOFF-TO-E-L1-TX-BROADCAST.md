# Handoff to E (L1 transaction / OptimismPortal owner): the L1 pair's local raw-transaction interface

From P (`work/rpc-l1-source-package`). This is a file note only. E's tree was not read for edits or touched. E owns Portal
and forced-inclusion semantics: what to sign, when, gas, retries, replacement and inclusion proof. Root owns activation.

## What the pair offers

- **Config:** `execution.txBroadcast` in `l1pair.json`.
  - **`disabled` (default):** reth runs with `--disable-tx-gossip` and `--txpool.no-local-transactions-propagation`.
  - **`local-raw-propagate` (explicit opt-in):** neither flag. This is standard reth gossip.
- **Interface:** `eth_sendRawTransaction(<already-signed tx>)` on `http://127.0.0.1:<execution.httpPort>/`.
  - It is loopback only, on the `eth,net,web3` API; reth cannot remove single methods, and `admin`/`debug`/`txpool` stay
    refused.
  - There is no forwarder (`--rpc.forwarder` is never rendered), and no proxy or new RPC framework.
- **The pair holds no keys and never signs, funds or auto-sends.** E's signer produces the raw bytes.

## Measured behaviour

From the real reth v2.8.0 (`test_tx_broadcast_offline.py`). This is a **TEST network**: offline, two peers, a synthetic
tx signed with a PUBLIC test key.

| Mode on node A | `eth_sendRawTransaction` on A | In A's pool | Reached peer B | Included |
|---|---|---|---|---|
| `disabled` (default) | **accepted**: returns the tx hash | yes | **no** within 30 s, link up (1 peer each) | no |
| `local-raw-propagate` | **accepted**: returns the tx hash | yes | **yes**, seen at the first poll | no |

**Test conditions:**
- Both peers were first advanced to block 1 with reth's own payload builder over the engine API, as a CL would.
  - **Why:** reth ignores peers' transaction announcements while "initially syncing"
    (`transactions/mod.rs:662`, `launch/engine.rs:389`).
- No block was built after the send, so the receipt is `null`.
- Run txb-3, logs in `logs/txb-3.out`.
- An earlier run (txb-2) without that block saw no propagation in EITHER mode. That shows a receiving peer that is still
  syncing drops gossip, which is real behaviour for a node that is not yet synced.

## What reth itself enforces on `eth_sendRawTransaction`

Measured in txb-4 on the real binary, in both modes, against E's requested gates (`NOTE-FOR-P-L1-BROADCAST.md` §1).

| E's gate | Enforced by reth? | Evidence |
|---|---|---|
| chain id = 1 for EIP-155/typed txs | **yes**: `invalid chain ID` (-32000) for a tx signed for another chain | probe `wrongChain` |
| chain id for **legacy replay-unprotected** (pre-EIP-155, no chain id) txs | **NO**: accepted into the pool and given a hash | probe `unprotected` |
| `to` = the pinned OptimismPortal only | **NO**: there is no recipient allowlist. A transfer to `0x…dEaD` was accepted and (opt-in) propagated | main tx |
| fee bound | **yes**: `--rpc.txfeecap`, default 1 ETH (`tx fee … exceeds the configured cap`). Not changed by this package | probe `overFeeCap` |
| size bound | reth default `--txpool.max-tx-input-bytes` 131072 (help text; not exercised) | binary help |
| no retries / no public fallback | **yes by construction**: no `--rpc.forwarder` and no proxy; a refusal is returned to the caller | rendered argv |

**So the general eth API on this loopback port is NOT an allowlist.** Under `local-raw-propagate`, ANY local process that
can reach `127.0.0.1:<execution.httpPort>` can hand reth ANY validly signed transaction, including unprotected legacy
ones, and reth will gossip it.

The portal-only, chain-1-only and EIP-155-only checks must therefore be done by **E's bounded sender, before the raw
bytes reach this port**. Root composes E's sender checks with this standard node. No proxy framework is added here to
hide that.

**Exposure:**
- **Bound:** loopback only, plus systemd hardening.
- **Not separated:** the port is not restricted to particular local users.

**Reads E asked for** (§2–3 of E's note) are all on the default `eth`/`net` API:
- `eth_getStorageAt`/`eth_call` with `{blockHash}`;
- `eth_getTransactionCount`, `eth_feeHistory`;
- `eth_getTransactionReceipt`/`eth_getBlockReceipts`, kept for 140,000 blocks;
- `eth_getBlockByNumber("finalized")`;
- `net_peerCount`;
- `eth_getTransactionByHash` for a pending tx (instead of `txpool_content`, whose namespace stays refused).

Finality as a separate field comes from the pair's `ready` gate and the beacon API, not from the send reply.

**Important:**
- **In `disabled` mode the method is NOT refused.** It admits the tx into the local pool and returns its hash, but the tx
  never leaves the node. A caller that only checks the returned hash would wrongly believe it was broadcast. **E must
  call this interface only when root has set `local-raw-propagate`,** and should confirm the mode from the rendered
  `el.argv.json` and the manifest label.
- **A returned hash is not propagation, and peer receipt is not inclusion.**
  - Inclusion must be proven from L1 itself: the receipt in a block that is canonical/finalized according to the pair's
    `ready` gate.
  - For a deposit, the Portal `TransactionDeposited` event and the derived L2 deposit.
- **Default-mode admitted txs stay in the local pool.** They are not persisted across restarts
  (`--txpool.disable-transactions-backup` in both modes), and their pool lifetime is reth's default.
- **Propagation depends on live peers.** One node at one site is a single point of withholding for submission.
  Censorship resistance of the submission path is E's analysis, not claimed here.

## What E still owns

- signing and key custody (outside this pair);
- deposit encoding, fees and replacement policy;
- confirmation depth and reorg handling;
- monitoring;
- whether to also submit through other routes.

The pair adds no automatic resend.
