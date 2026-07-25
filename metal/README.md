# Enclave Metal — self-hosted TEE enclave server (Tinfoil-independent)

Metal runs the exact same enclave stack as the hosted fleet (supervisor +
wasm-manager, the same digest-pinned images) inside a **self-launched
confidential VM** on hardware you own. No Tinfoil controlplane, no shim, no
vault: every platform service Tinfoil provides is replaced by an auditable
first-party equivalent in this directory.

It targets **any TEE, CPU and/or GPU**: AMD SEV-SNP today (QEMU
`sev-snp-guest`), Intel TDX by swapping the launch object (`tdx-guest`, same
image, same agent — the guest attestation driver is the configfs-tsm
abstraction, which serves both), and NVIDIA confidential computing by GPU
passthrough into the CVM (the GPU flavor's worker/MPS containers ride along
unchanged; CC attestation still comes from NVML inside the guest).

**See also:** [PROTOCOL.md](PROTOCOL.md) — the permissionless protocol for
anyone to sell hosting on enclave.host anonymously (attestation-gated attach,
chain-escrowed runner payout to the seller's own wallet, keyless relay).
[HANDOFF.md](HANDOFF.md) — what is live and the operator-gated production steps.

```
host (untrusted)                       guest CVM (trusted, measured)
┌──────────────────────────┐   ┌───────────────────────────────────────┐
│ systemd: enclave-metal   │   │ /init (busybox, in the launch digest) │
│   └─ QEMU -object        │   │   ├─ wasm-manager  (chroot, :8091)    │
│      sev-snp-guest       │──▶│   ├─ supervisor    (chroot, :8080)    │
│      kernel+initrd+      │   │   └─ metal-agent   (:8443)            │
│      cmdline measured    │   │       ├─ in-CVM TLS front             │
│                          │   │       ├─ RAD: /.well-known/           │
│  (no disk, RAM only)     │   │       │   enclave-attestation         │
└──────────────────────────┘   │       │   (configfs-tsm SNP report,   │
                               │       │    report_data = TLS pubkey)  │
        outbound WSS only      │       └─ fleet-tunnel client ─────────┼──▶ api-relay
        (CGNAT-safe)           └───────────────────────────────────────┘   (enclave.host)
```

## Why the trust story is *stronger* than the hosted fleet

Tinfoil measures the container config and images at its controlplane, but "no
guest RTMR-extend" means a launched image's digest is not folded into the
hardware registers — the quote proves the Tinfoil CVM, and Sigstore ties the
config to the repo. Metal's guest is a **single initramfs**: kernel, initrd
(which *contains* the supervisor and wasm-manager bytes, extracted from the
same digest-pinned images the fleet runs) and cmdline are all covered by the
SEV-SNP **launch digest** via direct-boot measured OVMF (`kernel-hashes=on`).
There is no unmeasured byte in the TCB: the quote alone proves the exact
supervisor code, with no transparency-log detour needed (the Sigstore record
remains as provenance, not as a trust root).

## Components

| file | role |
|---|---|
| `build-image.mjs` | reproducible, **unprivileged** guest image build: pulls the digest-pinned OCI images straight from ghcr (no docker), a pinned Arch kernel package, busybox; emits `dist/` (kernel, initramfs, cmdline) + `dist/manifest.json` with every input digest and the expected SNP launch digest |
| `oci-pull.mjs` | dockerless OCI puller (anon token, digest-verified blobs, whiteout-aware extraction) |
| `guest/init` | PID 1 in the CVM: mounts, virtio + TSM modules, DHCP, per-boot secret minting, starts the three services, restarts them, reboots on wedge |
| `guest/agent.mjs` | the metal-agent — everything the Tinfoil shim did: mints the in-CVM TLS key, gets the SNP report over configfs-tsm with `report_data[0:32] = sha256(TLS pubkey SPKI)`, serves the RAD, fronts the supervisor with TLS, and maintains the outbound fleet tunnel |
| `enclave-metal.mjs` | host-side launcher: builds QEMU argv (`dev` \| `snp` \| `tdx` mode), spawns, watches, restarts; serial console to the journal |
| `systemd/enclave-metal.service` | user service (`systemctl --user`), `Restart=always` |
| `verify.mjs` | first-party attestation verification: SNP report signature chain VCEK → ASK → ARK fetched **directly from AMD KDS** (`kdsintf.amd.com`), launch-digest comparison against `manifest.json`, TLS-key binding check. No Tinfoil endpoints. Used by the CLI (`enclave attest` learns the `metal` RAD formats) |
| `config.example.json` | host config: mode, cpus/ram, enclave name, relay URL, key paths |

## RAD format

The metal-agent serves `/.well-known/enclave-attestation` (and the supervisor
finds it via the `RAD_URL` env override — on the hosted fleet that env is
unset and the Tinfoil loopback shim path is used, unchanged):

```json
{ "format": "sev-snp-guest-metal-v1", "body": "<base64 SNP report>",
  "certs": { "vcek": "...", "chain": "..." },
  "manifest": { "kernel": "sha256:...", "initrd": "sha256:...", "cmdline": "..." } }
```

Dev mode (TEE disabled in BIOS, plain KVM) serves `format:
"dev-unattested-metal-v1"` — verifiers and the site MUST render this as
**UNATTESTED (dev)**; it exists so the whole pipeline can be exercised before
the SEV BIOS toggle, and becomes `sev-snp-guest-metal-v1` with no other change
once the hardware is enabled. TDX guests serve `tdx-guest-metal-v1` from the
same configfs-tsm code path.

## Reachability: the fleet tunnel (CGNAT-safe)

Every existing relay→enclave path dials INTO the enclave's public endpoint; a
self-hosted box behind CGNAT has none. Metal inverts the transport: the
metal-agent dials **out** to `wss://api.enclave.host/v1/fleet-tunnel` and holds
a multiplexed channel; the api-relay routes that enclave's `/v1/*`, `/x/*` and
app-zone traffic over the tunnel instead of `proxyTo`. Identity: the agent
holds an ed25519 tunnel key minted in-guest at first boot; acceptance is an
explicit per-enclave allowlist **in the relay code** (public keys are public —
committed in-repo, deployed by the normal relay CI; no new on-box secrets).
The SNI relay reaches tunnel enclaves by dialing the api-relay hub
(`wss://api.enclave.host/t/<name>/x/...`) so raw-TLS passthrough (in-CVM
termination, TLS-ALPN-01 ACME) keeps working without the fleet SECRET.

A metal enclave with a public IP (a colo box) skips the tunnel: set
`PUBLIC_URL`, the agent fronts 443 directly, the relay dials in as it does for
the hosted fleet.

## What degrades without the fleet secrets (and stays off by default)

- fleet deployment-secrets fetch (`SECRET`-HMAC with the relay) — off
- in-enclave ACME DNS-01 push (`SECRET`-HMAC with dns-relay) — off; TLS-ALPN-01 via the tunnel replaces it
- dedicated-IP egress/ingress (`EGRESS_RELAY_TOKEN`) — off
- on-chain registry + claim loop + earning — off until the seller sets
  `registryKey` (a funded operator EOA; a few dollars of Base ETH for gas) and
  `payoutAddress` in `metal/config.json`. With them set, the guest supervisor
  registers, claims funded deployments, and the rev-7 `EnclaveDeployments`
  ledger pays the runner share from escrow — auto-swept to `payoutAddress`
  (see PROTOCOL.md, "How payout works")
- `SECRET`/`ADMIN_TOKEN` are minted **in-guest per boot** — the host operator
  cannot read them (stronger than vault injection)

A dev-mode metal enclave additionally keeps `CLAIM_ENABLED=0` and is excluded
from the fleet capability-AND so it can neither claim paid work nor degrade
fleet-wide feature flags.

## Quick start (this repo, any Linux host with /dev/kvm)

```sh
node metal/build-image.mjs                 # unprivileged; ~10 min first run
node metal/enclave-metal.mjs --config metal/config.json   # dev mode boot
curl -sk https://127.0.0.1:18443/.well-known/enclave-attestation | jq .format
curl -s  http://127.0.0.1:18080/v1/health  # supervisor, via hostfwd
# install as a service:
mkdir -p ~/.config/systemd/user && cp metal/systemd/enclave-metal.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now enclave-metal
```

SNP mode needs: BIOS `SMEE`/`SEV-SNP` enabled + SNP RMP coverage, kernel
`kvm_amd sev_snp=Y`, `/dev/sev` present; then set `"mode": "snp"` in the
config. TDX mode: `"mode": "tdx"` on a TDX host.
