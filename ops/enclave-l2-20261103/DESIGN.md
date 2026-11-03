# Enclave L2: design (2026-11-03)

**Status: design plus a Sepolia devnet. Not production-ready.** Base (8453)
stays the production chain until a migration is approved separately. Nothing
here changes the Base contracts, the catalog or any production VM. Numbers
marked *measured* come from `rehearsal-*` and `sepolia/` in this directory;
everything else is an estimate and says so.

## 0. Summary

- **Chain.** An OP Stack L2 that settles on Ethereum and posts its data in
  blobs (or `auto`, see §4). ETH pays gas. It uses Enclave-owned authorities:
  its own SuperchainConfig and guardian, an L1 ProxyAdmin owner that is a Safe
  signed by the owner's Trezor, and its own challenger. Tooling: op-deployer
  0.8.1, op-reth v2.8.0, op-node v1.20.0, op-batcher v1.18.0, op-proposer
  v1.17.0, op-challenger v1.11.0. These are the releases the official docs
  recommend today. op-geth is end-of-support and cannot follow Karst.
- **Proofs.** Sepolia's (and mainnet's) current OPCM runs *super-root* games,
  so the permissionless game is SUPER_CANNON_KONA (type 9) with a kona-client
  prestate built for this chain.
  - A permissionless *genesis* is refused for non-OP authorities, so the chain
    starts on SUPER_PERMISSIONED (5) and adds 9 through `opcm.upgrade`.
  - Game 9 can be made respected only once a finalized type-5 game has replaced
    the placeholder anchor, about 7 days after launch. *Measured on a fork*:
    REHEARSAL.md.
- **Contracts.** Enclave's Ledger and Catalog sources on `main` compile to
  **exactly** the runtime code Base runs. Registry on `main` is one schema newer
  than production. The flows harness deploys all three unchanged and runs
  publish/create/claim/renew/release (`l2/enclave-flows.mjs`).
- **Leases live in the Ledger, not the Registry.** `EnclaveDeployments.renew`
  is the 30-minute traffic, and `claim` calls `registry.get` in the same
  transaction. So "Registry leases first, then the Ledger" cannot work as
  written: Registry and Ledger must sit on the same chain (§6).
- **Cheapest win, available today on Base with no contract change:** have each
  runner batch its renewals through `Ledger.multicall`, and have the owner
  raise `leaseSec` (owner-settable from 60 s to 1 day).
  - *Measured*: one renew costs 69,107 gas; a batch of 4 costs 49,067 gas per
    renew. One transaction per host per period replaces one per deployment.
  - A 2 h lease quarters the renewal count.
- **USDC.** Keep the Ledger and payments on Base through the transition (§5).
  Bridged USDC Standard is the right end state for an Enclave-only chain. But
  the funding path (Base → CCTP → L1 → L2) and the 7-day exit for host payouts
  are real friction, and it needs Circle's cooperation to become native.
- **Costs.** An L2's L1 bill is a fixed cost of the chain, not a per-host cost.
  At 0.05 gwei, with 15-minute batches and daily proposals, it is roughly
  $10–12 a month whatever the number of hosts. At 1 gwei it is roughly
  $200–230 (§4). Against Base's ~$2/host/month for leases, the fee case
  breaks even at roughly 6 hosts at 0.05 gwei and ~115 hosts at 1 gwei. The
  stronger reason for the L2 is the node: a replica stores only Enclave's chain
  plus whatever L1 access it uses (§7), not 1.7 TB of Base.

## 1. Architecture

```
                         Ethereum L1 (Sepolia on the devnet)
  ┌─────────────────────────────────────────────────────────────────────────────┐
  │ OptimismPortal (deposits = forced inclusion)   SystemConfig   BatchInbox    │
  │ DisputeGameFactory + AnchorStateRegistry (games 5, 9)   Enclave SuperchainConfig│
  │ L1 ProxyAdmin owner = Safe (Trezor)            guardian = Enclave key        │
  └──────▲───────────────▲──────────────────▲────────────────────▲──────────────┘
         │ blobs         │ proposals        │ moves/bonds        │ L1 blocks + blobs
   ┌─────┴─────┐   ┌─────┴─────┐      ┌─────┴──────┐   ┌─────────┴──────────────┐
   │ op-batcher│   │op-proposer│      │op-challenger│   │ host replica (any host) │
   └─────▲─────┘   └─────▲─────┘      └─────▲──────┘   │ op-node (derive only,   │
         │               │ super roots      │          │ p2p optional) + op-reth │
   ┌─────┴───────────────┴─────┐            │          └──────────▲──────────────┘
   │ sequencer: op-node + op-reth │◄─── txs ── hosts' runner keys, users, publishers
   │ in an attested SEV-SNP VM    │            └─ plays games against a replica, not the sequencer
   └──────────────────────────────┘
```

