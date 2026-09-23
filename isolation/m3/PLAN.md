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

**Three concurrency defects, found by a second source audit of the same code and fixed (2026-09-23).**
None of them needed a VM to find, and two of them could have leaked a domain permanently:

- **A destroy racing startup could strand a domain.** The domain was registered before `cmd.Start`, so a
  concurrent destroy could run the one-shot reclamation *before the process existed* — and the process
  that then started could never be reclaimed, because its cleanup had already been spent. There is now an
  explicit lifecycle (`starting -> running -> ending -> ended`): a reclamation arriving while a domain is
  starting records the request and leaves it to `start()`, which is the only code that knows how far the
  build got, and which honours it on the way out. `finishStart` only ever moves forward, so it cannot
  resurrect a domain that already ended — a bug the new test caught immediately. Every failure inside
  `start()` now reclaims what it took rather than leaving that to a caller that cannot know.
- **Killing by process-group id could signal unrelated work.** `release` ran a raw
  `syscall.Kill(-pid, SIGKILL)` even after `cmd.Wait` had reaped the process, and a pid or pgid can be
  recycled between being read and being signalled. Reclamation now kills by **cgroup** (`cgroup.kill`),
  which is a stable identity for exactly that domain's processes, keeps a real `*os.Process` handle rather
  than a number, and never signals a process it knows has been reaped. `stop` no longer hunts for the
  front's pid in `cgroup.procs` and `/proc` either: it signals the domain's init through the handle the
  monitor owns, and `domexec` forwards SIGTERM to the front.
- **One tenant could spend the monitor's whole attention.** Refusals were answered *inside the accept
  loop* and drained for up to two seconds, so one slow refused peer delayed every other tenant's
  connection; and a per-domain refusal drained while still holding a global slot, so one domain's flood
  could occupy the entire global budget despite the per-domain cap. The global slot is now returned
  before anything slow happens, refusals are closed on their own small budget (and simply closed when
  that is full), and the drain window is 250 ms. **Measured:** twelve refusals during a full monitor are
  answered in 578 microseconds rather than serially, a 60-connection flood from one domain comes back as
  the *per-domain* refusal rather than the global one, and a second domain is served throughout.

**A fourth defect, from a further audit pass of the same code: a failed launch stayed registered.** A
domain is put in the tables *before* its first instruction, deliberately, so one that dies during startup
is still found and reclaimed. That leaves one window where a domain is registered but has no process, and
the failure path closed it only halfway: it released the files, the cgroup and the listener but never
removed the domain from `doms` or `byUID`. So a launch that failed left a phantom: `list` reported it, its
uid still authenticated for reports, and a later destroy could not remove it (the state machine correctly
refused to reclaim it twice). Failure cleanup now goes through `abandon`, which deregisters from both
tables and then reclaims, deliberately bypassing the starting-state deferral because it *is* the code that
deferral hands work to. The post-registration window is its own method (`launch`), which also means a test
can drive it directly: `TestAFailedLaunchLeavesNothingBehind` gives it a binary that does not exist, so
`cmd.Start` fails deterministically, and then asserts both tables, the directory, the cgroup and the
state, and that the uid can no longer obtain a report. Writing it exposed a second, smaller thing:
`launch` took the listener but relied on its caller to have stored it, so an abandoned domain could leave
a port bound. `launch` now owns both.

**On `os.Process`:** an earlier comment implied it is a pidfd-backed stable identity. That is a runtime
detail this code does not verify and should not lean on, and the comment now says what is actually true.
The cgroup is the strong identity — it names exactly this domain's processes, however many — and the
`os.Process` fallback is safe for a narrower reason: we are the parent, so until we reap the child its pid
is held by a zombie and cannot be reused, and `reaped` is set by the one goroutine that reaps it.

`go test ./monitor/` is now 16 cases and passes under `-race`. Two of them drive the lifecycle state
machine directly, so the result does not depend on winning a race, and 50 start/destroy/crash cycles all
end with the domain out of both tables and nothing left behind.

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

