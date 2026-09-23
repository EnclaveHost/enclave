# Native per-app isolation: one execution model across ordinary and TEE hardware

Status: DRAFT design; milestone 1 implemented and passing on warden-host (2026-09-22, section 8). This page marks which parts are **measured**,
which are **source-based** (documentation or code we read, not run), and which are **proposals**. Only the
first kind is a result.

## 1. What is decided, and what is still open

Decided (Steven, 2026-09-22):
- **Wasm stays the publish format.** One portable artifact per app version, as today.
- **Apps execute natively.** Tenant isolation does not rest on a runtime's in-process sandbox (today that
  is Wasmtime's bounds checks, or Pulley interpreting inside one shared VBS enclave). Removing that
  reliance is NOT removing Wasm.
- **Each app gets its own isolation domain with its own resource share**, created when a lease starts and
  destroyed when it ends.
- **One execution model on ordinary and TEE-capable hardware.** The same domain runs on both. On
  SEV-SNP hardware, SNP adds the outer layer: guest memory confidentiality and integrity against the host,
  plus hardware attestation.
- **If the Linux software for a piece does not exist, we build it.** Stock-kernel limits are design inputs.

Open, deliberately NOT decided here:
- **AOT vs JIT.** Inside a domain that owns its own page tables, both are possible (unlike VBS VTL1, see 4).
  Milestone 1 uses whatever exists (Wasmtime's JIT inside the guest) and records the choice as provisional.
- **Packaging per OS and architecture.** One artifact per (arch, domain type) behind the app's CID is the
  working assumption. A literal single cross-OS binary is not assumed.
- **API shape.** No Microsoft-compatible enclave API is assumed for the Linux side.

## 2. Threat model, per tier

Parties: the **tenant app** (untrusted by the platform and by other tenants), the **platform code** in the
domain (runtime, init, agent), the **host operator** (owns the machine, runs the host OS and VMM), and the
**network**.

| tier | domain | app vs app | app vs host operator | attestation | status |
|---|---|---|---|---|---|
| T0 ordinary x86 Linux | one KVM guest per app | hardware virtualization | **none**: host kernel and root can read the guest | none from hardware (host TPM boot log at best) | M1 builds it |
| T1 AMD SEV-SNP | one SNP guest per app | hardware virtualization | guest RAM encrypted and integrity-protected against the host; the host can still stop or starve it | per-domain SNP report: launch measurement + report_data | M1 builds it |
| T2 consumer Windows (nucbox-k11) | VBS enclave (VTL1) | secure kernel | host OS (VTL0) excluded; hypervisor trusted via measured boot; **no RAM encryption** | VBS enclave report | exists today, one shared enclave |
| T0+ ordinary x86, host excluded | small trusted monitor BELOW a deprivileged host kernel (pKVM-style) | monitor | host kernel excluded; monitor trusted via measured boot | monitor-signed report rooted in TPM | **proposal only**; the Linux "VBS-like" piece that does not exist upstream on x86 |

Out of scope for every tier: availability (the host can always stop a domain), microarchitectural side
channels, and firmware or PSP bugs.

The one honest consequence: **on T0 the platform must not claim confidentiality from the operator.** The
per-app model buys app-vs-app isolation and native speed there. T1 and T2 add operator exclusion, and T0+
is the proposal to add it on ordinary hardware.

## 3. Why one VM per app on Linux, and what that is waiting to become

The findings that shape this (from `windows/vbs/snp/README.md`, which separates run from read):
- **Measured** on warden-host: SNP guests boot unprivileged at VMPL0 and return v5 reports with our nonce.
  Inside an SNP guest, the guest kernel refuses to act as a hypervisor.
- **Source-based:** mainline KVM supports no nested virtualization inside SEV/SEV-ES/SNP guests, and
  stock KVM has no VMPL "planes" (out-of-tree patches exist). OpenHCL, the only VTL-over-VMPL paravisor in
  code, runs on Hyper-V only.

So on stock KVM the only per-app hardware isolation available today is **one SNP guest per app**. That is
milestone 1. It is also the model that runs unchanged on T0, which gives the unification directly: same
image, same launcher, SNP on or off.

Where it goes next (proposals, not results):
- **VMPL domains.** One CVM with a small trusted monitor at VMPL0 (an SVSM role) and apps at lower VMPLs.
  This means less memory and boot overhead per app. It needs KVM planes support: build it or adopt the
  out-of-tree series.
- **T0+.** The same monitor idea on non-TEE x86, below a deprivileged host kernel. This is the literal
  "Linux VBS-like" component, and the largest item.

## 4. The execution unit: an app domain

A domain image is `[kernel] + [init + agent] + [runtime] + [one app .wasm] + [manifest]`, packed as a
measured initramfs.

- **Identity.** On T1 the SNP launch digest covers firmware, kernel, initramfs and command line (QEMU
  `kernel-hashes=on`). The app's .wasm is inside the initramfs, so **the app is part of the measurement**.
  metal0 already proved the reproducible-measurement half: `sev-snp-measure` predicts the live digest from
  the build inputs.
- **Execution.** The guest owns its page tables, so a JIT is allowed, unlike VBS VTL1, where we measured
  `ERROR_DYNAMIC_CODE_BLOCKED` on every executable page. JIT output is not itself measured; it is derived
  from measured Wasm by a measured compiler, which is the same trust argument as today.
- **Lifecycle.** build (at publish or deploy) -> launch (lease start) -> attest (report with a verifier
  nonce) -> serve -> stop -> destroy (lease end). Measured costs so far: a VBS enclave lifecycle is 3.5 ms
  with a 21 KB image. An SNP domain's is what M1 measures.
- **Resource share.**
  - **vCPU count:** fixed at launch. It is part of the SNP measurement, so it is part of identity.
  - **Guest RAM:** fixed at launch. It is not measured.
  - **CPU share:** cgroup v2 `cpu.max` on the VMM process.
  - **Memory cap:** guest RAM plus a VMM allowance, enforced by `memory.max`.
  - **PIDs:** `pids.max`.

  User-level cgroup delegation on warden-host includes `cpu memory pids` (checked), so none of this needs
  root. The ledger's cpuShare maps onto `cpu.max`.

## 5. Attestation requirements

A verifier accepts a domain only if all of these hold:
1. The report is signed by a VCEK chaining to AMD's ARK: `relay/snp-verify.mjs` implements
   VCEK -> ASK -> ARK via AMD KDS.
2. The measurement is in the allowlist for (runtime version, app CID, vCPU count), and is reproducible
   from those inputs.
3. `report_data` binds the report to this app and this challenge. **M1 (implemented):** the 64 bytes are
   app sha256 (32) || verifier nonce (32). The nonce reaches the guest via fw_cfg, deliberately unmeasured:
   on the kernel command line it would change the launch digest on every boot. **Proposed for serving
   domains:** replace the app half with sha256 of an in-domain transport key, as metal0 does, so the
   report also vouches for the TLS key traffic terminates on.
4. Policy: debug off, VMPL0 for the domain's own report, and an acceptable TCB version.

Known lab limit: this box's chip_id has no VCEK published by AMD KDS (recorded with metal0), so **(1)
cannot be completed on warden-host**. M1 tests (2) and (3) and reports (1) as not tested here. T0 has no
hardware attestation, and the platform must say so rather than present a T0 domain as attested.

## 6. What exists and is reused

| piece | where | state |
|---|---|---|
| measured initramfs builder, guest init, static helpers | `metal/build-image.mjs`, `metal/guest/` | production for metal0 |
| QEMU SNP launcher | `metal/enclave-metal.mjs` | production for metal0 (one CVM, many apps) |
| reproducible measurement check | `metal/verify.mjs` + `sev-snp-measure` | proven 2026-07-25 |
| first-party SNP report verification | `relay/snp-verify.mjs` | built, verified locally |
| in-guest report fetch (configfs-tsm) | `windows/vbs/snp/snpctl.c` | measured 2026-09-22 |
| VBS enclave probes and runtime | `windows/vbs/enclave/`, `windows/enclave-rt/` | T2 today |

## 7. Milestone 1: one Wasm app -> one measured domain, on T0 and T1

Smallest thing that is the new model end to end, on our own lab hardware with documented interfaces
only: QEMU/KVM as an unprivileged `kvm`-group user, the SNP guest's configfs-tsm, and cgroup v2. No host
kernel change, and no bypass of any security mechanism.

Deliverables (`isolation/m1/`, implemented):
- `build-domain.sh <app.wasm> <out.cpio.gz> [vcpus]` -> a **reproducible** initramfs holding PID 1
  (`dominit.c`), the runtime (Wasmtime 48) and its four shared libraries, the app, and the app's sha256. It
  prints the predicted SNP launch measurement. The measured inputs are shared through `domain.env`.
- `run-domain.sh <image> <snp|plain> [vcpus] [memMiB] [cpuQuota%] [nonce]` -> launches the domain as a
  transient systemd service, which is its own cgroup, with `CPUQuota`/`MemoryMax`/`TasksMax`. It passes the
  nonce through fw_cfg and prints what the guest printed plus systemd's CPU-time and memory-peak accounting.
- `dominit.c`: runs the app natively (the runtime JIT-compiles it inside the guest). On T1 it fetches a
  report whose report_data is app sha256 || nonce.
- `test-m1.sh [workdir]`: the tests below, PASS/FAIL with evidence. `RECHECK=1` re-evaluates a workdir's
  saved outputs without booting anything.

Tests. Each result is recorded as run or not run:
1. **Measurement reproducible**: live digest == `sev-snp-measure` prediction.
2. **App bound into identity**: app A and app B give different digests; A twice gives the same digest.
3. **Freshness**: report_data equals app sha256 (32) || nonce (32) for the nonce the host passed in.
4. **CPU share enforced**: a CPU-bound app's wall time at `cpu.max` 100% vs 25% of one CPU.
5. **Lifecycle cost**: launch -> app output -> report, and host RSS per domain.
6. **Tier parity**: the same image runs as a T0 domain (no report) and prints the same app output.

Explicitly NOT in M1: the VCEK chain (not available on this chip), network serving, VMPL domains, T0+, and
a host-memory confidentiality test. The last would demonstrate the T1 claim directly and is a later,
separately reviewed test.

## 8. M1 results: measured on warden-host, 2026-09-22

EPYC 9115, Linux 7.2.3, QEMU 11.1.1, `OVMF.4m.fd` sha256 `2a489a24…`, Wasmtime 48.0.1. Unprivileged
(`kvm` group). A clean end-to-end run of `test-m1.sh` gives **ALL PASS** (12 checks). An earlier run of the
same five boots failed 5 checks on a HARNESS bug: the serial console's `\r` ended every extracted value. The
evidence lines were identical, and the fixed harness passes on both that run's saved outputs and a fresh run.

| check | result |
|---|---|
| 1 measurement reproducible | live digest == `sev-snp-measure` prediction, for app A and for app B |
| 2 app bound into identity | A `bcc7af8c…` != B `0a4ef812…`; A with a new nonce keeps its digest |
| 3 freshness and app naming | report_data == app sha256 \|\| host nonce, for A/nonce1, A/nonce2 and B/nonce1; v5 report, VMPL0 |
| 4 CPU share enforced | the same app at `CPUQuota=25%` takes 8,992 ms vs 2,216 ms at 100%: **4.06x** |
| 6 tier parity | the identical image runs as a plain KVM guest with identical app output, and yields no report |
| build reproducibility | rebuilding a domain gives byte-identical initramfs output |

| 5 lifecycle cost (1 vCPU, 512 MiB) | T1 SNP | T0 plain |
|---|---|---|
| guest kernel -> PID 1 | 784 ms | 635 ms |
| app (1.5G xorshift rounds) | 2,216 ms (**same as on the bare host, 2,208 ms**) | 2,208 ms |
| host launch -> power-off, whole domain | 5.7 s | 3.4 s |
| memory peak of the domain's cgroup | 556 MB (SNP backs all of guest RAM) | 257 MB (touched pages only) |

What these results do and do not establish:
- **Established:** the unified model works on this hardware: one app per hardware-isolated domain, native
  speed, a per-app launch identity that includes the app, a report naming app and challenge, a CPU share
  enforced by the host, and the same image on T0 and T1.
- **Not established here:** VCEK signature validity (no KDS VCEK for this chip); any confidentiality
  measurement (the host-memory test is not run); network serving; anything on Windows or VBS; VMPL domains.
- **Cost to reduce:** SNP pins the whole guest RAM, so small apps need small domains, and the 5.7 s launch
  is mostly firmware plus a general-purpose kernel. Both are M2 targets.

## 9. Next milestones (proposals, in order)

- **M2 serving:** the domain exposes one port (virtio-vsock or virtio-net), terminates TLS inside, and
  binds the TLS key into report_data. This is what turns a domain into a platform deployment.
- **M2 cost:** a size-matched guest RAM and a minimal kernel config. Measure launch time and memory peak
  against M1.
- **AOT vs JIT, measured:** precompiled native code inside the measured initramfs vs JIT at start. Compare
  launch time, memory, and what the measurement then covers.
- **Host-memory confidentiality test:** reviewed separately before running.
- **VMPL domains:** one CVM with a trusted monitor and apps at lower VMPLs. Needs KVM planes support,
  built or adopted.
- **T0+:** the pKVM-style monitor for non-TEE x86, the literal Linux "VBS-like" component.