| role | key / authority | where it runs | why |
|---|---|---|---|
| sequencer (op-node `--sequencer.enabled` + op-reth) | unsafe-block signer (in-guest key, §2) | attested SNP VM | orders transactions, 2 s blocks |
| batcher (op-batcher) | batcher EOA (SystemConfig `batcherHash`) | same VM as the sequencer | posts channels to the BatchInbox |
| proposer (op-proposer, `--superroot-rpcs`) | proposer EOA for game 5; game 9 is open to anyone | any host | posts super roots for withdrawals and the anchor |
| challenger (op-challenger, kona-host + cannon) | any funded EOA | at least two operators, using **replicas** | disputes invalid roots; permissionless on game 9 |
| replica (op-node + op-reth) | none | every host that wants to verify | derives the chain from L1 only |
| L1 ProxyAdmin owner | Safe v1.4.1, signer = owner's Trezor | L1 | upgrades; must delegatecall OPCM v2 |
| guardian | Enclave key (its own SuperchainConfig) | L1 | pause, respected game type, blacklisting |
| SystemConfig owner, L2 ProxyAdmin owner | owner (Trezor) | L1 / L2 | fee scalars, gas limit, batcher key rotation |

Chain parameters (devnet, *measured* from rollup.json and L1 reads): 2 s
blocks, 60M gas limit, sequencing window 3,600 L1 blocks (12 h), max sequencer
drift 600 s, channel timeout 300 L1 blocks, all forks through Karst active at
genesis. Withdrawals use proof maturity 7 d, dispute finality delay 3.5 d,
game max clock 3.5 d, clock extension 3 h, game depth 73, split depth 30, and
a DelayedWETH delay of 3.5 d.

Own SuperchainConfig, not OP's Sepolia one. OP's shared SuperchainConfig
would give OP's guardian the power to pause Enclave's withdrawals. With its
own, the pause power belongs to Enclave alone. The cost: Enclave is not part
of the Superchain's standard configuration and cannot use OP's
StandardValidator path (REHEARSAL.md, attempt 1). That is the intended trade
under AGENTS.md (independent authority selection).

## 2. The sequencer in an attested SEV-SNP VM

This section reuses the RPC VM's patterns as they exist in `rpc/snp/`.

**The image.** Build it exactly like the RPC image:

- `rpc/snp/build_image.py` boots a sha256-pinned base image and installs
  pinned binaries, here op-node, op-reth and op-batcher, checked by sha256 as
  `rpc/guest/chain_service.py` checks reth and Lighthouse.
- The root partition is extracted and `veritysetup format` produces the root
  hash. The kernel cmdline is
  `root=/dev/mapper/vroot ro enclave.roothash=<hash> overlayroot=tmpfs`.
- The initramfs (`enclave-verity-hook`, `enclave-verity-local-top`) opens
  `vroot` or panics.

**What lives on the verity root.**

- `rollup.json`, `genesis.json`, the chain id and the L1 identity (Sepolia or
  mainnet genesis hash, beacon `genesis_validators_root`).
- The pinned prestate hash.
- A `chain.json` naming the batch inbox and SystemConfig.

`chain_service.py` already hard-codes and checks chain identity this way.
There is no runtime injection: changing any of these changes the measurement.
The chain data disk (op-reth datadir, op-node safedb) is a separate plaintext
qcow2 as on the RPC VM (`launch.py:84-98`). That is acceptable, because
everything on it is public chain state that the L1 can re-derive. A host that
tampers with it can make the sequencer crash or diverge, but cannot make it
produce a block that L1 derivation will accept differently. Derivation from L1
is the source of truth.

