# Enclave L2: Sepolia-fork rehearsal (2026-11-03)

Evidence, not source. The tooling lives in `l2/`. Everything here ran against
`anvil --fork-url https://ethereum-sepolia-rpc.publicnode.com` (chain id
11155111, forked near Sepolia block 12054755), so it used Sepolia's real
OPContractsManager (`0x6abfabbc793883add5fa308a97163e8225a9f4ca`, version
8.0.1) without spending real Sepolia ETH. The fork addresses below exist only
on the fork.

Tool versions (all official releases; image digests are pinned in `l2/devnet/compose.yml`):

| tool | version | digest |
|---|---|---|
| op-deployer | 0.8.1 (`319e3da9`, 2026-10-13) | tarball sha256 `6002a65a…fbe0a`, matches the GitHub release digest |
| op-node | v1.20.0 | `sha256:47436354…1726ea` |
| op-reth | v2.8.0 (op-geth is end-of-support since 2026-05-31 and cannot follow Karst) | `sha256:c843f5a9…af9776c` |
| op-batcher | v1.18.0 | `sha256:cd80d0c7…9a9719` |
| op-proposer | v1.17.0 | `sha256:ef260f24…c4044b` |
| op-challenger | v1.11.0 (bundles kona-host v1.9.0) | `sha256:c9d4d81b…be40a` |
| kona-client prestate source | monorepo tag `kona-client/v1.9.0` (commit `1286a886`) | built with `rust/kona/docker/fpvm-prestates/cannon-repro.dockerfile` |

The official docs (docs.optimism.io, "Creating your own L2 rollup testnet")
name op-deployer as the deployment tool and op-reth as the execution client.

## Attempt 1: permissionless CANNON_KONA from genesis (failed)

`attempt1-cannon-kona/`. The intent set `respectedGameType = 8`.
`op-deployer prepare` refused:

    initial dispute game type CANNON_KONA (8) is not deployable by the OPCM at 0x6AbfAbBC…: it has
    SUPER_ROOT_GAMES_MIGRATION enabled, which accepts only SUPER_CANNON_KONA (9) or SUPER_PERMISSIONED (5)

Switching to type 9, `prepare` worked and computed a super-root genesis
anchor. A custom kona-client prestate was then built with our rollup config
embedded (`l2/kona-custom-configs.mjs` produced the inputs). The build log shows
`kona-registry@0.4.5: debug: merging custom chains sepolia: [Enclave L2 Devnet]`,
and it took **284 s** on this 32-core host. Interop (super) variant prestate:
`0x0370ab39…7670c51`. `op-deployer prestate` committed it. Then
`op-deployer continue` refused before sending anything:

    simulated deployment validation failed … OPContractsManagerStandardValidator:
    OVERRIDES-L1PAOMULTISIG,OVERRIDES-CHALLENGER,SYSCON-130

A permissionless initial deployment runs OP's StandardValidator. That
validator accepts only OP's own L1 ProxyAdmin owner (the Security Council
multisig), OP's challenger and OP's shared SuperchainConfig. Enclave keeps
independent authorities (AGENTS.md), so this path is closed to it. Nothing was
broadcast: 0 transactions, 0 wei.

## Attempt 2: permissioned genesis, then add the permissionless game (worked after three fixes)

`attempt2-standard-validator/`.

1. Deploying with `respectedGameType = 5` (SUPER_PERMISSIONED) and Enclave
   roles succeeded. The validator only runs for permissionless initial games.
   This took one OPCM.deploy transaction, gas limit 8,968,443.
2. `op-deployer manage add-game-type-v2` produces calldata for
   `OPContractsManagerV2.upgrade`. The L1 ProxyAdmin owner must **delegatecall**
   it (the script etches a DummyCaller at the owner address), and an EOA cannot
   do that. The owner became a 1-of-1 Safe v1.4.1 (`l2/safe.mjs`). Production
   should use a Safe whose signer is the Trezor anyway.
