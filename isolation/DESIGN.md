# Native per-app isolation: one execution model across ordinary and TEE hardware

Status: DRAFT design; milestones 1 and 2 implemented and passing on warden-host (2026-09-22, sections 8 and 11). This page marks which parts are **measured**,
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
   VCEK -> ASK -> pinned ARK via AMD KDS, and requires the VCEK's extensions to name the report's chip
   and exact reported TCB.
2. The measurement is in the allowlist for (runtime version, app CID, vCPU count), and is reproducible
   from those inputs.
3. `report_data` binds the report to this app and this challenge. **M1 (implemented):** the 64 bytes are
   app sha256 (32) || verifier nonce (32). The nonce reaches the guest via fw_cfg, deliberately unmeasured:
   on the kernel command line it would change the launch digest on every boot. **M2 serving domains
   (implemented, section 10):** `[0:32]` = sha256(TLS key SPKI DER || verifier nonce), the binding
   metal0 serves and `relay/snp-verify.mjs` checks, and `[32:64]` = app sha256 as in M1. The report then
   also vouches for the TLS key traffic terminates on, and the nonce arrives per request, not per boot.
4. Policy: debug off, VMPL0 for the domain's own report, and an acceptable TCB version. **What is
   acceptable is the caller's to say**: `verifyQuote({ minTcb })` takes a floor per product line with every
   field required (section 10). The code chooses no floor. With none supplied the TCB is reported and
   left unjudged, and M2's trusted client does not accept the domain.

**Correction (2026-09-22).** This page and metal0's notes said warden-host's chip "has no VCEK published
by AMD KDS". That was wrong, and the cause was our own code. warden-host's EPYC 9115 is a Turin part.
Turin lays out the TCB bytes differently (FMC, boot loader, TEE, SNP, ..., microcode) and uses the first 8
bytes of CHIP_ID as its KDS hardware ID. Both verifiers read every report with the Milan layout and sent
all 64 bytes, so the lookup never matched. With the Turin form, KDS returns this chip's VCEK, and (1)
holds on warden-host: section 11 has live `attested` domains. M1's results are unaffected: M1 recorded
(1) as not tested. T0 has no hardware attestation, and the platform must say so rather than present a
T0 domain as attested.

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
  Implemented: sections 10 and 11.
- **M2 cost:** a size-matched guest RAM and a minimal kernel config. Measure launch time and memory peak
  against M1.
- **AOT vs JIT, measured:** precompiled native code inside the measured initramfs vs JIT at start. Compare
  launch time, memory, and what the measurement then covers.
- **Host-memory confidentiality test:** reviewed separately before running.
- **VMPL domains:** one CVM with a trusted monitor and apps at lower VMPLs. Needs KVM planes support,
  built or adopted.
- **T0+:** the pKVM-style monitor for non-TEE x86, the literal Linux "VBS-like" component.

## 10. Milestone 2: a serving domain, on T0 and T1

M1's domain ran a command and powered off. M2 makes it a deployment: the domain serves one port for
the life of a lease, TLS ends inside it, and the attestation report vouches for the TLS key. Same lab
host, same unprivileged interfaces, same measured launch inputs (`isolation/m1/domain.env`).

Design choices, with the reason for each:
- **The one port is vsock, and the domain has no NIC.** `vhost-vsock-pci` is the domain's only device
  besides the serial console. The domain then has no network stack facing anything but the host's vsock,
  no IP configuration, and no egress by construction. The host maps a TCP port onto the domain's vsock
  port 443, the Nitro Enclaves shape. `/dev/vhost-vsock` is usable without root here. Devices are not in
  the SNP launch digest, so adding one does not change the domain's identity. Under SNP, QEMU turns on
  `iommu_platform` for virtio by itself, so the guest bounces vsock traffic through shared memory.
- **TLS ends in a small static front, not in the app or the runtime.** `m2/front` (Go, standard library
  only, built `-trimpath` and byte-reproducible) mints a P-256 key in guest memory at start and writes
  it nowhere. It terminates TLS 1.3 on vsock, answers `GET /.well-known/enclave-attestation?nonce=<64 hex>`
  itself, and passes everything else as plaintext on the guest's loopback to the app under
  `wasmtime serve`. The app is an ordinary wasi:http component and needs no TLS code. The front issues no
  session tickets, so every connection does a full handshake and shows the key.