1. **Control plane.** The supervisor speaks HTTP to `VMMGR_URL` on guest loopback:
   `POST /vms {image, cpuShare, gpuShare, appPort, name, ports, config, configCid, egress, secrets,
   hosts}` -> `201 {id, hostPort, portMap, status}`, plus `GET /vms`, `GET /vms/:id`, `DELETE /vms/:id`,
   `GET /vms/:id/logs`, `POST /vms/lease` and `GET /health`. The monitor speaks line-JSON over vsock
   because M3a's harness drives it from outside the guest; inside a CVM it should serve that HTTP shape
   on loopback and keep vsock for the out-of-guest case.
   **One field does not translate, and it is not a detail:** `image` is a *reference* the manager
   fetches. The monitor has **no network at all** — vsock is its only channel, by design — so it cannot
   fetch anything, and the supervisor must push the app bytes instead. That is a small supervisor-side
   change (it already holds or can fetch the artifact) but it is a change, so a drop-in
   `VMMGR_URL=monitor` is not available: the monitor takes bytes, the manager takes a reference. The
   trade is deliberate. A component that can fetch can be pointed somewhere else; one that only accepts
   bytes and hashes them cannot be.
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
- **the planes host kernel** (coconut-svsm/linux `svsm-v7.2` at `bf5bafed3`), configured from this
  machine's own running kernel config so what was built is a kernel this machine could actually boot:
  it **compiles**, produces a 16.6 MB `bzImage`, and builds `kvm-amd.ko` with the planes and SEV-SNP
  code in it. Its uAPI has `KVM_CAP_PLANES`, `KVM_CREATE_PLANE` and `KVM_EXIT_PLANE_EVENT`, none of
  which exist in our running 7.2.3 header.
- **the patched QEMU** (coconut-svsm/qemu `svsm-v7.2` at `1649642`, QEMU 11.1.0) built
  `--enable-igvm` against that libigvm. It offers the `igvm-cfg` object our packaged 11.1.1 does not
  have at all, and it implements the `device-plane` machine property (added at runtime in
  `hw/core/machine.c`, which is why it is absent from `-machine q35,help`).

**The VMM side is ready, and the running kernel is provably the only missing piece.** Asked to create a
plane on this host, the built QEMU gets as far as the kernel and is refused, in the kernel's own words:

```
$ qemu-system-x86_64 -machine q35,accel=kvm,device-plane=2,kernel-irqchip=split ...
qemu-system-x86_64: KVM plane 2 is not supported
```

And an SNP launch from the IGVM we built fails one layer lower, again in the kernel:

```
check_sev_features: VMSA contains unsupported sev_features: 29, supported features: 221
failed to initialize kvm: Operation not permitted
```

Both messages name the mechanism rather than leaving it to inference: QEMU asks for the plane, the
running kernel does not have it, and the SEV features the SVSM's VMSA needs are outside what this kernel
supports. That is as far as the VMPL path can be validated without the reboot in section 13.

**Two corrections to earlier sections of this page, found by building it:**
1. `igvmmeasure` is part of **COCONUT-SVSM**, not microsoft/igvm. Section 2 implied the latter.
2. `igvmmeasure`'s interface is `igvmmeasure [OPTIONS] <INPUT> <COMMAND>` — the file comes *before*
   `measure`.

**The reproducibility remedy, as far as it goes.** Two `--remap-path-prefix` entries appended to the
SVSM's own bare-metal rustflags — one for the checkout, one for `CARGO_HOME`, because dependency panic
messages carry the registry path and every builder's cargo home differs — take the two checkouts' ELFs
from **224,320 differing bytes to 56**. One source remains, identified: the vTPM's C code
(`libtcgtpm/deps/tpm-20-ref`, compiled by gcc, not rustc), which needs the gcc equivalent
(`-ffile-prefix-map`) added to `TCGTPM_CFLAGS`. So the complete fix is three remaps across two
toolchains, and it is a change upstream needs rather than a local workaround. Two things worth knowing if
you continue this: COCONUT pins Cargo 1.88, where the `trim-paths` profile option is not stabilised, so
setting it simply fails the build; and setting `RUSTFLAGS` would replace the rustflags their
`.cargo/config.toml` sets (`force-frame-pointers`, soft AES), silently changing the thing measured.

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

### The image the boundary test will use (2026-09-23)

Step (b) of the post-boot sequence needed one more artifact, and it is built: an **IGVM carrying the SVSM
and firmware**, 4.8 MB, digest

```
E0C43562CE5D804959DCC6996606BB4B7F0D878AC6D29B789B855D907D8889387C7992EA21314CD8E3FBC0C38272E499
```

made with the OVMF this machine already boots M1 and M2 images with
(`make RELEASE=1 FW_FILE=/usr/share/edk2-ovmf/x64/OVMF.4m.fd igvm`), so no edk2 build was needed after
all — which is just as well, since building edk2 would need `nasm` and `iasl`, neither of which is
installed and neither of which I will install on a shared host.

