# Enclave Metal: self-hosted TEE enclave server

Metal runs the exact same enclave stack as the hosted fleet (supervisor +
wasm-manager, the same digest-pinned images) inside a **self-launched
confidential VM** on hardware you own. No external controlplane, no vendor
shim, no hosted vault: every service the managed fleet gets from its provider
is replaced by an auditable first-party equivalent in this directory.

It targets **any TEE, CPU and/or GPU**: AMD SEV-SNP today (QEMU
`sev-snp-guest`), Intel TDX by swapping the launch object (`tdx-guest`, same
image, same agent, because the guest attestation driver is the configfs-tsm
abstraction, which serves both), and NVIDIA confidential computing by GPU
passthrough into the CVM (the GPU flavor's worker/MPS containers ride along
unchanged; CC attestation still comes from NVML inside the guest).

**See also:** [PROTOCOL.md](PROTOCOL.md), the permissionless protocol for
anyone to sell hosting on enclave.host anonymously (attestation-gated attach,
chain-escrowed runner payout to the seller's own wallet, keyless relay).
[HANDOFF.md](HANDOFF.md) covers what is live and the operator-gated
production steps.

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

## Staying current (auto-update)

Tinfoil enclaves are PUSHED: merge to main, CI cuts a release, `tinfoil-cli`
moves each running enclave. A metal box usually has no inbound path at all
(CGNAT), so it PULLS the same artifact on a timer instead:

    cp metal/systemd/enclave-metal-update.* ~/.config/systemd/user/
    systemctl --user daemon-reload
    systemctl --user enable --now enclave-metal-update.timer

    node metal/update.mjs --check     # what it would do, changes nothing
    node metal/update.mjs --force     # ignore the idle policy (still health-gated)

It tracks the newest published release for this box's flavor (`vX.Y.Z-cpu` for a
CPU box) — the same artifact the CPU fleet moves to — and builds it in a
throwaway git worktree at that tag, never from the working tree this box runs
out of. That tree is also somebody's desk, and an enclave must not attest to
half-finished work.

**It stages and rolls back.** The new image is built beside the live one and
swapped in; if the box does not answer `/v1/health` with a fresh watcher inside
`healthGraceSec`, the previous image goes back and a halt marker
(`metal/.update-halted`) stops further updates until a human clears it. This is
not hypothetical: on 2026-07-27 a manager build reached metal0 whose wasmtime
did not know a flag that build passes unconditionally, every tenant died at
spawn, and the box handed back the lease it had just resumed. An unattended
updater without this gate would have done that at 3am and left it there.

**It waits for idle by default.** A restart relaunches every tenant AND costs
one ACME issuance per app-zone hostname the box serves — the guest is
initramfs-only, so no certificate survives it, and Let's Encrypt allows 5 per
168h per name. Updating on every merge would spend a week's budget in an
afternoon. `maxDeferSec` (6h) caps the wait so a permanently busy box still
takes fixes.

Note the measurement changes with the image, by design. While the relay's
`METAL_ALLOWED_MEASUREMENTS` allowlist is empty (token-only attach) that costs
nothing; once it is in use, the new release's measurement has to be published
before boxes move to it, exactly as for any other release.

## Why the trust story is *stronger* than the hosted fleet

A managed TEE provider measures the container config and images at its own
controlplane, but without a guest RTMR-extend a launched image's digest is
never folded into the hardware registers: the quote proves only that *some* CVM
of theirs is running, and a transparency log ties the config to the repo.
Metal's guest is a **single initramfs**: kernel, initrd
(which *contains* the supervisor and wasm-manager bytes, extracted from the
same digest-pinned images the fleet runs) and cmdline are all covered by the
SEV-SNP **launch digest** via direct-boot measured OVMF (`kernel-hashes=on`).
There is no unmeasured byte in the TCB: the quote alone proves the exact
supervisor code, with no transparency-log detour needed (the Sigstore record
remains as provenance, not as a trust root).

## Components

