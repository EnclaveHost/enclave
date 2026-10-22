# Open participation: hardening after review (2026-10-19)

**Scope.** Participation files only:

- `network/service-index.mjs`, `scripts/network/service-index.mjs`, `contracts/EnclaveServiceIndex.sol`;
- `test/service-index.test.mjs`, `test/EnclaveServiceIndex.t.sol`, `docs/network/open-participation.md`;
- `network/wg-provider/{install.sh,main.mjs}` (unchanged in this round);
- newly owned and edited: `network/provider-probes.mjs` and `scripts/network/wg-qualify.mjs`, for explicit default-target
  configuration only.

**Not done:** no commits, pushes, SSH, subagents, private configuration, production access, chain writes or contract
deployment. The source is still not integrated. Mutation tests ran in a scratch copy under `/tmp`, removed afterwards.

## The blocker, fixed: one RPC can no longer veto

Before this fix, `readServiceIndex` required **every** answering RPC to agree. One malicious endpoint could therefore
censor discovery against two honest ones.

It now uses `agreedRead`, which follows `LeaseReader.agreed`'s rule in `network/lease-reader.mjs`, with deadlines and
evidence added:

- **Picking the block.**
  - Each RPC reports its chain id and head. An RPC on the wrong chain, or one that fails, is excluded at the head stage.
  - Once two heads are in, the rest get a 250 ms grace.
  - The block is the **second-highest** head minus 2, never below a caller's floor. One fastest or far-future RPC cannot
    choose an unbounded head, and one lagging RPC cannot hold the others back.
- **Reading the snapshot.** Every RPC that reported a head reads the **whole snapshot** at that one block:
  - block hash and timestamp;
  - code hash;
  - every page;
  - every lookup.

  A future-dated block (more than 5 s ahead) or a stale one (90 s or older) is that RPC's failure. The block hash is read
  again after the read, and a change counts as a reorganization, which is also that RPC's failure.
- **Deciding.** The **first two identical snapshots** win. There is no first-answer fallback, and one RPC never wins
  alone.
- **Deadlines.** Each request is bounded (8 s by default) and so is the whole operation (30 s by default). A hanging RPC
  cannot stall discovery.
- **Evidence.**
  - Every result carries `evidence.peers`, giving each RPC as `agreed`, `disagreed`, `failed` (with stage and reason),
    `pending` or `late`.
  - Without a quorum, a `QuorumError` carries the same evidence. The command prints `{refused, evidence}` and exits 2.
  - It never returns an empty candidate list for a disagreement.
- **Pins are not weakened.** The agreed code must equal the pinned code hash, and the chain must equal the pinned chain.

**Why a reimplementation, not an import.** `LeaseReader.agreed` cannot pin a block for a resumed read, has no deadlines,
and exposes no per-peer evidence, and `lease-reader.mjs` belongs to another owner. So the rule is reproduced, and the
mutation checks below test it.

### Other all-answer comparisons, audited

| Place | Before | Now |
| --- | --- | --- |
| `scripts/network/service-index.mjs` `pin` | All RPCs must return the same code. | Quorum read. |
| `nextSequence` (used by `prepare-publish` / `prepare-withdraw`) | All RPCs must agree. | Quorum read (`indexState`). |
| `send` | Code checked on the single sending RPC. | Code hash and current sequence from a quorum read (two or more `--rpc` are now required). The transaction still goes through the first `--rpc`. A stale sequence is refused before sending. |
| `wg-qualify --independent` | n/a | Registry operator reads and the on-chain digest the checker signs are quorum reads (below). |
| `windows/node/host-identity.mjs` `quorumReader` (outside this scope) | Had the same all-must-agree flaw when I wrote it. | Someone has since rewritten it on disk with first-two-agree semantics. I did not touch it. |

No other all-answer comparison remains in my files.

## Discovery that spam cannot eclipse

**Self-owned lookup.**

- `lookups: [{operator, slot?}]` (up to 32 operators; with no slot, all 8) reads `get(operator, slot)` **in the same
  agreed snapshot**.
- Each result is `listed`, `absent`, `expired` or `rejected`.
- In the CLI: `list --lookup 0xOP[:slot]` and `lookup --operator 0xOP [--slot N]`.
- A known operator is found however many ads precede it in the listing.

**Bounded pagination and resume.**

- Each kind is read in a window of 1 to 1024 ads (256 by default), at 64 per request.
- The result reports `status: complete | incomplete`, with per-kind `windows: {total, start, end, complete}`.
- An incomplete result carries a `next` cursor `{chainId, index, blockNumber, blockHash, positions}`.
- Passing the cursor back (`--resume`) continues at the **same block**:
  - Every RPC must return that exact block hash, so a forged or reorganized cursor is refused with evidence.
  - The block must still be fresh.
  - A cursor for another index is refused.
