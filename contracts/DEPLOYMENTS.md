# Enclave portable deployments (EnclaveDeployments) — design

**Status: implemented. The contract compiles clean; the claim loop is wired
into `supervisor.js` (search `startClaimLoop`) behind `CLAIM_ENABLED` +
`DEPLOYMENTS_ADDRESS` in `enclaves/*/tinfoil-config.yml`. The code excerpts below are the
design reference; `supervisor.js` is authoritative where they diverge.**

Today a deployment is one enclave's private state: the spec and the funded-time
balance live in that supervisor's `state.json`, and the on-chain `Paid` events
reference a `payRef` whose preimage only that enclave knows. If the enclave dies
for good, the deployment — including paid, unconsumed runtime — dies with it.

`EnclaveDeployments` turns deployments into **work items on a queue**, like
transactions waiting to be processed. The chain holds the three things a
stranger enclave needs to take over:

1. the **intent** — what to run (`appRef`), the two shares bought (GPU + CPU), ports, visibility;
2. the **balance** — funded runtime (USDC 6dp), credited by payments, burned by leases;
3. the **lease** — who is serving it right now, and until when.

```
user    --(create tx)------------> EnclaveDeployments   intent recorded, id minted
user    --(fundWithAuthorization)> EnclaveDeployments   USDC -> payout (same tx; a paid app's publisher
                                                    cut splits off to their wallet), balance += value
enclave --(poll getPage)---------> EnclaveDeployments   "anything claimable I can fit?"
enclave --(claim tx)-------------> EnclaveDeployments   lease taken, min(leaseSec, balance/rate) burned
enclave --(wasm-manager launch)--> runs the app     same provisioning path as today
enclave --(renew tx, each lease)-> EnclaveDeployments   healthy runner keeps extending
enclave dies                      (nothing)         lease expires on its own
enclave'--(claim tx)-------------> EnclaveDeployments   another enclave picks it up, continues
...until balance < rate           claim reverts     "no more time left" — the queue drops it
```

At-most-one-runner-at-a-time is enforced by the chain (a live lease blocks
`claim`), not by any operator. A dead runner needs no detection protocol: its
silence *is* the signal, because the lease it stopped renewing expires.

A *half*-dead runner — outbound chain access intact, public front gone — is
the one case silence doesn't catch: it would happily claim and renew work
nobody can reach (observed 2026-07-11: a CVM lost its DNS record and front
routing but kept renewing for six hours). Runners close that hole themselves
with a reachability watchdog: each claim tick they ask public DoH resolvers
for their own advertised hostname, and once every resolver has *affirmed* the
name gone several rounds in a row they release everything they hold, stop
claiming, and stop renewing until the name resolves again (supervisor
`reachTick`; `REACH_DNS_STRIKES=0` disables).

## What changes, what doesn't

| | today (EnclavePay path) | portable (EnclaveDeployments path) |
|---|---|---|
| deployment created by | HTTP `POST /v1/deployments` to one enclave | `create()` transaction |
| spec lives in | that enclave's `state.json` | chain |
| balance lives in | `rec.remainingMs` in `state.json` | chain (`balance6`), leases prepay slices of it |
| payment | EnclavePay `Paid` event, credited off-chain | `fundWithAuthorization` / `fundEth`, credited on-chain |
| enclave death | deployment lost | lease expires, any enclave claims the remainder |
| billing clock | per-tick, freezes during outages | lease-quantum; `release()` refunds unused tail |
| app state | ephemeral ramdisk `/data` | unchanged — a takeover is a relaunch from the CID |
| attestation, approval gate, isolation | — | unchanged (runners still check `cidStatus`, fail closed) |