3. Two config errors came up on the way:
   - `math/big: cannot unmarshal "\"0x38d7…\""`: `initBond` must be a JSON number.
   - `OPContractsManagerV2_InvalidGameConfigs()` (selector `0x7c165cd6`): OPCM v2
     wants one entry for each of the six valid game types, in its fixed order
     (CANNON, PERMISSIONED_CANNON, CANNON_KONA, SUPER_PERMISSIONED,
     SUPER_CANNON_KONA, ZK). Disabled entries carry bond 0, and
     SUPER_PERMISSIONED must carry bond 0.
4. The Safe delegatecall then registered game 9 with a 0.001 ETH init bond. My
   first `safe.mjs` reported a false "ExecutionFailure", because its event ABI
   left `txHash` unindexed. That was fixed. The guardian (Enclave's own
   SuperchainConfig) then called `AnchorStateRegistry.setRespectedGameType(9)`:
   55,483 gas.

## Attempt 3: the whole pipeline as one script (passed)

`attempt3-scripted/`. `l2/deploy-l1.sh` runs every stage above in order and
can be resumed. Its first run collided with the Safe CREATE2 salt left over
from attempt 2 on the same fork (`Create2 call failed`). `SAFE_SALT` now
overrides the salt. The second run passed every stage. `proofs.json` reads
back from L1:

- L1 ProxyAdmin owner = the Safe
- respected game type = 9 (SUPER_CANNON_KONA)
- game 5 kept as the guardian's fallback
- game 9 init bond = 1e15 wei
- the absolute prestate = this chain's own kona build

## Enclave contracts on a plain anvil (flows harness check)

`rehearsal-anvil-flows/flows.json`. `l2/enclave-flows.mjs` compiled Registry,
Ledger and Catalog from `contracts/` on `main` with production's pinned
settings (`contracts/deployments/source-verification-base.json`, solc 0.8.35)
and compared them with what Base mainnet runs:

| contract | source sha256 = production pin | compiled runtime = Base runtime (immutables and library links masked) |
|---|---|---|
| EnclaveDeployments (Ledger) `0xb178…117b` | yes | **yes**, 24,368 bytes |
| EnclaveAppCatalog `0x1841…26e3` | yes | **yes**, 22,733 bytes |
| EnclaveRegistry `0x868e…ccac` | no: main is schema 5, production is the pinned schema-4 build | no (8,079 vs 5,892 bytes) |

The flows all succeeded on anvil, which has no L1 fee. Gas used, including the
21k intrinsic:

- publishVersion 451,091
- register 306,199
- create 382,075 (347,875 warm)
- fund 165,935 (131,7xx warm)
- claim 195,938
- **renew 69,107**
- **multicall of 4 renews 196,268, i.e. 49,067 per renew**
- release 54,920

The Sepolia devnet numbers, with real L1 data fees, are in `sepolia/`.

## Correction: attempt 3 made game 9 respected too early

After attempt 3, an attempt to create a game-9 proposal on the fork reverted
with `BadExtraData`. The reason: `AnchorStateRegistry.getAnchorRoot()` returned
`0xdead…0000` at sequence 0, OP's placeholder. A SUPER_PERMISSIONED genesis
leaves the placeholder anchor in place, and `opcm.upgrade` rejects an
`overrides.cfg.startingAnchorRoot` instruction (only
`overrides.cfg.startingRespectedGameType` is permitted,
`OPContractsManagerV2._isPermittedInstruction`). The anchor moves only when a
respected game resolves and finalizes and `setAnchorState` is called. On
standard parameters that takes about 3.5 days of clock plus a 3.5-day
finality delay.

Respecting game 9 on a placeholder anchor would have every permissionless game
start from a root that no honest challenger can prove against. So
`deploy-l1.sh` now registers game 9 but leaves SUPER_PERMISSIONED respected
while the anchor is the placeholder. The proposer starts on type 5
(`PROPOSER_GAME_TYPE`). Making game 9 respected is a dated follow-up step and a
mainnet release gate (see DESIGN.md). The kona prestate and config are checked
now, against live blocks, with `op-challenger run-trace`.