**Launch and measurement.** QEMU direct boot with OVMF and
`kernel-hashes=on` (`launch.py:58-77`). The launch measurement comes from
`sev-snp-measure --mode snp --vcpus N --ovmf --kernel --initrd --append`
(`release.py:33-38`) and is published in the catalog version's
`config.snp.measurements`, as for RPC. **HOST_DATA** carries the
EnclaveDeployments deployment id (`launch.py:14-18`), so one measured image
serves any deployment and the consumer checks it against the chain
(`attested-fetch.mjs:77-79`).

**Keys, generated in the guest.** The RPC VM "holds no keys and signs nothing"
(`release.py:17-20`). The sequencer is different: it signs unsafe blocks
(p2p) and the batcher signs L1 transactions. Proposal:

1. At first boot the guest generates the **unsafe-block signer** and the
   **batcher** keys from the SNP derived-key interface. This is new code: today
   nothing in `rpc/` uses `MSG_KEY_REQ`, and `identity.py` only makes the
   engine JWT. Derive them from the measurement plus HOST_DATA, or generate
   them randomly and seal them with a derived key, so they never leave the
   guest.
2. The guest puts `keccak(pubkeys) || channel-key hash` in REPORT_DATA, as
   `front.py` does for the TLS SPKI (`front.py:43-76`).
3. The owner (Trezor) then sets them on L1:
   - SystemConfig `setUnsafeBlockSigner(addr)` and
     `setBatcherHash(addr)`, only after verifying a quote whose REPORT_DATA
     binds those addresses.
   - That makes the L1 the public record that *this* attested VM is the
     sequencer. Rotating the VM means a new quote and a new SystemConfig
     transaction.
4. The batcher key needs a little ETH. Fund it from the owner. A compromised
   host can at worst stop the VM. It cannot extract the key without breaking
   SNP.

**How consumers verify they are talking to the attested sequencer or a
replica.** Same mechanism as RPC today:

- `GET /.well-known/enclave-attestation` serves `{report, certificate,
  reportData, measurement}`.
- The consumer calls `createAttestedFetch` (`rpc/snp/attested-fetch.mjs:47`):
  - checks that the served certificate's SPKI matches the document;
  - runs `verifyQuote` (`relay/snp-verify.mjs:285`): VCEK → ASK → pinned ARK,
    VMPL 0, no debug or migration, measurement on the allowlist;
  - checks REPORT_DATA[0:32] = sha256(SPKI) and HOST_DATA = deployment id;
  - pins the SPKI.
- `chain-policy.mjs:56-81` (`resolveDeploymentPolicy`) supplies the allowlist
  from the on-chain deployment and catalog version, read from ≥2 agreeing RPCs.

Two additions for the sequencer:

- **Bind the sequencer's identity to L1.** The verifier also reads
  SystemConfig `unsafeBlockSigner()` and `batcherHash()` and requires them to
  equal the addresses in REPORT_DATA[32:64], which is unused today. Then "the
  attested VM" and "the chain's sequencer" are provably the same.
- **Close the gaps the review of `rpc/snp` found.**
  - No fresh nonce: the report is generated once per boot. Add a challenge
    endpoint so a consumer can demand a fresh report.
  - The TCB is not judged unless `minTcb` is passed. Pass a committed floor, or
    use the stricter `verifier/snp.mjs`.
  - REPORT_DATA[32:64] is not checked.

  These apply to RPC as well. Track them as one change.

**What attestation does not buy.** A replica verifies the chain by derivation,
not by trusting the sequencer's attestation (§7). Attestation answers "is the
unsafe head I'm reading from the sequencer honest *right now*", which matters
for the 2 s pre-confirmations that leases and admission may want before a
batch lands. Safety still rests on L1 derivation plus fault proofs.

## 3. Censorship resistance

**Forced inclusion (works from day one).** Anyone can call
`OptimismPortal.depositTransaction` on L1, including a host renewing its lease
when the sequencer ignores it. L2 transactions from deposits are part of
derivation:

- **While the sequencer runs,** it must keep its L1 origin within
  `max_sequencer_drift` (600 s) of wall-clock time, and every L1 origin it
  adopts forces that block's deposits into the next L2 block. So a censored
  deposit lands in **≈ 10 min plus L1 confirmation depth**.
- **If the sequencer withholds batches or goes offline,** derivation
  auto-generates blocks with the deposits once the **sequencing window (3,600
  L1 blocks ≈ 12 h)** passes. Worst case ≈ 12 h.
