# Enclave L2: Sepolia devnet (2026-11-05)

Evidence, not source. The tooling is in `l2/`. This is real Sepolia
(chain id 11155111), funded with faucet ETH. No real funds are involved.

L2 chain id 4206917 (`0x403145`). The L1 addresses are in `chain-addresses.json`,
`safe.json` and `superchain.json`. The rollup config is in `rollup.json`. The
L2 genesis is not committed (9.5 MB); its sha256 is in `genesis.json.sha256`.

## Funding

The owner sent 0.09 Sepolia ETH to the deployer
`0x5f2957Af397902cF53141314dB12Bd7D3cbfdb5b`. The deployer then sent 0.01 each
to the admin, batcher and proposer, and 0.005 to the challenger
(`role-funding.jsonl`). Each of those transfers used **204,600 gas**, against
21,000 to an existing account. Sepolia's current fork (forkId `0x6c1d9423`,
activated at 1791294816) charges for state growth. Creating an account now
costs about 186k gas, and contract code costs about 1,540 gas per byte (a
1 KiB runtime costs 1.79M gas to deploy, a 24 KiB one 38.1M).

## Attempt 1: op-deployer continue on live Sepolia (failed, nothing sent)

`deploy.out`, `continue.out`. The Safe and Enclave's SuperchainConfig deployed
normally (`safe.json`, `superchain.json`). The bootstrap cost 0.0142 ETH,
because op-deployer bids a tip of at least 1 gwei. Then `op-deployer continue`
retried 30 times and gave up:

    failed to estimate gas: execution reverted, reason: 0x30116425   (DeploymentFailed())

The cause is the repricing. OPCM.deploy needed 8,968,443 gas on the fork
rehearsal (old rules), and live Sepolia needs **between 54,687,500 and
54,882,812** (binary search with `eth_call` on rpc.sepolia.ethpandaops.io).
That is just above geth's default 50M cap on `eth_call`/`eth_estimateGas`.
So the inner CREATE2 runs out of gas during estimation and the Blueprint
reverts. publicnode's `eth_call` also reverted at 100M and succeeded at 190M,
so its cap or its backends vary. op-deployer 0.8.1 has no gas-limit override.

## Attempt 2: fork-assisted broadcast (worked)

1. `op-deployer continue` ran against an anvil fork of Sepolia
   (`continue-fork.out`). It mined a single OPCM.deploy (fork tx `0xbb2158b3…80a4`)
   and recorded the deployed state.
2. The fork's calldata (`opcm-deploy-calldata.hex`, the exact `input` of that
   tx) returned byte-identical data from `eth_call` on live Sepolia (gas 64M)
   and on the fork. The addresses are CREATE2-derived, so the state op-deployer
   recorded matches the live deployment.
3. `l2/send.mjs` sent that calldata to the OPCM with a 66M gas limit:
   tx `0x31de7f7ae58f20031153878ecf5cb2b69c23a640c34e5bfb42a6fed12ac4c195`,
   block 12072740, **54,770,633 gas** at 19 wei (`opcm-deploy-receipt.json`).
4. Every proxy and implementation in `chain-addresses.json` has code on
   Sepolia. SystemConfig reads back the batcher, unsafe block signer and owner
   from the intent.

`l2/deploy-l1.sh` now does this automatically when `op-deployer continue`
fails to estimate (`fork_assisted_deploy`). It sends nothing if the fork's
result and the live result differ.

## Permissionless game registered (worked)

`deploy3.out`, `add-game*.json`, `proofs.json`. This chain's kona-client
prestate built reproducibly in 135 s (`prestate-build.tail.out`); the interop
variant is `0x03bb8afa…5f4988` (`prestate-super.txt`). The Safe delegatecalled
`opcm.upgrade` to register SUPER_CANNON_KONA (9) with a 0.001 ETH init bond:
tx `0x350f4dc3…78c5`, 2,155,775 gas (1,525,323 on the old-rules fork). The
anchor is still the `0xdead…` placeholder, so the respected game stays
SUPER_PERMISSIONED (5). Game 9 becomes respected only after a type-5 game
finalizes, about 7 days from now (re-run `deploy-l1.sh` after 2026-11-13).

## Devnet stack

`l2/devnet/up.sh` against real Sepolia. Sequencer L1: publicnode (execution
and beacon). Replica and challenger L1: ethpandaops (execution and Lodestar
beacon). Three flags were wrong for these releases and were fixed in
`l2/devnet/compose.yml`:

- op-batcher v1.18.0 takes `--batch-type=1`, not `span`.
- op-batcher's DA throttling calls `miner_setMaxDASize`, so the sequencer's
  op-reth must serve the `miner` API.
- op-challenger v1.11.0 has **no `super-permissioned` game type** (its valid
  types: alphabet, cannon, cannon-kona, permissioned, fast, super-cannon-kona,
  zk). It also wants the generic `--rollup-config`, `--l2-genesis`,
  `--depset-config` and `--prestates-url` flags, not the `super-cannon-kona-*`
  variants. The challenger now plays only game 9. Nothing defends type-5
  games, which only the proposer can create.

