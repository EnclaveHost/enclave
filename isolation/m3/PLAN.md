# M3: app domains inside one outer TEE — feasibility and plan

Milestone 2 gives every app its own SNP guest: 3.4 s and 586 MB each (DESIGN.md section 11). M3 asks
whether several app domains can share one outer TEE and still be separated from each other by hardware.

This page follows the DESIGN.md convention: **measured** (run here), **source-based** (read, not run) and
**proposal**. Sources are listed at the end, with dates, because most of this software is moving.

## 1. What the hardware gives, and what it does not

**Measured on warden-host (2026-09-23)**, CPUID `Fn8000_001F` read directly:

```
eax=cffffffb ebx=000041b3  ->  SEV=1 SEV-ES=1 SEV-SNP=1 VMPL=1
                               cbitpos=51  vmpl_count=4  max_encrypted_guests=1006
```

So this CPU has the VMPL feature and **four** privilege levels, VMPL0 to VMPL3. A monitor at VMPL0
therefore leaves **at most three** lower planes in one guest.

That single number decides the shape of M3:

- VMPL is **not** a way to put many app domains in one TEE. Three is the ceiling per guest, and the
  configuration the upstream work actually exercises is one service module at VMPL0 with **one** guest OS
  beneath it.
- VMPL **is** the right boundary for a privilege split: a platform monitor above, the app runtime below.
  That is the same shape as VBS on Windows (VTL1 above VTL0), which is what this whole line of work is
  modelled on, and it is worth having for its own sake: it takes the guest kernel out of the TCB for
  keys, attestation and the domain table.
- Scale keeps coming from M2's model, one CVM per app, which has no such ceiling.

**Proposal, stated plainly so it is not assumed away:** hardware separation of *app from app* inside one
CVM is capped at three domains. Anything beyond that, inside one CVM, is separated by the guest kernel,
which is weaker (section 4).

## 2. What the software needs, and how far this box already is

| piece | needed | on warden-host today | gap |
|---|---|---|---|
| SNP with VMPL | CPUID VMPL bit, 4 levels | **measured**: present, 4 levels | none |
| host KVM | planes uAPI: `KVM_CREATE_PLANE`, `KVM_CAP_PLANES`, `KVM_EXIT_PLANE_EVENT` | **measured**: 7.2.3, zero occurrences of "plane" in the installed KVM uapi header | out-of-tree kernel |
| host VMM | QEMU with IGVM **and** planes (`igvm-cfg` object, `device-plane=`) | **measured**: QEMU 11.1.1, no `igvm-cfg` object, no plane machine option | out-of-tree QEMU, built `--enable-igvm` |
| IGVM library | microsoft/igvm C library, built with `cargo-c` + `cbindgen` | **measured**: no libigvm, `cbindgen` and `cargo-c` absent | build them |
| VMPL0 monitor | an SVSM | COCONUT-SVSM, not present here | build it |
| guest kernel at VMPL>0 | upstream support | **measured**: our own 7.2.3 image already exports `svsm_issue_call`, `svsm_perform_call_protocol`, `snp_svsm_vtpm_probe`, `snp_vmpl` | **none** |
| report interface for a lower plane | configfs-tsm `privlevel` / `privlevel_floor` | **measured**: documented in the v7.2.3 kernel ABI, max level 3 | none |
| measurement prediction | `igvmmeasure` over the IGVM file | **measured**: `sev-snp-measure` 0.0.13 here has `--mode snp:svsm --svsm PATH`, but an IGVM launch is measured by `igvmmeasure` | new tooling in the build |
| verifier pins the plane | `expectedVmpl` | **measured**: implemented and tested, 2026-09-23 (section 5) | none |
| Rust toolchain for the SVSM | nightly, `x86_64-unknown-none`, binutils >= 2.39 | **measured**: rustc 1.99.0-nightly, binutils 2.47, target available (not installed) | one `rustup target add` |

**The version gap is much smaller than it looked.** COCONUT-SVSM announced `svsm-v7.2` branches for both
Linux and QEMU on 2026-08-27, with the KVM planes patches rebased to 7.2 and the QEMU patches rewritten
on v11.1.0. This box runs kernel **7.2.3** and QEMU **11.1.1**. So the out-of-tree work targets the
versions already here, rather than requiring a move backwards to an older base.