- The lease quantum is 30 min, so a host relying on forced inclusion for
  renewals needs `leaseSec` comfortably above 12 h to be immune to a hostile
  sequencer, or it accepts takeover risk. This is one of the reasons to raise
  `leaseSec` (§6).

Forced inclusion costs one L1 deposit (~60–90k L1 gas, estimate). That is an
escape hatch, not the normal path.

**Exit.** Withdrawals need a resolved, respected game: 3.5 d clock plus 3.5 d
finality delay, plus 7 d proof maturity running in parallel, ≈ 7 days. They
are trustless only once game 9 is respected (§1 and the release gates).

**Decentralizing the sequencer later. Two paths, recommended order:**

1. **Rotation among attested Enclave hosts.** Several hosts run the measured
   sequencer image. One is active. Leadership passes by an L1 or L2 schedule
   (op-conductor style, but with attestation as the admission rule instead of
   operator identity). Rotation is a SystemConfig change of
   `unsafeBlockSigner` / `batcherHash`, so today it needs the SystemConfig
   owner. To make it permissionless, deploy a small **SequencerElection**
   contract as SystemConfig owner's delegate. It accepts a candidate only with
   a valid SNP quote (verified on chain via an AMD-chain-checking verifier
   contract, or by an optimistic window in which any host can veto with a
   counter-quote). A rotation needs no change to OP Stack code.
2. **Based sequencing** (L1 proposers order the L2). It removes the sequencer
   entirely but gives up 2 s soft confirmations and needs a different
   derivation pipeline: not in the OP Stack today, and no op-deployer support.
   Revisit it if rotation proves operationally fragile.

## 4. L1 costs (posting batches plus proposals)

### Assumptions

- ETH = $2,261.
- Execution gas price at **0.05 gwei** and at **1 gwei**, priority fee
  ignored.
- **Blob fee.** Since Fusaka (EIP-7918) the blob base fee does not usefully
  fall below its reserve price, `base_fee × 8192 / 131072`. So one blob costs
  at least `8192 × base_fee` in execution-gas terms:
  - 409.6 gwei (4.1e-7 ETH) at 0.05 gwei;
  - 8,192 gwei (8.2e-6 ETH) at 1 gwei.
  
  The table uses that floor. If the blob market is congested above it, add
  131,072 × (blob base fee) per blob. At 1 gwei of blob base fee that is
  1.3e-4 ETH ($0.30) per blob.
- **Batch transaction.** One type-3 transaction with one blob costs 21,000
  execution gas (no calldata) plus the blob. An Enclave-only chain fits a
  whole posting period of 2 s blocks in one blob: span batches plus brotli
  compress empty blocks to a few bytes each. *Measured on the devnet*:
  `sepolia/RESULTS.md`.
- **Proposal.** One `DisputeGameFactory.create` of a super-root game, plus
  resolution and bond reclaim. Estimate **600k L1 gas per proposal, all in**;
  the devnet measures it (`sepolia/RESULTS.md`).

### Per-post cost

| | 0.05 gwei | 1 gwei |
|---|---|---|
| batch (21k + 1 blob at floor) | 1.46e-6 ETH = $0.0033 | 2.92e-5 ETH = $0.066 |
| proposal (≈600k, estimate) | 3.0e-5 ETH = $0.068 | 6.0e-4 ETH = $1.36 |

### Monthly (30 d)

| batch interval (`--max-channel-duration`) | posts/mo | 0.05 gwei | 1 gwei |
|---|---|---|---|
| 5 min (25 L1 blocks) | 8,640 | $28.5 | $570 |
| 15 min (75) | 2,880 | $9.5 | $190 |
| 1 h (300) | 720 | $2.4 | $47.5 |
| 6 h (1,800) | 120 | $0.40 | $7.9 |

| proposal interval | posts/mo | 0.05 gwei | 1 gwei |
|---|---|---|---|
| 1 h | 720 | $48.8 | $977 |
| 24 h | 30 | $2.0 | $40.7 |
| on demand (withdrawals only) | ~0–5 | ≤ $0.3 | ≤ $7 |

**Recommended start: 15-minute batches and daily proposals.** That is
≈ $11.5/mo at 0.05 gwei and ≈ $231/mo at 1 gwei, regardless of host count.
Bonds (0.001 ETH on the devnet; OP standard 0.08 ETH) are locked about 7 d per
game and returned. Proposals are the dominant cost lever and matter only for
L1 withdrawals and for advancing the anchor. Nothing on the L2 itself waits
on them.