- **report_data** (section 5): `[0:32]` = sha256(SPKI DER || nonce), `[32:64]` = app sha256. The first half
  is exactly what `relay/snp-verify.mjs` checks for metal0, so the platform's verifier checks a domain's
  report without change. The front also returns the configfs-tsm `auxblob` (the VCEK table) when the host
  supplied one. It proves nothing by itself: the verifier chains the VCEK to AMD's pinned root.

### The verdict, and the gate it opens

One function, `m2/judge.mjs`, decides what a client may conclude. The client and the negative tests
both call it, so the rule that is tested is the rule that runs.

| verdict | meaning |
|---|---|
| `attested` | a T1 report whose AMD signature chain (VCEK -> ASK -> pinned ARK) verified, whose VCEK names this chip and reported TCB, whose reported TCB meets the caller's minimum-TCB policy, and whose policy, VMPL, measurement, key binding and app naming check out |
| `no-tcb-policy` | all of that except the TCB: no minimum-TCB policy was supplied, so the firmware level is unjudged. Authenticated, but not accepted |
| `unauthenticated` | the field checks pass, but the chain did not verify. Nothing authenticates the fields: a host could have written every one of them |
| `not-attested` | a T0 domain, which has no hardware report |
| `reject` | anything else |

| client mode | verdicts that open the gate |
|---|---|
| trusted (the default) | `attested` only |
| `--lab-unsigned` | `attested`, `no-tcb-policy`, `unauthenticated`. An explicit diagnostic, never a trusted gate |
| `--t0-diagnostic` | `not-attested` only. The explicit, untrusted T0 path: its pin is trust-on-first-use |

**A closed gate sends no application request at all.** `m2/client.mjs`:
1. fetches the document with a fresh nonce and takes the server key from that connection's TLS
   handshake, never from the document's `transportKey` field. Before a verdict, that GET and its nonce
   are the only traffic;
2. judges it, and stops with exit 3 if the mode does not open the gate for that verdict;
3. pins the judged key **at the handshake**. The client's HTTPS agent builds each socket itself and hands
   it to a request only after the handshake has finished and the key matched, so no application byte is
   ever queued on a socket with the wrong key. This covers reconnects. One mismatch trips a latch that
   refuses every later connection, and the client exits 4.

The first version of this client failed an independent audit (2026-09-22) on exactly these two
points. It printed `attested` for a report whose AMD chain was not verified. It also checked the pin
only after a response came back, and it sent application requests after a `reject`. Both are fixed as
above, and each has a test below.

**The minimum TCB is the caller's policy.** `--min-tcb` (and `minTcb` in `relay/snp-verify.mjs`,
`METAL_MIN_TCB` on the relay) is a floor per product line, for example
`{"Turin":{"fmc":..,"bootloader":..,"tee":..,"snp":..,"microcode":..}}`, with every field required. It
applies to REPORTED_TCB, the TCB the VCEK signing key is derived from. Nothing picks a floor. A policy
that is malformed, incomplete, has no floor for the report's product line, or cannot be evaluated
(the report names no product line) fails the quote. It never becomes a pass for lack of data, including
when there is no VCEK. An operator's real floor comes from AMD's security bulletins. The harness's floors
are **test values**: the box's own reported TCB, which must pass, and the same with SNP one higher, which
must fail.

**Found along the way, in shared code.**
- `relay/snp-verify.mjs` passed the VCEK's public key to `createPublicKey()`, which Node refuses for a
  public key object. Every report that arrived with a VCEK failed before its signature was checked, so
  nothing could ever verify through this code, the relay's attestation-gated attach included. Fixed in
  6b086edd, with `test/snp-vcek-signature.test.mjs` (2 of its 3 cases fail against the old code).
- Both verifiers built the KDS VCEK URL with the Milan TCB layout and the 64-byte chip ID, so every
  Turin lookup missed (section 5, correction). Fixed in 3d9ba863, with `test/snp-tcb-policy.test.mjs`.
  `metal/verify.mjs` gets the same lookup, the `createPublicKey` fix, the VCEK cross-check and
  `--min-tcb`.