**Upstream status (source-based):** the planes series is a formal v1, 60 patches, posted 2026-06-08 by
Jörg Rödel against v7.1-rc7, demonstrating COCONUT-SVSM at VMPL0 with a Linux guest at VMPL2. It is not
merged; LWN on 2026-08-11 says the abstraction "will have to evolve for a while yet before it is
considered ready". Known limitations in that series: planes need a split IRQ chip, irqfd is not
supported, and memory attributes are VM-wide rather than per-plane. IGVM support itself **is** upstream
in QEMU; this build simply lacks it.

**Out of scope for this step, by instruction:** installing a host kernel, rebooting warden-host, or
anything that disturbs the shared services on it. Everything in section 6 up to M3b is buildable and
testable without touching the running host.

## 3. The identity problem this creates (the part that actually needs work)

M1 and M2 put the app **inside the measured image**: the .wasm lives in the initramfs and QEMU's
`kernel-hashes=on` folds kernel, initrd and command line into the SNP launch digest. A verifier learns
which app it is talking to from the launch measurement alone.

Under IGVM that stops being true. The IGVM file contains the SVSM and the firmware, and those are what
the launch digest covers; the guest OS is loaded afterwards by that firmware. Consequences, and they are
not cosmetic:

1. **Per-app identity has to come from the monitor.** VMPL0 code — whose own measurement *is* in the
   launch digest — hashes the app it loaded and writes that hash into the `report_data` of a report it
   requests. The verifier's chain becomes: AMD signs the report; the report's measurement names the
   monitor image; the monitor names the app. In M2 the hardware named the app directly.
2. **The monitor must be the only holder of the report interface**, or a domain could name itself.
3. **The allowlist key changes** from "launch digest of (kernel, initrd holding the app, cmdline, vCPUs)"
   to "IGVM digest of (SVSM, firmware)" plus the expected plane, and the app hash moves into the
   evidence rather than the allowlist.
4. **Reproducibility moves with it.** We need `igvmmeasure` output to match a rebuild of the SVSM. That is
   a known sore point upstream — builder paths have leaked into SVSM binaries and broken exactly this —
   so it is a build-system requirement for us, not an assumption.

This is the single largest design change in M3, and the useful part is that **it can be built and proved
without any of the blocked host changes** (section 6, M3a).

## 4. Trust boundaries

For a CVM with a monitor at VMPL0 and app domains beneath it:

| party | sees a domain's memory? | in the domain's TCB? |
|---|---|---|
| host kernel, VMM, operator | no (SNP encrypts and integrity-protects guest memory) | no, except for availability |
| the VMPL0 monitor | yes, by construction | **yes** — it holds the report interface, the domain table and the domains' keys |
| another app domain at a different VMPL | no (RMP/VMPL permissions, hardware-enforced) | no |
| the guest kernel of the domain's own plane | yes | yes, for that domain only |
| AMD firmware/PSP | per the platform threat model | yes |

What a domain's report proves, in that design: this hardware signed it; the launch image was that
monitor and firmware; the plane it came from was VMPL *n*; and the monitor asserts this app hash. What it
does **not** prove: that the app was measured by hardware. A verifier that wants the M2 property — the app
in the launch digest — should keep using M2's one-CVM-per-app domains.

**The interim backend, named honestly.** Before any of the host-side work lands, the same monitor can run
as PID 1 of one ordinary SNP guest and separate domains with the guest kernel: a uid, a network
namespace, a private directory and a cgroup each. That is MMU isolation enforced by the guest kernel, so
**the guest kernel is in the app-vs-app TCB and this is weaker than VMPL isolation**. It is not a
substitute and must never be described as equivalent. SNP still excludes the host from all of it.

## 5. Already done, offline, 2026-09-23