| file | role |
|---|---|
| `build-image.mjs` | **unprivileged** guest image build, reproducible when both `--supervisor`/`--wasm` are pinned by `@sha256:` (the manifest records `reproducible`): pulls the OCI images straight from ghcr (no docker), a pinned Arch kernel package, busybox; emits `dist/` (kernel, initramfs, cmdline) + `dist/manifest.json` with every input digest and the expected SNP launch digest |
| `oci-pull.mjs` | dockerless OCI puller (anon token, digest-verified blobs, whiteout-aware extraction) |
| `guest/init` | PID 1 in the CVM: mounts, virtio + TSM modules, DHCP, per-boot secret minting, starts the three services, restarts them, reboots on wedge |
| `guest/agent.mjs` | the metal-agent, the whole ingress side in-CVM: mints the in-CVM TLS key, gets the SNP report over configfs-tsm with `report_data[0:32] = sha256(TLS pubkey SPKI)`, serves the RAD, fronts the supervisor with TLS, and maintains the outbound fleet tunnel |
| `enclave-metal.mjs` | host-side launcher: builds QEMU argv (`dev` \| `snp` \| `tdx` mode), spawns, watches, restarts; serial console to the journal |
| `systemd/enclave-metal.service` | user service (`systemctl --user`), `Restart=always` |
| `verify.mjs` | first-party attestation verification: SNP report signature chain VCEK → ASK → ARK fetched **directly from AMD KDS** (`kdsintf.amd.com`), launch-digest comparison against `manifest.json`, TLS-key binding check. No third-party endpoints. Used by the CLI (`enclave attest` learns the `metal` RAD formats) |
| `volumes.mjs` | builds the attested read-only **model volumes** (ext4 + appended dm-verity hash tree, reproducible: same model tree in → same root hash out); needs no root |
| `guest/mverity.c` | static in-guest dm-verity setup over the raw device-mapper ioctls (no cryptsetup in a slim measured image) |
| `config.example.json` | host config: mode, cpus/ram, enclave name, relay URL, key paths, attached volumes |

## Model volumes (the self-hosted Modelwrap)

Large read-only weights — GGUF/ONNX LLMs, diffusion checkpoints, RAG corpora —
reach tenants the way Tinfoil's Modelwrap delivers them, without Tinfoil. Each
volume is **one host file**: an ext4 image of the model tree with a dm-verity
hash tree appended. The launcher attaches it as a read-only virtio-blk disk; the
guest brings dm-verity up **itself** and mounts it read-only, so every block a
tenant reads is hash-checked inside the CVM and a host that flips a byte gets an
I/O error instead of serving different weights.

```sh
sudo mkdir -p /vm/enclave-volumes && sudo chown $USER /vm/enclave-volumes   # once
node metal/volumes.mjs build qwen2.5-0.5b-gguf --src ~/models/qwen2.5-0.5b-gguf
node metal/volumes.mjs list
# metal/config.json:  "volumes": ["qwen2.5-0.5b-gguf"]   (or "*" for the whole store)
systemctl --user restart enclave-metal
```

**The volume set is signed by the CPU.** The launcher launches the VM with
`sha256(volume table)` in **HOST_DATA** (`MRCONFIGID` on TDX), which the hardware
stamps into every attestation report; the guest reads HOST_DATA back out of its
own report and refuses to mount **anything** whose table doesn't hash to it. So a
buyer can tell *from an attestation alone* which weights an enclave is serving —
the property Modelwrap gets by putting its verity root on the measured cmdline —
and `metal/verify.mjs` checks it for you (`HOST_DATA binds this exact
model-volume set`, then one line per volume with its root hash).

HOST_DATA rather than the cmdline is deliberate: it binds host-supplied config to
the quote *without* entering the launch measurement, so attaching a model does
not invalidate the release measurement that `dist/manifest.json` pins and the
relay's `METAL_ALLOWED_MEASUREMENTS` allowlists. Identity of the **code** and
identity of the **data** stay separable, which is what lets an anonymous seller
carry their own models and still attach permissionlessly (PROTOCOL.md gate 1).

