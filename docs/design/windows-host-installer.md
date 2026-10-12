# Windows host installer

Status: design, 2026-10-11. Owner decisions (Steven): open market; downloads from get.enclave.host; unsigned for now,
SignPath Foundation (free OSS signing) to follow; the host's name is chosen during setup.

## What a Windows host is

Naming: the per-app Hyper-V isolation is **Enclave Shield** in everything a host owner sees (installer, folders, tasks,
files, docs). `vbslike` survives only as a legacy internal path in the repo (`windows/vbslike`) until its own rename.

A Windows 11 Pro/Enterprise 24H2+ PC with Hyper-V, Secure Boot and an AMD fTPM, running:

| part | what it does | today's source (known-good on nucbox-k11 until its 10-11 reset) |
|---|---|---|
| node agent (`windows/node`) | attaches to the relay (TPM attestation), registers, claims, renews, the local hosting API | `releases/risc-service-20261002/control/windows/node` |
| Enclave Shield manager (repo: `windows/vbslike/manager`) | one Hyper-V partition per app | same `control/` tree |
| `shield-host.exe` (Rust; built as `vbslike-host.exe` today) | Enclave Shield's WMI/hv_sock host side | `risc-service-20261002/vbslike-host.exe` |
| guest IGVM (77 MB) | the partition's firmware + kernel | `public-web-20261005/runtime.bin` (sha256 5fbfb947…) |
| blank guest state `type1.vmgs` (~64 MB) | VBS guest-state master | minted on the box by `New-VM -GuestStateIsolationType VBS`; the installer mints it |
| `hyperv.psm1` | petri's Hyper-V helpers | `C:\Users\claude\hyperv.psm1` (17ca4352…) |
| `runtime.json` | the wasm runtime identity | wasmtime 49 |
| `ipfs_fetch.py` + Python | the manager's CID fetcher | `v44-codex-20260929/control/wasm`; `C:\Python314` |
| egress: `shield-egress.exe`, `shielded-bridge.exe` | per-app public egress | `public-web-20261005` |
| `tpmattest.exe` | TPM quote / EK / AK | built with MSVC on the box |
| TUNA privacy agent + `enclave-tuna`, `enclave-route-discovery`, `enclave-circuit-firewall`, `enclave-provider-inventory`, circuit `worker.exe` | each app's private route (the relay has no public data plane) | `tuna-privacy/agent` (bundled .mjs + Go exes) |
| Shield GPU worker (optional) | GPU inference for Shield apps | `vbs/vkw` |
| tray (`windows/tray`) | caps, on/off, earnings, payout wallet | `EnclaveTray.exe` |
| Node.js 24 | runs node, manager, privacy agent | `C:\Program Files\nodejs` |

## Install layout

- `C:\Program Files\Enclave\` — read-only program files: `runtime\node\`, `runtime\python\`, `control\` (node + manager +
  node_modules), `guest\` (IGVM, hyperv.psm1, runtime.json), `bin\` (shield-host, tpmattest, egress, bridge),
  `tuna\` (privacy agent + exes), `tray\`.
- `C:\ProgramData\Enclave\` — state, ACL SYSTEM + Administrators: `node\` (keys, records, payout, caps, delegations),
  `manager\` (vmgs master + archive, bundles), `tuna\` (circuits, config), `logs\`, `hosting\` (tray token).
- Services: scheduled tasks `\Enclave\Shield` (the per-app isolation manager, boot +30 s), `\Enclave\Node` (+90 s),
  `\Enclave\Tuna`, as SYSTEM, restart
  loops, as the hand rollout did. Tray: per-user, HKCU Run + Desktop/Start Menu shortcuts.

## Setup flow (`EnclaveSetup.exe`, C# WinForms in the tray's theme, requireAdministrator)

1. Checks: edition, virtualization in firmware, Secure Boot on / test-signing off, TPM 2.0 AMD fTPM (Intel: "not yet"),
   RAM/disk, AMD SEV not needed. Each failure says how to fix it.
2. Hyper-V features (+ VirtualMachinePlatform); if a reboot is needed, a RunOnce entry resumes setup after it.
3. Host prerequisites: `AllowFirmwareLoadFromFile=1`, the hv_sock 9001 GCS GUID (host-prereq.ps1, kept as a step).
4. **Name**: the owner types it; checked live (`GET https://api.enclave.host/v1/hosts/name/<name>`: syntax, not
   registered on chain, no tunnel holds it).
5. Download the pinned bundle from get.enclave.host, verify SHA256SUMS (+ Ed25519 signature once the release key exists),
   extract; mint `type1.vmgs`; write configs from templates; generate operator/proof/transport keys.
6. Register tasks, start manager → node; wait for attach (hardware attestation) and the SPONSORED registration
   (EnclaveHostPaymaster, no ETH needed); then the TUNA agent.
7. Install the tray for the signed-in user; open it on the payout-wallet step.

`irm https://get.enclave.host/host.ps1 | iex` downloads and verifies `EnclaveSetup.exe` and runs it (no Mark of the
Web, so no SmartScreen prompt while unsigned). The Host page links both.

## Platform work for an open market (none of this is per-host by hand any more)

1. Windows nodes may claim from the ledger: drop the forced owner-only scope on an engine-retired node; market claims
   gated by the same capacity/isolation rules as today.
2. Relay: an hv-node that passed hardware attestation is market capacity (today: listed, never serving or eligible), and
   its operator needs no `RELAY_HVNODE_OPERATORS` entry for its own owner's apps.
3. TUNA privacy config issued automatically to an attested box (control seeds, NKN wallets, the admitted Shield policy),
   funded by the platform's top-up job, instead of written over SSH.
4. Relay `GET /v1/hosts/name/<name>`.

## Bundle build

`windows/installer/build-bundle.ps1` on a Windows build box: a sources map (bundle path → file + sha256) collects the
known-good parts above, downloads Node.js and Python (embeddable) at pinned versions and sha256, drops test/probe
artefacts, writes `manifest.json` (every file's sha256) and `SHA256SUMS`, zips `enclave-host-<version>.zip`. v1 takes
binaries from the known-good runtime; making each one build from the public repo (Rust, MSVC, Go, the IGVM) is the
next step, and is what SignPath needs.

## Order

1. bundle builder + bundle v1; 2. `EnclaveSetup.exe` + `host.ps1`; 3. platform items 4, 1, 2, 3;
4. publish on get.enclave.host + Host page link; 5. Steven's end-to-end run on the reset NucBox.
