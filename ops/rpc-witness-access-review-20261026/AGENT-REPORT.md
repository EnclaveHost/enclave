# witness-rpc-access-stage: private debug access for witness acquisition (PREPARED, FROZEN; offline 10/10 PASS; no live/SSH/build/commit)

**Stage:** `witness-rpc-access-stage`, `SHA256SUMS` `646e6db12bfdbb6ec2cbc2926c3f0b69ff850d109efa30351e1d2fa1c8420287`.
- **Receipt:** `logs/claude-witness-rpc-access-3.out` (sha `7209f98c…`, rc 0): `PASS witness-rpc-access Ran 10`, no skips. It also verifies that the candidate `80cea888` is unchanged and that overlay = candidate wrapper + patch.
- **Earlier attempts kept:**
  - `-1`: rc 1, 7 test-fixture failures: AF_UNIX path too long under the deep TMPDIR (6), and the units regex matching a comment (1);
  - `-2`: rc 0, before the docs.
- **Untouched:** the candidate and all other stages.

## What witness_fetch actually needs (source)
`witness_fetch.rs` `69812507` → `base-proof-zk-witness` (`fetcher.rs`, `host/src/handler.rs`), plus combined-r1 `runner.py`:

| Target | Methods |
|---|---|
| **Base EL** | `debug_executePayload` (`handler.rs:891`), `debug_getRawHeader` (`:1205,:1237`), `debug_dbGet` (`:1264-1302`: `0x63‖code_hash`, keccak-checked node fallback), `eth_getBlockByNumber/ByHash`, `eth_getProof`; runner: `eth_chainId`/`eth_syncing`/`eth_blockNumber`/`debug_getRawHeader` |
| **L1 EL** | `debug_getRawHeader` (`:745,:1070`), `debug_getRawReceipts` (`:1117`), `eth_getBlockByHash/ByNumber` |
| **Base rollup RPC 19545** | `optimism_rollupConfig` (`fetcher.rs:388`), `optimism_outputAtBlock` (`:599,:617`); `optimism_safeHeadAtL1Block` is not on witness_fetch's explicit-L1-head path |

**Correction:** `debug_getRawReceipts` is an **L1** call, so the L1 EL needs private debug access too, not only Base.

## Pinned source facts
- **Reth 7134be3:**
  - `debug_getRawHeader` (debug.rs:749-766), `debug_getRawReceipts` (:810-819) and `debug_dbGet` (:1027-1059) are all read-only, `Debug` module, with no other flag.
  - `debug_dbGet` accepts ONLY a 33-byte `0x63‖code_hash` key (no table access).
  - IPC serves ALL modules by default (module.rs:44-49), with no `--ipc.api`.
  - Also in debug: `debug_clearTxpool` (mutating) and `debug_trace*` (heavy).
- **Base 5476069f:**
  - `debug_executePayload` is Base-only (execution/rpc/src/witness.rs:31), registered only when Debug is configured (node/src/node.rs:629). It runs in memory, never persists, with a semaphore of 3, and needs the parent header + parent historical state.
  - With Debug on any transport, reth debug is merged into the engine auth server (node.rs:643-646; JWT/auth-IPC only).
  - Rollup RPC on `--rpc.addr/port`: `optimism_outputAtBlock`, `optimism_safeHeadAtL1Block`, `optimism_syncStatus`, `optimism_rollupConfig`, `optimism_version` (jsonrpsee.rs:98-123), always on. `admin_*`/`dev_*`/ws are off by default.
  - **`opp2p_*` peer controls are always on, with no gate:** an existing loopback-only finding.
- **Flags:** `--ipcpath` and `--ipc.permissions` exist in the Base release help (`smoke-help-rpc.txt:368,373`) and the L1 reth v2.8.0 (`8cdd1f35`) help.

## Why private, not `--http.api …,debug`
18545 and 18645 are raw `systemd-socket-proxyd` forwards to host 28545/28645 (`provision_vm.py` proxy_units; live config confirms). 28545 is a proof source for other VMs. Consumer allowlists block `debug_*`, but the forward does not, so debug on HTTP would be public. **It stays off.**

## Implementation (minimal)
1. **Wrapper overlay** (`9607b831`, patch vs `6a4d7aa5`): only `--ipcdisable` → `--ipcpath <node tmp>/witness-el.ipc --ipc.permissions 0600`, for both ELs. HTTP API and every other flag are unchanged, as proven by the REAL `_start` argv diff test.
2. **`bridge/witness_rpc_bridge.py`** (`ff4da80c`): loopback-only HTTP→IPC relay.
   - **Endpoints:** Base `127.0.0.1:18547`, L1 `127.0.0.1:18647`.
   - **Allowlist:** exactly the read-only set above; anything else gives -32601 before the socket is touched.
   - **Bounds:** 1 MiB request, 192 MiB response, batch ≤ 32, 4 in flight, 600 s timeout.
   - **Socket check:** must be owned by the user with no group/other bits, else 502 (fail-closed if reth ignored the permissions).
   - **Binding:** non-loopback refused.
3. **Units** `enclave-witness-bridge-{base,l1}.service` (`e4bdc947`, `dd82cd45`):
   - node user, no capabilities, `ProtectSystem=strict`, loopback IP only, `MemoryMax=512M`;
   - **no [Install]:** opt-in per witness run; never forwarded.

## Composition (`witness-rpc-access-stage/COMPOSITION.md`)
- **Into a NEW candidate:** replace the wrapper and run the pin cascade (base_launch, finality_state, forward_sync, MANIFEST, then reproof).
- **Re-run** the wrapper and dependent suites, and update the systemd canary's wrapper FINAL-PIN.
- **MANIFEST add:** the bridge and the 2 units.
- **Endpoints:** runner `run.json` `l2Rpc` `http://127.0.0.1:18547`, `l1Rpc` `http://127.0.0.1:18647`, `l2Node` `:19545`, `l1Beacon` `:15052`.
- **Restart:** the L1 EL IPC needs a coordinated L1 EL restart (root decision; it affects Helios/A1 and the download's L1).

## Prerequisites and limits
- **Base:** witness ranges must start above the retained state-history floor **52,500,000** (parent state for `debug_executePayload`).
- **L1:** the window must be inside the 140,000-block receipt retention.
- **Still unproven (live only):** that reth applies `--ipc.permissions`, socket creation under the holder sandbox, the bridge's `connect` under `ProtectSystem=strict`, and the real witness run.