- KDS answers HTTP 429 (`Retry-After: 10`) after a couple of requests. The verifier caches a VCEK once it
  has chained. A caller can hold AMD's chain (`seedCertChain`, pin-checked) and verify with `kds: false`,
  which the harness does after fetching the VCEK once (`vcek-prep.mjs`).
- Not supported by this QEMU: the kernel can hand guests a host-supplied certificate table
  (`KVM_SEV_SNP_ENABLE_REQ_CERTS`), but QEMU 11.1's `sev-snp-guest` has no option for it. So the front's
  `auxblob` is empty here, and the VCEK comes from KDS.

### Code (`isolation/m2/`)

- `app/`: the test app, a wasi:http component. `POST /echo` streams the body back; anything else
  answers `APP <label> path=<path>`.
- `dominit.c`: PID 1. It loads the vsock transport (and the report interface under SNP), brings up
  loopback, starts `wasmtime serve` and the front, and powers off if either exits.
- `front/`, `vsock/`, `domtls/`: the in-domain TLS and attestation front, a minimal AF_VSOCK binding, and
  in-memory key minting.
- `judge.mjs`, `client.mjs`: the verdict and the client described above.
- `negative.mjs`: forged, unsigned and TCB-policy evidence, judged offline (no VM, no KDS).
- `vcek-prep.mjs`: fetches the chip's VCEK once per batch and writes the two test floors.
- `fwd/`: the host side. It relays TCP to the domain's vsock and holds no key. `-tee` records the bytes
  it relays. `-mitm` is the attack: the host terminates TLS with its own key and re-encrypts to the
  domain. `-switch-after N` relays N connections and then MITMs the rest. `-mitm-tee` records the
  plaintext the host reads on MITM'd connections.
- `build-domain.sh`, `run-domain.sh start|stop`, `test-m2.sh [workdir]` (`RECHECK=1` re-scores saved
  outputs without booting).

### Tests

Three boots of one image: s1 (SNP), s2 (SNP, a second launch) and t1 (plain KVM). Every mode runs
against the live domains.

0. Build reproducible: two builds are byte-identical.
1. Measurement reproducible: the live digest equals the prediction, for both SNP launches.
2. **Attested, live, on s1 and s2**: the chain to the pinned root, the VCEK naming this chip and TCB,
   the TCB meeting the supplied floor, the key and nonce bound, and the app named. A second nonce on a
   new pinned connection is attested under the same key. A report does not satisfy a different nonce.
   And the refusals, each sending no application request: the trusted default holding no VCEK (2d),
   the chain verified but no TCB policy (2e), and a floor one SNP version above the box (2f). 2g is the
   negative suite.
3. The lab diagnostic without the chain says `unauthenticated`.
4. TLS ends inside the domain: the attested key is the one the domain minted. A host terminating TLS
   itself is rejected on the binding and receives no application request. The bytes the host relays
   hold no plaintext. A reconnect that meets a switched key after an attested handshake is refused at
   the handshake, and the host reads 0 plaintext bytes from it.
5. The key is minted per launch: s1 and s2 keys differ while their identity does not.
6. The app serves on the attested key, and 4 x 16 MiB are echoed intact (T1 attested, T0 diagnostic).
7. Tier parity: the same image serves the same output on T0 (`--t0-diagnostic`), and no mode calls T0
   attested. A host in the middle of a T0 domain cannot be detected.
8. Cost, measured without pass/fail.

The negative suite (`negative.mjs`, check 2g) builds reports from nothing, the way a host that wants a
client to trust its key would, and adds the live s1 report:

| case | trusted | lab-unsigned |
|---|---|---|
| N1 every field forged to bind the host's key, no signature | reject (no VCEK) | `unauthenticated`: the lab mode cannot tell a forgery, which is why it opens no trusted gate |
| N2 the same, signed by a host-made "VCEK" delivered in the auxblob | reject: "VCEK does not chain to ASK" | reject, same step |
| N2c one signed byte changed after signing | reject: "VCEK signature over the report is invalid" | |
| N3-N6 DEBUG policy, measurement off the allowlist, another app, binding to another key, another nonce | reject | reject |
| N7 a T0 document | gate closed | gate closed (open only in `--t0-diagnostic`) |
| N8 a T1 document in `--t0-diagnostic` | | reject: the modes do not mix |
| T1-T5 a Turin-shaped forgery under TCB policies: met, below, incomplete, no floor for the line | T5: reject (a policy never stands in for the chain) | met: still `unauthenticated`; the others: reject |
| N9 s1's genuine report with its VCEK: no policy / the box's own floor / one SNP version above / tampered | `no-tcb-policy` (closed) / **`attested`** / reject / reject on the signature | without the chain: `unauthenticated`, never better |

