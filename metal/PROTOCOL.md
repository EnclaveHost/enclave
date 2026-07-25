# Metal — permissionless hosting protocol

This describes how **anyone**, anonymously, can sell confidential-compute hosting
on enclave.host by running a Metal enclave — and why it is safe for tenants, the
platform, and the seller, even though none of them trust each other.

## The idea

A seller runs `metal` on a machine with a hardware TEE (AMD SEV-SNP or Intel
TDX). The enclave dials into the enclave.host relay, proves by hardware
attestation that it is running the exact published, reproducibly-built Metal
image, then claims funded on-chain deployments and serves them — earning lease
payments to an Ethereum address it controls. No sign-up, no KYC, no operator
allowlist, no static IP.

The seller is **untrusted**. That is the whole point: the security does not come
from trusting the person who owns the machine, it comes from the CPU.

## Who trusts what

| party | trusts | does NOT trust |
|---|---|---|
| tenant | the AMD/Intel root of trust; the published Metal source | the seller, the seller's OS/hypervisor, the relay |
| platform (relay) | the AMD/Intel root; the reproducible Metal measurement | the seller |
| seller | the on-chain lease contract (non-custodial payout) | the platform, the tenant |

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
challenge. The relay verifies, first-party (no Tinfoil, no third party):

- the report is signed by a **VCEK that chains to the AMD ARK** (root of trust),
  fetched from AMD KDS or carried in the report's extended-report auxblob;
- the **launch measurement is on the allowlist** of published Metal release
  measurements (per vcpu count) — see *Measurement governance* below;
- `report_data` binds the transport key, and the challenge is fresh (anti-replay).

Only then is the tunnel authorized. There is **no shared secret and no per-seller
allowlist** — anyone whose enclave presents a valid Metal quote is in. This is
the permissionless core. (The bootstrap token path in `tunnel.js` remains for
first-party boxes and for platforms whose parts have no KDS-published VCEK.)

### 2. On-chain registration + earning (non-custodial)

The Metal supervisor already speaks `EnclaveRegistry` / `EnclaveDeployments`
(register → claim → lease). A seller enclave:

- mints (or is given) an Ethereum key **inside the CVM**; the host operator never
  sees it, so they cannot divert payouts or forge the enclave's on-chain identity;
- registers with `endpoint = https://api.enclave.host/t/<enclaveId>` — a
  relay-hosted URL that routes through the tunnel, so a CGNAT box with no public
  address is still a valid, dialable registry entry;
- claims funded deployments it can serve, signing `claim`/`renew`/`release` with
  that key.

> **Payout is NOT yet wired for sellers — this needs a contract change.**
> `EnclaveDeployments` today forwards every funding payment, in the funding
> transaction itself, to a single platform `payout` cold wallet (minus the
> optional app-publisher fee). `claim`/`renew`/`release` only move accounting
> numbers; the runner EOA that claims is recorded solely for authorization and
> receives **nothing** on-chain. So a permissionless seller currently earns
> nothing through the contract — operator compensation is off-chain.
>
> To make this a real earning protocol, `EnclaveDeployments` must settle a
> per-runner share to `runnerOperator` (the seller's in-CVM EOA) as lease time is
> burned — a metered split at `release`/`renew`, or a claimable per-runner
> balance. That is the core open contract work for Phase C. Until it ships, a
> "seller" can serve deployments but is not paid on-chain.

### 3. The relay stays a keyless router

The relay routes ciphertext, not trust. Control-plane API calls terminate TLS at
the relay today (the same trade-off as the hosted fleet); **app traffic**
(`<id>.app.enclave.host`) is SNI-passed-through the tunnel so TLS terminates
**inside the CVM** and the relay never sees tenant plaintext. A tenant can fetch
`/t/<id>/v1/attestation` and verify the enclave end-to-end *before* sending a
byte, exactly as with a first-party enclave.

### 4. Anti-sybil / anti-grief

- A fake or modified enclave cannot attach (gate 1) or be routed to.
- A real enclave that claims work and fails to serve earns nothing (billing ticks
  only while healthy) and its lease is re-claimed by another enclave; the existing
  stranded-lease sweep handles this.
- Attach is rate-limited per source IP; registration can require a small on-chain
  **bond** (slashable on provable misbehavior) so spinning up thousands of fake
  identities has a cost. Griefing is further bounded by non-refundable funding
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
# fund the enclave's EOA with a few dollars of Base ETH (gas for register/heartbeat)
node metal/enclave-metal.mjs --config metal/config.json   # attaches, registers, earns
```

That is the entire onboarding. No account, no approval.

## Delivery phases

- **A — foundation (done):** token-gated tunnel, a Metal enclave presented on
  enclave.host, running under systemd, real SEV-SNP measured boot, reproducible
  measurement, first-party `verify.mjs`.
- **B — attestation-gated attach:** the relay verifies the SNP quote on attach
  against the measurement allowlist (gate 1). Permissionless, no token.
- **C — permissionless earning:** relay-hosted registry endpoint + claim/lease/
  payout to the seller EOA (gate 2); optional registration bond (gate 4).
- **D — end-to-end app privacy:** SNI passthrough of app traffic over the tunnel
  so the relay never sees tenant plaintext (gate 3, app plane).

Phases B–D are additive and preserve every invariant above; each is independently
shippable.
