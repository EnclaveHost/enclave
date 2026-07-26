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

**How payout works (schema rev 7 of `EnclaveDeployments`).** Every new
deployment snapshots a per-second **runner rate**: `runnerBps` (owner-set,
default **80%**) of the platform component of its price. The app publisher's
fee is carved out first, exactly as before. When a user funds a deployment
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
re-buys it, like the price), and credits are structurally capped by escrow, so
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
  (the meter pays for lease time HELD, and a release hands the tail back); a
  claim-and-vanish earns at most one lease quantum before the stranded-lease
  sweep re-claims the work for another enclave.
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

## What a seller runs

```sh
git clone https://github.com/EnclaveHost/enclave && cd enclave
sudo bash metal/host-setup.sh                 # one-time: SEV device perms
node metal/build-image.mjs                     # reproducible; matches the allowlist
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