## 11. M2 results: measured on warden-host, 2026-09-22

Same host and toolchain as section 8, Go 1.27.0, app `cd6f49cb…`. The code changed between three runs,
and they are kept apart:

- **Run 1: before the audit fixes, on a quiet machine.** `test-m2.sh` printed ALL PASS, but its check 2
  counted a report with an unverified AMD chain as `attested`. **Its verdicts are superseded.** Its
  serving measurements stand: the serving path did not change.
- **Run 2: after the audit fixes, before the Turin lookup fix.** ALL PASS, but its trusted checks could
  only show refusal, because the broken lookup never found the VCEK. Superseded by run 3.
- **Run 3: current code. ALL PASS, 21 checks plus the 23 negative cases.** It ran while another
  session's 45-minute GPU soak (about 20 CPU threads) shared the machine, so its costs are noisy and not
  used below. Measurement `8fc54dac…`, TCB Turin fmc 1 / bootloader 3 / TEE 2 / SNP 5 / microcode 117.

What run 3 establishes:
- **Authenticated attestation of a live serving domain, twice.** s1 and s2 are `attested`: report signed
  by this chip's VCEK, chained to AMD's pinned Turin root, the VCEK naming this chip and TCB, the TCB
  meeting the supplied test floor, and the report binding the TLS key the client's own handshake saw
  with its fresh nonce. The app is then served on that key.
- **Refusal wherever the evidence falls short, with nothing sent:** no VCEK held, no TCB policy, a
  floor above the box, a host terminating TLS, a switched key on reconnect, and T0 in trusted mode.
- **TLS ends inside the domain**, the host relays only ciphertext, and it reads 0 bytes from a
  switched-key reconnect.
- **A fresh key per launch, the same identity, and the same app output on T0 and T1.**

Cost, run 1 (quiet machine; 1 vCPU, 512 MiB):

| | T1 SNP | T0 plain |
|---|---|---|
| guest kernel -> PID 1 | 808 ms | 650 ms |
| PID 1 -> serving (app and front both up) | 70 ms | 66 ms |
| host launch -> first HTTPS answer | 3.4 s | 1.2 s |
| request latency, one kept-alive TLS connection, p50 / p99 | 0.31 / 0.71 ms | 0.29 / 0.72 ms |
| echo throughput (16 MiB bodies, both directions) | 576 MB/s | 829 MB/s |
| memory peak of the domain's cgroup | 586 MB | 279 MB |
| host CPU for the whole domain lifetime | 2.1 s | 1.3 s |

The host-only baseline (vsock loopback, no VM) is 0.3-0.5 ms and about 1.0-1.1 GB/s through the same
front and forwarder. Latency is the same on T0 and T1. T1's echo runs at about 70% of T0's, consistent
with SNP bouncing virtio buffers through shared memory. The launch gap (3.4 s vs 1.2 s) is firmware and
SNP launch, as in M1. The memory gap is SNP backing all of guest RAM, as in M1, plus about 30 MB for
`wasmtime serve` and the front.

Not established here:
- **An acceptable firmware floor.** The floors used are test values from the box itself, so they prove
  the check works, not that this firmware is acceptable.
- The VCEK arriving from the host rather than from KDS (this QEMU cannot supply the certificate table).
- Any confidentiality measurement (the host-memory test); a client that is not this harness; anything on
  Windows or VBS.
- **Isolation between apps inside one outer TEE.** M1 and M2 give each app a whole SNP guest. Section 12
  covers the next step.

## 12. Next: app domains inside ONE outer TEE

M1 and M2 give every app a whole SNP guest: 3.4 s and about 586 MB each (section 11), and the outer TEE
is the per-app boundary. M3 asks whether several app domains can share one outer TEE and still be
separated by hardware. The feasibility research, the sourced plan, the trust boundaries, the isolation
tests and the milestones are in **`isolation/m3/PLAN.md`** (2026-09-23). The three findings that change
the design:

- **Four privilege levels, so at most three domains.** Measured here with CPUID `Fn8000_001F`:
  SEV-SNP present, VMPL feature present, `vmpl_count=4`. A monitor at VMPL0 leaves VMPL1-3. So VMPL is
  **not** a route to many app domains in one CVM. It is the right boundary for a **privilege split** —
  platform monitor above, app runtime below, the shape VBS uses on Windows — and for at most three
  hardware-separated domains per guest. Scale keeps coming from M2's one CVM per app.
- **The out-of-tree software now targets the versions this box already runs.** KVM planes
  (`KVM_CREATE_PLANE`, `KVM_CAP_PLANES`) is a formal v1 series, not merged; COCONUT-SVSM publishes
  `svsm-v7.2` Linux and QEMU branches (2026-08-27) with planes rebased to 7.2 and QEMU rewritten on
  v11.1.0, against our 7.2.3 and 11.1.1. Our stock kernel has no planes uAPI and our QEMU has no IGVM;
  the **guest** half is already satisfied (this kernel image exports `svsm_issue_call`, `snp_vmpl`).
  Installing a host kernel and rebooting warden-host is Steven's call and is not part of the research step.
- **Identity moves from the launch digest to the monitor.** Under IGVM the launch measurement covers the
  SVSM and firmware, not our initramfs, so the M1/M2 property "the app is in the measurement" does not
  survive. Per-app identity has to come from VMPL0 code — itself in the launch digest — hashing the app
  and naming it in `report_data`. That is the largest design change, and it can be built and proved with
  no host change, which is why it is the smallest useful milestone.

**Smallest useful milestone (M3a-1, no host change):** one stock SNP guest, a monitor as PID 1 holding the
only report interface, apps loaded at lease start and hashed by the monitor, and per-domain reports whose
`[0:32]` = sha256(domain TLS key SPKI || nonce) and `[32:64]` = the requesting domain's app hash taken
from the monitor's own table, keyed by the socket's kernel credentials rather than anything the domain
says. The M2 client and verdict rules apply unchanged.

At that stage domains are separated by the **guest kernel** — a uid, a network namespace, a private
directory and a cgroup each. That is MMU isolation enforced by the guest kernel, which therefore joins
the app-vs-app TCB: **weaker than VMPL isolation, never equivalent, and labelled so wherever it appears.**
SNP still excludes the host from every domain's memory. The app stays a Wasm component and runs natively
under `wasmtime serve`; the AOT/JIT choice stays open.

**Done already (2026-09-23, offline):** a report carries the VMPL that asked for it, and the launch
measurement is identical at every level, so that field is the only thing separating a monitor's report
from a domain's. `verifyQuote({ expectedVmpl })` and `metal/verify.mjs --vmpl N` now pin it, default 0,
with `test/snp-vmpl-policy.test.mjs` covering the default, each explicit level, malformed expectations and
the fact that the gate replaces none of the other checks. Production behaviour is unchanged.

### What a VMPL number is worth, and what it is not

Pinning the level is necessary and **is not sufficient**, and the difference is easy to write up wrongly.

**A signed report naming VMPL2 does not show that the guest is confined.** A guest at VMPL0 holds every
VMPCK, so it may request a report naming VMPL1, 2 or 3. The level field is therefore equally consistent
with *confined beneath a monitor at VMPL0* and with *at VMPL0 and saying otherwise*. Downward claims are
cheap, and that is precisely the direction an unconfined guest would lie in.

Three facts get gathered, and they are worth three different amounts:

| fact | where it comes from | what it is worth |
|---|---|---|
| `vmpl_floor` | configfs-tsm | **nothing.** `sev-guest` sets it from `vmpck_id`, a module parameter, so it is the guest's own command line talking |
| `vmpl` | the VMPL field of our own signed report (offset 0x30) | signed, so a verifier can pin it — but see above: it can name a level below the one we hold |
| `vmpl0` | asking for a report at level 0 and **being refused** | the only part that cannot be faked downwards: our secrets page holds no VMPCK0 unless we really are at VMPL0 |

So the boundary claim rests on the refusal, and the enforcement is layered:

1. The monitor runs the probe **before it serves anything**, and `os.Exit(1)`s on an incoherent tuple
   (`boundaryFault`, 16 mutants in `monitor/report_test.go`). It also only ever requests reports at its own
   floor, so the measured code cannot mint a downward-claiming report even if asked.
