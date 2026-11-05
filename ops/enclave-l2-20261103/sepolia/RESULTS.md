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

`deploy.log`, `continue.log`. The Safe and Enclave's SuperchainConfig deployed
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
   (`continue-fork.log`). It mined a single OPCM.deploy (fork tx `0xbb2158b3…80a4`)
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
