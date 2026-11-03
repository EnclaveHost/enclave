# l2/: Enclave L2 tooling (testnet)

An OP Stack L2 that settles on Ethereum and carries only Enclave's own
traffic. The design is in `ops/enclave-l2-20261103/DESIGN.md`, and the evidence
from the Sepolia devnet sits beside it. **Nothing here touches production.**
The scripts refuse production chain ids, and Base stays the production chain
until a migration is approved separately.

| file | what it does |
|---|---|
| `deploy-l1.sh` | Deploys the L1 contracts with op-deployer (SUPER_PERMISSIONED genesis), builds this chain's kona-client prestate, adds SUPER_CANNON_KONA through `opcm.upgrade` from the Safe, and makes it the respected game. Resumable by stage. |
| `safe.mjs` | A 1-of-1 Safe v1.4.1 (create / exec / delegatecall). It is the L1 ProxyAdmin owner, because OPCM v2 must be delegatecalled. |
| `kona-custom-configs.mjs` | Converts `rollup.json` into the `KONA_CUSTOM_CONFIGS_DIR` inputs (chainList / configs / depsets) for the reproducible prestate build. |
| `enclave-flows.mjs` | Compiles Registry, Ledger and Catalog from `contracts/` with production's pinned settings, checks them against Base runtime code, deploys them to the L2 and runs publish → approve → register → create → fund → claim → renew (single and multicall) → release, recording L2 gas and the L1 data fee of every receipt. |
| `devnet/compose.yml`, `devnet/up.sh` | Run the sequencer (op-reth + op-node), batcher, proposer, challenger and an independent replica (p2p disabled, its own Sepolia RPC and beacon provider). |

Keys are read from a directory of `<role>.key` files kept outside the repo
(`~/.config/enclave-l2-devnet/keys` on the devnet host). They never go on a
command line, and `up.sh` writes them only into 0600 env files under
`$DEVNET`.
