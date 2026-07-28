# Metal: permissionless hosting protocol

This describes how **anyone**, anonymously, can sell confidential-compute hosting
on enclave.host by running a Metal enclave, and why it is safe for tenants, the
platform, and the seller, even though none of them trust each other.

## The idea

A seller runs `metal` on a machine with a hardware TEE (AMD SEV-SNP or Intel
TDX). The enclave dials into the enclave.host relay, proves by hardware
attestation that it is running the exact published, reproducibly-built Metal
image, then claims funded on-chain deployments and serves them, earning lease
payments to an Ethereum address it controls. No sign-up, no KYC, no operator
allowlist, no static IP.

The seller is **untrusted**. That is the whole point: the security does not come
from trusting the person who owns the machine, it comes from the CPU.

## Who trusts what

| party | trusts | does NOT trust |
|---|---|---|
| tenant | the AMD/Intel root of trust; the published Metal source | the seller, the seller's OS/hypervisor, the relay |
| platform (relay) | the AMD/Intel root; the reproducible Metal measurement | the seller |
| seller | the on-chain lease contract (chain-held escrow pays the runner share) | the platform, the tenant |

Every trust edge terminates at a **hardware root** or an **on-chain contract**,
never at a human. A malicious seller cannot read tenant data (SEV-SNP encrypts
and integrity-protects guest memory; the host, including root, is outside the
boundary) and cannot run modified code (the launch measurement would not match a
published release, so the relay refuses to route and tenants refuse to connect).

## The four security gates

### 1. Attestation-gated attach (replaces the token allowlist)

When a Metal enclave dials `wss://api.enclave.host/v1/fleet-tunnel`, the relay
issues a random challenge. The enclave returns a **fresh SEV-SNP attestation
report** whose `report_data[0:32]` binds the transport key it will use, over that
challenge. The relay verifies it first-party, with no third party in the path:

- the report is signed by a **VCEK that chains to the AMD ARK** (root of trust),
  fetched from AMD KDS or carried in the report's extended-report auxblob;
- the **launch measurement is on the allowlist** of published Metal release
  measurements (per vcpu count); see *Measurement governance* below;
- `report_data` binds the transport key, and the challenge is fresh (anti-replay).

Only then is the tunnel authorized. There is **no shared secret and no per-seller
allowlist**: anyone whose enclave presents a valid Metal quote is in. This is
the permissionless core. (The bootstrap token path in `tunnel.js` remains for
first-party boxes and for platforms whose parts have no KDS-published VCEK.)

### 2. On-chain registration + earning (chain-escrowed)

The Metal supervisor already speaks `EnclaveRegistry` / `EnclaveDeployments`
(register → claim → lease). A seller enclave:

- signs with the seller's own operator EOA (`registryKey` in `metal/config.json`,
  delivered out-of-band via fw_cfg like the tunnel token, never part of the
  measurement). The **platform never holds this key**: it is the seller's
  on-chain identity, it earns to the seller's own `payoutAddress`, and nobody
  else can redirect either;
- registers with `endpoint = https://api.enclave.host/t/<enclaveId>`, a
  relay-hosted URL that routes through the tunnel, so a CGNAT box with no public
  address is still a valid, dialable registry entry;
- claims funded deployments it can serve, signing `claim`/`renew`/`release` with
  that key.

**You set your own price (schema rev 2 of `EnclaveRegistry`, rev 8 of the
ledger).** Your registry entry carries what your WHOLE machine costs per
second — `cpuPricePerSec6` for the node's vCPU+RAM, `gpuPricePerSec6` for one
card — and that is what a tenant is charged, pro-rata to the shares it bought,
the moment you claim its work. There is no platform list price to undercut or
sit above any more: buyers see every box's price, pick from the ones inside
their deployment's `maxRate6` ceiling, and a deployment whose ceiling is under
your price is simply not yours to take (`claim` reverts `"over rate cap"`).
Set it with `priceCpuUsdHr` / `priceGpuUsdHr` in `config.json`; the guest
publishes it at registration and re-publishes on the next heartbeat whenever
you change it. Price yourself out of the market and your box idles; price
under the fleet and queued work lands on you first.

**You get paid for time you PROVE you served (schema rev 9 of the ledger).**
This is the one rule change a seller has to internalise: holding a lease no
longer earns. Every 5 minutes your box signs a checkpoint — *"this app was
running here through time T"* — and the ledger pays you for
`min(now, leaseUntil, provenUntil)`. Three things follow.