Volume images are reproducible (fixed fs UUID, hash seed, `SOURCE_DATE_EPOCH`,
name-derived verity salt), so anyone holding the same model files can rebuild
the image and check the root hash the enclave attests to is the model they think
it is. `--gguf <file>` picks one quantization out of a multi-file tree, `--sd`
marks a volume that preloads through the stable-diffusion.cpp backend rather
than ggml; the guest passes both through to the wasm-manager as `MODEL_VOLUMES`
/ `MODEL_VOLUMES_SD`, which is how deployments then attach them by name
(console volume picker, or `volumes` in the deployment's config CID).

## RAD format

The metal-agent serves `/.well-known/enclave-attestation` (and the supervisor
finds it via the `RAD_URL` env override; on the hosted fleet that env is
unset and its own loopback attestation path is used, unchanged):

```json
{ "format": "sev-snp-guest-metal-v1", "body": "<base64 SNP report>",
  "certs": { "vcek": "...", "chain": "..." },
  "manifest": { "kernel": "sha256:...", "initrd": "sha256:...", "cmdline": "..." } }
```

Dev mode (TEE disabled in BIOS, plain KVM) serves `format:
"dev-unattested-metal-v1"`, which verifiers and the site MUST render as
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
explicit per-enclave allowlist **in the relay code** (public keys are public, so
committed in-repo, deployed by the normal relay CI; no new on-box secrets).
The SNI relay reaches tunnel enclaves by dialing the api-relay hub
(`wss://api.enclave.host/t/<name>/x/...`) so raw-TLS passthrough (in-CVM
termination, TLS-ALPN-01 ACME) keeps working without the fleet SECRET.

A metal enclave with a public IP (a colo box) skips the tunnel: set
`PUBLIC_URL`, the agent fronts 443 directly, the relay dials in as it does for
the hosted fleet.

## What degrades without the fleet secrets (and stays off by default)

- fleet deployment-secrets fetch (`SECRET`-HMAC with the relay): off
- in-enclave ACME DNS-01 push (`SECRET`-HMAC with dns-relay): off; TLS-ALPN-01 via the tunnel replaces it
- dedicated-IP egress/ingress (`EGRESS_RELAY_TOKEN`): off
- on-chain registry + claim loop + earning: off until the seller sets
  `registryKey` (a funded operator EOA; a few dollars of Base ETH for gas) and
  `payoutAddress` in `metal/config.json`. With them set, the guest supervisor
  registers, claims funded deployments, and the rev-7 `EnclaveDeployments`
  ledger pays the runner share from escrow, auto-swept to `payoutAddress`
  (see PROTOCOL.md, "How payout works")
- `SECRET`/`ADMIN_TOKEN` are minted **in-guest per boot**, so the host operator
  cannot read them (stronger than vault injection)

A dev-mode metal enclave additionally keeps `CLAIM_ENABLED=0` and is excluded
from the fleet capability-AND so it can neither claim paid work nor degrade
fleet-wide feature flags.

## Quick start (this repo, any Linux host with /dev/kvm)

```sh
curl -fsSL https://get.enclave.host | sh   # the enclave CLI, if you have not got it

enclave host init          # scaffold metal/config.json + mint this box's key
enclave host build         # the measured guest image (unprivileged; the first
                           # run pulls the pinned images, so give it a while)
enclave host run           # boot it in the foreground, ctrl-c to stop
enclave host check         # is the guest answering, is the quote real hardware
enclave host install       # or run it under systemd: enabled at boot, survives
                           # logout, pointed at THIS checkout
```

Each of those maps onto a script in this directory if you would rather drive it
yourself (`build-image.mjs`, `enclave-metal.mjs`, `systemd/`); the CLI just
fills in the paths and checks the answers. To sell hosting, keep going with
`enclave host fund` and `enclave host status` (see PROTOCOL.md).

SNP mode needs: BIOS `SMEE`/`SEV-SNP` enabled + SNP RMP coverage, kernel
`kvm_amd sev_snp=Y`, `/dev/sev` present; then set `"mode": "snp"` in the
config. TDX mode: `"mode": "tdx"` on a TDX host.
