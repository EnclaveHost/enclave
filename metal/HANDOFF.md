# Metal — operator handoff & production checklist

What is live, what needs your access or a decision, and how to drive it. Written
for the enclave.host operator (Steven).

## What is live right now

- A self-hosted **SEV-SNP** enclave (`metal0`) runs on this box under systemd
  (`systemctl --user status enclave-metal`), completely independent of Tinfoil.
- It is **presented on production enclave.host**: `https://api.enclave.host/enclaves`
  lists it as `tunnel://metal0` next to the Tinfoil GPU enclave, and
  `https://api.enclave.host/t/metal0/v1/health` answers over the reverse tunnel.
- It is **independently verifiable**:
  `node metal/verify.mjs --url https://api.enclave.host/t/metal0 --vcpus 4`
  → the launch measurement matches the reproducible build and the served key is
  bound into the SEV-SNP quote.
- The relay tunnel + permissionless attestation-gated attach are deployed
  (permissionless attach is OFF until you curate a measurement allowlist — see
  below — so nothing about the existing fleet changed).

## Needs your access / a decision

### 1. Make `/dev/sev` access persistent (2 min, root)
You granted it for this session with `setfacl`. To survive reboot:
```sh
sudo bash metal/host-setup.sh      # installs a udev rule + memlock limit
```

### 2. (Optional) Run as a boot-time system service instead of a user service
The enclave currently runs as a **user** service (survives logout via linger).
For a hardened, boot-time, cross-user deployment:
```sh
sudo cp metal/systemd/enclave-metal.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now enclave-metal
systemctl --user disable --now enclave-metal    # stop the user one first
```

### 3. Turn on the permissionless seller protocol (Phase C) — a decision
Today anyone can *attach* by attestation, but earning is not wired. To let
anonymous sellers actually earn:

- **Curate the measurement allowlist.** Establish a Metal **release** (tag +
  reproducible build) and publish its launch measurements per vcpu count. Then on
  the relay box set `METAL_ALLOWED_MEASUREMENTS=<hex,hex,…>` (and keep
  `METAL_REQUIRE_VCEK=1`). Until then, attach stays token-only. The allowlist is
  auditable: anyone can rebuild the release and reproduce each measurement.
- **On-chain earning.** Point a seller enclave's registry endpoint at
  `https://api.enclave.host/t/<enclaveId>` (relay-hosted, routes through the
  tunnel) and enable `REGISTRY_ENABLED`/`CLAIM_ENABLED` with an in-guest-minted
  EOA. Decide gas: either the seller funds their EOA (a few dollars of Base ETH)
  or the platform sponsors first registration.
- **Anti-sybil.** Decide whether registration requires a small on-chain bond and
  the per-IP attach rate limit.

### 4. Full hardware-signature chain on THIS box (informational, likely no action)
This workstation EPYC reports a masked/unprovisioned chip id, so AMD KDS has no
VCEK for it and `verify.mjs` reports the signature chain **inconclusive**
(measurement + key binding still verify). A datacenter EPYC provisions its VCEK
and the chain verifies fully — nothing to fix in the code.

### 5. This box's egress helper (informational)
This sandboxed host blocks QEMU user-net's *external* NAT, so `metal/config.json`
enables a small host-side egress helper. A normal seller box has working NAT and
should leave `egressHelper` unset.

## Secrets & where they live

- The `metal0` tunnel **token** is only in the gitignored `metal/config.json`; the
  relay holds just its **sha256** (in `DEFAULT_METAL_ALLOW`, committed). Rotate by
  changing both.
- All in-CVM secrets (`SECRET`, `ADMIN_TOKEN`, the session + TLS keys) are minted
  **inside the guest per boot** — the host operator never sees them.

## Quick operations

```sh
systemctl --user status  enclave-metal          # state
journalctl --user -u enclave-metal -f           # logs (guest serial)
node metal/build-image.mjs                       # rebuild (reproducible)
systemctl --user restart enclave-metal           # apply a new build
node metal/verify.mjs --url https://api.enclave.host/t/metal0 --vcpus 4
```