*It is automatic, and there is no key to provision.* The signing key is
secp256k1 and **minted inside your CVM at boot**, alongside the TLS-bridge and
session keys; the guest publishes its address to your registry entry
(`EnclaveRegistry.setProofKey`, schema 3) on the next heartbeat and re-publishes
after every relaunch, because the key is memory-only. You never see it, and
neither does the platform — which is the point: your operator EOA came from
outside the CVM (it is in your `config.json`), so a signature from *that* proves
nothing about what your box is running. This key proves it.

*A partial period pays pro-rata, to the second.* If a tenant's app crashes 19
minutes into the hour, your supervisor posts a final checkpoint and then
releases, and you are paid 19 minutes. Under rev 8 you would have been paid the
whole 30-minute lease; under rev 9 a box that dies silently 7 minutes in is paid
7 minutes. The symmetry is deliberate — you are no longer paid for dead air, and
tenants can see that you are not.

*If your proving loop stops, your income stops* within one proof window (15
minutes), even though the lease is still yours and the tenant is still paying.
Watch `/v1/health` → `.proofOfTime`: `ready:true` and a `lastRoundAt` that keeps
moving means you are earning. A rising `rejected` count, or a box logging
`rev-9 ledger but NO prover address`, means you are working for free. The
ledger's `proofRequiredFrom` gives the network a 14-day grace window after the
rev-9 deployment in which held time still pays and checkpoints are merely
recorded — that window exists so you can confirm your box is proving *before* it
costs you anything. Do not spend it.

One thing you cannot do, and everyone can check: registering a `proofKey` whose
private half is not actually in your CVM. Your enclave serves its live key at
`/v1/attestation` over its attested origin, so anyone can compare that with your
registry entry, and a mismatch is public evidence against you — which is exactly
what the bond below exists to be slashed against.

**How payout works (schema rev 7 of `EnclaveDeployments`).** Every claim
snapshots a per-second **runner rate**: `runnerBps` (owner-set, default
**80%**) of the platform component of the price YOU posted. The app
publisher's fee is carved out first, exactly as before. When a user funds a deployment
with USDC, the runner's pro-rata share of that funding is **retained in the
contract as escrow** instead of being forwarded to the platform wallet. A
credit meter then moves escrow to whichever operator EOA holds the lease, one
second at a time, **for lease time actually held**: `renew` and `release`
settle the current runner, the next `claim` settles a dead runner's expired
quantum, and the permissionless `settle(id)` collects anything left. A
released tail refunds to the user and earns the runner nothing, so a
claim-and-bail earns ~zero. `withdrawEarnings(to)` pays the operator's
accrued USDC (across all deployments it ever served) to any address; the
Metal supervisor sweeps it to the seller's configured `payoutAddress`
automatically once it clears a minimum (default $5).

The seller's trust never leaves the chain: the escrow is held by the
contract, the rate snapshot is immutable for the deployment's life (a resize
re-buys it at your then-current posted price), and credits are structurally
capped by escrow, so
the meter cannot promise money the contract does not hold. The platform
cannot touch a claimable deployment's escrow (`sweepEscrow` only recovers
residual dust after a record is drained and unleased).

### 3. The relay stays a keyless router

The relay routes ciphertext, not trust. Control-plane API calls terminate TLS at
the relay today (the same trade-off as the hosted fleet); **app traffic**
(`<id>.app.enclave.host`) is SNI-passed-through the tunnel so TLS terminates
**inside the CVM** and the relay never sees tenant plaintext. A tenant can fetch
`/t/<id>/v1/attestation` and verify the enclave end-to-end *before* sending a
byte, exactly as with a first-party enclave.

### 4. Anti-sybil / anti-grief

- A fake or modified enclave cannot attach (gate 1) or be routed to.
- A real enclave that claims work and releases without serving earns ~nothing
  (the meter pays for time PROVEN, and a release hands the tail back); a
  claim-and-vanish earns at most one **anchor window** — ~8.5 minutes, the range
  of `blockhash` on Base — because a checkpoint stops being redeemable shortly
  after it is signed and cannot be pre-signed at all. Before rev 9 the same
  attack earned a full lease quantum (30 min).