Both paths coexist: `EnclavePay` + the HTTP deploy flow keep working unchanged;
`EnclaveDeployments` is opt-in per enclave (`CLAIM_ENABLED`) and per user (deploy
via transaction instead of via one enclave's API).

## Contract summary (`EnclaveDeployments.sol`)

- **`create(appRef, gpuMilli, cpuMilli, appPort, ports, isPublic, configCid, feeRecipient, feePerSec6)`**
  (schema rev 7 — rev-1 contracts carried an extra `sshPubKey` string here and in
  the `Deployment` struct; consumers sniff `deploymentsSchema()` to pick the shape.
  Rev 3 keeps the rev-2 shapes byte-for-byte and only marks the `setAppRef`
  surface; rev 4 again keeps the struct byte-for-byte (the fee snapshot lives in
  a side mapping behind `feeOf(id)`) and adds the two fee args; rev 5 keeps every
  signature and only widens the `configCid` length bound from CID-sized (100
  bytes) to envelope-sized (4096); rev 6 again keeps the struct byte-for-byte
  and only marks the `setShares` surface (owner share resizes); rev 7 once more
  keeps the struct byte-for-byte (runner-payout state lives in side mappings
  behind `earnOf(id)`/`earned6(op)`/`bondOf(op)`) and marks the RUNNER-PAYOUT
  surface (below) — so struct decodes gate on `>= 2`, version changes on `>= 3`,
  publisher fees on `>= 4`, any options envelope over 100 bytes on `>= 5`: a
  rev-4 `create` reverts `"configCid length"` on one, share resizes on `>= 6`,
  runner payout on `>= 7`, per-host pricing + the rate cap on `>= 8`, and
  PROOF OF TIME on `>= 9` — rev 9 keeps the struct byte-for-byte one last time
  and changes what EARNS: the runner meter is capped by a `provenUntil`
  watermark that only a bound `EnclaveProofOfTime` may advance. See "Proof of
  time (rev 9)" below)
  — permissionless; inert until funded. `appRef` is `catalog://<appId>/<versionIndex>`,
  the on-chain record of the catalog VERSION to run (2026-07-09; CID refs are refused
  by runners — a CID names bytes, not a version). The record supplies the wasm,
  config (ENCLAVE_CONFIG + volumes) and ports the catalog owner approved;
  `ports`/`appPort` ride along untrusted, and `configCid` as a **CID is retired**
  (fail-closed: runners refuse one). The field instead carries `""` or the
  **deployment-options envelope** — inline JSON, strictly whitelisted by
  runners: `{"waf":{…}}` (per-IP rate limit + request filter, enforced at the
  enclave's proxy) and `{"config":{…}}` (a per-deployment app-config override
  that replaces the version's config as that deployment's `ENCLAVE_CONFIG`; the
  catalog default and every other deployment are untouched). The whole string is
  public on-chain — no secrets. A deployment BUYS two shares, both in
  1/1000ths: `gpuMilli` of one GPU card (VRAM + compute together; `0` = a
  CPU-only deployment) and `cpuMilli` of a node's vCPU+RAM (1..1000). The
  contract enforces `gpuMilli == 0 || gpuMilli >= cpuMilli` — a GPU app's CPU
  slice rides on the same node as its card. The app's exact specs in
  EnclaveAppCatalog (vramMb, gpuGflops, memMb, cpuGflops) set its MINIMUM shares: each RUNNER
  re-derives them against its own hardware (spec / server spec, the larger of
  the memory and compute axes, ceil to the percent grain) and skips
  under-provisioned deployments — the chain stays hardware-agnostic. The GPU
  share is also capped from above: `create` refuses `gpuMilli > maxGpuMilli`,
  an owner-set on-chain parameter (`setMaxGpuMilli`, 0..1000, default 1000 =
  uncapped; 0 pauses GPU creates). The cap gates **deploys only** — the catalog
  keeps listing apps whose specs exceed it (publishable, just not deployable
  until the cap covers their minimum), existing records and owner imports are
  untouched, and every client (console dials, quick-deploy, CLI) re-checks it
  before the wallet signature so nobody signs a doomed create. Both
  shares are paid for, at the price of **the enclave that claims the work**
  (rev 8 — there is no platform price any more; see *Pricing and the rate cap*
  below):
  `rate = (host.gpuPricePerSec6 × gpuMilli + host.cpuPricePerSec6 × cpuMilli) / 1000`,
  rounded up, **plus the publisher fee** (below). `create` also takes
  `maxRate6`, the owner's per-second ceiling (required, above the fee): until
  the first claim it IS the record's working rate — the worst case — so
  funding splits and `secondsFundable` never over-promise.
  `id = keccak256(creator, nonce)`.
  **Publisher fee (rev 4)**: a catalog version may declare a per-second
  publisher fee (`EnclaveAppCatalog.versionFee`, capped at publish). Clients
  copy it into `create` as `(feeRecipient = the app's publisher wallet,
  feePerSec6)`; the pair is snapshotted (immutable for the deployment's life,
  resizes included — read it back with `feeOf(id)`), folded into `rate`, and capped by the owner-set
  `maxFeePerSec6` (`setMaxFee`, create-only like the GPU cap). The ledger
  still never parses appRefs: RUNNERS refuse to claim a deployment whose
  snapshot under-declares the referenced version's fee or names the wrong
  payee (fail closed, exactly like catalog approval), so an under-declared
  record is simply nobody's work item — clients pre-check before the
  signature, like the share floors.
  **Routing (enforced by runners at claim time): GPU work (`gpuMilli > 0`) is
  claimed ONLY by GPU-enabled enclaves; CPU-only work is claimed by CPU-only
  enclaves immediately and by GPU enclaves only after `CPU_CLAIM_GRACE_SEC`
  (default 120s), out of their leftover CPU/RAM pool — e.g. a tenant taking a
  whole card + 10% of the node leaves 90% of that node's CPU for CPU-only work.**
- **`fundWithAuthorization(id, ...)` / `fund(id, value)` / `fundEth(id)`** —
  EnclavePay's pattern (EIP-3009 nonce bound to the first 16 bytes of `id`;
  the platform's and publisher's splits forward in the same tx). The
  difference: the credit lands in on-chain `balance6` instead of an off-chain
  clock. ETH is priced by the Chainlink ETH/USD feed *in the contract*
  (staleness-checked), because the balance is chain state so the conversion
  must be too. Every USDC funding is SPLIT in that same transaction three
  ways: the publisher's pro-rata cut (`value × feePerSec6 / rate`, floor —
  the platform absorbs the dust) straight to the snapshot's `feeRecipient`;
  the RUNNER's pro-rata share (`value × runnerRate6 / rate`, **ceil**, rev 7)
  RETAINED in the contract as that deployment's escrow — the pot future lease
  credits are paid from; the platform remainder to `payout`. `balance6`
  credits the full amount — the split is who receives the money, not what
  the deployer bought. (`fundEth` still forwards everything but the publisher
  cut: the escrow pays runners in USDC and the contract can't convert —
  `fundEscrow` re-backs an ETH-funded record if needed.)
- **`claim(id, enclaveId)`** — gated to the operator of an **active EnclaveRegistry
  entry** (structural, like catalog lineage ownership). Requires no live lease
  and a balance that buys ≥ 1 second. Burns `min(leaseSec, balance/rate)`.
- **`renew(id)`** — current runner only, before expiry only; extends **from**
  `leaseUntil` (that time is already paid). After expiry even the same runner
  must re-`claim` — the job is back on the open queue.
- **`setActive(id, bool)`** — the owner's suspend/resume switch. `false` takes
  the record off the claim queue; a well-behaved runner sees `ActiveSet`, tears
  down and releases (refunding the lease tail), and the balance STAYS on the
  record. `true` re-queues it — the app relaunches fresh from its published
  version, spending what's left. The dashboard's Suspend/Resume buttons and the
  CLI's `stop`/`resume` are exactly this toggle.