- **An incomplete result says nothing about ads it did not reach.** The doc and the result notice both say so.

**Never organizations, never admission.** The notice now reads: "distinct keys are not distinct organizations … Nothing
here is admitted automatically." Every candidate is marked `trust: "untrusted-candidate"`. Nothing in the reader, CLI,
provider or checker consumes ads as peers.

## Smart-contract wallet operators

**Direct calls.** These worked already: a wallet calling `publish` or `withdraw` from its own address is the operator.
Tested in Foundry and on Anvil, where an owner-executed wallet publishes and the reader lists it.

**Gas-sponsored submission** (`publishFor` / `withdrawFor`) **needs ERC-1271**, because a wallet has no key of its own.
It is implemented as follows:

- **Order.** A low-s 65-byte `ecrecover` is tried first. ERC-1271 is used only if that fails and the operator has code.
- **How the wallet is asked.** `isValidSignature(digest, sig)` is called by `STATICCALL`, with a fixed 500k gas budget,
  copying **at most 32 bytes** of return data in assembly.
- **What is accepted.** Only the magic `0x1626ba7e`.
- **Size cap.** Signatures are limited to 2048 bytes.
- **Binding.** The digest already binds chain id, this contract and the per-slot sequence, so a wallet's approval cannot
  be replayed later or elsewhere.
- **Refused:** a wallet that reverts, returns the wrong magic, returns fewer than 32 bytes, or burns its gas, and any
  oversized signature. An EOA operator never takes the ERC-1271 path.

**This changes the contract.** The runtime code hash changes, so any pin must be re-derived with `service-index.mjs pin`.
Nothing is deployed.

**In the CLI.** `prepare-*` emits the wallet's `call`, for wallets that execute it themselves, and the EIP-712 typed data,
for an owner to sign. `send --signature` submits through any gas payer. `sign` still refuses a key that isn't the
operator.

## Checker and probe defaults

**`scripts/network/wg-qualify.mjs --independent`** (validated by `resolveCheckerBootstrap` in
`network/service-index.mjs`):

- **Requires:** directories (1 to 8; no relay fallback), `--pins` (complete authority pins; zero `connectivity` disables
  attestations), two or more distinct RPC origins, `--outbound` (https), `--dns` (public IPv4 resolvers), and `--smtp`
  or `--smtp-domain`.
- **Refuses:** `--relay` and `--book`.
- **Quorum reads.** The registry operator of a community host, and the digest the checker signs, are quorum reads.
- **Without `--independent`,** behaviour is exactly as before. This is the compatibility path that `checker.service` uses
  (`--relay https://api.enclave.host`).

**`network/provider-probes.mjs`.** `probeTargets()` and `providerProbes(..., {independent, probeZone, outbound})`:

- **Independent:** the **checker** names both the probe zone and the HTTPS canary. Neither comes from the host's
  manifest.
- **Otherwise:** the compatibility defaults stay (`probe-*.enclave.host`, `https://enclave.host/`), with byte-identical
  hostname rules. `test/provider-canary.test.mjs` still passes.
- **Remaining:** `network/provider-canary.mjs` (another owner) still mints `probe-*.enclave.host` hostnames for
  direct-host canaries. Using another zone there is its owner's change.

### Registry and onboarding compatibility (read `docs/network/deployed-sources.md` first)

- **The deployed registry is schema 4 (`b17db9a3`).** It has `register(endpoint, repo, measurement, cpuPrice, gpuPrice,
  proofKey)`, which is open and first-come by endpoint id. It has **no** `registerRelay`, `setCaps` or capability bits.
  Its `get()` struct is the 11-field shape that `network/registry-abi.mjs` `hostABI` decodes.
- **On Anvil,** the test deploys that exact source from git, checks `registrySchema() == 4`, and has a provider register
  its own host. The independent checker then qualifies it.
- **Onboarding needs nothing more:**
  - **Unpaid providers** need only their own signed record.
  - **Paid (community) providers** register a host and call connectivity `setHost` with their own key.
  - **Nothing anywhere** needs `registerRelay` or capability bits.

## Tests

| Command | Result |
| --- | --- |
| `FOUNDRY_TEST=test forge test --match-path test/EnclaveServiceIndex.t.sol` | **10 of 10 pass:** 7 index tests and 3 wallet tests (direct call; sponsored ERC-1271 with no replay and no other chain; misbehaving wallets and oversized signatures refused). |
| `node --test test/service-index.test.mjs` | **15 of 15 pass, three consecutive runs.** Real Anvil chains, plus a JSON-RPC proxy in front of them that is honest, lying (answers calls from another chain), flipping, wrong-chain, hanging, future-head or reorganizing. |
| Same command, plus `provider-canary`, `wg-provider`, `provider-bootstrap`, `lease-reader`, `network-authority-pins`, `provider-settlement`, `public-provider-mirror` | **59 of 59 pass** |
| esbuild bundles of `network/wg-provider/main.mjs` and `scripts/network/wg-qualify.mjs` | Both build |