The sequencer started 40 minutes after its genesis time and sealed the
backlog of 2 s blocks in a few minutes. The batcher started posting blobs at
once. The proposer created its first SUPER_PERMISSIONED game at L1 block
12073033.

## L2 funding by portal deposits (forced-inclusion path)

`portal-deposits.jsonl`, `deposit-inclusion.jsonl`. The deployer called
`OptimismPortal.depositTransaction` four times (0.002 ETH each to the owner,
publisher, user and runner): 128,998–129,026 gas each. The deposits landed in
L2 blocks 2320–2325. One later deposit, made with the chain in steady state,
reached the L2 **52 s** after its L1 receipt (4-block confirmation depth).
Replayed under the old rules the deposit uses 128,489 gas
(`deposit-replay-osaka.json`), so the repricing barely affects it.

## Enclave contracts and flows on the L2 (worked)

`flows.json`. `l2/enclave-flows.mjs` compiled the contracts from `main` with
production's pinned settings. EnclaveDeployments (Ledger) and
EnclaveAppCatalog again equal Base's runtime code (immutables and library
links masked); EnclaveRegistry on `main` is schema 5, not production's pinned
schema-4 build. It deployed them unchanged on the L2 together with a
3009-capable mock USDC. Then it ran **41 transactions, all successful**:

| step | L2 gas |
|---|---|
| deploy EnclaveDeployments / EnclaveAppCatalog / EnclaveRegistry | 5,500,225 / 5,016,876 / 1,800,364 |
| catalog.publishVersion | 451,091 |
| catalog.setApproval (owner) | 53,469 |
| registry.register | 306,223 |
| registry.setPayoutWallet | 30,740 |
| ledger.create (×9, warm) | 347,875 |
| ledger.fund (×9, warm) | 131,735 |
| ledger.claim (×9) | 195,938 |
| ledger.renew (single) | 97,456 |
| ledger.multicall renew ×8 | 416,814 (52,102 per renew) |
| ledger.release | 62,698 |

The L1 data fee on every receipt was 269–1,060 wei, because Sepolia's blob
base fee was 1–4 wei. The batching saving holds: one multicall of 8 renews
costs 0.53× of 8 single renews.

## Replica derived the chain from Sepolia alone (worked)

`replica-check.json`, from `l2/devnet/check-replica.sh`. The replica (p2p
off, its own datadir, JWT, execution RPC and beacon provider) reached safe
head 2490, past every flow transaction. It matched the sequencer's block hash
and state root at all 51 compared heights (every 50th block and the target)
with **0 mismatches**. The runtime code of all 5 deployed contracts is
identical on both. Its op-reth datadir was **8.5 MB** (the sequencer's was
7.8 MB) after about 2,700 blocks.

## Fault-proof program against live blocks

`run-trace.out`. `op-challenger run-trace --run super-cannon-kona/enclave/<prestate>`,
fed by the replica, executed this chain's kona-client prestate in cannon
against live super roots. It printed `Successfully verified output root` 3
times, with no failures, in the first ~15 minutes. Release gate 2 asks for 24 h.

## Posting costs, measured from L1 receipts

`posting-costs.json` (default tip), `posting-costs-lowtip.json`, `proposal-replay-osaka.json`,
from `l2/devnet/measure-posting.mjs`.

| | measured on Sepolia | under mainnet's current rules |
|---|---|---|
| batch post | 15,000 gas + 1 blob, 26 of 26 posts | 21,000 gas + 1 blob (intrinsic cost) |
| proposal (`DisputeGameFactory.create`, game 5) | 1,163,650 gas | 252,492 gas (fork replay) |
| portal deposit | 129,014 gas | 128,489 gas (fork replay) |
| largest channel (all 41 flow txs) | 72,875 bytes in, 30,190 bytes out = 23% of one blob | n/a |
| idle channel (42–121 blocks) | 56–185 bytes in, 84–143 bytes out | n/a |

op-batcher and op-proposer default to a **1 gwei minimum tip**. With it each
post paid 1.44e-5 ETH, almost all tip. With
`--txmgr.min-tip-cap=0.001` (now the `up.sh` default) a post confirmed in the
next block and paid 1.5e10 wei, 960× less. The mainnet monthly bill priced
from these numbers is in DESIGN.md §4: $10.4 at 0.05 gwei and $207 at 1 gwei
for 15-minute batches and daily proposals.

Sepolia ETH spent so far: 0.09 − (0.0327 deployer + 0.0334 in role wallets) =
0.024 ETH. Most of it is op-deployer's 1 gwei tip on the SuperchainConfig
bootstrap.

## Not done yet

- Game resolution, bond reclaim, anchor move and making game 9 respected:
  wait for the first type-5 game to finalize (after 2026-11-13).
- Forced inclusion with the sequencer withholding (the 12 h window).
- A 24 h `run-trace` and a 24 h cost series at the recommended intervals.
