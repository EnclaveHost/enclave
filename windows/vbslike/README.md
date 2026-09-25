# Our own VBS-like isolation on Windows: one Hyper-V partition per app, the same guest as Linux

> **DIRECTION (2026-09-25, Steven): the custom type-1 isolation path is the ONLY NucBox target. The legacy ee-engine.dll VBS-enclave backend is not a recovery target; Secure Boot stays on. See [DIRECTION.md](DIRECTION.md).**


Status: **built and measured on the NucBox K11, 2026-09-23** (`evidence/lab-2026-09-23.json`: ALL PASS,
30 checks). Branch `windows/custom-vbs-like-hyperv`. Nothing here touches the live node under
`C:\Users\claude\vbs` or the `EnclaveWindowsNode` task; the lab lives in `C:\Users\claude\vbs-like`.

## What was decided, in one sentence each

- **The boundary is a Hyper-V child partition per app**, created through the Host Compute Service on
  Virtual Machine Platform: the same hypervisor and the same second-level-paging partition boundary
  that VBS itself is built on, and the strongest thing this box exposes without enabling a feature,
  changing a boot setting or rebooting (section 2).
- **The guest inside every partition is the Linux path's guest**: the isolation/m3 monitor image,
  built once by `isolation/m3/build-domain.sh`, byte-identical on both machines (sha256
  `30d8e34403d54bd06fb33e5994c0426957859d2a6a66e27c3b0d6ab30956167b`), booted on the WSL kernel
  Microsoft already ships on the box. Only the launcher and its transport are Windows-specific.
- **The app is one portable bundle** (`isolation/contract`): canonical manifest + Wasm component, its
  identity the sha256 of exactly those bytes, the same ID on both hosts (`appA.bundle` = `603bb7a7…`,
  `appB.bundle` = `bba82d56…`, here and there).
- **The invariants are ported, the mechanism is not.** Monitor-derived identity, one domain per app,
  report_data = bind || app ID, crossed-domain refusal by construction, crash independence, fail-closed
  lifecycle: all from isolation/m3, expressed once in `isolation/contract` and checked on both
  backends by the same `vectors.json`.
- **This tier does not exclude the host.** A Ryzen has no SEV-SNP; the launcher runs in the root
  partition and signs the reports. Every document says so (`tier=T0-hv`, `host_excluded=no`), and the
  verdict a verifier can reach is `monitor-signed`, never `attested` (section 4).

## 1. The pieces

```
isolation/contract/            the backend-neutral contract (Go): bundle + AppID, Bind/ReportData, the
                               one-field report request, the lifecycle state machine, vectors.json,
                               conformance tests, `bundle` CLI
isolation/m3/monitor           the in-guest monitor, now importing the contract; new backend
                               `-report-host PORT` (a launcher on the host signs report_data)
isolation/m3/dominit.c         passes `report_host=` from the kernel command line to the monitor
isolation/m2/front             carries the monitor's tier/format in the attestation document
windows/vbslike/host/          the Windows launcher (Rust, built ON the box): HCS partitions, hv_sock,
                               the report-signing service, TCP relay, a mirror of the contract and
                               `vbslike-host vectors`
windows/vbslike/verify/        judge-hv.mjs (the verdict) and lab.mjs (the client-side checks)
windows/vbslike/evidence/      the 2026-09-23 run: lab.json, launcher.json, probe.json, consoles, build log
```

Per partition, the launcher: binds the signing service to that partition's id (hv_sock port 9001)
before the partition exists; creates and starts it (`LinuxKernelDirect`: WSL kernel + `mon.cpio.gz`,
command line `console=ttyS0 rdinit=/init loglevel=3 report_host=9001`, one COM port on a named pipe,
one hv_sock device, no disk, no NIC); dials the in-guest monitor's control port (9000) and `load`s the
bundle; compares the app ID the monitor computed with its own hash of what it sent and ends the
partition on any difference; relays host TCP to the domain's port inside the partition (TLS ends in
the domain); signs report_data only when its app half is an ID it loaded into that partition; retires
the partition exactly once however it ends. `ShouldTerminateOnLastHandleClosed` means no partition can
outlive the launcher.

## 2. What the box exposes, measured (`evidence/probe-2026-09-23.json`)

