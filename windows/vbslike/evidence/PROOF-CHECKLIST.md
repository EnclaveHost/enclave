# Isolation proof checklist: nucbox-k11, type-1 (VBS) partition, pinned non-debug a7b0bd4 paravisor

Owner: enclave-d1. Contract and trust-boundary review: enclave-5d (`isolation/m3/PARAVISOR-ATTESTATION-CONTRACT.md`).
Build and pins: enclave-53. Last updated 2026-09-25 ~05:25 UTC.

The target is exclusion of the ordinary Windows host OS (the root partition's VTL0) under a trusted lower layer:
TPM, platform firmware and boot chain, hypervisor, and the root's secure kernel (VTL1). Physical access is out of
scope.

Every line is exactly one of:
- **VERIFIED**: observed on this host, with a reproducible artifact;
- **SOURCE**: argued from pinned source or vendor documentation, not observed;
- **UNTESTED**: assumed or open;
- **BLOCKED**: cannot proceed, with the reason.

A successful app response, a type-1 boot, or a refused Save-VM is none of these for host exclusion.

**Current verdict: host exclusion NOT established. `host_excluded=no`. Admission unchanged.** (updated ~06:25 UTC)

**Boot 68 (2026-09-25 05:32:35Z, Secure Boot ON) supersedes boot 67 for every same-boot item.** See
`boot68-2026-09-25.md`. Target: the custom type-1 path ONLY (`../DIRECTION.md`).

## O0. What Windows requires to load the isolation firmware (boot 68, Secure Boot ON)

- VERIFIED: with AllowFirmwareLoadFromFile set, Hyper-V loads our unsigned OpenHCL IGVM (control `32d464cc`) and
  starts the type-1 partition; the guest serves (canary 054323).
- VERIFIED: without the setting, Hyper-V refuses with Worker 5142 "failed to load custom IGVM file because
  AllowFirmwareLoadFromFile registry key is not set" (inverse control 054616).
- So the gate is the registry opt-in, not Secure Boot and not the VBS-enclave signing rule (which gives error 577
  for the legacy engine).
- OPEN, product decision: the opt-in is host-wide, and Microsoft describes it as a developer setting for unsigned
  images. The firmware's trust comes from its measurement in the report, not from Windows' load policy.

## O1. What enforces exclusion of the ordinary host OS

- VERIFIED: the partition is configured as type 1 (VBS). The read-back shows `GuestStateIsolationType=1`, and the
  guest's CPUID states `isolation_priv=true` and `hv_isolation=vbs` (`type1-isolation-2026-09-25.md`, canary 050338).
- SOURCE: enforcement is the hypervisor's, not the CPU's memory encryption. OpenHCL classes VBS as not
  hardware-isolated (`vmm_core/virt/src/generic.rs:149-151`) and its attestation as "software-attested"
  (`vm/devices/tpm/tpm_device/src/ak_cert.rs:19-25`).
- UNTESTED: that the root's VTL0 cannot read or write this partition's memory. The only documented host
  instrument, Save-VM, is refused on type 1, and the vmwp reader failed its type-16 positive control.
- BLOCKED (parked by direction): the host-memory experiment (E3). Report testing does not replace it.

## O2. Which guest, runtime and app bytes the measurement covers

- SOURCE: the VBS launch digest hashes the full content of every measured page, records unmeasured pages by
  number only, skips shared pages, and measures VP registers last (`igvm` b7e717d `igvm/src/measurement/vbs.rs:140-162, 257-280`).
- SOURCE, today's production path (UEFI in the IGVM, our DVD medium booted by UEFI): the paravisor, its static
  command line and the UEFI image are measured. **Our medium is NOT** (`vm/loader/src/uefi/mod.rs:439-457`;
  `underhill_core/src/loader/mod.rs:442-747` writes host-derived UEFI config at runtime).
- SOURCE, the proposed construction (Linux VTL0 inside the IGVM):
  - igvmfilegen accepts a `linux` VTL0 image in an OpenHCL IGVM (`vm/loader/igvmfilegen/src/main.rs:1453-1545`).
  - The kernel, initrd and VTL0 command line are imported as measured pages (`vm/loader/src/linux.rs:478,531,592`;
    `vm/loader/src/paravisor.rs:913-965`).
  - At runtime the paravisor appends `OPENHCL_CMDLINE_APPEND` to that command line
    (`underhill_core/src/loader/mod.rs:159-185`). That variable, and `OPENHCL_FORCE_LOAD_VTL0_IMAGE`, come from the
    paravisor's own environment (`options.rs:462-467`), which derives from its kernel command line
    (`underhill_init/src/options.rs:21-75`).
  - On a non-debug isolated image, the boot shim uses only the measured static command line and ignores the host's
    (`openhcl_boot/src/main.rs:671-672`; `host_params/dt/mod.rs:1027-1039`).
  - So the whole VTL0 command line is fixed by measured bytes, provided the static command line contains no
    confidential-debug flag.
- SOURCE: not covered in either construction:
  - host-derived runtime configuration handed to VTL0 (memory layout, ACPI and device tree:
    `underhill_core/src/loader/mod.rs:186-197`, the `LoadLinuxParams` passed to `load_linux`);
  - the app. Apps are loaded at runtime over the control port, so their identity (AppID) reaches a verifier only
    as a statement made by measured code, through report_data.
- VERIFIED (boot 68, `candidate-c567e432-review.md`): enclave-53 built it (`c567e432`, launch digest `A0FDAC0F…`).
  - The digests were independently recomputed with the pinned igvm crate.
  - Kernel, initrd and both command lines are confirmed in measured pages, and 53's mutation digests show each
    input changes the digest.
  - It BOOTED as a type-1 partition under Secure Boot with no medium: `MON ready`, `hv_isolation=vbs`, and the
    control channel answered (canary 061934).
  - Still host-supplied and unmeasured: the device tree, ACPI and memory map, the DPS apart from load kind, VMBus
    offers and the vTPM.
- VERIFIED (boot 68, `candidate-a44bb55a-review.md`): the G1 candidate `a44bb55a` (launch digest `58DFEBFE…`) is
  enclave-63's v30 build. It is `c567e432`'s recipe with only the initrd swapped for enclave-5d's G1+G3 initrd
  (`680d40fa…`).
  - Digests were independently recomputed. The new initrd is in measured pages, and the old initrd's bytes are absent.
  - It BOOTED and SERVED under Secure Boot (canary 070020).
  - The per-boot nonce held over hv_sock: no boot gave `bootRequired`, a wrong boot gave `rebooted:true`, both with
    the app untouched; the load answer's boot destroyed the domain.
  - It is a stale-reference guard, not caller authentication.
- Runtime: the wasm runtime binary lives in our initrd, so it is covered once the initrd is measured (SOURCE, same
  citations). RuntimeID is bound in report_data by measured code, as on the SNP path.

## O3. Report signer and trust root

**Current (boot 68, Secure Boot ON since 2026-09-25 05:32:35Z):**
- VERIFIED (`boot68-2026-09-25.md`, quote session `quote-20260925-053931/`):
  - a fresh quote from the node's own `tpmattest`, with this verifier's MakeCredential and nonce;
  - the EK chains to the pinned AMD fTPM root;
  - REAL EK-AK credential activation returned the minted credential;
  - the quote signature holds and its extraData equals the fresh nonce;
  - the log replays to the quoted PCRs, with Secure Boot ON, TESTSIGNING 0 and every debug flag 0;
  - all 7 negative controls are refused.
  The monitor independently re-verified the committed recording offline, with the same result.
- VERIFIED: boot 68's log carries new VSM_IDK/IDKS keys (IDKS modulus sha256 `402f2281…01a9`, PCR 12).
- RULED (enclave-5d, contract `aebd6bd7` and `1e5d3ae1`): the trust root is "host TPM plus IDKS under an ACCEPTED
  boot state". Secure Boot off or test signing on is a rejection condition, and **neither is present on boot 68**.
  That is not a pass of anything else.
- OPEN, current gaps:
  - PCR 0 (platform firmware) is not independently pinned; it is carried and recorded as an omission.
  - That IDKS (or any key) signs the paravisor's VM report: a HYPOTHESIS. No VM report bytes exist, and capturing
    them is provider-blocked (parked).
  - These are boot and node identity results only. They say nothing about custom-VM isolation or app admission.

**Historical (superseded, kept only as record; nothing waits on it):**
- Boot 67: Secure Boot OFF and TESTSIGNING ON (`trust-root-2026-09-25.md`), because the legacy enclave engine
  needed it. That was resolved by Steven's reboot with Secure Boot on, and the legacy engine is retired
  (`../DIRECTION.md`).
- Boot 64 (offline fixture): IDKS verified a VBS **enclave** report (Microsoft's documented enclave chain) as tier
  vbs-dev only. It had no credential round trip. It is not combined with any boot-68 evidence.
- The Windows AIK has no Microsoft AIK certificate (enrollment `0x80072EE7`). The tpmattest route above replaced
  that need.

## O4. Fresh verifier nonce and guest-held TLS key, authenticated to the measured instance

- SOURCE: the vTPM interface puts 64 guest-chosen bytes into the report through `report_data = sha256(runtime-claims
  JSON)` (`design/paravisor-attestation.md`, reviewed by enclave-5d).
- CLOSED AS A PREREQUISITE on the linux-direct path. The old gap was that an unmeasured medium let a host boot the
  measured paravisor with its own VTL0 and get a genuine report over data it chose. The measured Linux VTL0 now exists
  and boots and serves (`a44bb55a`, launch digest `58DFEBFE…`, canary 070020). A host booting another VTL0 gets
  another launch digest, which V3's pin refuses. That holds IF the report's `measurement` is that digest, which is a
  PREDICTION until report bytes exist (see "Outstanding dependency" below). The uefi-medium path keeps the gap
  forever: never an isolation claim (enclave-99's contract).
- SOURCE (d1, 07:42Z, `isolation/portable-runtime-jit`): a tenant cannot reach the TPM device.
  - Each domain is chrooted to its own directory, in new mount, PID, network, IPC and UTS namespaces (monitor
    `main.go:512-516`).
  - domexec mounts only `/proc`, `/tmp` and `/data` there, then drops to an unprivileged uid (`domexec.c:150-192`).
  - So no `/dev/tpm*` exists in a domain; only the measured monitor, in the root namespace, could ask for a report.
  - NOT MEASURED: the in-domain adversary probe (`domprobe.c`) checks the SNP interface (`configfs tsm`), not
    `/dev/tpm0` or `/dev/tpmrm0`. That negative control is requested of enclave-5d (open only, never a TPM command).
- SOURCE GAP: the vTPM's seeds and AK are in plaintext in the host-held VMGS, so AK quotes carry no trust
  (`vmgs_impl.rs:690-701`, `tpm_device/src/lib.rs:663-671`).
- BLOCKED (parked): capturing report bytes through the vTPM interface. enclave-5d's probe stopped at a provider
  safety block and is not rerouted.

### Outstanding dependency: report, signer and key binding (d1, 2026-09-25 07:42Z)

**Source facts (openvmm `a7b0bd4`, read-only):**
- OpenHCL (VTL2) gets the report with hypercall `HvCallVbsVmCallReport` (`0xC001`): "Request a VBS VM report from the
  host VSM" (`openhcl/hcl/src/ioctl.rs:1343`). So the signer is on the host's secure-kernel side, not in our
  paravisor.
- The layout is `hvdef/src/vbs.rs`, `VbsReport` (0x230 B).
  - A package header names `signature_scheme` and `signature_size`; their values are not named in the source.
  - `report_data[64]`.
  - `identity`: `owner_id`, `measurement`, `signer`, `host_data`, `enabled_vtl`, `policy.debug_allowed`,
    `guest_vtl`, SVN, product and module ids.
  - `signature[256]`. 256 bytes fits an RSA-2048 signature, the IDKS key's size. That is CONSISTENT with the IDKS
    hypothesis, not evidence for it.
- OpenVMM's own non-Hyper-V backend answers `0xC001` with a DUMMY report of `0xCD` bytes
  (`vmm_core/virt_whp/src/hypercalls.rs:695-702`). A parser that trusts fields without verifying the signature would
  accept it, so signature verification is not optional.

**What every open check waits for:** ONE real `VbsReport` package from a booted `a44bb55a` partition. Obtaining it
(the vTPM NV path, enclave-5d's step-1 probe) is PROVIDER-BLOCKED and PARKED; it is not rerouted or rephrased. Until
then these stay UNTESTED:
- V1: which key signs the report, and whether IDKS from the same boot's quoted log verifies it;
- V3: whether the report's `measurement` equals the pinned launch digest `58DFEBFE…` (a PREDICTION);
- V4: debug refusal by digest, plus `policy.debug_allowed`;
- V5: the binding of nonce, TLS key, appId and runtimeId in `report_data`;
- V7: replay and cross-VM refusal;
- every row of O5 below.
`host_excluded` additionally needs E3 (the host-memory experiment, PARKED). A report, even a valid one, does not
supply it.

**Next permissible steps, none of which captures a report:**
1. enclave-5d: the domain negative control above, an `open()` of `/dev/tpm0` and `/dev/tpmrm0` from `domprobe`
   (expect ENOENT). It runs in d1's acceptance run.
2. enclave-99: record the source facts in the contract. Add a refusal case for a report whose signature does not
   verify, including an all-`0xCD` dummy, and for an unknown `signature_scheme`, with no parsed field trusted first.
3. enclave-5d and 99: write down the `report_data` construction (which bytes, in which order) as a SPEC. It is not
   code that requests a report.
4. Steven or the provider: whether the parked capture can proceed is their decision, reported as the blocking item.
   Nothing here substitutes for it.

Eligible is not verified. `a44bb55a` is the one ELIGIBLE digest in 99's allowlist (main `2fc4f46b`). Eligible means a
report naming it would be accepted IF V1-V7 pass. No report has been verified, so nothing is verified.

## O5. Refusal tests on real evidence

| test | status |
|---|---|
| host log: altered key bytes / altered digest | VERIFIED detected (`tcglog.py replay`, NEGATIVE 1 and 2) |
| enclave-chain evidence (boot 64): altered report, SIPA field, quote, nonce, quoting key, EK root | VERIFIED refused (`test/vbs-verify.test.mjs`) |
| debug paravisor rejected (pinned release measurement + `debug_allowed == 0`) | UNTESTED: needs report bytes |
| substituted measurement rejected | UNTESTED: needs report bytes |
| replayed report rejected (nonce in user-data) | UNTESTED: needs report bytes |
| wrong key binding rejected | UNTESTED: needs report bytes and O2 |
| cross-VM report rejected | UNTESTED: needs report bytes from two VMs |
| positive control: a correct report accepted | UNTESTED: needs report bytes |

## Next, and who owns it

Nothing here waits on a decision already made: boot state (Secure Boot on) and the fresh quote are DONE on boot 68.

1. DONE (boot 68): measured Linux-VTL0 guests boot under Secure Boot and serve the pinned app.
   - `c567e432` (`A0FDAC0F…`): canaries 061934 and 062450.
   - The G1 candidate `a44bb55a` (`58DFEBFE…`, package v30): canary 070020, where G1's three destroys held on
     hardware.
   - Launcher `0160d835` (from `8f156c9a`) carries the IGVM identity and the boot nonce.
   - DONE: package v31 (enclave-63, `fb1bb0e6`, staged at `pkg\5e6b972e0451416a\`) makes `a44bb55a` vbsLinux's
     firmware and the one ELIGIBLE entry, superseding `c567e432`. The verifier is re-pinned on main (`2fc4f46b`).
     Eligible is not verified (see "Outstanding dependency").
   - DONE: the manager's ported WMI launcher defined, started, listed by identity and removed a type-1 linux-direct
     partition on this host, twice (runs 070935 and 071140; `mgr-launcher-canary-20260925/`). It serves no app. The
     partition name is settled by enclave-99 (main `ae6e9147`), and the manager follows (`25fa4e32`).
   - DONE: a candidate launcher, `vbslike-host.exe` `15338081…` (source `50010709`, lock `5c0ee1b7`), adds
     `--hold stdin` for the manager's per-domain wmiserve. It was built and checked VM-less on the box
     (`wmiserve-hold-stdin-build-20260925/`). `0160d835` is shown reproducible modulo link metadata. The candidate
     ships beside `0160d835` until the acceptance run passes with it.
   - DONE (run 080420, `mgr-restart-accept-20260925/`): the manager's restart recovery on real Hyper-V. The VM survives
     a killed manager and is recovered as `recovered:true`, held and never serving, with a 409 and no second VM. Two
     earlier failures were a console-attach race, fixed by `startAndRead`.
   - DONE (run 082325, `serving-accept-20260925/`): the measured `a44bb55a` guest SERVES through the real manager, node,
     app zone and data plane.
     - enclave-5d's hvlab-accept ALL PASS: a browser TLS session on the manager-verified key; every refusal; a forced
       relaunch; a node restart.
     - Restart A0-A7 ALL PASS: the relay dies with the manager.
     - The launcher is `435717de` (`1a6f1556`). The packaged candidate `15338081` FAILED the judge on a stray report
       format name, so it must not be promoted.
   - DONE (run 084443): the same serving acceptance on enclave-63's v34 PACKAGE, whose one launcher is `435717de`: ALL
     PASS. A8 shows the liveness sweep failing a domain whose VM went Off, within 4 s, on hardware.
   - DONE (run 090327): tree `2c3a2873` on v35 passes hvlab-accept and A0-A9. A9 shows enclave-5d's answer sweep failing
     a domain stopped inside a still-Running VM, on hardware. v36 pins that tree as the package's control/.
   - DONE, NARROWED by an independent audit (run 091720, `probe-domain-20260925/`): a PROBE-mode domain on
     `a44bb55a` with NO live neighbour. It shows the domain's own namespace and resource containment: an unprivileged
     uid, its own chroot, a pid namespace, no network route, and an enforced memory cap. It does NOT show denial
     against another live app: domprobe's "other" targets were its own or absent.
   - DONE (runs 093326 and 093904; `neighbour-probe-20260925/`, `candidate-b7ba7731-canary-20260925/`): the
     live-neighbour probe under enclave-99's rules (judge `ad61cb02`, 15 tests on the box). Both are INCONCLUSIVE.
     - The neighbour was live before and after, own_app is positive, memory is CONTAINED at its cap, pids are 2 and 1,
       and nothing was reached.
     - Neighbour denial is NOT established: the file targets' existence in the root namespace is unstated, and vsock
       to CID 1 is no in-guest route (no loopback transport).
     - 093326 printed PASS; that is superseded.
   - DONE (093904): candidate `b7ba7731` BOOTS under Secure Boot and SERVES the pinned fixture. Its TPM control reads
     ENOENT: absent from the domain's view, existence in the root namespace not stated.
   - DONE, functional serving and stability only (run 094631, `pkg-accept-b7ba7731-20260925/`): candidate `b7ba7731`
     serves through enclave-63's PACKAGED manager, node and launcher (v36 `3384e097aa024b73`, launcher `435717de`, not
     the standalone canary's `0160d835`). hvlab-accept (28 checks) and restart-accept A0-A9 ALL PASS, with every input
     hashed at use (tree list `842ba056`). This is NOT an eligibility promotion (enclave-63's rollover rule and
     enclave-99's review) and NOT host exclusion. Production attach and respawn (OFF) are unchanged.
   - DONE (v39, windows/vbslike-pkg `7e979b38`, id `61028ec3`; d1's review `v39-rollover-review/`): THE ROLLOVER.
     `b7ba7731` (56FBB27F) is the ONE eligible reference image. a44bb55a (58DFEBFE) and its twin are superseded and
     refused. The digest set is the same 12 (1 eligible, 11 refused), with every debug and probe image refused by
     exact digest. enclave-99 reviewed it and re-pinned it on main (`cf1b9dc3`). v39 is staged at
     `pkg\61028ec33770f4d7\` (staged.json `1cca37cc`; SelfTest 17/17 incl. the seven blank-master corruptions on
     5.1). Rollback to v38 (`88c18259`, reference `ba3f49a7`) is intact on the box.
     "Eligible" is PROSPECTIVE only: no production capacity, verified status, badge or protected-host admission.
     Custom-report verification stays fail-closed. host_excluded=no. Attach and respawn OFF; recovered VMs HELD.
   - DONE (3e3ad330; enclave-99's contract V5 "keys", main `1ce4bd69`): the guest-state master `4f051697` is MEASURED
     blank (4 MiB body all zero, 57 bytes in the VHD footer only, no GUESTRTS), so partitions share no vTPM state.
     enclave-63 pins that property in check.ps1. No re-mint.
   - OPEN, needed only before any FUTURE use of vTPM keys (custody, or a TPM-backed report key): show two partitions
     reporting DIFFERENT AKs. A blank input shows no shared state, not per-partition key generation. V5 admits on
     nothing in "keys" today. No capture or probe is scheduled for it.
   - OPEN (with Steven, via enclave-5d): stat-only root-namespace existence statements and printed probe targets.
     PASS for the neighbour acceptance needs them.
   - RULED (enclave-99's contract, main `de2a9f66`, "What the launcher's signature binds: the PARTITION, not a domain"):
     - wmiserve's 9001 signer checks the calling VM and signs a request whose app half it loaded into that VM. "A domain
       names only itself" holds only while the monitor is the sole in-guest path to 9001.
     - One app per partition: not a finding. More than one domain: a launcher-signed report never binds a domain.
     - The fix, when 5d's source unpauses: no AF_VSOCK or AF_HYPERV for domains, tested as domprobe to CID 2:9001 DENIED
       while the monitor's own dial connects in the same run.
     - Until then every neighbour run carries "host signer 9001: not probed" as INCONCLUSIVE (judge pin
       `hostSigner9001Probed`). The 093904 timeout shows the connect is attempted; it is not a denial.
   - DONE (G4, run 082856, `g4-probe-20260925/`): a type-1 guest whose monitor dies panics, asks for a reset, and
     Hyper-V turns the partition OFF (18590, then 18515). It does not reboot. The manager's liveness sweep now fails such
     a domain (`d7d4fd1c`); that sweep is not yet run on hardware.
   - OPEN, low value: the Rust launcher's own `rebooted:true` path. It has no WMI caller, and on type 1 there is no
     reboot to meet. The monitor side of G1 is proven (070020).
   - **Every run above is app plumbing and lifecycle. None of them is evidence of host exclusion.**
2. **enclave-5d and enclave-99:** the replacement node identity (windows-hv-node/v1), host-only and honest. A
   TPM-only node attach grants no app capacity and no isolation badge.
3. DONE, reviewed by d1: the node lifecycle treats a manager's `recovered: true` instance as HELD.
   - enclave-5d's windows/node-hv-identity: `dad939e9`, `d626da4e`, then `fb1db848` for the re-review.
   - The manager side is in windows/isolation-manager (`53672cbe`, `6b1137ee`, `8aac6cb4`).
   - d1 reproduced `fb1db848` at 361/361 in a clean worktree.
4. **Unresolved production requirement, documented, not blocking proof:** loading our firmware needs the host-wide
   AllowFirmwareLoadFromFile opt-in (O0). Proof runs use it temporarily and restore it. Permanent production use is
   Steven's decision, and it is not enabled permanently.
5. **Parked (provider-blocked or declined; not rerouted):** VM report-byte capture, and the host-memory experiment
   (E3). If every permitted prerequisite completes while these remain blocked, the remaining boundary is exactly:
   - no VM report signer verified;
   - no guest key or app binding in a report;
   - no host-memory exclusion evidence.