The guest side turns out to need no disk image either: `igvmbld`'s `--kernel` is the **SVSM** elf and
`--firmware` is OVMF, and the built QEMU **accepts `igvm-cfg` together with `-kernel`/`-initrd`** —
it gets as far as KVM and stops on the same missing kernel feature, not on the configuration. So the plan
is the M1/M2 boot path (fw_cfg, firmware, our bzImage and initramfs) with the firmware coming from the
IGVM instead of `-bios`. The exact command line is in `~/.cache/enclave-isolation/BOOT-CHECKLIST.md`, and
it has been run on this kernel to confirm every part of it parses.

**Two things the boot will answer and nothing before it can:** whether OVMF *inside* an IGVM still picks
up `-kernel` from fw_cfg the way it does with `-bios`, and whether our monitor image runs correctly at
VMPL2 rather than VMPL0. If the first turns out negative, the guest needs a bootable disk and that is
extra work inside the window.

**A rebuild trap worth knowing:** the SVSM pins cargo 1.88 via `rust-toolchain.toml`, and Arch's
`/usr/bin/cargo` ignores that pin and uses sysroot `/usr`, which has no bare-metal std — the build then
fails with "can't find crate for `core`", which looks like a missing rustup component and is not. I lost
time to it because of my own shell bug: `export CARGO_HOME=X PATH=$CARGO_HOME/bin:$PATH` expands
`$CARGO_HOME` *before* the assignment, so PATH began with `/bin` and picked up the system cargo.

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
1. ~~Rebuild with the machine's FULL module config~~ **resolved 2026-09-23: not needed, and skipped on
   evidence rather than to save time.** The `localmodconfig` build was checked item by item against what
   this machine actually boots, networks and displays on, and carries all of it: `USB_RTL8152` (the only
   real NIC here is USB ethernet, `r8152`), xhci, `EXT4_FS`, `VFAT_FS`, `BLK_DEV_NVME`, `DM_CRYPT` with
   `CRYPTO_XTS`/`AES`/`AES_NI` (the root LUKS is `xts(aes)`), `DRM` + `DRM_AST` + framebuffer console +
   `USB_HID` + `VT` (there is a person at a keyboard), `KVM_AMD` with `KVM_AMD_SEV`, `VHOST_VSOCK`, and
   the `vfio` modules `mkinitcpio.conf` names. Residual risk, stated rather than hidden: 212 modules
   against the running kernel's 6476, so anything not currently bound has no driver. Acceptable for a
   one-shot non-default test boot; not a kernel to leave as the general-purpose one. `SEV_GUEST` is
   deliberately absent because this is the HOST kernel; guests keep using `/boot/vmlinuz-linux`.
2. **Done 2026-09-23, and GREEN.** NVIDIA 580.178.04 builds clean against the planes tree: all five
   modules, zero errors, vermagic `7.2.0-gbf5bafed3e6d`. Built without root in
   `~/.cache/enclave-isolation/nvbuild` using the make line from the package's own `dkms.conf`. The GPUs
   survive this kernel, so the boot is affordable. Secure Boot is disabled and `MODULE_SIG_FORCE` is not
   set, so nothing needs signing.
3. Install with **`install-planes-kernel.sh install`** (committed, reviewable, and it refuses to
   half-install). It does NOT use `vmlinuz-linux-planes`, which would have been a real trap:
   `/etc/grub.d/10_linux` globs `/boot/vmlinuz-*` and reverse-version-sorts the result, and
   `GRUB_DEFAULT=0` - so that name could sort ahead of `vmlinuz-linux` and silently become the DEFAULT
   entry, the one thing this step must not do. The files go in `/boot/planes/`, invisible to that glob,
   and the entry comes from `/etc/grub.d/42_planes`, which runs after every generated entry. The script
   reads `grub.cfg` back and refuses to finish if entry 0 moved. It copies the command line from
   `/etc/default/grub` verbatim, which matters here: `rd.luks.name=` and `root=` for the encrypted root,
   and `usbcore.autosuspend=-1` for the USB NIC.
4. ~~Confirm out-of-band access exists~~ **checked 2026-09-23: there is none.** `/dev/ipmi0` exists and
   the `ipmi_si`/`ipmi_devintf` modules are loaded, but no IPMI tool is installed (`ipmitool`, `ipmiutil`,
   `freeipmi`, `redfishtool` all absent) and `/proc/cmdline` has no `console=`. So a kernel that does not
   bring up networking is a keyboard visit, and nobody can watch the boot remotely.