| API | result |
|---|---|
| Virtual Machine Platform | enabled (the WSL2 prerequisite); Hyper-V role and Windows Hypervisor Platform feature both **disabled**, and left so |
| `HcsGetServiceProperties` | schema 2.11; `HcsEnumerateComputeSystems` works |
| `HcsCreateComputeSystem` + `HcsStartComputeSystem` | a child partition from our document, no registry or feature change; the WSL kernel (6.6.87.2-microsoft-standard-WSL2) boots and its console arrives on the COM-port named pipe |
| hv_sock (`AF_HYPERV`) | guest listens, host dials (control 9000, domain 40001); host listens bound to the partition's id, guest dials (signing 9001). Linux side is the WSL kernel's built-in transport; the QEMU-path virtio vsock modules fail to load there and nothing depends on them |
| `WHvGetCapability(HypervisorPresent)` / `WHvCreatePartition` | **both succeed** although the HypervisorPlatform feature is off: the WHP API is usable on this box as well (not used here; OpenVMM's WHP backend would be the route to our own VMM) |
| VBS | running (`VirtualizationBasedSecurityStatus 2`); VBS-isolated VMs (`SecuritySettings.Isolation`) were **not** requested: on a client SKU with no OpenHCL IGVM present that needs `AllowFirmwareLoadFromFile`, a host-wide setting deliberately not touched |

## 3. Results (`evidence/lab-2026-09-23.json`, 30/30)

| check | evidence |
|---|---|
| the shipped image is the Linux path's image | sha256 of `mon.cpio.gz` equal on warden-host and the NucBox; two builds here byte-identical; predicted SNP launch digest `044779fa…` for the same file |
| the launcher's hash of the pushed bundle == the in-guest monitor's hash of what arrived, for A and B | app IDs `603bb7a7…` and `bba82d56…`, each in its own partition |
| each domain attests on its own key, judged against the client's OWN handshake and nonce, naming its app, its partition and the shipped image; launcher signature verifies | `monitor-signed` for A, B, a second nonce, and D after the cycles |
| crossed domains refused | expecting B at A: reject; A's report as B's partition: reject; other nonce: reject; B's key: reject; a host rewriting A's document to name B: `unsigned` (signature broken); an untrusted launcher key: not monitor-signed |
| the artifact that was hashed is the one that runs | `APP AAAAA` / `APP BBBBB` from the m2 test app inside each partition; 4 MiB echoed intact through the relay |
| the adversary inside a partition (m3 `domprobe`, root, native) | no other domain's files, no `/sys`, no configfs, no vsock reach beyond its own monitor, no host network; its report names its own app although it asked for another |
| crash independence | host terminates A with no notice: retired by the exit path once, port closed, table clean; B still attests on the same key and answers |
| lease end | graceful stop winds the in-guest domain down; destroy removes it; the service lists zero partitions owned by the launcher; a new one loads, attests and serves |

Cost, 1 vCPU and 512 MiB per partition:

| | |
|---|---|
| HCS create / start | 36-40 ms / 70-73 ms |
| boot to the in-guest monitor answering | **5.3 s** (WSL kernel + dominit + monitor) |
| app loaded and serving after that | +7 ms |
| memory per partition (vmmem working set) | **~241 MiB** (+18 MiB vmwp); launcher 2 MiB |

Against the Linux tiers (isolation/DESIGN.md): a partition here costs about what an M2 SNP guest
costs (3.4 s, 586 MB) in kind, with the 5.3 s dominated by the general-purpose WSL kernel.

## 4. Trust, stated exactly

| party | sees a domain's memory? | in the domain's TCB? |
|---|---|---|
| another app's partition | **no**: separate child partition under the hypervisor's second-level paging; hv_sock has no guest-to-guest path (measured: every cross reach refused) | no |
| the guest kernel of its own partition | yes | yes, for that domain only |
| the launcher (root partition, this code) | **yes**: it can read any partition's memory, and it signs the reports | **yes** |
| Windows, its administrator, the machine's owner | yes | yes |
| the hypervisor | yes | yes (measured boot vouches for it on this box; not consumed here) |

So a verifier of a `T0-hv` document learns which app, which key and which nonce, from a launcher it
chose to trust, and nothing about the host. That is the M2 `not-attested` T0 verdict plus a pinned
software identity, and the document is built so it cannot be read as more (`hostExcluded:false`,
`tier=T0-hv`, `signer=launcher-in-root-partition`). Host exclusion on this box would need either
hardware this CPU does not have, or a VBS-isolated partition with a paravisor, which is the next
boundary to probe (section 6).

## 5. Running it

On the workstation (warden-host), from this branch:
```
isolation/m3/build-domain.sh $W/mon.cpio.gz 1                # the shared guest image (reproducible)
go run ./isolation/contract/cmd/bundle build -label AAAAA app-AAAAA.wasm $W/appA.bundle
(cd isolation/contract && go test ./...)                      # the vectors, Go side
windows/vbslike/sync.sh minipc-zt                             # sources only; ship $W/mon.cpio.gz + bundles + vectors.json too
```
On the box (`ssh minipc-zt`, everything under `C:\Users\claude\vbs-like`):
```
cmd /c C:\Users\claude\vbs-like\build-win.cmd                 # cargo build --release, log in build.log
.\target\release\vbslike-host.exe vectors vectors.json         # VECTORS PASS = the contract, Rust side
.\target\release\vbslike-host.exe probe                        # what the host exposes
cmd /c C:\Users\claude\vbs-like\run-lab.cmd --expectImage <sha256 of mon.cpio.gz>
```
Remote paths: `C:\Users\claude\vbs-like\{host,verify,apps,out}`, `wsl-kernel` (a copy of
`C:\Program Files\WSL\tools\kernel`), `mon.cpio.gz`, `vectors.json`, `target\release\vbslike-host.exe`.

## 6. Open, in one line each

- **Phase 2** (the isolated mode with an OpenHCL paravisor): see PHASE2.md and HOST-PREREQ.md.

- **VBS-isolated partitions** (`IsolationType: VirtualizationBasedSecurity`, an OpenHCL IGVM as
  guest firmware): the one Hyper-V construct that would exclude the root partition from a domain's
  memory on this hardware. It needs the OpenHCL image and, on a client SKU, `AllowFirmwareLoadFromFile`
  (a host-wide registry value) — a deployment change, deliberately not made in this pass.
- **The Linux live suite after the monitor change: re-run and passing** (2026-09-23, in a window the
  M3b owner handed over): `test-m3.sh` on the M3b path (COCONUT-SVSM at VMPL0, monitor at VMPL2, digest
  derived from the IGVM `62b4a946…` equal to the live report) 31/31, and on the plain M3a path 31/31 with
  the predicted digest moving with the image as it must (`evidence/linux-m3{a,b}-live-2026-09-23.txt`).
  One caveat from that owner: under IGVM the launch measurement covers the SVSM, firmware and VMSA
  only, not the monitor image, so on that path check 1 does not cover a monitor change; on the plain
  path it does.
- **cwasm**: the bundle carries a Wasm component and the in-guest runtime compiles it; a cached cwasm
  would be a per-host optimisation behind the same bundle ID, not an artifact.
- **The boot cost** is the WSL kernel: a minimal kernel config would cut the 5.3 s, and the same image
  would still run on QEMU.
- **Signer provenance**: the launcher key is minted per run and pinned trust-on-first-use in the lab;
  binding it to the box's existing attestation (the node's TPM/IDKS chain) is the production step.