2. The tuple travels to a verifier **inside the attestation document, over the domain's attested TLS**,
   because a serial console belongs to the host and is not verifier-visible evidence. `judge.mjs`
   `checkBoundary` rejects a document that is missing it, contradicts the signed report, says `GRANTED`,
   or says the probe never ran — 10 cases in `test/isolation-boundary-policy.test.mjs`.
3. The harness gate `boundary-gate.sh` demands **exactly one** coherent console record, with 26 fixtures in
   `boundary-gate-fixtures.sh` covering `GRANTED`, `n/a`, mismatches, missing and repeated fields, and zero
   or duplicate records. Most of those logs would have passed the earlier `grep vmpl=$VMPL`.

**The residual assumption, stated plainly because it cannot be removed:** the hardware does not attest
"this guest cannot reach VMPL0". The PSP signs the level a request came from, not the absence of a
capability. A verifier therefore relies on **measured monitor code truthfully performing and reporting its
own local refusal**. What makes that worth relying on is that the code is inside the launch measurement and
fails closed — not that anyone checked the refusal from outside. Under an IGVM the launch measurement covers
COCONUT-SVSM at VMPL0, and *that* is the hardware-authenticated part of "something more privileged is above
us"; the refusal corroborates it and catches the case where the measurement allowlist is wrong. Never write
the level field up, on its own, as proof of confinement.

**M3a is built and measured (2026-09-23): `isolation/m3/`, `test-m3.sh` ALL PASS, 21 checks**, plus
`go test ./monitor/` for the report path's bounds, detailed in
`isolation/m3/PLAN.md` section 10. Two apps run as separate domains in one SNP guest; the launch
measurement is the same whichever apps are loaded, and each domain's report carries the app hash the
monitor took when it loaded it. Both domains are attested, serve their own app on their own port and
key, and a client expecting another app is refused. A root process that is not a registered domain
cannot obtain a report. Starting a domain costs 5-13 ms against M2's 3.4 s per guest, and a second
domain costs no extra host memory, because SNP pins the guest's RAM at launch.

A domain ends exactly once however it ends: five create-and-crash cycles leave the guest identical to
before them, with nothing left in the table, no stray mount, cgroup, directory or process. What a domain
can make the monitor do is bounded — authenticated before its bytes are parsed, capped in size, and
admitted under a global and a per-domain limit — so a tenant cannot move memory or work into the
privileged component that serves every other domain.

**M3b is done and measured (2026-09-23), on the KVM-planes kernel `7.2.0-gbf5bafed3e6d`.** Full
`isolation/m3/m3b-verify.sh`: ALL STAGES PASSED, with no environment overrides.

- **The hardware boundary.** COCONUT-SVSM holds VMPL0; our monitor and its domains run at VMPL2. Every SNP
  guest reports `tier=t1 vmpl=2 vmpl_floor=2 vmpl0=refused` in exactly one coherent record, the same tuple
  reaches every trusted client inside the attestation document over the domain's attested TLS, and the signed
  report agrees at `report_vmpl=2`. The adversary, lifecycle, resource and parity checks all still hold
  beneath the SVSM, and M1, M2 and M3a pass unchanged on the new kernel.
- **Launch identity.** The digest `igvmmeasure` derives from the IGVM being launched equals the measurement in
  the guests' signed reports (`62b4a946...`). This required moving the VMSA into guest memory
  (coconut-svsm/svsm PR #1209, VMSA at `0x08FFF000` in the SVSM's measured kernel range) so QEMU takes the
  direct-VMSA path; on the legacy path KVM synthesises and measures its own VMSA per vCPU and no predictor can
  match. Entirely userspace: no kernel change, and the stock kit QEMU suffices.
- **What it is NOT.** Still not app-vs-app isolation by hardware: inside our plane, domains are separated by
  the guest kernel, and per-app separation needs one plane per app with `vmpl_count=4` capping that at three.
  And the VMPL0 refusal remains the measured monitor's own word - the PSP does not attest the absence of a
  capability - worth relying on only because that code is inside a measurement a verifier can now derive, and
  because it fails closed.

Details, artefact hashes and the exact rebuild in `isolation/m3/PLAN.md` section 16.