5. Announce, wait for every session to park work, and take the window.
6. Boot the new entry **once**, non-default, then run **`m3b-verify.sh <workdir> <kernel-release>`**,
   which is the whole post-boot sequence in one command so the window is spent on the boundary rather
   than on assembling checks. It stops at the first stage that fails:
   - **stage A, is this kernel safe to keep:** the intended `uname -r`, `nvidia-smi` (the other sessions'
     CUDA work), a default route, DNS, `sshd` active, and whether QEMU is granted a plane. The plane gate
     is checked against a real negative: on the kernel running today it answers `KVM plane 2 is not
     supported`, so the gate can fail rather than merely being present. Any stage-A failure prints ROLL
     BACK and attempts nothing else.
   - **stage B, regression:** M1, M2 and M3a re-run unchanged. A kernel that enables planes but breaks
     what already worked is not a step forward.
   - **stage C, the boundary:** step 7 below, with the gates of section 7.
7. Only then the new work, in this order, because each step is worth having on its own:
   a. **COCONUT's own configuration first**, unmodified: SVSM at VMPL0, their guest at VMPL2, with
      `kernel-irqchip=split` and `device-plane=2`. If this does not run, nothing of ours will, and the
      fault is upstream rather than in our image.
   b. **Our monitor guest at VMPL2**, under that SVSM. This is the VBS shape: a more privileged layer
      below our whole OS, which is what VTL1 is to VTL0. It needs the identity change of section 3 —
      under IGVM the firmware is what the digest covers, so our image arrives by disk and its own
      measurement moves to the SVSM's vTPM or to the monitor's statement.
   c. **A report at privilege level 2**, verified with `expectedVmpl: 2` and refused without it, **plus a
      refusal at level 0, which is the part that is actually evidence and is now ENFORCED rather than
      described** (see section 15). A report's VMPL field alone does
      not prove confinement: a guest at VMPL0 holds every VMPCK, so it can request a report naming a
      LOWER level than it has. Downward claims are cheap, and that is precisely the direction a plain
      VMPL0 guest would fake. What cannot be faked is being refused at level 0, because our secrets page
      holds no VMPCK0 unless we really are at VMPL0. `privlevel_floor` is worth less still: it comes from
      the `sev_guest.vmpck_id` module parameter, so it is the guest's own command line talking.

      The guest side is built and committed, and prints the three separately: `vmpl_floor` (the kernel's
      claim), `vmpl` (the PSP's VMPL field, parsed out of our own signed report at offset 0x30), and
      `vmpl0` (`refused`, `GRANTED` or `n/a`). `GRANTED` means the boundary is not there whatever else
      reads well. `client.mjs` prints `report_vmpl` beside the `expected_vmpl` it demanded, and
      `test-m3.sh` takes `VMPL=N` with **check 3e** requiring the guest's kernel, the report and every
      client's demand to agree. Validated on hardware at VMPL0 (`vmpl=0 vmpl_floor=0 vmpl0=n/a`, M3a 30
      checks / 0 failures), and offline against forged reports: level 2 demanded and present passes, level
      2 present with the default 0 demanded is refused, level 0 present with 2 demanded is refused. The
      `vmpl0` probe can only do anything once the floor is above 0, which needs the boot.
   d. Only then **one plane per app** (at most three, section 1), which is the point at which app-vs-app
      isolation stops resting on the guest kernel. Steps a to c do not achieve that: they move the
      MONITOR/runtime split into hardware, which is worth having, and leave domains inside our plane
      separated as they are today.

