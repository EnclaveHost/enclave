# witness-rpc-access-stage → reviewed candidate: composition instructions (do NOT mutate frozen r13-manifest-final 80cea888)

**Base:** `base-finality-proof-stage/r13-manifest-final`, `SHA256SUMS` `80cea888…`; wrapper `6a4d7aa5`.

## 1. Source change (one file; the job proves overlay = candidate + patch)
`wrapper/chain_service.py` `6a4d7aa5…` → `9607b831c8941d1108022a500cf1ae328367b84a110e38b00fdd18476ff4656a` (`patches/wrapper_chain_service.py.patch`). In both EL argvs ONLY the token `--ipcdisable` is replaced by `--ipcpath <mount>/tmp/witness-el.ipc --ipc.permissions 0600`:
- **L1 EL:** `/srv/enclave-l1-pair/tmp/witness-el.ipc`.
- **Base EL:** `/srv/enclave-base-holder/tmp/witness-el.ipc`.
- **Unchanged:** `--http.api eth,net,web3` and every other flag. The test proves the full argv diff, behaviourally.

**Pin cascade (composer):** the wrapper sha is pinned by
- `producer/base_launch.py` `WRAPPER_SHA256`;
- `src/finality_state.py` `WRAPPER_SHA256`;
- `recovery/forward_sync.py`;
- `install/MANIFEST.json`.

So `finality_state` → (`base_launch` `FINALITY_STATE_SHA256`, `reproof` `FINALITY_STATE`) and `base_launch` → `reproof` `PRODUCER` re-pin; then MANIFEST. **Re-run** the r13 wrapper suites on the new byte (wrapper-pruned 49 + mutants, r3-regression, reanchor, integration, reproof, forward-sync). The systemd canary's `wrapper/chain_service.py` FINAL-PIN changes too.

## 2. New files → MANIFEST `add`
| dest | src | mode |
|---|---|---|
| `/opt/enclave-rpc/witness/witness_rpc_bridge.py` | `bridge/witness_rpc_bridge.py` | 0755 |
| `/etc/systemd/system/enclave-witness-bridge-base.service` (unit) | `units/enclave-witness-bridge-base.service` | 0644 |
| `/etc/systemd/system/enclave-witness-bridge-l1.service` (unit) | `units/enclave-witness-bridge-l1.service` | 0644 |

The shas are this stage's `SHA256SUMS` entries. No forward or socket unit is added.

## 3. Operation (root; after the composed candidate is qualified and installed)
1. **IPC sockets appear when each node (re)starts on the new wrapper:**
   - **Base:** at its first production start.
   - **L1 EL:** needs a coordinated RESTART of `enclave-l1-el.service` to pick up the IPC change. That restart affects Helios/A1 and the download's L1, so it is a root decision.
2. **Start the bridges for a witness run:** `systemctl start enclave-witness-bridge-base.service enclave-witness-bridge-l1.service`. They have no [Install] section, so they never start at boot.
   - The bridge REFUSES (502) unless the socket is the node user's own with no group/other bits. If reth did not apply `--ipc.permissions 0600`, it fails closed.
3. **Witness runner `run.json` endpoints:**
   - `l2Rpc` `http://127.0.0.1:18547` (bridge → Base EL IPC);
   - `l1Rpc` `http://127.0.0.1:18647` (bridge → L1 EL IPC);
   - `l2Node` `http://127.0.0.1:19545` (Base rollup RPC, unchanged);
   - `l1Beacon` `http://127.0.0.1:15052`.
4. **Stop the bridges after the run:** `systemctl stop enclave-witness-bridge-base.service enclave-witness-bridge-l1.service`.
5. **Rollback:** stop the bridges. Reverting the wrapper restores `--ipcdisable` (the sockets disappear on the next node start).