- **`transferDeployment(id, to)`** (rev 11+; `deploymentsSchema() >= 11` is the
  feature probe) — the owner hands the record to another wallet. **Control
  moves, money never does**: the call reverts `"refund first"` while the
  contract still holds any of the owner's own refundable backing, so the
  owner's funds always return to the owner's wallet (via `refund`) before the
  record changes hands — a mistyped address can lose you a RECORD, never
  money. The gate is `min(ownerEscrow6, escrow6) == 0`, NOT
  `refundableOf == 0`: mid-lease the free part refunds immediately but the
  seller's reserve stays escrowed and frees again at release — a
  `refundableOf` gate passes in that window and would hand the released tail
  to the NEW owner; and a fully-SPENT record's stale `ownerEscrow6` (only
  `refund` decrements it) must not brick the handoff — the `escrow6` side
  clears it. Sponsored and ETH-bought runtime rides along (it was never the
  owner's to withdraw), and from the handoff on the NEW owner's fundings
  credit `ownerEscrow6` while the old owner's top-ups become third-party
  sponsorship. Relay-staged secrets (values readable by the new owner —
  rotate credentials they must not hold) and custom domains stay with the
  record, both keyed by deployment id with ownership re-read from the ledger
  per request; the runner's audit pass re-keys the serving box's own owner
  gates (private data path, logs, restart/delete, top-up) within one pass.
  **ONE-SHOT**: a pending/accept two-step costs ~460 bytes this contract does
  not have under EIP-170, so there is no way back except the new owner
  transferring it again — every client restates the full destination address
  in its confirm, and chains the refund in front when the gate is hot (the
  dashboard's "Refund & transfer", the CLI's two-tx `transfer <id> <0xaddr>`,
  MCP `build_transfer`'s `[refund, transfer]` pair). Wallet-owned records
  only in the UI: a vault-owned record's on-chain owner IS the credit vault,
  and the vault's selector allowlist deliberately excludes this call (a
  passkey op must never move a record — and its future refunds — out of the
  vault's accounting).
- **`retire()`** (rev 11+, owner, ONE-WAY, no event — the public `retired`
  flag is the record) — END-OF-LIFE, the migration answer to stranded user
  funds. Every activity entry point (`claim`, `renew`, `fund`,
  `fundWithAuthorization`, `fundEth`, `fundEscrow`) funnels through
  `_requireActive`, which refuses a retired ledger — so no rogue operator can
  race the wind-down and burn owners' balances into lease earnings — and
  `refund()` opens to ANY caller while still paying each record's OWNER: one
  permissionless sweep (the admin console's Refund button after Retire, or
  anyone's keeper script) pushes every record's held escrow back to the
  wallet that funded it, no owner signatures needed. Until retire() is called
  the platform holds none of this power — every gate reads exactly as rev 10
  — and retiring is what repointing the fleet already does de facto, made
  honest and observable on-chain. Live leases keep their reserve through the
  sweep (`_creditRunner` first, as in an owner refund), so a seller can never
  be stranded; sweep again after the last lease lapses to collect the tails.
  Retirement opens ONLY the refund gate: transfer, config and active stay
  owner-gated. There is no un-retire.
- **`setAppRef(id, appRef)`** (rev 3+; `deploymentsSchema() >= 3` is the feature
  probe) — the owner's VERSION CHANGE. Repoints the deployment at another
  catalog version record; funded time, shares, rate and any live lease all
  stay, so picking up a new release never costs a second buy-in. The ledger
  doesn't parse the ref (same trust model as `create`): runners re-gate it on
  catalog approval + minimum shares. The CURRENT runner restarts the app in
  place on its next audit pass — new wasm prefetched before the old instance
  stops, so the gap is ≈ one relaunch — and an unclaimed deployment simply
  launches the new version when claimed. A change the runner can't apply
  (unapproved target, minimums over the bought shares, catalog
  unreachable) keeps the OLD version serving and surfaces why on the record
  (`versionChange` in the status API), retrying every pass. The dashboard's
  Version control and the CLI's `upgrade` are this call, both pre-checking
  approval and share fit before the wallet signature.
- **`setShares(id, gpuMilli, cpuMilli)`** (rev 6+; `deploymentsSchema() >= 6`
  is the feature probe) — the owner's SHARE RESIZE, grow or shrink, typically
  batched with `setAppRef` via `multicall` when a new version needs different
  resources (one wallet signature for both). Same bounds as `create`,
  `maxGpuMilli` cap included, and the **rate is recalculated at the SERVING
  enclave's posted price** (its ceiling when nothing is serving it) plus the
  immutable fee snapshot, and must stay inside `maxRate6`: a resize is a new
  purchase decision, exactly like create — over the ceiling it reverts
  `"over rate cap"`, so raise the cap first. A LIVE
  lease is settled, never re-priced retroactively: the unserved tail refunds
  at the OLD rate (the rate it was burned at — `release()`'s own arithmetic,
  so `spent6` can't underflow), then re-burns at the NEW rate for as many of
  those seconds as the balance affords; `leaseUntil` never extends, a grow the
  balance can't fully cover just shrinks it (the runner renews or lapses
  sooner), and a resize that couldn't fund one second reverts `"unfunded at
  the new rate"` — top up first, a resize never silently kills a running app.
  The serving runner sees the changed shares on its next audit pass and
  re-gates them like a claim (app minimums, local capacity, fail closed): it
  restarts the app in place on a re-sliced allocation, or — when the new size
  doesn't fit its box, or the shares dropped below the version's minimums —
  stops and RELEASES the lease (tail refunded) so an enclave that fits the new
  record claims the work. Clients gate on the fleet-AND `shareResize`
  availability flag before the signature: against a fleet whose runners
  predate the share watch, the tx would change the billing while the served
  slice silently didn't. The dashboard's Version-panel dials, the CLI's
  `upgrade --gpu/--cpu` and `resize`, and MCP's `build_upgrade`/`build_resize`
  are this call.
- **`release(id)`** — graceful hand-back; refunds the unused lease tail to
  `balance6`. Called on clean shutdown, after the owner `setActive(false)`,
  or when provisioning fails right after a claim.
- **Runner payout (rev 7; `deploymentsSchema() >= 7` is the feature probe)** —
  what makes permissionless selling real (metal/PROTOCOL.md Phase C): the
  operator EOA that holds a lease is PAID for it by the chain, not by an
  invoice to the platform. Each new deployment snapshots `runnerRate6` =
  `runnerBps` (owner-set, default 8000 = 80%) of the PLATFORM component of its
  rate (the publisher fee is excluded); claims and resizes re-snapshot at the
  current bps, exactly as they re-price at the claiming enclave's price — a
  host earns 80% of what it itself charges. USDC fundings retain
  that share in-contract as per-deployment **escrow** (see the funding bullet),
  and a **credit meter** moves escrow to the current runner's withdrawable
  balance for every second it holds the lease: `claim` settles the PREVIOUS
  runner's expired quantum, `renew`/`release`/`setShares` settle the current
  one — the meter rides the transactions runners already send, and the
  permissionless, idempotent **`settle(id)`** collects the one case they miss
  (a lease that expired and was never re-claimed or released). A released
  tail refunds to the user and earns nothing: a claim-and-bail runner is paid
  ~zero. Credits are capped by the deployment's escrow, so the meter can
  never promise money the contract doesn't hold (imported balances and
  ETH-funded time have no escrow until **`fundEscrow(id, amount)`** re-backs
  them — credits just read zero, never revert). **`withdrawEarnings(to)`**
  pays the caller-EOA's accrued total (across every deployment it ever
  served) to any address; the supervisor auto-sweeps to `PAYOUT_ADDRESS`
  once `EARNINGS_MIN_USDC` (default $5) accrues. `earnOf(id)` /
  `earned6(operator)` are the reads. An optional **claim bond** (gate 4 of
  the metal protocol; `setClaimBond`, default 0 = off) requires operators to
  lock USDC before claiming — timelocked exit (`postBond` /
  `requestBondExit` / `withdrawBond`), owner-slashable with public evidence
  (`slashBond`) — so claim-without-serving sybils have a price. Migration:
  `importEarn` carries the rate snapshots (the admin console reads them via
  `earnOf` like it reads `feeOf`); escrow is real USDC held by the source
  contract and does NOT migrate — re-back with `fundEscrow` — and earned
  balances stay withdrawable on the source forever.

### Pricing and the rate cap (rev 8)

Price belongs to the **enclave**, not the platform. `EnclaveRegistry` (schema
2) carries two numbers per entry — `cpuPricePerSec6` for the whole node's
vCPU+RAM and `gpuPricePerSec6` for one whole card, USDC 6dp — stated at
`register` and changeable with `setPrices` (future claims only; a live lease
was bought at the price in force when it was claimed). `EnclaveDeployments`
has no `pricePerSec6`/`cpuPricePerSec6` and no `setPrice`/`setCpuPrice` at
all: `claim` reads the claiming enclave's entry (it already reads it for the
operator check), computes `hostRate × shares / 1000 + fee`, and snapshots that
as the deployment's `rate` for the life of the lease. Move the work, and the
price moves with it.