- Attach is rate-limited per source IP; claiming can require a small on-chain
  **bond** (rev 7 ships it: `postBond` gates `claim` when the owner sets
  `setClaimBond`, exit is timelocked, and provable misbehavior such as repeated
  claim-without-serving is slashable with public evidence in the event log).
  Off by default; spinning up thousands of earning identities has a cost the
  moment it's on. Griefing is further bounded by non-refundable funding
  thresholds (see `docs/autoscale.md`).

## Measurement governance

The allowlist is the set of launch measurements of **published, reproducibly-built
Metal releases**. Because the build is deterministic (`build-image.mjs` →
byte-identical initramfs → identical measurement), anyone can rebuild a release
and confirm its measurement independently with `sev-snp-measure`. The allowlist
is therefore **auditable, not authoritative**: the platform publishes it (committed
in the relay, and/or in an on-chain `EnclaveMeasurements` registry), and anyone
can check that each entry corresponds to a real, inspectable source release.

This is strictly stronger than the hosted model's Sigstore link: the measurement
*is* the code, folded into the hardware quote, with no transparency-log detour.

### Model volumes stay OUT of the measurement (and in HOST_DATA)

A seller carrying model volumes (README, "Model volumes") is running the same
release as everyone else with different DATA attached. If that data entered the
launch measurement — the obvious design, and what Modelwrap does by putting its
dm-verity root on the kernel cmdline — then every distinct model set would be a
distinct measurement, and gate 1's allowlist would have to enumerate the
cross-product of releases and model sets. Permissionless attach would break for
exactly the sellers we want.

So the volume-set digest goes in **HOST_DATA** (`MRCONFIGID` on TDX): signed by
the CPU into every report, absent from the launch measurement. The guest reads
it back out of its own report and refuses to mount a volume table that doesn't
hash to it, so the binding is fail-closed inside the enclave, not merely
observable outside it. Result: **identity of the code and identity of the data
are separable** — the allowlist keeps pinning releases, while any verifier reads
straight off the quote which models the box is serving, and dm-verity guarantees
the bytes behind each of those roots.

## What a seller runs

```sh
git clone https://github.com/EnclaveHost/enclave && cd enclave
sudo bash metal/host-setup.sh                 # one-time: SEV device perms
node metal/build-image.mjs \
  --supervisor ghcr.io/enclavehost/enclave-supervisor@sha256:<d> \
  --wasm       ghcr.io/enclavehost/enclave-wasm-manager@sha256:<d>
# Reproducible ONLY with both images pinned by digest (the release notes
# carry them, and dist/manifest.json records `reproducible: true|false`).
# A bare invocation resolves TAGS, so it builds a different measurement
# whenever the tag moves and must not be curated into the allowlist.
# metal/config.json: set registryKey to a fresh EOA key funded with a few
# dollars of Base ETH (gas for register/claim/renew), payoutAddress to YOUR
# wallet, and publicUrl to the relay-routed https://api.enclave.host/t/<name>
node metal/enclave-metal.mjs --config metal/config.json   # attaches, registers, earns
```

That is the entire onboarding. No account, no approval. Earnings accrue on
`EnclaveDeployments` (`earned6(operator)`, visible in the enclave's
`/v1/health` as `earnings`) and auto-sweep to `payoutAddress`.

## Delivery phases

- **A, foundation (done):** token-gated tunnel, a Metal enclave presented on
  enclave.host, running under systemd, real SEV-SNP measured boot, reproducible
  measurement, first-party `verify.mjs`.
- **B, attestation-gated attach (done):** the relay verifies the SNP quote on
  attach against the measurement allowlist (gate 1). Permissionless, no token.
- **C, permissionless earning (built; activation is operator-gated):** the
  rev-7 `EnclaveDeployments` pays the runner share to the seller EOA from
  in-contract escrow (gate 2), the Metal config carries the seller's
  `registryKey`/`payoutAddress`, and the supervisor auto-sweeps earnings; the
  optional claim bond (gate 4) is in the contract, off by default. What
  remains is operational: the platform redeploying the rev-7 ledger (and
  migrating records), publishing the measurement allowlist, and the seller
  funding their EOA with gas.
- **D, end-to-end app privacy:** SNI passthrough of app traffic over the tunnel
  so the relay never sees tenant plaintext (gate 3, app plane).

Phases B–D are additive and preserve every invariant above; each is independently
shippable.