### Tuning

- `--max-channel-duration` sets the batch interval. It must stay well under
  the 12 h sequencing window: use ≤ 6 h with a margin.
  - **The trade-off is the safe-head lag.** A replica that derives from L1
    sees a lease renewal only after its batch lands. With 30-minute leases and
    hourly batches, a derive-only replica can see a renewal *after* the lease
    it extends would have expired.
  - So either keep batches ≤ 15 min, or raise `leaseSec` to ≥ 2 h and post
    hourly. The second is cheaper and is recommended once leases are
    lengthened (§6).
- `--data-availability-type auto` lets op-batcher pick calldata when it is
  cheaper. For a few hundred compressed bytes per post, calldata
  (21k + ~10 gas per token, EIP-7623) is roughly break-even with a floor-priced
  blob (21k + 8,192). Blobs win as volume grows. The devnet runs `blobs` to
  match the decision; `auto` is a safe production setting.
- Proposals: daily by schedule, plus on demand when a withdrawal is pending.
  Game 9 is permissionless, so a withdrawing user can also propose for
  themselves.
- The fees users pay on the L2 reimburse the L1 data cost through the Ecotone
  scalars (`l1Fee` on every receipt, recorded per transaction by
  `enclave-flows.mjs`). Set `minBaseFee` to 0 and keep the operator fee at 0.

### Comparison

Leases on L1 directly cost about $17/host/mo at 0.052 gwei (brief), and on
Base about $2/host/mo. The L2's L1 bill is fixed, so it beats Base on fees
above ~6 hosts at 0.05 gwei and above ~115 hosts at 1 gwei. Below that, the L2
is justified by node size and control, not by fees.

## 5. USDC: Bridged USDC Standard vs keeping payments on Base

**Facts.** The Ledger takes payments in USDC (`fund` → `transferFrom`;
`fundWithAuthorization` on the EIP-3009 path) and burns lease time from a USDC
balance. ETH funding needs a Chainlink ETH/USD feed, which an Enclave-only
chain will not have. `claim` and `renew` are in the same contract as the
balance.

**Option A: Bridged USDC Standard on the L2.**

- Deploy Circle's FiatToken on L2 behind a proxy, minted by the standard
  bridge against an L1 lockbox, with the ownership and upgrade hooks Circle
  needs to take over and convert it to native USDC later.
- Users fund by moving USDC from Base to L1 (CCTP, minutes) and then
  depositing to the L2 (minutes): two hops and two transactions.
- Host payouts exit the other way at L1 speed: 7 days through the fault-proof
  bridge, or faster through a third-party bridge's liquidity.
- Circle's takeover depends on Circle. Until then the bridged token's
  security is the L2's own bridge.

**Option B: keep the Ledger and payments on Base during the transition (recommended).**

- Nothing changes for payers or payees.
- Lease cost on Base drops several-fold with no contract change: batch
  renewals plus a longer `leaseSec` (§6).
- The L2 runs the Registry, Ledger and Catalog on a **devnet/testnet lane**
  until it has met its release gates. Bridged USDC goes on the L2 only when
  the Ledger itself moves.

**Recommendation: B now, A when the Ledger moves.** Until there is a fee
reason to move the Ledger (§4), a second USDC adds friction without saving
money.

## 6. Migration order, and making leases cheaper first

**Correcting the premise.** Leases (`claim`, `renew`, `release`) are functions
of the **Ledger** (`EnclaveDeployments.sol:1095-1170`, `leaseSec = 1800`), and
`claim` reads `registry.get(enclaveId)` synchronously (`:1098`). The Registry's
own write traffic is rare: register at boot, price changes, payout wallet. No
periodic heartbeat is sent (contracts/README.md). So:

- Moving the Registry first moves almost no traffic and *breaks* `claim` on
  Base, which would read a stale or empty registry.
- The Ledger and the Registry have to move together. The Catalog can follow or
  stay: runners read it, and the Ledger does not call it.

**Step 0, on Base, now (no contract change).**