Every deployment therefore carries `maxRate6` — **the most it will pay per
second** — set at `create` and changeable any time by the owner with
`setMaxRate(id, maxRate6)`. It is checked on every purchase of time:

| call | over the cap |
|---|---|
| `claim` | reverts `"over rate cap"` — that enclave simply cannot take the work |
| `renew` | reverts — the paid lease runs out and the app stops |
| `setShares` | reverts — raise the cap first, or pick smaller dials |

That is what makes automatic failover safe on a fleet of independently-priced
boxes: when a host goes dark its lease lapses, the work is open to everyone,
and the enclaves that both FIT it and charge at or under the ceiling are the
only ones that can pick it up. Lowering the cap under a running rate is a
deliberate stop — the lease already bought is honoured, then nothing renews or
re-claims (runners surface the reason rather than retrying, gated on the
fleet-AND `rateCap` availability flag; the CLI and console warn before
signing). `capOf(id)` reads the ceiling, `rateFor(id, enclaveId)` prices a
deployment on any enclave, and `claimableBy(id, enclaveId)` answers "could
that box take this right now" in one call.

Reads that used to come off the contract now come off the fleet: clients quote
the **cheapest currently-connected enclave** (the relay aggregates it as
`cheapestCpuPricePerSec6`/`cheapestGpuPricePerSec6` over claiming boxes, each
of which advertises its own `askCpu/askGpuPricePerSec6`), and default a new
deployment's cap to exactly that quote, so nothing dearer can pick it up
without the owner raising the ceiling. Migration: `importDeployments` defaults
each imported record's cap to the rate it arrives with — same price, same
economics, no dearer enclave can take it — and `importCaps` overrides that
while the window is open (0 = uncapped, the pre-rev-8 behaviour).

### Free self-hosting (rev 12)

A seller running **their own app on their own box** pays no hosting charge.
`EnclaveRegistry` (schema 4) carries a `payoutWallet` per entry — the seller's
own wallet, the one the supervisor already sweeps earnings to
(`metal/config.json` `payoutAddress`), now stated on-chain. When `claim` reads
the entry it already reads for the operator check, and that wallet **is** the
deployment's `owner`, the host component of the rate is zero:

    rate = (payoutWallet == owner ? 0 : hostRate × shares / 1000) + publisherFee

Everything that follows is a consequence of a `rate` that can legitimately be
zero. A free deployment needs **no balance at all** (`claim` and `renew` burn
nothing and take a full `leaseSec` quantum), escrows nothing, and earns its
runner nothing — the runner cut is a slice of the host component, so it is zero
too. Nobody pays, so nobody is paid; the platform's share of a free deployment
is zero as well.

**The publisher fee is untouched.** It is another party's money in another
party's wallet, and the waiver has nothing to say about it: a free deployment
of a paid app still costs `fee` per second, still has to be funded for it, and
still forwards the publisher's pro-rata cut on every funding — where, the rate
now being the fee alone, that cut is 100% of it.

#### Why only the wallet may declare it

`setPayoutWallet(bytes32 id)` takes **no address**. It records `msg.sender`, so
the only wallet a box can name is one whose owner sent a transaction saying so;
`clearPayoutWallet` lets either side (the wallet, revoking; the operator, on a
box that changed hands) withdraw it. The operator's own `register` cannot set
it and never overwrites it, so a metal box re-registering at every boot keeps
the declaration.

That direction is load-bearing rather than stylistic. A rate of zero is
**beyond the reach of the owner's rate cap** — `_requireUnderCap` is
`rate <= cap` and `setMaxRate` will not accept a ceiling at or under the fee,
so no cap value excludes a free claim — and a zero-rate record is claimable
with an empty balance, which no record was before. If an operator could type
any address into that field it could pull a stranger's deployment into a tier
their usual eviction lever cannot touch, and squat the lease indefinitely at
zero cost. Requiring the declaration to come *from* the wallet makes that
impossible rather than merely unprofitable.

The owner's remaining lever, and the one to reach for if a free lease is ever
held by a box you did not intend: `setActive(id, false)`. `renew` refuses on an
inactive record, so the lease lapses within one `leaseSec`; `clearPayoutWallet`
on the registry side removes the exemption itself.

#### What clients have to know

`rate == 0` is a legal answer from rev 12 on, and `deploymentsSchema >= 12` is
how a client knows to expect it rather than treat it as a failed read.
`rateFor(id, enclaveId)` returns 0 for the pair, and `claimableBy` deliberately
does **not** go through `claimable()`: the enclave-agnostic view tests the
balance against the record's own worst-case ceiling, which reads a free
deployment as unclaimable and would hide it from the one box that hosts it for
nothing. Off-chain, the relay marks such rows `hostedFree` and reports no
`timeRemainingSec` (there is no funded time to count down), the runner prices
the waiver in its own claim gate before it spends gas, and
`enclave host declare-payout` sends the one transaction that starts it.

### Proof of time (rev 9)

Through rev 8 a **held lease paid by itself**. `_creditRunner` credited
`min(now, leaseUntil)` and nothing on-chain could tell serving from silence, so
an enclave that claimed a lease and then stopped — crashed app, wedged box, or
plain dishonesty — was paid to the end of its quantum anyway. The documented
worst case was 30 minutes of paid dead air per runner death, and the only
recourse was an owner-judged bond slash.

