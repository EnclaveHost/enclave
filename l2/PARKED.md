# Enclave L2: parked on 2026-11-24

Steven asked for the L2 work to come off `main` and stay on this branch
(`l2/parked-20261124`) until he wants it again. Nothing here is in
production. Base (8453) is still the only production chain. The design is
in `ops/enclave-l2-20261103/DESIGN.md`, the Sepolia evidence in
`ops/enclave-l2-20261103/sepolia/RESULTS.md`.

## Where the chain stands

A Sepolia OP Stack L2 with chain id 4206917 (`0x403145`) and Enclave-owned
authorities. State at shutdown: `ops/enclave-l2-20261103/sepolia/parked-state.json`.

| | |
|---|---|
| L1 ProxyAdmin owner (1-of-1 Safe, admin key) | `0xb9FB98c855a053A1cD3576eabCda1D74f1D5fD3D` |
| SystemConfig | `0xbe9ba7607d6dca6d7fd47fa0e640e4784bd498ba` |
| OptimismPortal | `0xf870ec445bcc1887cacb366b1bae908789a8159c` |
| DisputeGameFactory | `0x6d3afe7c0c75a908bd048ff1db6b6ed2aad1d471` |
| AnchorStateRegistry | `0xeaf5d8c722629f878edd447b4ddd7246ea269ceb` |
| Batch inbox | `0x00dbb164b4fe54940f900e79e885753166c1128b` |
| All other addresses | `ops/enclave-l2-20261103/sepolia/chain-addresses.json` |
| L2: EnclaveRegistry / EnclaveDeployments (Ledger) / EnclaveAppCatalog | `0xE774ABfDDCB146A741f8fa9DD6Cf6c2d072dDcFc` / `0x704Be913740cc850a9993B6c91A2cC48696aD697` / `0x936b3bcF95720694ABFcea6CE59c052F1f2df7E1` |

- **Proofs.** SUPER_CANNON_KONA (game 9) has been the respected game since
  2026-11-24. The anchor is the super root at L2 timestamp 1795070266,
  `0xc641aa2e…ff47`, which the replica independently matches. 356 games
  exist. The last one (index 355, type 9, `0x6C0C784B…D944`, 0.001 ETH bond)
  was in progress at shutdown and resolves for the proposer once its
  3.5-day clock runs out unchallenged.
- **Batches.** None since 2026-11-15, when a Sepolia blob-fee spike drained
  the batcher. Since then the safe chain is what derivation forces after the
  12 h window: deposit-only blocks. The stack was restarted on 11-24 without
  the batcher and stopped again 20 minutes later.
- **One forced deposit is pending.** L1 tx `0x1d3dfbfa…0032` (block
  12201140): the runner clears its payout wallet on the L2 registry through
  the portal. Derivation includes it whenever the nodes next process that
  L1 block. If the batcher stays off, that is the forced-inclusion test.
- **Sepolia ETH left:** deployer 0.0207, admin 0.0100, batcher 0.0062,
  proposer 0.0075, challenger 0.0042, runner 0.0020.

## Left to do

1. **Release gate 1, second half.** An invalid type-9 proposal that the
   challenger counters and wins. One counter-move bond is 0.08–0.09 ETH, so
   the challenger (`0xA43e1a374506c7A26e641C4F47778cf33a016a8B`) needs
   ~0.15 Sepolia ETH first.
2. **Forced inclusion while the sequencer withholds batches.** Keep the
   batcher off, and record when the replica's safe chain shows the pending
   deposit above. Expected at L1 block 12204740 or later (deposit block +
   3,600). The 11-24 watcher is `forced-inclusion-watch.jsonl`.
3. **Release gates 2 and 6.** 24 h of `op-challenger run-trace` reporting
   `Successfully verified`, and 24 h of posting costs at the recommended
   15-minute batches and daily proposals (`l2/devnet/measure-posting.mjs`).
4. Open questions and the remaining release gates: DESIGN.md §9–10.

## How to restart

Everything is still on warden-host: deploy output in
`~/.cache/enclave-l2-devnet/sepolia`, runtime data in
`~/.cache/enclave-l2-devnet/devnet`, keys in `~/.config/enclave-l2-devnet/keys`
(never commit them). The containers are stopped, not removed.

1. Check memory first. warden-host is a production host; the capped stack
   needs up to ~13.5 GB.
2. publicnode has pruned old receipts. Use an L1 RPC with history for both
   sides, and keep the two providers different:

   ```bash
   WORK=$HOME/.cache/enclave-l2-devnet/sepolia KEYS=$HOME/.config/enclave-l2-devnet/keys \
   DEVNET=$HOME/.cache/enclave-l2-devnet/devnet \
   SEQ_L1_RPC=https://sepolia.gateway.tenderly.co SEQ_L1_BEACON=https://ethereum-sepolia-beacon-api.publicnode.com \
   REPLICA_L1_RPC=https://0xrpc.io/sep REPLICA_L1_BEACON=https://beacon.sepolia.ethpandaops.io \
   BATCHER_MAX_CHANNEL_DURATION=75 PROPOSAL_INTERVAL=24h PROPOSER_GAME_TYPE=9 \
   l2/devnet/up.sh seq-reth seq-node replica-reth replica-node challenger proposer runtrace
   ```

3. The nodes are about 23k L1 blocks behind the head and derive at ~120 blocks
   a minute. Keep the sequencer paused (`admin_stopSequencer` on
   127.0.0.1:9547) until its derivation reaches the L1 head, then
   `admin_startSequencer` with its unsafe head hash.
4. Start the batcher (`l2/devnet/up.sh batcher`) only after the forced-inclusion
   test, or skip that test. It posts with `--data-availability-type=auto`.
5. If the shell has a stale `PYTHONHOME` (an unmounted AppImage), python3
   fails, and so do `deploy-l1.sh`'s intent stage and the repo's git hooks.
   Start from a clean shell.
