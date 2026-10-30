# Witness RPC access: root live canary recipe for r14-witness (PREPARED; nothing here was run live)

**Inputs:** `base-finality-proof-stage/r14-witness` (sums in its qualification receipt). Bridge `cb976541…`, units `e4bdc947…` / `dd82cd45…`, wrapper `9607b831…`.

## A. Sandbox canary with a DISPOSABLE fixture socket (any time; does not touch a node, a node socket or a production unit)
`guest/bridge_fixture_canary.sh <ID> <path to the r14 witness/witness_rpc_bridge.py>` (root, on the guest). It:
1. Runs the reviewed bridge byte (sha-pinned) in a transient unit with the **same sandbox as the shipped unit**: rpcbase, no capabilities, `ProtectSystem=strict`, loopback IP only, `MemoryMax=512M`.
2. Points it at a fixture unix socket owned by rpcbase, mode 0600, in a private `/run` directory.
3. Proves on the guest's real systemd:
   - the bridge listens only on 127.0.0.1;
   - an allowlisted call is relayed;
   - `debug_clearTxpool` is refused (-32601);
   - a group-accessible socket is refused (502);
   - the unit properties are as shipped;
   - the production PIDs are unchanged.
4. Cleans up its own units and paths.

**What it does NOT show:** reth/base creating their sockets, `--ipc.permissions` handling, or any real debug method.

## B. Real-node steps (only after r14 is qualified, installed and each node runs the r14 wrapper; root decisions)
1. **Base EL**, at its first production start on r14 (the holder release-mode drop-in is unchanged), metadata only:
   ```
   stat -c '%a %U %F' /srv/enclave-base-holder/tmp/witness-el.ipc
   ```
   It must be `600 rpcbase socket`. Anything else → STOP: the bridge would refuse (502) anyway.
   - The HTTP surface is unchanged: `ss -ltn` shows 18545/19545 on 127.0.0.1 only. The forward 10.0.2.15:28545 still targets 18545 (`--http.api eth,net,web3`).
2. **L1 EL:** its socket appears only after a **coordinated restart of `enclave-l1-el.service` on the r14 wrapper**. That restart affects Helios/A1, the readiness gates and the download's L1, so it is **root-scheduled later**. Then: `stat -c '%a %U %F' /srv/enclave-l1-pair/tmp/witness-el.ipc` = `600 rpcl1el socket`.
3. **Bridges, for a witness run only:** `systemctl start enclave-witness-bridge-base.service` (and `-l1` once 2 is done). Then:
   ```
   curl -s --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' http://127.0.0.1:18547/    # → 0x2105
   curl -s --data '{"jsonrpc":"2.0","id":2,"method":"debug_getRawHeader","params":["latest"]}' http://127.0.0.1:18547/
   curl -s --data '{"jsonrpc":"2.0","id":3,"method":"admin_peers","params":[]}' http://127.0.0.1:18547/       # → -32601, nothing reaches the node
   ss -ltn | grep -E '18547|18647'                                                                               # 127.0.0.1 only
   ```
4. **Witness runner** (`derivation-client-stage/combined-r1/runner`) `run.json` endpoints:
   - `l2Rpc` `http://127.0.0.1:18547`;
   - `l1Rpc` `http://127.0.0.1:18647`;
   - `l2Node` `http://127.0.0.1:19545`;
   - `l1Beacon` `http://127.0.0.1:15052`.

   Ranges above the Base state-history floor 52,500,000, inside the L1 receipt retention.
5. **Stop** the bridges after the run. They have no [Install] section and never start at boot.

**Not yet measured:** `debug_executePayload` response sizes and durations on real mainnet blocks. The bridge's 256 MiB / 900 s caps are bounds, not measurements; record the actual numbers from the first run.