From rev 9 a runner is paid for time it can **prove** it served.

**The proof.** Every `proofWindowSec` (default 900) the serving enclave signs a
checkpoint — *"deployment X was running here through time T"* — with a
secp256k1 key **minted inside its own CVM**. `EnclaveRegistry` schema 3 carries
the address half per entry (`proofKey`, set at `register` or with
`setProofKey`); the private half never leaves the enclave, so the operator
running the host OS — who was handed the operator EOA from outside the CVM, and
could always sign with *that* — cannot sign for an app it has stopped. The
supervisor only signs after confirming the app is actually up, and "up" means a
real TCP connect to the port the tenant serves on, not just "the manager still
has a record".

**Why it proves *time*, not just uptime.** Each checkpoint commits to the hash
of a **recent block**, and that one binding does three jobs:

1. the hash did not exist before that block was mined — so a signature carrying
   it cannot have been pre-computed for a shift the host had not yet worked;
2. `blockhash()` only reaches back 256 blocks (~8.5 min on Base) — so a proof
   stops being redeemable shortly after it is made, and cannot be hoarded and
   cashed in after the box is dead;
3. the anchor is **unpredictable**. This is the property Storj buys with
   randomly-timed audits from a satellite; here it falls out of the chain, with
   nobody to trust for the randomness.

And one checkpoint advances the watermark by **at most `proofWindowSec`**, so an
hour of pay costs an hour of separately-anchored proofs. Time cannot be
compressed into a single transaction — which is the whole reason it is called
proof of *time*.

**What it pays.** The meter becomes
`min(now, leaseUntil, provenUntil)`. Unproven time inside a paid lease earns
nobody anything, and every partial period settles **to the second**:

| situation | rev 8 paid the host | rev 9 pays the host |
|---|---|---|
| serving all hour, proving on cadence | the hour | the hour |
| app crashes 19 min in, host settles at teardown | the full 30-min lease | 19 minutes |
| box dies silently 7 min into a lease | the full 30-min lease | 7 minutes |
| holds the lease, never serves | the full 30-min lease | nothing |
| host proves nothing for 40 min, then posts one proof | — | 15 minutes (one window) |

That last row is the design working: a host that goes dark and comes back is
paid for what it proves *after* it returns, never for the gap.

**Partial periods are the point.** A runner tearing down mid-hour — crash, owner
stop, eviction, drain, shutdown — posts a final checkpoint **and then** releases.
That order is load-bearing: `release` clears the watermark, so a proof sent
after it has no lease left to settle against. Skipping the final proof entirely
is legal and costs the runner the unproven tail, so the incentive points at
settling honestly either way. The supervisor wires this into every teardown path
that had actually been serving, and deliberately **not** into the ones that
never provisioned (claim-then-provision-failed earns nothing, as it should).

**Why two contracts.** `EnclaveDeployments` is ~90 bytes under the EIP-170
24,576-byte limit. EIP-712 + `ecrecover` + the anchor and window rules do not
fit there, so the protocol lives in **`EnclaveProofOfTime`**, bound into the
ledger **once** with `setProver` and then frozen (it refuses to overwrite a
non-zero binding — a seller's proof of service must never be re-pointable at
something the platform swaps in later). The ledger keeps only what touches
money: the `provenUntil` watermark, the meter clamp, and the prover-gated
`creditProven`. Every clamp that moves money is re-applied **in the ledger** —
never past `now`, never past `leaseUntil`, strictly monotonic, never beyond the
escrow held — so the worst a broken or hostile prover can do is degrade the
ledger to rev-8 held-time metering. It can never overpay beyond what rev 8
already would.

**The cutover is a date, not a flag.** `proofRequiredFrom` defaults to 14 days
after deployment. Before it, the meter pays held time exactly as rev 8 did while
checkpoints are already accepted and recorded — so every operator, including
independent sellers upgrading their own boxes on their own schedule, can watch
their own coverage and fix their box *before* it costs them anything. It is also
the kill switch: `setProofRequiredFrom` moves it either way with no other state
disturbed, and `provenUntil` keeps advancing meanwhile, so flipping it back on
resumes exactly where it left off. Past the cutover, `claim` additionally
refuses an enclave with no published `proofKey` — a box that cannot be paid
should not be holding a tenant's app.

**Watching it.** `provenUntil(id)` is the authority. The live shortfall is
`min(now, leaseUntil) - provenUntil` — zero on a healthy deployment, at most one
proof interval in normal operation, and a sustained non-zero value is a host
that stopped serving (`EnclaveProofOfTime.unprovenSec(id)` and `coverageOf(id)`
compute it, and `enclave status <id>` prints it). `EnclaveProofOfTime` also keeps
what the money path cannot afford to: `recordOf(id)` (`lastProofAt`,
`provenSec`, `proofs`) and `hostedSec(operator)` — lifetime **proven** hosting
seconds per host, the one uptime number in the system no seller can
self-report. A `lastProofAt` that stopped moving is the on-chain shape of
"stopped serving", and is exactly the evidence the claim bond exists to be
slashed against.

**The residual trust.** One lie no contract here can catch: an operator
registering a `proofKey` whose private half is *not* in its CVM. It is also the
one lie **anybody** can catch — the enclave serves its live proof key over its
attested origin (`/v1/attestation` → `proofKey.address`), so comparing that with
`EnclaveRegistry.get(enclaveId).proofKey` is a public check any tenant, watcher
or competing seller can run, and a mismatch is public evidence. Making the proof
adversarial rather than self-reported-within-an-attested-boundary — binding a
client-signed receipt, Storj's uplink orders — is the next step, and is listed
in the FUTURE block of `EnclaveProofOfTime.sol`.

### Fairness bounds (the price of decentralized failover)

The old per-tick clock could freeze during outages because one trusted party
kept it. Without that party, the quantum of trust is the **lease**:

- A runner that dies mid-lease has burned that lease. The **tenant's**
  worst-case loss is `leaseSec` per runner death (default 30 min). Clean
  shutdowns lose nothing (`release` refunds).
- The **runner's** exposure is now the mirror of that, and it is what rev 9
  changed: a host is paid only through its last checkpoint, so the gap between
  dying and being noticed earns it nothing. The most it can take for service it
  did not render is one anchor window (~8.5 min on Base) — a proof signed
  moments before the app died can still be redeemed while its block is in
  range — against the full 30 minutes a rev-8 ledger paid for the same silence.
- Two enclaves racing to claim: the loser's tx reverts. Gas on Base is cents;
  the jittered sweep below makes races rare.
