# Metal — operator handoff & production checklist

What is live, what needs your access or a decision, and how to drive it. Written
for the enclave.host operator (Steven).

## What is live right now

- A self-hosted **SEV-SNP** enclave (`metal0`) runs on this box under systemd
  (`systemctl --user status enclave-metal`), completely independent of Tinfoil.
- It is **presented on production enclave.host**: `https://api.enclave.host/enclaves`
  lists it as **`metal0`** (`name` field; its `endpoint` stays the internal
  `tunnel://metal0` routing key) next to the Tinfoil GPU enclave, and
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
The earning machinery is now BUILT end to end; what remains is operational
activation, all of it yours:

- **Redeploy `EnclaveDeployments` (schema rev 7) + migrate.** The rev-7
  contract pays a metered runner share — `runnerBps` (default **8000** = 80%
  of the platform component, publisher fee excluded; change it pre-deploy or
  via `setRunnerBps`) — from per-deployment USDC escrow to whichever operator
  EOA holds each lease, with `withdrawEarnings` payout and an optional
  slashable claim bond (`setClaimBond`, off by default). Deploy + migrate from
  the admin console exactly like the rev-6 cutover (the migration now also
  carries `importEarn` rate snapshots; note migrated records have NO escrow
  until re-backed with `fundEscrow`, so they pay runners nothing until then —
  new deployments escrow from their first funding). NOTE: rev 7 compiles
  **viaIR** (it outgrew legacy codegen's EIP-170 headroom); both compile paths
  already match.
- **Decide the hosted fleet's own payout.** Rev 7 diverts the runner share of
  NEW deployments' fundings into escrow, and the fleet's enclaves earn it as
  they serve. Set `PAYOUT_ADDRESS=<the platform cold wallet>` (plus optional
  `EARNINGS_MIN_USDC`, default 5) in the fleet configs so each enclave
  auto-sweeps its earnings home — without it, earnings simply accrue on the
  contract under each enclave's operator EOA, withdrawable any time.
- **Curate the measurement allowlist.** Establish a Metal **release** (tag +
  reproducible build) and publish its launch measurements per vcpu count. Then on
  the relay box set `METAL_ALLOWED_MEASUREMENTS=<hex,hex,…>` (and keep
  `METAL_REQUIRE_VCEK=1`). Until then, attach stays token-only. The allowlist is
  auditable: anyone can rebuild the release and reproduce each measurement.
- **Anti-sybil.** Decide whether to turn the claim bond on
  (`setClaimBond(bond6, exitDelaySec)`; a bond ≥ one lease quantum's runner
  share makes claim-without-serving unprofitable) and the per-IP attach rate
  limit. Slashing is an owner action with public evidence in the event log.
  CAREFUL: the bond gates EVERY claim, including the hosted fleet's own —
  post a bond from each first-party operator EOA (`postBond`) BEFORE flipping
  it on, or the fleet stops claiming new work (running leases keep renewing).
- **Seller side (documented in `metal/config.example.json`):** set
  `registryKey` (fresh EOA + a few dollars of Base ETH for gas),
  `payoutAddress`, and `publicUrl=https://api.enclave.host/t/<name>`; the
  guest supervisor then registers, claims, earns, and auto-sweeps.
- **OPEN DESIGN QUESTION — heterogeneous node sizing.** App minimum shares
  are sized against the fleet-wide MINIMUM node (relay `spec*` fields), so a
  small node joining the CLAIMING set inflates every CPU app's minimum share
  and price for all buyers (observed 2026-07-25: the 3 GB metal demo box made
  a 512 MB app's minimum 17% instead of 1% — fixed for NON-claiming boxes by
  scoping sizing to claiming enclaves, but a real small SELLER will do it
  again the moment it claims). The deploy CONSOLE now sidesteps this: it
  targets a specific enclave per deploy (pickEnclaveFor — cheapest fitting
  box, i.e. the largest hardware; shown as "deploys to <name>", rerouted or
  refused live as availability changes), so its floors never inflate from a
  small box. Still open for the AGGREGATE consumers (CLI, quick-deploy, MCP
  — they size on the relay's fleet-min spec* fields) and as policy: a
  node-class floor for sellers (e.g. min 16 vCPU / 64 GB to earn), or
  absolute-unit pricing in a future ledger rev. The current per-node-fraction
  pricing pays a 3 GB node the same per share as a 64 GB one, so some floor
  is likely wanted anyway.

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