- **Batch renewals per host.** `supervisor.js` sends one `renew` transaction
  per deployment (`sendLeaseTx("renew", [rec.id])`, `:10879`). The Ledger's
  `multicall` delegatecalls itself and keeps `msg.sender`
  (`EnclaveDeployments.sol:1596`). So a runner can renew all its leases due
  in the next margin in one transaction.
  - *Measured*: 69,107 gas for one renew; 196,268 for four, i.e. 49,067 each.
  - The saving per renew is 29% on gas plus one L1-data overhead per host
    instead of per deployment, which matters on Base, where most of the fee is
    L1 data.
  - Constraint: `multicall` is atomic, so one reverting renew (for example
    "over rate cap") reverts the batch. Simulate first and drop failing rows,
    or fall back to single renews for the failures.
- **Lengthen the lease.** `setLeaseSec` is owner-only, bounded 60 s – 1 day
  (`:1688-1692`).
  - 2 h quarters the renewals.
  - The cost of a longer lease is the failover bound: a dead runner holds the
    work until its lease expires. The reachability watchdog and `release()`
    (refunds the unused tail) cover the common cases.
  - A 2 h lease also makes forced inclusion on the L2 a credible fallback
    within the lease.
- Together, 2 h leases batched four to a transaction cut lease gas to about
  0.18× today's. These are owner and supervisor changes and need their own
  approval. They are not made here.

**Step 1: an L2 lane for new deployments (after the release gates).** Deploy
Registry, Ledger and Catalog on the L2, unchanged, as the devnet does. Add an
optional second ledger to the supervisor, keyed by chain. New deployments
choose a lane. Payments on the L2 need Bridged USDC (§5), so Step 1 waits for
that decision.

**Step 2: move the remaining deployments.**

- The Ledger already has owner-only, sealable migration imports:
  `importDeployments`, `importFees`, `importEarn`, `importCaps`, `sealImports`
  (`:1472-1584`), with `scripts/ledger-cutover-rehearsal.mjs`.
- Balances are USDC, so the USDC escrow must move first:
  - bridge it via CCTP to L1, then into the L2 bridge;
  - import the records on the L2;
  - `setActive(false)` on Base.
- Rehearse it on the devnet before proposing it.

## 7. How a host verifies the chain

**From L1, a replica needs:**

- **Execution:** L1 block headers and receipts (deposits, SystemConfig
  updates, batcher-sender checks), plus `eth_getBlockByNumber` for the L1
  origin chain.
- **Blobs:** the beacon API `blob_sidecars` for every L1 block that carries a
  batch, within the ~18-day blob retention window. A replica that syncs later
  than that needs a blob archive, or must start from a trusted, attested
  snapshot whose output root matches a finalized game.

**Is a light L1 client enough?**

- *For execution data, yes in principle.* A light client (Helios or an
  equivalent sync-committee client) gives verified headers. Receipts and logs
  are checked against `receiptsRoot` by Merkle proof, and blob sidecars against
  the KZG commitments in the beacon block body (`rpc/snp/beacon-patch.py`
  already verifies blob KZG proofs).
- *Today's op-node does not take a light client.* It wants a full JSON-RPC
  plus beacon endpoint and trusts them unless `--l1.trustrpc=false` (the
  default), in which case it re-checks receipts against headers, but not the
  headers' canonicality. A replica would front an untrusted provider with a
  light-client-verified proxy:
  - headers from the sync-committee light client;
  - receipts and blobs proven against them.

  The repo has the pieces: `network/derived-reader/` (an L1 light client plus
  derivation verifier, not yet switched on in production) and
  `network/witness-gateway.mjs` (Helios witness verification).
- **Recommendation.**
  - Hosts that already run L1 in their SNP VM (most do; L1 is ~1.1 TB and
    keeps up) point the replica at it. That is a full verifier at zero extra
    cost.
  - Hosts without L1 use the light-client proxy. It is a *new component*: a
    release gate below.

A replica's own footprint is just Enclave's L2 state. Measured devnet sizes
are in `sepolia/RESULTS.md`.

**Independence on the devnet.** The replica uses a different Sepolia execution
RPC and a different beacon provider (Lodestar / ethpandaops vs publicnode),
has p2p disabled, and has its own datadir and JWT. Every block it has, it
derived from Sepolia. The challenger plays games against the replica's view.

## 8. Risks

1. **Sequencer liveness and censorship.** There is a single active sequencer
   until rotation exists. Forced inclusion bounds censorship at about 12 h,
   which is longer than today's 30-minute leases (§3).