- `leaseSec` is the tuning knob: shorter = tighter fairness + more gas;
  longer = cheaper + more exposure to dead runners.

## Supervisor-side claim loop

Everything below is written against `supervisor.js`'s existing internals:
`deployments` (the Map), `allocGpu`/`releaseGpu`, `provisionTenant`,
`gateAppReference`, `parseFirewall`, `saveStateSoon`, `chainClient`, and the
registry identity (`REGISTRY_PK`, `registerOnChain`). The claim loop **must**
sign with `REGISTRY_PRIVATE_KEY` — the contract checks that `msg.sender` is the
operator of the enclave's registry entry, so the two features share one EOA.

### Config

```js
const DEPLOYMENTS_ADDRESS = process.env.DEPLOYMENTS_ADDRESS || "";
const CLAIM_ENABLED   = /^(1|true|on)$/i.test(process.env.CLAIM_ENABLED || "");
const CLAIM_POLL_SEC  = parseInt(process.env.CLAIM_POLL_SEC  || "60", 10);  // queue sweep + split-brain check cadence
const RENEW_MARGIN_SEC= parseInt(process.env.RENEW_MARGIN_SEC|| "300", 10); // renew when < this much lease is left
// GPU enclaves wait this long after a CPU-only deployment becomes claimable
// before bidding, so CPU-only enclaves get first claim (GPU leftovers = fallback)
const CPU_CLAIM_GRACE_SEC = parseInt(process.env.CPU_CLAIM_GRACE_SEC || "120", 10);
const CLAIM_PAGE      = 100;
// ready iff we advertise on the registry (claims are gated to its operators)
// and we know our own enclave id (keccak256 of the advertised endpoint —
// registerOnChain already computes it; export it as _enclaveId).
const CLAIM_READY = CLAIM_ENABLED && !!(DEPLOYMENTS_ADDRESS && REGISTRY_READY);

const DEPLOYMENTS_ABI = [
  { type: "function", name: "claim",   stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "bytes32" }, { name: "enclaveId", type: "bytes32" }], outputs: [] },
  { type: "function", name: "renew",   stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "bytes32" }], outputs: [] },
  { type: "function", name: "release", stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "bytes32" }], outputs: [] },
  { type: "function", name: "claimable", stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "count",  stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "get",     stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }], outputs: [{ type: "tuple", components: DEPLOYMENT_TUPLE }] },
  { type: "function", name: "getPage", stateMutability: "view",
    inputs: [{ name: "start", type: "uint256" }, { name: "n", type: "uint256" }],
    outputs: [{ type: "tuple[]", components: DEPLOYMENT_TUPLE }] },
];
// DEPLOYMENT_TUPLE mirrors the struct; generate it from EnclaveDeployments.abi.json.
```

### The sweep: find work, filter locally, claim with jitter

```js
// One claim-loop pass: page the ledger, adopt anything claimable that fits.
// Runs every CLAIM_POLL_SEC alongside the payment watcher; never throws.
async function claimSweep() {
  if (!CLAIM_READY || !_enclaveId) return;              // not advertising yet
  for (let start = 0; ; start += CLAIM_PAGE) {
    const page = await chainClient.readContract({ address: DEPLOYMENTS_ADDRESS,
      abi: DEPLOYMENTS_ABI, functionName: "getPage", args: [BigInt(start), BigInt(CLAIM_PAGE)] });
    if (!page.length) break;
    for (const d of page) {
      if (deployments.has(d.id)) continue;              // already ours (running or recovering)
      if (!d.active || Number(d.leaseUntil) * 1000 > Date.now()) continue;  // stopped or leased
      if (d.balance6 < d.rate) continue;                // out of funded time — queue drops it
      // routing + capacity BEFORE claiming: never burn a user's lease we can't
      // serve. The deployment bought two shares; GPU work fits a card AND the
      // node's cpu pool; CPU-only work runs on CPU enclaves immediately, on GPU
      // enclaves only after a grace window (CPU enclaves get first claim) and
      // only out of LEFTOVER cpu pool.
      const gpuShare = Number(d.gpuMilli) / 1000, cpuShare = Number(d.cpuMilli) / 1000;
      if (gpuShare > 0) {
        if (!IS_GPU) continue;                          // GPU work never runs on a CPU-only enclave
        if (gpuShare * CARD_VRAM_GB > maxFreeVram() + 1e-9 || cpuShare > maxFreeCpu() + 1e-9) continue;
      } else {
        if (IS_GPU && Date.now() < (Math.max(Number(d.createdAt), Number(d.leaseUntil)) + CPU_CLAIM_GRACE_SEC) * 1000) continue;
        if (cpuShare > maxFreeCpu() + 1e-9) continue;
      }
      // catalog approval gate, same as the HTTP deploy path (fail closed); the
      // app's specs also set its minimum shares on OUR hardware — a deployment
      // that bought less is nobody's work item
      const g = await gateAppReference(d.appRef);
      if (g.error) continue;
      const mins = minSharesOf(g.min);       // specs / our hardware -> minimum shares
      if (gpuShare < mins.gpuShare - 1e-9 || cpuShare < mins.cpuShare - 1e-9) continue;
      // publisher-fee gate (rev-4 ledgers + rev-5 catalogs): a paid app's fee
      // must be snapshotted on the record (feeOf >= versionFee, right payee)
      // or the publisher never sees a cent — refuse, fail closed, like approval
      if (await feeGate(d.id, g)) continue;
      await tryClaim(d, g.ref);
    }
    if (page.length < CLAIM_PAGE) break;
  }
}

// Jitter + re-check + claim. The jitter de-syncs enclaves that all saw the same
// queue state; the eth_call re-check catches a claim that landed during the wait
// without paying for a reverted tx.
async function tryClaim(d, resolvedRef) {
  await new Promise(r => setTimeout(r, Math.random() * 5000));
  const open = await chainClient.readContract({ address: DEPLOYMENTS_ADDRESS,
    abi: DEPLOYMENTS_ABI, functionName: "claimable", args: [d.id] });
  if (!open) return;                                    // someone beat us to it — fine
  const hash = await claimWallet.writeContract({ address: DEPLOYMENTS_ADDRESS,
    abi: DEPLOYMENTS_ABI, functionName: "claim", args: [d.id, _enclaveId] });
  const rcpt = await chainClient.waitForTransactionReceipt({ hash });
  if (rcpt.status !== "success") return;                // lost the race; tx cost ~cents
  const fresh = await chainClient.readContract({ address: DEPLOYMENTS_ADDRESS,
    abi: DEPLOYMENTS_ABI, functionName: "get", args: [d.id] });
  await adopt(fresh, resolvedRef);
}
```

