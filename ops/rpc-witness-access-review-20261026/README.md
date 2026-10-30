# witness-rpc-access-stage: private access to the debug/optimism methods witness_fetch needs (PREPARED; offline tests PASS; nothing live)

**The gap.** `witness_fetch` (sha `69812507`, `base-proof-zk-witness`) calls:
- **Base EL:** `debug_executePayload`, `debug_getRawHeader`, `debug_dbGet`, plus `eth_getBlockByNumber/ByHash`, `eth_getProof`;
- **L1 EL:** `debug_getRawHeader`, `debug_getRawReceipts`, plus eth reads;
- **Base rollup RPC:** `optimism_rollupConfig`, `optimism_outputAtBlock`;
- **The runner** additionally calls `eth_chainId`, `eth_syncing`, `eth_blockNumber`.

Both ELs run `--http.api eth,net,web3 --ipcdisable`, so the debug calls fail.

## Source facts (pinned bytes)
- **Reth `7134be3`** (base/reth tag base-v2.5.2.8):
  - `debug_getRawHeader` (rpc/src/debug.rs:749-766), `debug_getRawReceipts` (:810-819) and `debug_dbGet` (:1027-1059) are read-only, in `RethRpcModule::Debug`, with no extra flag.
  - `debug_dbGet` accepts ONLY a 33-byte key `0x63‖code_hash` (contract code at latest state).
  - IPC serves ALL modules by default (rpc-server-types/src/module.rs:44-49), with no `--ipc.api`. IPC socket mode comes from `--ipc.permissions`; parse/chmod errors are silently ignored (ipc/src/server/mod.rs:146-156).
  - The debug namespace also has state-changing `debug_clearTxpool` and heavy `debug_trace*`.
- **Base `5476069f`:**
  - `debug_executePayload` is Base-only (crates/execution/rpc/src/witness.rs:31), registered via `merge_if_module_configured(Debug)` (execution/node/src/node.rs:629).
  - It executes in memory (`payload_witness`, payload/src/builder.rs:236-263; `State::builder().with_bundle_update()`), with a semaphore of 3. It needs the parent header plus the parent's historical state (`state_by_block_hash`).
  - When Debug is configured on any transport, reth's debug API is also merged into the engine auth server (node.rs:643-646; JWT/auth-IPC only).
  - The rollup RPC on `--rpc.addr/--rpc.port` (wrapper: 127.0.0.1:19545) always serves `optimism_outputAtBlock`, `optimism_safeHeadAtL1Block`, `optimism_syncStatus`, `optimism_rollupConfig`, `optimism_version` (consensus/rpc/src/jsonrpsee.rs:98-123). These are the only `optimism_*` names. `optimism_safeHeadAtL1Block` reports "safe head tracking is disabled" without `--safedb.path` (unused by witness_fetch with an explicit L1 head).
- **Flags in the real `--help`:**
  - the Base release `smoke-help-rpc.txt:368,373`;
  - L1 reth v2.8.0 (`8cdd1f35…`) help: `--ipcpath`, `--ipc.permissions`.

## Why not `--http.api …,debug`
- 18545 and 18645 are forwarded VERBATIM by `systemd-socket-proxyd` to host 28545/28645 (provision_vm.py proxy_units). Host 28545 is a proof source for other VMs (`http://10.0.2.2:28545/`).
- Consumer allowlists (witness-gateway, chain-authority, measured-control) block `debug_*`, but the raw forward does not.
- So debug on HTTP would be public. It stays off.

## The change
- **Wrapper overlay:** only `--ipcdisable` → `--ipcpath <node tmp>/witness-el.ipc --ipc.permissions 0600`, for both ELs. HTTP and every other flag are unchanged.
- **`bridge/witness_rpc_bridge.py`:** a loopback-only HTTP→IPC relay (Base 127.0.0.1:18547, L1 127.0.0.1:18647).
  - **Allowlist:** an exact per-node read-only list; anything else gives -32601 BEFORE the socket is touched.
  - **Bounds:** 1 MiB request, 192 MiB response, batch ≤ 32, 4 in flight (else 503), 600 s IPC timeout.
  - **Socket check:** the socket must be the user's own with no group/other bits, else 502.
  - **Binding:** a non-loopback bind is refused.
- **Units:** `enclave-witness-bridge-{base,l1}.service`.
  - Run as the node's user (rpcbase / rpcl1el) with no capabilities, `ProtectSystem=strict`, `IPAddressDeny=any` + `IPAddressAllow=localhost`, `MemoryMax=512M`.
  - **No [Install]:** opt-in, started only for a witness run. **No forward.**

## Security scope
- **Unchanged:** public/forwarded surfaces (no debug on HTTP; no new forward; the 28545/28645 forwards untouched); L1 proof, trust, bootstrap and admin controls.
- **Newly reachable:**
  - **IPC (all modules, incl. admin/txpool/`debug_clearTxpool`):** only by the node user and root, through a 0600 socket inside the node's 0750 tmp subtree.
  - **The bridges' read-only allowlist:** by any guest-local process via loopback, ONLY while a bridge runs.
- **Load:** `debug_executePayload` is CPU-heavy, bounded by node 3 + bridge 4.
- **Pre-existing finding (not changed here):** the rollup RPC 19545 always serves the mutating `opp2p_*` peer controls (block/unblock/connect/disconnect peer, address, subnet; consensus/rpc/src/p2p.rs:47-116) with no gating flag. It is loopback-only and not forwarded. Consider an allowlisting front later.

## Retained-state prerequisites
- **`debug_executePayload` at parent P** needs P's historical state. The Base retention keeps state history from **52,500,000**, so witness ranges must start above it.
- **`debug_dbGet`** reads latest-state bytecode.
- **L1 `debug_getRawReceipts`** needs L1 receipts inside the L1 EL's 140,000-block prune distance (about 19 days), so the L1 head and derivation window must be within it.

## Tests (`jobs/root-witness-rpc-access-tests.sh`, shared queue 512, `unshare -Urn`): 10 PASS
1. **Allowlists:** exactly the source-derived read set per node, with no admin/txpool/send/trace/set/clear methods, and socket paths under 108 bytes.
2. **Relay:** an allowed call is relayed to a FAKE node IPC socket and a 5 MB chunked response returned.
3. **Refusals:** refused methods (`debug_clearTxpool`, `admin_addPeer`, `debug_traceCall`, `eth_sendRawTransaction`, `txpool_content`, cross-node methods, `optimism_*`) NEVER reach the node.
4. **Batches and malformed input:** an all-allowed batch is relayed; mixed, oversized and empty batches are refused; parse and invalid-request errors are returned.
5. **HTTP bounds:** GET gives 405; a declared oversize body gives 413.
6. **IPC guards:** missing socket, group/other-accessible socket, early close and not-a-socket all give 502, with nothing relayed.
7. **Concurrency:** bounded (503).
8. **Binding:** a non-loopback listen is refused.
9. **Wrapper:** the REAL original and patched `_start('el'|'base')` with execve captured. The argv differs ONLY by the IPC swap; `--http.api` stays `eth,net,web3`; there is no debug, ws, admin or proofs-history flag.
10. **Units:** opt-in, unprivileged, loopback-only, bounded, never forwarded.

## Needs the live guest (not provable offline)
- reth applies `--ipc.permissions 0600`; the bridge fails closed otherwise.
- Socket creation in the node tmp under the holder sandbox.
- The bridge's `connect()` to the socket under its own `ProtectSystem=strict`.
- The actual witness run.