2. **A placeholder anchor and permissioned proofs for the first week.** Until
   game 9 is respected, withdrawals depend on the type-5 proposer key (only
   it can propose) and the guardian. Treat the L2 as permissioned for exits
   until then.
3. **The prestate is ours to maintain.** Game 9's absolute prestate embeds this
   chain's rollup config. Every hardfork or op-challenger/kona upgrade needs a
   new reproducible build and an `opcm.upgrade`. At least two independent
   builders must agree on the hash. A wrong prestate makes honest challenges
   impossible.
4. **Own SuperchainConfig.** It is outside the Superchain's standard upgrade
   train. Enclave must track OP security releases itself (for example the
   eMudhra CA fix shipped in this month's releases).
5. **Bridged USDC risk** (if A): bridge security equals the L2's proofs. There
   is depeg or liquidity risk until Circle takes over.
6. **Blob retention.** Replicas offline for more than ~18 days need a blob
   archive or an attested snapshot.
7. **The sequencer VM's plaintext data disk.** Its integrity is not protected
   (`launch.py:88-89`). A host can make the sequencer misbehave. It is
   detectable by replicas and recoverable by L1 derivation, but it is a
   liveness lever for the hosting operator.
8. **Fee volatility.** The L1 bill scales linearly with the L1 gas price. At
   10 gwei, a sustained spike, the recommended settings cost ~$2,300/mo.
   Lengthen the intervals automatically when the L1 base fee is high: the
   batcher's throttle and channel duration, and the proposer's interval.

## 9. Release gates before mainnet

1. Game 9 respected on the devnet after a type-5 game finalized and moved the
   anchor, followed by at least one full permissionless cycle:
   - a valid proposal resolved for the proposer;
   - an **invalid** proposal countered and won by the challenger.
2. The prestate built reproducibly by two parties on two machines, with
   matching hashes, and `op-challenger run-trace --run super-cannon-kona`
   reporting `Successfully verified` over at least 24 h of live blocks.
3. The sequencer image built and measured with `rpc/snp/build_image.py`
   conventions, its in-guest keys bound into REPORT_DATA, and SystemConfig set
   from a verified quote by the Trezor-signed Safe. The verifier changes in §2
   (fresh nonce, TCB floor, REPORT_DATA[32:64]) merged.
4. Forced inclusion exercised on the devnet: a deposit-path `renew` while the
   sequencer drops that sender, landing within the bound.
5. A derive-only replica that uses an L1 light-client proxy (no trusted L1
   RPC) stays in sync for 7 d.
6. Measured monthly L1 cost on the devnet within 20% of §4 at the chosen
   intervals. An alerting and auto-lengthening policy for L1 fee spikes.
7. Safe ownership (Trezor), guardian key custody and runbooks for pause,
   blacklisting and prestate upgrade, reviewed.
8. A decision on USDC (§5) and a rehearsed Step-2 migration on the devnet.

## 10. Open questions and next steps

| question | recommended next step |
|---|---|
| Who holds the guardian? An Enclave hot key is a pause lever. | Make it a second Safe with the owner's Trezor plus one independent signer. Rehearse pause and unpause on the devnet. |
| Should the type-5 proposer be the sequencer VM? | No: run it on a different host, so liveness of exits does not depend on the sequencer. |
| Who runs challengers? | At least two hosts that also run replicas. Fund each with bonds; on mainnet, budget about 1 ETH each until bonds are tuned. |
| Can the sequencer image share the RPC image's build? | Yes, with a separate measured variant (different pinned binaries and chain.json). Prototype it in `rpc/snp/` as a second target. |
| Are batch-plus-multicall renewals and a longer `leaseSec` acceptable product-wise (failover bound)? | Decide the bound (2 h proposed). Implement batching in `supervisor.js` behind a flag. Measure on Base Sepolia. |
| Bridged USDC: has Circle agreed to a future takeover? | Ask Circle before building the bridge. Until then keep payments on Base (§5). |
| An on-chain SNP quote verifier for permissionless sequencer rotation: the cost of verifying an AMD chain in EVM. | Spike it: measure the gas of the ECDSA P-384 VCEK check on L2 (cheap there); fall back to an optimistic veto window. |
| Blob archive for late-joining replicas. | Let replicas serve the blobs they derived. Measure the size on the devnet. |