### Adoption: on-chain record → local `rec`, same provisioning path

The local record uses the **on-chain id as `rec.id`**, so the data path
(`/x/:id`, the TCP bridge, UDP addressing) works unchanged and clients can
derive the URL from chain state alone. `rec.owner` is the on-chain owner
address — SIWE tokens already carry an address, so private-deployment auth
works with zero changes.

```js
async function adopt(d, resolvedRef) {
  const gpuShare = Number(d.gpuMilli) / 1000, cpuShare = Number(d.cpuMilli) / 1000;
  // GPU work reserves a card slice AND its cpuShare; CPU-only work just the cpu pool
  const gpu = gpuShare > 0 ? allocGpu(gpuShare * CARD_VRAM_GB, gpuShare, cpuShare) : allocCpu(cpuShare);
  if (!gpu) { await releaseOnChain(d.id); return; }     // capacity vanished; refund the lease
  const rec = {
    id: d.id, owner: d.owner.toLowerCase(), status: "claimed",
    public: d.isPublic, firewall: firewallFromPorts(d.ports),  // CSV -> the parseFirewall shape
    image: { reference: resolvedRef }, command: [],
    resources: gpuShare > 0 ? { gpuShare, cpuShare, cardId: gpu.cardId } : { gpuShare: 0, cpuShare },
    network: { port: Number(d.appPort), protocol: "https", endpoint: null }, // filled from originOf per request
    createdAt: new Date(Number(d.createdAt) * 1000).toISOString(), startedAt: null,
    // the local clock only covers the CURRENT lease; the chain holds the rest
    remainingMs: Number(d.leaseUntil) * 1000 - Date.now(), consumedMs: 0,
    rate: Number(d.rate) / 1e6, paidUsdc: Number(d.spent6) + Number(d.balance6),
    _onchain: true, _leaseUntil: Number(d.leaseUntil),
    _gpu: gpu, _gpuSpec: gpuShare > 0 ? { cardId: gpu.cardId, vramCapGb: gpu.vramGb, computeShare: gpu.computeShare } : null,
  };
  deployments.set(rec.id, rec); saveStateSoon();
  if (!(await provisionTenant(rec))) {                  // launch failed (bad wasm, OOM, ...):
    deployments.delete(rec.id);                         // hand it back with a refund so another
    await releaseOnChain(rec.id); saveStateSoon();      // enclave can try — the user paid nothing
  }
}
```

### Renewal: piggyback on the billing ticker

The existing reaper already tears down when `remainingMs` hits zero. For
on-chain records, `remainingMs` means "paid until lease end", so the only new
behavior is *extending it* by renewing before expiry:

```js
// inside the BILL_TICK_SEC ticker, before the reaper check:
if (rec._onchain && rec.status === "running"
    && rec._leaseUntil * 1000 - Date.now() < RENEW_MARGIN_SEC * 1000 && !rec._renewing) {
  rec._renewing = true;
  claimWallet.writeContract({ address: DEPLOYMENTS_ADDRESS, abi: DEPLOYMENTS_ABI,
                              functionName: "renew", args: [rec.id] })
    .then(h => chainClient.waitForTransactionReceipt({ hash: h }))
    .then(() => chainClient.readContract({ address: DEPLOYMENTS_ADDRESS,
                  abi: DEPLOYMENTS_ABI, functionName: "get", args: [rec.id] }))
    .then(d => { rec._leaseUntil = Number(d.leaseUntil);
                 rec.remainingMs = rec._leaseUntil * 1000 - Date.now(); saveStateSoon(); })
    .catch(e => console.warn(`[claim] renew ${rec.id} failed (${e.shortMessage || e.message}) — `
                           + `letting the lease run out`))   // "unfunded" lands here: reaper handles it
    .finally(() => { rec._renewing = false; });
}
```

If `renew` reverts with `unfunded`, the balance can't buy another second: the
lease runs to its end, the existing reaper tears the app down (grace applies),
and the queue never offers the deployment again until someone tops it up —
"processed until there is no more time left", with no new teardown code.

### Split-brain guard

A partitioned enclave might keep serving after its lease expired and someone
else claimed. Each `claimSweep` pass therefore re-reads every adopted record:

```js
for (const rec of [...deployments.values()].filter(r => r._onchain)) {
  const d = await chainClient.readContract({ address: DEPLOYMENTS_ADDRESS,
    abi: DEPLOYMENTS_ABI, functionName: "get", args: [rec.id] });
  const mine = d.runnerOperator.toLowerCase() === claimAccount.address.toLowerCase();
  if (!d.active) {                     // owner stopped it: tear down AND release (refunds the tail)
    await teardown(rec); await releaseOnChain(rec.id);
  } else if (!mine || Number(d.leaseUntil) * 1000 < Date.now()) {
    await teardown(rec);               // lost the lease: stop serving; do NOT release (not ours)
  }
}
```

The check is one `eth_call` per adopted deployment per minute — the data path
itself stays chain-free. The exposure window (serving a few seconds past a
takeover) is harmless: the new runner is attested identically, app state is
ephemeral by design, and both instances are the same measured CID.

The same audit pass is where owner **version changes** land: a healthy record
whose ledger row carries a different `appRef` (the owner sent `setAppRef`) or
different bought shares (`setShares`, rev 6) is re-gated like a fresh claim and
restarted in place onto the new record — the held slice is swapped for one at
the new size, and a size this box can't fit (or shares below the version's
minimums) stops the app and releases the lease so a fitting enclave claims
it — see `switchTenantVersion` in `supervisor.js`.

### Graceful shutdown and restart

- **SIGTERM/SIGINT** (already hooked for `saveStateNow`): additionally
  `release()` every adopted deployment, in parallel with a ~10 s cap, then
  exit. Each release refunds the lease tail — a clean shutdown costs users
  nothing and reopens the queue immediately.
- **Restart** (same enclave): `loadState()` restores `_onchain` records; for
  each, the first `claimSweep` pass re-reads the chain — still ours with a
  live lease → resume (respawn the app if needed); lost meanwhile → drop
  locally. No special recovery protocol: the chain is the source of truth.

### Client-side resolution (site)

The dashboard/CLI resolves a portable deployment without contacting any
particular enclave first:

```
EnclaveDeployments.get(id)      -> runner (enclave id), leaseUntil, appRef, balance
EnclaveRegistry.get(runner)     -> endpoint, repo
SecureClient(endpoint,repo) -> attest, then https://<endpoint>/x/<id>[...]
```

On failover the endpoint changes; clients re-resolve (a 404/refused from the
old runner or a `Claimed` event both work as triggers) and re-attest against
the new enclave. This is the same no-trusted-gateway shape as discovery today.

## Open problems (known, deferred)

- **Secrets.** App config is the version's on-chain record — public by
  construction (and deployer-supplied config is retired entirely, so there is
  no per-deployment secret channel at all). Candidates: a fleet key negotiated
  over attested enclave-to-enclave channels (same measurement ⇒ mutual trust);
  or the owner posts secrets to the runner via a SIWE-authed endpoint after
  each claim (trustless but manual).
- **UDP addressing.** The per-deployment IPv6 host bits derive from the id and
  survive failover, but the /64 prefix is per relay box; a takeover by an
  enclave behind a different relay changes the address. Client re-resolution
  covers it, long-lived UDP flows don't.
- ~~**No on-chain refunds to the payer.**~~ **PARTLY SHIPPED in rev 10** —
  `refund(id)` lets an owner cancel a deployment and take back the unused
  runtime, but only what the contract still HOLDS: the runner escrow. The
  platform's and publisher's splits still forward immediately (non-custodial by
  design) and cannot be clawed back, so a refund returns `runnerBps` of the
  platform component of unspent time — ~80% today, less any publisher fee — and
  never the sticker price. Every client quotes `refundableOf(id)` (which is
  exact, not an estimate) rather than `balance6`, because the gap between the
  two is the part of the story users get wrong. Two guards make it trustless in
  both directions: whatever a live-or-still-provable lease could yet claim is
  reserved out of the payout, so cancelling can never strand a seller; and the
  payout is capped at `ownerEscrow6` — the escrow the owner's OWN fundings
  contributed — so a third party's top-up is not withdrawable by the owner and
  a refund stays a reversal of the owner's own payment
  (`docs/billing-runbook.md` §3). **Migration note:** imported records carry no
  escrow (the real USDC stays on the source contract), so the platform re-backs
  them with `fundEscrow` — and while the import window is open that credits
  `ownerEscrow6`, because it is re-seating money the owner already paid. Skip
  that and every pre-existing deployment migrates in permanently un-refundable,
  which `sealImports` then makes permanent. After sealing, a platform
  `fundEscrow` is the ETH-funding case and stays non-refundable.
  Closing the remaining gap (returning the
  platform's own 20% too) means escrowing it rather than forwarding it, i.e.
  making the contract custodial for the platform share — a real design change,
  not a patch.
- ~~**Consumed-time attestation**: runners posting signed usage checkpoints
  would shrink the dead-runner loss below `leaseSec`.~~ **SHIPPED in rev 9** —
  see "Proof of time (rev 9)" above. What remains of the idea is making the
  proof *adversarial* (a client-signed receipt or an independent prober, rather
  than the enclave's own attested assertion) — see the FUTURE block of
  `EnclaveProofOfTime.sol`. Returning unproven time to the **tenant** rather
  than leaving it escrowed is no longer open: rev 10's `refund` reaches it once
  the lease is closed out, since escrow a runner never proved against is escrow
  no lease can still claim.
- **`EnclaveDeployments` is at its size ceiling.** 146 bytes under EIP-170's
  24,576 as of rev 10, which is why rev 9's verification had to become a second
  contract. Rev 10's `refund` cost 953 bytes and did not fit; it was paid for by
  collapsing the *parameter-validation* revert strings (twelve `"<param> range"`
  into one `"range"`, three `"<field> length"` into `"length"`, the zero-amount
  checks into `"amount=0"`, `"USDC transferFrom failed"` into
  `"USDC transfer failed"`) — ~62 bytes reclaimed per unique string eliminated.
  That lever is still the largest one available, and it is far less blocked than
  this note used to claim: an audit of `supervisor.js`, `relay/`, `cli/` and
  `site/` found exactly **one** revert string that off-chain code branches on,
  `"over rate cap"` (`supervisor.js`, the renew loop's cap-blocked backoff).
  Everything else that looked like a consumer is a comment, a doc, or a
  client-side message that merely quotes the text. What IS pinned is the Foundry
  suite (`vm.expectRevert("literal")`), so a rename is a two-place edit. Keep
  state and authorization strings intact — they are what ops actually diagnose
  from; spend validation strings first. Measure with `forge build --sizes`
  before adding anything.
  > Do **not** buy bytes by lowering `optimizer_runs`. `runs=1` fits the current
  > contract with 46 bytes to spare, but `claim`/`renew` run on every lease
  > quantum for every deployment in the fleet, and that is the wrong hot path to
  > tax for a size problem the revert strings can solve.

## Deploy

```bash
# Base Sepolia dry run (compile + plan, no broadcast; re-emits the ABI):
DEPLOYER_PRIVATE_KEY=0x... node scripts/deploy-deployments.mjs --dry-run --yes

# Base Sepolia (uses REGISTRY_ADDRESS from enclaves/gpu/tinfoil-config.yml; prices and the
# publisher-fee cap are hardcoded in the contract, owner-adjustable later — no setter txs sent):
DEPLOYER_PRIVATE_KEY=0x... node scripts/deploy-deployments.mjs

# Base MAINNET:
NETWORK=base DEPLOYER_PRIVATE_KEY=0x... node scripts/deploy-deployments.mjs
```

> **CPU price.** The contract's hardcoded default CPU rate is
> `cpuPricePerSec6 = 834` µUSDC/s ≈ **$3.00/hour** for a full node — the same
> figure the site fallback (`pricing.js CPU_NODE_RATE`) and the fleet's
> `/v1/pricing` (`supervisor.js CPU_RATE`) advertise, so a fresh deploy needs
> no follow-up `setCpuPrice` tx. (The pre-2026-07-18 default was 278 ≈
> $1.00/hour, which had drifted below the advertised price — a redeploy back
> then would have silently reverted the live rate.)

The script writes `DEPLOYMENTS_ADDRESS` into `tinfoil-config.yml` when the line
exists (add it under the supervisor `env:` alongside `FORWARDER_ADDRESS`), and
re-emits `contracts/EnclaveDeployments.abi.json` so the checked-in ABI can't drift.
Constructor wiring: `usdc`, `payout` (the Enclave cold wallet), `registry` (claim gating),
`ethUsdFeed` (Chainlink; `ETH_USD_FEED=none` disables ETH funding).