**What the Anvil tests show:**

- **The honest pair decides** against each bad peer:
  - with a liar, both honest RPCs show `agreed`, and the liar shows `disagreed` or `pending`;
  - a wrong-chain peer fails at the head stage (`reports chain 1`);
  - a hanging peer adds less than 1.5 s;
  - with a future head, the block is the honest head minus 2;
  - a reorganizing peer changes nothing.
- **It fails closed** with 1 honest + 1 liar, and with 1 honest + 1 hanging peer. The latter is bounded by the timeouts,
  and its reason is `timed out`. The CLI exits 2 and prints the evidence, with no `candidates`.
- **Reorg and age.** 1 honest + 1 reorganizing peer fails closed with `reorganized during the read`. A stale view is
  refused by every peer (`older than`).
- **Pagination.** 50 + rest resumes at the same block, and every ad is examined exactly once across the windows.
  - A known (operator, slot) outside a 5-ad window is found by lookup, with all 8 slots asked; an unknown operator reads
    as `absent`.
  - A forged cursor is refused by every peer, and a cursor for another index is refused.
- **Wallet operators** publish directly through the wallet, and sponsored through ERC-1271 via the CLI with a separate gas
  payer. The owner's signature does not authorize another wallet.
- **The checker entry point.**
  - **Setup:** the real `wg-qualify --independent` process, with a preload that refuses and logs any `*.enclave.host`
    lookup or connection. Behind it: a fresh chain carrying the deployed schema-4 registry source and a mock connectivity
    contract; three RPCs, one of which alters every `eth_call`; and a chosen local directory. The WireGuard check binary
    is a stand-in that records its inputs (see limits).
  - **Results:**
    - It qualifies a self-registered community provider.
    - It signs the **honest** digest.
    - It passes the operator's outbound, DNS and SMTP targets, and a probe name in the provider's zone.
    - It publishes to the chosen directory.
    - The `enclave.host` log is empty, and no `eth_call` reaches the address-book contract.
  - **Legacy and refusals:** the legacy form does reach `api.enclave.host` (the blocker logs it). `--relay`, `--book` and
    missing targets are refused in independent mode.
- **A live `tcp80` probe** against a stand-in, in a non-Enclave zone. The compatibility zone rejects other zones, and an
  independent zone rejects `*.enclave.host`.

### Mutation checks (scratch copy; each mutation re-introduced alone, full file run)

| Mutation | Tests that fail |
| --- | --- |
| Every answer must agree (the reviewed blocker) | #10, #11, #14 |
| Highest head picks the block | #10 |
| No block-hash recheck | #10 |
| No per-request timeout | #11 |
| Lookups dropped | #12, #13 |
| No freshness check | #6 |
| A single answer accepted | #10, #11, #14 |
| Code pin not enforced | #1 |
| Contract without ERC-1271 | Foundry `test_walletSignedPublishIsSponsoredViaErc1271` |
| Checker trusts its first RPC | #14 |
| Probes ignore independent targets | #15 |

The unmutated scratch baseline was 15 of 15.

## Limits and residual items

- **Test stand-ins for chains and RPCs.** Anvil stood in for Base. The RPCs were local proxies standing in for separately
  operated endpoints. Freshness tests use a chain-synced clock because auto-mined Anvil blocks run ahead of wall time;
  stale and future refusals are tested with explicit clocks. The wallet and checker tests use fresh chains, because the
  CLI and checker use the wall clock.
- **WireGuard checks were not run.** `enclave-wg check` needs root and a tunnel, so the WireGuard data-path checks were
  replaced by a stand-in that records its inputs. The existing root-only `test/netns/wg-e2e.sh` (legacy flags) was not
  run.
- **RPC trust.** With exactly two RPCs, either can refuse service, though neither can forge it. Three or more are needed
  to tolerate one bad RPC. This is still RPC-quorum trust, not a light client.
- **Remaining for other owners:**
  - `network/provider-canary.mjs` still mints `probe-*.enclave.host` hostnames.
  - `scripts/network/qualify-provider.mjs` still calls `providerProbes` in compatibility mode. Passing
    `{independent, probeZone}` from its config is a one-line change for its owner.
- **Nothing deployed; no independent operators exist.** The contract source changed (ERC-1271), so coordinator review
  covers the new code hash. Every existing provider, directory and checker is still Enclave-operated, and nothing here
  creates or proves independent operators.