- **Windows Hypervisor Platform works here** (WHvCreatePartition succeeded), so OpenVMM as our own
  VMM on this box is a real option; not pursued in this pass.

## 7. ABI/2 on this tier (2026-09-23, later the same day)

The guest image was rebuilt from the merged tree (`isolation/portable-runtime-jit` wiring): it now
carries the runtime identity beside the runtime (`plat/rt/runtime.json`: wasmtime 48.0.1, execution
jit, target and host x86_64, CPU features host-detected, W^X enforced, cache none) and its domains run
`wasmtime serve -C cache=n`, so "cache none" is true by construction inside a partition too. New image
sha256 `44abb52b1486dd2aae344e021a0d8049dfb2015d137c22a6e336051c4db5a0cf`, byte-identical on both
machines and across two builds. `verify/lab.mjs` against it: **34/34** (`evidence/lab-abi2-2026-09-23.json`).

What the extra checks establish: every attestation document states `enclave-domain-abi/2` with exactly
that identity and a self-test of `exec_pages=allowed wx=clean maps=2 scope=cgroup:/dom1` taken inside
the partition; the verdict (`judge-hv.mjs`) judges the ABI, the identity, the self-test and the binding
through the Linux judge's own `checkRuntime` (`isolation/m2/judge.mjs`, with the closed scope
vocabulary), so the two verifiers cannot disagree about what a clean scan means; restating the report under another runtime version fails on the binding
itself, a claimed unauthenticated cache is refused before any binding is computed, and a document that
dropped to ABI/1 is rejected when ABI/2 is expected. The self-test remains the front's own word relayed
over the attested connection, as on Linux; on this tier the launcher's signature is what vouches for it.
The evidence file also records why the compiled cache is absent: not a flag this lab passes, but the
shared image's own launcher starting every domain's runtime with `-C cache=n`, without which wasmtime's
default module cache would have been live under the domains' `HOME=/tmp` in a partition too.