**Who can actually run this, which is a constraint and not a detail:** every session working on this
box, including the one that built all of the above, runs **on warden-host itself**. A reboot therefore
ends the agent that would verify the result and trigger the rollback. Stage A of `m3b-verify.sh` is
written to be run by a person, or by an agent that reconnects afterwards, and the machine has
`/dev/ipmi0` but **no `ipmitool` installed and no `console=` on the current cmdline**, so there is no
out-of-band path for an agent to watch the boot or recover a kernel that does not bring up networking.
There is also **no passwordless sudo**, so installing a kernel and rebooting are not an agent's to
perform at all. It does not block building or validating anything - all of that is done - it blocks an
agent performing "reboot, verify, roll back" unattended. Steps 5 to 7 are for a person at the machine.

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
| a compromised domain (native code as the domain's uid) cannot reach another domain or the report authority | **measured in-guest with the `domprobe` adversary** (checks 10-10c) — but against the GUEST-KERNEL boundary, not VMPL |
| a compromised domain cannot exhaust the guest's memory | **measured**: it is killed at its own cap and nothing else is affected (check 8c) |
| a domain's port cannot be opened from inside the guest, only by the host | **measured** (the probe's vsock attempts; the monitor's host-CID gate) |
| a report names the privilege level it came from, and a verifier pins it | **built and tested offline** against forged reports (levels 0 and 2, demanded and not); on hardware it has only ever seen VMPL0, where it is trivially true |
| a report naming a LOWER level proves the guest is confined | **FALSE, and no longer claimed anywhere.** A guest at VMPL0 holds every VMPCK and can request a report naming VMPL1-3 |
| the guest was REFUSED a report at VMPL0 (the part that cannot be faked) | **enforced in three places offline**: the monitor fails closed before serving (16 mutants), `judge.mjs checkBoundary` rejects a document that cannot show it (10 cases), `boundary-gate.sh` demands exactly one coherent console record (26 fixtures). **Not yet observed on hardware:** the probe only does anything once the floor is above 0, which needs the boot |
| that refusal is attested BY THE HARDWARE | **No, and it cannot be.** The PSP signs the level a request came from, not the absence of a capability. A verifier relies on measured monitor code truthfully reporting its own local refusal; the code is in the launch measurement and fails closed, which is what makes that reliance worth anything |
| **app-vs-app isolation by hardware (VMPL)** | **NOT measured. Not simulated either.** The kernel that can do it is built but not booted (section 13) |
| the SVSM launch measurement is reproducible | **measured, and it FAILS today** (section 12) |
| VBS enclaves inside SNP | source-based only, and negative (DESIGN.md section 3, `windows/vbs/snp/README.md`) |

The honest summary: every layer of the design **except the VMPL boundary itself** is now measured on real
SEV-SNP hardware. The VMPL boundary is blocked on one reviewed reboot, and its prerequisites are built.

## 15. The VMPL0-refusal gate: closing the gap between describing a property and enforcing it

An audit found that the acceptance tests described this property and did not check it. `test-m3.sh` check
3e required only that the guest log contain `vmpl=$VMPL` and that clients accept signed reports carrying
that level; `m3b-verify.sh` C2 grepped the same string and C3 only required 3e to pass. **None of that
distinguishes a confined guest from a VMPL0 guest claiming a lower level**, and the old grep would have
passed a log that also read `vmpl0=GRANTED`.

What changed, in the order the evidence travels:

1. **The monitor fails closed.** `selfTest()` now runs BEFORE `serveReports` starts - it previously ran
   after, so a domain could obtain a report before the monitor had established whether anything bounded it.
   On an incoherent tuple it prints `MON BOUNDARY FAULT` and exits rather than serving. The decision lives
   in a pure `boundaryFault()`, so all 16 bad cases are tested without hardware: `GRANTED` at any level, a
   probe that never ran, an unreadable report or floor, the two numbers disagreeing, and the
   floor-0-but-claiming-lower forgery. The monitor also only ever requests reports at its own floor, so the
   measured code cannot mint a downward-claiming report even if a caller asks it to.
2. **One canonical record.** The tuple is emitted exactly once as `MON boundary tier=... vmpl=...
   vmpl_floor=... vmpl0=...`, and the level was removed from the `MON ready` line: two sources of the same
   fact is one more than a checker can safely believe.
3. **It reaches a verifier over attested TLS.** Serial text is not verifier-visible evidence - the console
   belongs to the host, which could write those lines. The tuple now travels with the report to the domain's
   front and into the attestation document, served over the TLS connection whose key is bound into
   `report_data`. `judge.mjs checkBoundary` rejects a document that omits it, contradicts the signed VMPL
   field, says `GRANTED`, says the probe never ran, or is malformed, duplicated or oversized - 10 cases in
   `test/isolation-boundary-policy.test.mjs`. Absence is tolerated only when the caller demands VMPL0, where
   no confinement is claimed, which is what keeps M2 documents valid.
4. **The harness gate is shared and pinned.** `boundary-gate.sh` is the single implementation used by check
   3e and by `m3b-verify.sh` C2. It demands exactly one record, rejects zero, duplicates (even identical
   ones), repeated or missing fields and unexpected fields. `boundary-gate-fixtures.sh` runs 26 crafted
   logs, most of which the old check would have accepted.
5. **The prose was narrowed.** C2 now reads as the refusal gate rather than a level grep, C3 says what
   reached the client, a new C3b fails if any guest reported a boundary fault, and the final verdict
   separates what the IGVM measurement authenticates (COCONUT-SVSM at VMPL0) from what rests on measured
   code reporting its own refusal.

**The residual assumption, which cannot be engineered away:** the hardware does not attest "this guest
cannot reach VMPL0". A verifier relies on measured monitor code truthfully performing and reporting its own
local refusal. What makes that worth relying on is that the code is inside the launch measurement and fails
closed - not that anyone verified the refusal from outside. DESIGN.md states this at the same length, and
no document should describe a lower-level report, on its own, as proving confinement.