**The verifier now pins which plane a report came from.** A report carries the VMPL that requested it
(Linux writes it through configfs-tsm `privlevel`, floor = the guest's own level, documented maximum 3).
The launch measurement is identical at every level, so that field is the *only* thing separating a
monitor's report from a lower-privilege domain's report in the same guest.

- `relay/snp-verify.mjs`: `verifyQuote({ expectedVmpl })`, default 0, integer 0-3, and the result carries
  `vmpl`. A non-zero expectation is accepted only when asked for, and the reason records that VMPL0 to
  *n*-1 of that guest are more privileged and inside the reporter's TCB. Omitted means 0, never lenient.
- `metal/verify.mjs`: the same, as `--vmpl N`.
- `test/snp-vmpl-policy.test.mjs`: default refuses VMPL1/2/3; an expectation of *n* accepts only *n* and
  refuses every other level including 0; a malformed expectation is refused before any KDS or allowlist
  work; the gate does not replace the key binding or the allowlist.

Production behaviour is unchanged: everything the platform runs today reports VMPL0, which is the
default. 36/36 verifier tests pass.

## 6. Milestones

**M3a — no host change. BUILT AND MEASURED, 2026-09-23 (section 10).**

- **M3a-1 (smallest useful): a domain whose identity comes from a monitor, not from the launch digest.**
  One stock SNP guest, monitor as PID 1, one app domain under it. The monitor loads the app over a host
  control channel, hashes it itself, and is the only holder of the report interface; a domain's front
  asks the monitor for a report and the monitor writes `[0:32]` = sha256(domain TLS key SPKI || nonce)
  and `[32:64]` = that domain's app hash **from its own table**, keyed by the requesting socket's kernel
  credentials, never by what the domain claims. The M2 client and its verdict rules apply unchanged, with
  the monitor image's measurement on the allowlist.
  This de-risks the one thing that genuinely breaks when planes arrive (section 3) and needs nothing that
  is blocked. Isolation between domains at this point is guest-kernel only and is labelled so everywhere.
- **M3a-2:** several domains in that guest, one vsock port and one cgroup share each, and the M2 serving
  path per domain (TLS ends in the domain; the host relays ciphertext only).
- **M3a-3:** build the blocked pieces without installing them — `x86_64-unknown-none` target, `cargo-c`,
  `cbindgen`, the IGVM library, `igvmmeasure`, and COCONUT-SVSM itself, in a scratch tree. Check that
  two builds of the SVSM from the same commit give the same `igvmmeasure` digest. Disk-bounded: the
  /tmp quota is shared with other sessions.

**M3b — needs a host kernel and VMM, i.e. Steven's decision. Not started.** Run COCONUT-SVSM at VMPL0 with our domain
image at VMPL2 on the `svsm-v7.2` branches, and move the M3a monitor's report path behind the plane
boundary. Prerequisites, all of which are the blocked part: build and install kernel + QEMU from those
branches, and boot the box on them. The honest framing for that decision: warden-host also carries the
27B benchmark work and other sessions' VMs, so this belongs on a scheduled window or a second machine,
not on an ordinary afternoon.

**M3c — our own VMPL0 monitor.** COCONUT-SVSM is a service module (vTPM, PV variables), not a place to
run platform logic. Putting *our* monitor at VMPL0 means a `no_std` Rust component implementing the SVSM
protocol the guest expects. Large; only worth scoping once M3b has shown the boundary works.

Throughout: the app stays a **Wasm** component, published once, and runs **natively** in its domain under
`wasmtime serve`. The AOT-versus-JIT choice stays open, as in M1 and M2.

## 7. Isolation tests M3b must pass

Each is pass/fail with its own evidence, in the style of `test-m1.sh` and `test-m2.sh`.

1. **The plane is real.** The domain reports VMPL *n* != 0, and `privlevel_floor` equals *n*.
2. **A domain cannot reach the monitor.** A domain attempts a read of a page the monitor owns; the
   attempt faults rather than returning data, and the fault is recorded.
3. **A domain cannot reach another domain.** Same, across two domains.
4. **A domain cannot impersonate the monitor.** It cannot obtain a report below its own floor, so it
   cannot produce VMPL0 evidence.
5. **The monitor names the app, not the domain.** A domain asking for a report for another app's hash is
   refused; the hash in `report_data[32:64]` is the one the monitor recorded when it loaded that app.
6. **The verifier separates the two.** A domain's report is refused by a verifier expecting VMPL0 and
   accepted only with `expectedVmpl` set to the domain's plane. (Already covered offline, section 5.)
7. **Measurement reproducible.** Two builds of the IGVM give the same `igvmmeasure` digest, and the live
   report's measurement equals it.
8. **Serving survives the boundary.** Per domain: TLS terminates inside the domain, the host relays
   ciphertext only, a host that terminates TLS is refused on the binding, and a switched-key reconnect is
   refused at the handshake — the M2 checks, re-run per plane.
9. **Cost.** Launch to first attested response, memory per domain and per guest, and request latency,
   against M2's per-app-CVM numbers. This is what decides whether the VMPL path is worth its complexity
   for three domains.

## 8. Sources

- KVM planes + SEV-SNP support, v1, Jörg Rödel, 2026-06-08 (60 patches, base v7.1-rc7; `KVM_CREATE_PLANE`,
  `KVM_CAP_PLANES`, `KVM_EXIT_PLANE_EVENT`; COCONUT-SVSM at VMPL0 with a Linux guest at VMPL2):
  https://patchew.org/linux/20260608144252.351443-1-joro@8bytes.org/
- "KVM planes head for takeoff", LWN, 2026-08-11 (status, `KVM_CREATE_PLANE`, not ready):
  https://lwn.net/Articles/1087590/ — and the earlier "KVM: VM planes": https://lwn.net/Articles/1016113/
- COCONUT-SVSM installation prerequisites (host/QEMU branches, `--enable-igvm`, EDK2 flags, guest kernel
  >= 6.16, `device-plane=2`, Rust `x86_64-unknown-none`, binutils >= 2.39):
  https://github.com/coconut-svsm/svsm/blob/main/Documentation/docs/installation/INSTALL.md
- "SVSM: Updated Linux and QEMU branches", 2026-08-27 (`svsm-v7.2` for Linux and QEMU, planes rebased to
  7.2, QEMU rewritten on v11.1.0, launch-measurement caveat on the direct-VMSA GPA change):
  https://ratatoskr.run/linux-coco/2026/08/17470720/t
- COCONUT-SVSM development plan (what is complete, in progress, not started):
  https://coconut-svsm.github.io/svsm/developer/DEVELOPMENT-PLAN/
- QEMU IGVM documentation (`igvm-cfg` object, SEV-SNP only):
  https://www.qemu.org/docs/master/system/igvm.html
- Linux configfs-tsm report ABI at v7.2.3 (`privlevel`, `privlevel_floor`, max level 3, `service_provider`
  = "svsm"): `Documentation/ABI/testing/configfs-tsm-report`, kernel.org, tag v7.2.3
- AMD, "Secure VM Service Module for SEV-SNP Guests", docID 58019 — referenced by the kernel ABI above for
  the service-provider report format. Not yet read here.
- Local, measured on warden-host 2026-09-23: CPUID `Fn8000_001F`; `/usr/include/linux/kvm.h`;
  `/proc/kallsyms`; `qemu-system-x86_64 -object help` and `-machine q35,help`; `sev-snp-measure --help`;
  `rustup target list`; `ld --version`.

## 10. M3a results: measured on warden-host, 2026-09-23

`isolation/m3/test-m3.sh`, three boots of one monitor image (s1: SNP, two domains; s2: SNP, one domain;
t1: plain KVM, two domains). **ALL PASS, 21 checks**, plus 7 offline tests of the monitor's report path. EPYC 9115, kernel 7.2.3, QEMU 11.1.1, Go 1.27.0,
2 vCPUs and 1 GiB per guest. Another session's GPU work shared the machine, so the timings are noisy.

**The identity change works, which was the point.**

| what | evidence |
|---|---|
| the app is **not** in the launch measurement | two different apps in one guest, and a different mix in a second launch, all report the same digest `62dbc936…`, equal to the prediction from the image alone. M1's equivalent check showed a *different* digest per app |
| the **monitor** names each app | domain A's report carries `report_data[32:64]` = sha256(app A), domain B's = sha256(app B), from the hashes the monitor took when it loaded them |
| both domains are **attested** | AMD chain to the pinned Turin root, the VCEK naming this chip and TCB, the TCB meeting the supplied test floor, and the key the client's own handshake saw bound to its nonce |
| a client cannot be fooled about which app it reached | a client expecting app B is rejected by the domain running app A, and sends it nothing |
| the report interface is the monitor's alone | a root process inside a domain that is not a registered domain is refused a report; the monitor identifies callers by the socket's kernel credentials, and the request has no field naming an app |

**Serving, per domain:** each domain serves its own app on its own port and its own TLS key, 4 x 16 MiB
echoed intact, and the host relayed 134 MB of ciphertext for domain A with no plaintext marker in it.
TLS ends inside the domain, so the monitor relays bytes it cannot read.

**Separation, guest-kernel (WEAKER than VMPL, and named that way in the check itself):** each domain's
workloads run as their own uid, see no `/sys`, no configfs and no other domain's tree, see only their own
three processes, and both domains serve on `127.0.0.1:8080` at once without colliding or reaching each
other. Each gets its own cgroup share: the same work took 2,209 ms at `cpu.max` 100% and 8,735 ms at 25%
(**3.95x**). Destroying a domain stops its port answering and removes it from the monitor's table.

**Cost, and this is the payoff:**

| | M2 (one CVM per app) | M3a (domains in one CVM) |
|---|---|---|
| starting app N+1 | a whole guest: **3.4 s** | load -> serving: **5-13 ms** |
| host memory for app N+1 | **+586 MB** (another SNP guest) | **0** — 1,125 MB with one domain and 1,125 MB with two, because SNP pins the guest's RAM at launch |
| request latency p50 / p99 | 0.31 / 0.71 ms | 0.38 / 0.92 ms |
| echo throughput | 576 MB/s | 800-1,032 MB/s (2 vCPUs here vs 1) |

So a domain is three orders of magnitude cheaper to start than a guest, and free in host memory until the
guest itself must grow — at the cost of a weaker app-vs-app boundary, which is exactly the trade M3b
would remove for up to three domains.

**Lifecycle and bounds (added 2026-09-23 after an independent source audit; checks 9-9c and
`monitor/report_test.go`).** The first version reaped a domain's process and did nothing else, so a
domain whose workload died stayed in the table with its port, mounts and cgroup still held, and the
report socket parsed whatever a caller sent before checking who the caller was. Both are fixed:

- **Every domain ends exactly once, however it ends.** A crash, a failed start and an explicit destroy
  all run one idempotent reclamation, which closes the port first, then waits for the process tree to be
  gone (not a fixed sleep) before unmounting, removing the directory and the cgroup. A domain is put in
  the table *before* its first instruction, so one that dies during startup is still reclaimed.
  **Measured:** five create-and-crash cycles — a deliberately invalid app, so the runtime fails and the
  domain's init exits, a real crash path with no test-only hook in the guest — leave the guest identical
  to before them: `{"cgroups":2,"dirs":["1","2"],"domains":2,"mounts":4,"userspace_procs":7}` both times,
  with five `domain N ended` lines and nothing left in the table. A new domain then loads, attests and
  serves. The whole-tree kill path is what `destroy` does and is covered by check 7. The front-exit
  branch shares the same handler as the runtime-exit branch and was not separately triggered: adding a
  host command to kill a process inside a running domain would be a hole, not a test.
- **What a domain can make the monitor do is bounded.** Callers are authenticated from the socket's
  kernel credentials *before* their bytes are parsed; requests are read under a 1 KiB cap and a 20 s
  deadline; reports are admitted under a global limit (16) and a per-domain limit (2), with admission
  taken before a goroutine exists so a flood cannot cost one stack per connection; a refused caller is
  answered and drained rather than reset. The control channel gets the same treatment: bounded command
  lines, a 64 MiB app cap, deadlines and a connection limit. `go test ./monitor/` covers this offline,
  with no VM and no root: an unauthenticated caller pushing 64 MiB is refused after 219 KB and never
  reaches the hardware path; an oversized request is refused and the domain is still served next;
  one domain at its limit does not delay another; a flood is refused at the global limit; a half-open
  request cannot hold the monitor past its deadline; retire is idempotent; and report_data's app half
  comes from the monitor's table even when the request carries an `appSha256` field naming another app.

`domexec` now fails closed on every setup step (its private `/proc`, `/tmp` and loopback), drops
supplementary groups before `setgid`/`setuid` — otherwise a domain workload would have kept the
monitor's groups, root's among them — and confirms the privilege drop held before exec.

**Two defects the first run caught, both fixed:**
- `domexec`'s credential probe printed `GRANTED` when it got **no answer**. The monitor had refused
  correctly (its own log said so), but a read that timed out was being reported as a granted report. A
  security check must never read silence as success; it now distinguishes `refused`, `no-answer` and
  `GRANTED`, and only a reply actually carrying a report counts as the last.
- The measurement was predicted for 1 vCPU while the guest booted with 2, so every trusted client
  rejected on the allowlist. The vCPU count is part of a domain's identity (M1 section 7); the harness
  now predicts and boots with the same number.

**Not established here:** hardware separation between domains (that is M3b, and it is capped at three
domains per guest by `vmpl_count=4`); anything about VMPL; a right-sized guest (1 GiB was chosen for
headroom, not measured as a minimum).

## 11. What wiring M3a into the platform would take (design; not implemented)

M3a lives under `isolation/` and nothing in the product starts a domain. Worth saying first, because it
reframes the work: **production already runs many apps in one CVM with the app outside the launch
measurement.** metal0 boots one SNP guest whose supervisor hands each app to an app manager
(`PROVISION_BACKEND=vm`, `VMMGR_URL`, default `127.0.0.1:8091`) which runs it as a `wasmtime serve`
process; `cpuShare` is the admission unit and sets the memory cap. The measurement covers the Metal
release, not the tenant's app, and the RAD serves **one** report for the whole enclave, binding the
enclave's transport key. So today a buyer of app X gets evidence about the enclave image, and nothing in
the hardware evidence names X.

That makes M3a a replacement for that app manager rather than a new concept, and it closes a gap that
exists now:

| | production today | with M3a domains |
|---|---|---|
| one app per | `wasmtime serve` process in the shared guest | domain: uid, mount/PID/network/IPC/UTS namespaces, cgroup, own port |
| app named in the hardware evidence | **no** | yes: `report_data[32:64]` is the hash the monitor took when it loaded that app |
| report per | enclave | domain, each binding that domain's own TLS key |
| app-vs-app boundary | the runtime's in-process sandbox and the guest kernel | the guest kernel (M3a) or VMPL (M3b), with the runtime sandbox no longer load-bearing |
| share enforcement | `cpuShare` -> manager policy | `cpu.max`, `memory.max`, `pids.max` per domain |

### Touchpoints

1. **Control plane.** The supervisor speaks HTTP to `VMMGR_URL` on guest loopback. The monitor speaks
   line-JSON over vsock because M3a's harness drives it from outside the guest. Inside a CVM the
   supervisor is in the guest, so the monitor should serve the same HTTP shape on loopback and keep
   vsock for the out-of-guest case. Either a third `PROVISION_BACKEND=domain`, or the monitor answers
   the existing manager's routes.
2. **Routing.** Today the manager exposes an app on `appPort` and the relay forwards `/x/:id`. A domain's
   front listens on a unix socket that the monitor relays; the monitor would instead relay to the
   loopback port the supervisor expects per deployment.
3. **Attestation, the product-visible part.** A per-deployment attestation endpoint, so a client of app X
   fetches evidence naming X. The verdict rules already exist (`isolation/m2/judge.mjs`), the binding is
   what `relay/snp-verify.mjs` already checks, and the app half is the monitor's to write. This is the
   piece worth shipping first, because it is a capability the platform does not have at all today.
4. **Secrets and config.** Deployment secrets and per-version app config are delivered at container
   creation today; the monitor would write them into the domain's private directory, which is the
   natural place, and they would then be outside every other domain's namespace.
5. **Allowlist.** Unchanged in kind: the measurement names the release. The app hash moves into the
   evidence, which is what section 3 describes.

### Decisions needed before any of that is written

- **Does a deployment get a domain, or does a tenant?** One app with several deployments could share a
  domain or get one each; the share ledger assumes per-deployment accounting.
- **What happens when a domain dies?** M3a reclaims it and the port stops answering. The platform's
  lease machinery must decide whether that is a restart, a refund, or a claim released.
- **Three-domain ceiling under VMPL (section 1).** If per-app hardware isolation matters more than
  density, the answer is M2's one CVM per app, and the monitor becomes the thing that manages *those*
  rather than domains inside one guest. That is a product call, not a technical one.
- **Whether the runtime sandbox stays load-bearing during the transition.** Running both boundaries is
  strictly safer and costs nothing; saying so publicly is what must not get ahead of the code.

**Not started, and it needs a go-ahead:** every touchpoint above is on the live serving path for real
deployments. The right order is (3) first, behind a flag and with no change to how apps run, then (1) and
(2) on a single self-hosted node before the fleet.

## 12. M3a-3 results: the blocked pieces, built (2026-09-23)

`isolation/m3/build-svsm-toolchain.sh` and `build-planes-host.sh`. Both **build only**: nothing installed
system-wide, no kernel installed, no reboot, the running host untouched. Work directories and a private
`CARGO_HOME` under the scratchpad.

**Built here:**
- the `x86_64-unknown-none` Rust target, `cargo-c` and `cbindgen`
- **libigvm** from microsoft/igvm — what QEMU needs before `--enable-igvm` means anything
- **COCONUT-SVSM** at `d37095e1` through its own Makefile (`make RELEASE=1 FEATURES=vtpm igvm`), which
  produces the SVSM ELF, `igvmbuilder`, `igvmmeasure`, and IGVM files for QEMU, Hyper-V and Vanadium.
  `FW_FILE` defaults to none, so this needs no edk2 build; M3b supplies a real OVMF.
- **the planes host kernel** (coconut-svsm/linux `svsm-v7.2` at `bf5bafed3`) and the **patched QEMU**
  (coconut-svsm/qemu `svsm-v7.2`), configured from this machine's own running kernel config so what was
  built is a kernel this machine could actually boot.

**Two corrections to earlier sections of this page, found by building it:**
1. `igvmmeasure` is part of **COCONUT-SVSM**, not microsoft/igvm. Section 2 implied the latter.
2. `igvmmeasure`'s interface is `igvmmeasure [OPTIONS] <INPUT> <COMMAND>` — the file comes *before*
   `measure`.

**The finding that matters, and it is a blocker for the attestation story:** an SVSM launch measurement is
**not reproducible across build paths**. Two checkouts of the **same commit** `d37095e1`, differing only
in directory name, produced different IGVM digests:

```
checkout .../svsm     E46A5A58B57CAE906E0950DA59FE5ED76B97DA6CB233CE2C81FC24B53E4987AE67DB2525D622A90FE484885D07945222
checkout .../svsm-b   6287D87E9343CBF1639C051CD179B01D3B751596FA1B07945DDAA4374CF6C27D1F2BB10797AB2B51DE7DC72162EF53C3
```

The cause is mechanical: absolute source paths are embedded in the SVSM binary (`strings` finds each
checkout's own path, e.g. `…/svsm/kernel/src/cpu/control`), and the two ELFs differ in about 224,000
bytes. DESIGN.md section 5 point 2 requires a measurement that is **reproducible from its inputs**, and an
allowlist entry nobody else can reproduce is not an allowlist entry. So this must be fixed before an
SVSM-based CVM can be attested the way the platform attests M1 and M2 domains. The remedy under test in
step 7 of the script is Cargo's `trim-paths`, set through `CARGO_PROFILE_RELEASE_TRIM_PATHS` rather than
`RUSTFLAGS` — `RUSTFLAGS` would *replace* the rustflags the SVSM's own `.cargo/config.toml` sets
(`force-frame-pointers`, soft AES), silently changing the thing being measured.

**A process note, since it cost a run:** editing a shell script while it is executing corrupts the
interpreter's file offset. The first toolchain run died at its last line for that reason, after all its
steps had completed.

## 13. The boot that needs a decision, and how to undo it

Everything above is built and validated without touching the running host. The VMPL boundary itself
cannot be: `KVM_CREATE_PLANE` has to exist in the kernel that is running. This section is here so that
decision is concrete rather than open-ended.

**What the boot would cost on warden-host, measured from the machine as it is now:**
- **The GPUs go away while booted into it.** `nvidia`, `nvidia_uvm`, `nvidia_modeset` and `nvidia_drm`
  are loaded now, with 893 references, and the driver is `nvidia-580xx-dkms`. A new kernel needs that
  module rebuilt by DKMS against it, or there is no CUDA — which is exactly what the 27B benchmark
  session uses. **This alone makes the boot a coordinated event, not an afternoon's step.**
- ZFS is loaded but has **no pools**, so it is not a constraint. Root is ext4 on `/dev/mapper/cryptroot`,
  `/boot` is a vfat ESP, and the bootloader is **GRUB 2.14** — so a new kernel is an added entry, not a
  replacement, and nothing existing is overwritten.

**The plan, in order:**
1. Finish `build-planes-host.sh` green, and rebuild with the machine's FULL module config (this run used
   `localmodconfig` to fit the disk and the time).
2. `dkms build` the NVIDIA 580 module against the new kernel **before** installing anything. If it does
   not build, stop: the cost is no longer just a reboot.
3. Install as a SEPARATE GRUB entry (`vmlinuz-linux-planes` + its own initramfs). Do not touch
   `vmlinuz-linux`, its initramfs, or the default entry. Verify `grub-mkconfig` output lists both.
4. Confirm out-of-band access exists before the reboot. If the only way in is SSH, a kernel that does not
   bring up the network is an on-site visit.
5. Announce, wait for every session to park work, and take the window.
6. Boot the new entry **once**, non-default. First checks, in order: SSH answers; `uname -r`;
   `nvidia-smi`; `grep -c PLANES /usr/include/linux/kvm.h` is irrelevant — instead confirm
   `KVM_CAP_PLANES` is advertised by the running kernel via a two-line ioctl probe; then the M1 and M2
   harnesses, which must still pass exactly as they do today.
7. Only then the new work: COCONUT-SVSM at VMPL0 with our domain image at VMPL2, and the isolation tests
   in section 7.

**Rollback:** reboot and pick the original GRUB entry; nothing was replaced. If the new kernel does not
boot at all, GRUB's menu is the rollback, which is why step 3 must not touch the default entry. If the
machine does not come back, step 4 is what saves it.

**Remaining hardware test after the boot, stated now so it is not invented later:** the section 7 checks,
of which 1 to 5 and 7 have no equivalent today and are the whole point — that a domain at VMPL2 cannot
read the monitor's or another plane's memory, cannot obtain a report below its own privilege level, and
that its report verifies with `expectedVmpl` set to its plane and is refused without it.

## 14. Measured on real TEE hardware, versus simulated

Kept separate deliberately, because the difference is the whole value of the claim.

| claim | status |
|---|---|
| SNP guest boots unprivileged, returns a v5 report at VMPL0, reproducible launch measurement | **measured on warden-host** (M1, M2, M3a) |
| the app is in the launch measurement (one app per guest) | **measured** (M1, M2) |
| the app is NOT in the measurement, and a monitor names it instead | **measured** (M3a, 21 checks) |
| authenticated attestation: VCEK -> ASK -> pinned ARK, VCEK matching chip and TCB, caller's TCB floor | **measured** (M2 run 3, M3a) |
| TLS terminating inside a domain, host relaying ciphertext only, switched-key reconnect refused | **measured** |
| per-domain resource share, lifecycle reclamation, bounded monitor work | **measured** in-guest (M3a) plus offline Go tests |
| a compromised domain (native code as the domain's uid) cannot reach another domain or the report authority | **measured in-guest with the `domprobe` adversary** — but against the GUEST-KERNEL boundary, not VMPL |
| **app-vs-app isolation by hardware (VMPL)** | **NOT measured. Not simulated either.** The kernel that can do it is built but not booted (section 13) |
| the SVSM launch measurement is reproducible | **measured, and it FAILS today** (section 12) |
| VBS enclaves inside SNP | source-based only, and negative (DESIGN.md section 3, `windows/vbs/snp/README.md`) |

The honest summary: every layer of the design **except the VMPL boundary itself** is now measured on real
SEV-SNP hardware. The VMPL boundary is blocked on one reviewed reboot, and its prerequisites are built.
