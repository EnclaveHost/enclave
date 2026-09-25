# VBS isolation (Hyper-V GuestStateIsolationType 1) on the NucBox: what the sources support

Dated 2026-09-25. The owner is the guest runtime lane (enclave-5d), at enclave-d1's request after the review of
`docs/uefi-host-exclusion-feasibility.md` (d1, a15f5a21).

**The bar being measured.** Steven's requirement is VBS-like exclusion of the **ordinary host OS**, with a trusted
lower layer. It is NOT protection from the physical owner or from a compromised hypervisor. So "the hypervisor and
the box's boot chain are trusted" is the stated design, not a disqualifier.

**Sources.**
- openvmm at `a7b0bd4` (`~/enclave-bench/vbslike-phase2/openvmm`);
- the box kernel's own source, microsoft/WSL2-Linux-Kernel tag `linux-msft-wsl-6.6.87.2`, the kernel inside UKI
  `7fe3edb5`;
- the IGVM files in enclave-53's package sources;
- the VBS enclave spike measured on this box (`windows/vbs/REPORT.md`, 2026-09-20).

Nothing below has been run on a type-1 partition. Every statement is from source unless marked MEASURED.

## 1. The report chain decides go/no-go, and it is one experiment away

**What the source gives.**
- The VM asks the hypervisor for a report with `HvCallVbsVmCallReport` (0xC001). It sends 64 bytes of
  `report_data` and gets back up to 2048 bytes (`hvdef/src/lib.rs:775, 2244-2256`; OpenHCL issues it at
  `hcl/src/ioctl.rs:1343-1370`).
- The layout is `hvdef/src/vbs.rs`, `VbsReport`, 0x230 bytes:
  - a package header: size, version, `signature_scheme`, `signature_size`;
  - `version` and `report_data[64]`;
  - an identity block: `owner_id`, `measurement`, `signer`, `host_data` (32 bytes each), the enabled-VTL bitmap,
    the policy (`debug_allowed`), `guest_vtl`, `guest_svn`, the product id and the module id;
  - a **256-byte signature**.
- OpenHCL treats VBS as a TEE (`tee_call/src/lib.rs:372-401`, `TeeType::Vbs`). It sends the report to the host's
  "IGVM agent" for key release and AK certificates (`underhill_attestation/src/igvm_attest/mod.rs:116-165`).

**What the source does NOT give.** The key that signs the report, or how anyone verifies it. openvmm's own host VMM
(virt_whp) returns a dummy report (`hypercalls.rs:695-702`). Microsoft's public attestation protocol (MAA, "VBS
protocol") covers VBS **enclave** reports only.

**The strongest lead (MEASURED on this box, 2026-09-20).** VBS enclave reports here verify:
- with RSA-PSS (SHA-256, salt 32),
- under the **IDKS** key that this boot's measured-boot log carries (SIPA event 0x50023),
- where the log replays against a TPM quote, and the TPM's EK chains to AMD's fTPM root.

IDKS in this box's log is **RSA-2048**, so its signatures are 256 bytes, the size of the VM report's signature
field. The VM report's package header also has the same shape as the enclave report's (size, version, scheme,
signature size). If the VM report verifies under the same IDKS, a remote client has a chain:

  AMD fTPM EK certificate → TPM quote (the AIK bound to the EK) → measured-boot log replay (hypervisor, Secure
  Kernel and VBS configuration, PCRs 7/12/13/14, with PCR0 pinned) → IDKS → the VM report (`measurement` of the
  IGVM, `report_data` binding our key, `debug_allowed=0`, `guest_vtl`) → the domain's TLS key.

**The experiment that decides it**, bounded, on our own probe VM only:

1. A type-1 VM boots a **probe** medium: the production guest plus `/probe.ko`
   (`isolation/m3/probe/vbsreport.c`, built by `build-probe.sh`).
   - dominit loads it once, after its guards, and announces `MON PROBE IMAGE`.
   - It makes one `HvCallVbsVmCallReport` from VTL0 with the marker `ENCLAVE-VBS-REPORT-PROBE/1` in `report_data`,
     prints the status, and prints the report as hex.
   - A probe medium's hash is never a production medium's.
2. In the same host boot, save the TCG log (`Tbsi_Get_TCG_Log_Ex`, as `windows/vbs` did).
3. Run `probe/verify_vbs_vm_report.py --serial <console> --log <TCG log>`. It tries IDKS and IDK over each plausible
   signed span, with PSS and PKCS#1 v1.5, and names the combination that verifies, or says none does.

Outcomes:
- **status 0, and it verifies under IDKS**: the chain exists. GO on the chain. The remaining work is known:
  - bind our key through `report_data`;
  - implement ActivateCredential for the AIK (open since 09-20);
  - pin PCR0;
  - a production box policy: Secure Boot ON and test signing OFF (today both are wrong on this box, and a
    measured-boot policy would rightly reject it).
- **status 0, and it verifies under nothing in the log**: the signer is unknown, and the report is the host's
  assertion. NO-GO on client verification, whatever the memory protection does.
- **VTL0 refused (status 6, access denied, or 2)**: only VTL2 (OpenHCL) may ask. Our binding would then have to go
  through OpenHCL's vTPM. OpenHCL puts the AK public key into the report's runtime claims; VTL0 then
  `TPM2_Certify`s our key with that AK. That needs a vTPM (d1's VM has none today) and a way to get the report and
  runtime claims out. Not ruled out, but a bigger change.

**Probe validation, locally (QEMU/KVM, NOT Hyper-V), on the box's WSL kernel:**
- The module loads into 6.6.87.2-microsoft-standard-WSL2: vermagic, `struct module` layout and exported symbols
  all hold.
- With KVM visible there is no Hyper-V hypercall page, and it says so.
- With `kvm=off` and Hyper-V enlightenments it reaches a real hypercall page, and KVM refuses 0xC001 with status 2.
  That is right for a hypervisor that has no VBS reports.
- `verify_vbs_vm_report.py --selftest` finds the signed span of a synthetic report and nothing after a one-byte
  change. It reads IDKS and IDK (both RSA-2048) from this box's real log (`windows/vbs/evidence/measuredboot-64.log`).

## 2. Prerequisites on this build

**The IGVM.** d1's `7caf7408` (`openhcl-ownguest-4610d594.bin`) is **isolation None**:
- its map reads "IGVM file isolation: None";
- it was built from `probe/manifest-ownguest.json`, whose `"isolation_type"` is `"none"`.

Every OpenHCL IGVM declares the VSM_ISOLATION platform, isolated or not. igvmfilegen emits the same platform header
and VP-context builder for None and Vbs (`file_loader.rs:525-545`); the difference is the loader's
`IsolationConfig` (`:1155-1180`) and the VBS launch measurement (`main.rs:600-660`). So the platform header does not
tell type 1 from type 16.
- **Recipe change**: the guest config becomes `"isolation_type": {"vbs": {"enable_debug": false}}` with a real
  `guest_svn`. That is exactly the third guest config of `vm/loader/manifests/openhcl-x64-cvm-release.json`.
- **UEFI path**: Microsoft's own `openhcl-cvm.bin` (`cfd40ce2`, release 2511) already carries it: VSM_ISOLATION under
  compatibility mask 0x4, next to SNP and TDX. Its VTL0 image is UEFI (`"uefi": true`), so the ISO medium path is
  unchanged. `openhcl.bin` (`48773995`, what the box boots today) is the isolation-None build.

**The VM.** `-GuestStateIsolationType` 1 (d1 measured that it creates and starts), with the CVM firmware file.
OpenHCL refuses these host settings on an isolated VM (`underhill_core/src/worker.rs:4020-4114`):
- hibernation, processor idle, a legacy memory map, PCAT, PSP, servicing, `default_boot_always_attempt`;
- firmware debugging together with Secure Boot;
- additional PCRs not measured, or the SHA-384 PCR disabled.

**This host has no stateless option and no attestation agent** (measured by enclave-d1: `GuestStateLifetime` and
`GuestStateEncryptionPolicy` do not exist in 26200's `Msvm_VirtualSystemSettingData`). A type-1 VM there has a real
VMGS and a vTPM with a key protector, and `suppress_attestation` is off. OpenHCL's path then
(`underhill_attestation/src/lib.rs`, `secure_key_release.rs`):

1. `try_unlock_vmgs` (`lib.rs:313-470`) asks for the tenant key.
   - It gets a VBS report from VTL2 (`secure_key_release.rs:174-182`, `HvCallVbsVmCallReport`).
   - It sends that report as an IGVM_ATTEST KEY_RELEASE request over GET to the host's agent.
   - With no agent that fails, and **any** failure there, including the report itself failing, is caught as
     "Non-fatal, allowing for hardware-based recovery" (`lib.rs:386-398`). OpenHCL carries on with no tenant key.
2. `get_derived_keys` asks the host for guest-state-protection seeds (GSP, and GSP by id) over GET
   (`lib.rs:1026-1110`). Then:
   - The host supplies GSP (expected with a vTPM key protector): the VMGS is encrypted with keys derived from a
     **host-supplied** seed. The log says "Applying GSP." on a first boot and "Using existing GSP." after that.
   - No GSP, VMGS not yet encrypted, policy Auto/None: "No VMGS encryption used.", and the boot continues
     (`lib.rs:1364-1386`).
   - No key but the VMGS already encrypted: `DisableVmgsEncryptionFailed` (`lib.rs:1367`), retried 10 times one
     second apart (`lib.rs:721-760`), then fatal.
   - A policy that requires encryption (GspKey/GspById) with none available: `EncryptionRequiredButNotFound`
     (`lib.rs:1374`), fatal.
     Which policy vmwp sends when the setting does not exist is unknown here.
3. Each step needs the host to ANSWER on GET: host time, IGVM_ATTEST, GSP. vmwp's side is not in this source. A
   request it never answers would stall VTL2, and VTL0 (COM1) would then never start.

What this means for us:
- The guest should boot.
- The guest state (VMGS: vTPM seeds, UEFI variables) is protected, if at all, by a key the **host** supplies. So the
  host can read or forge the vTPM. **The vTPM route to key binding (section 1, "VTL0 refused") is closed on this
  host.**
- The direct VTL0 report (the probe) does not touch the VMGS and is unaffected.
- Our guest keeps no persistent secret: its TLS key is generated per boot, in RAM that is host-private on type 1.

**OpenHCL's own log without COM3.** OpenHCL starts its diagnostics server unconditionally
(`underhill_core/src/lib.rs:283-287`, `diag.rs:41-46`: vsock on `diag_proto::VSOCK_CONTROL_PORT`/`VSOCK_DATA_PORT`),
and `ohcldiag-dev <VM name> kmsg` (openvmm `openhcl/ohcldiag-dev`) reads its `/dev/kmsg` from the host.
- On a confidential VM the output is filtered to `CVM_ALLOWED` entries (`underhill_confidentiality`). Every
  attestation line above is `CVM_ALLOWED`.
- The line that matters most for section 1 is "Failed to retrieve key-encryption key", with its error:
  - `GetAttestationReport(...)`: VTL2 itself could not get a VBS report, which bodes badly for the probe.
  - an IGVM-attest or agent error: the report worked, and only the agent is missing.
- Not yet run on this host. `ohcldiag-dev` has to be built for Windows (`cargo build -p ohcldiag-dev --release` at
  a7b0bd4).

**The guest kernel: no change needed (from source, unmeasured).** Under isolation, VTL0 must put its VMBus ring
buffers in host-visible memory. OpenHCL does not even start its relay for a guest that hides isolation, "since it will
not be able to put their ring buffers in shared memory" (`worker.rs:1727-1737`). The box's kernel handles it:
- `arch/x86/kernel/cpu/mshyperv.c:588-590` calls `hv_vtom_init()` for `HV_ISOLATION_TYPE_VBS`;
- `arch/x86/hyperv/ivm.c:573-612` wires `set_memory_decrypted` to `hv_vtom_set_host_visibility`, the
  host-visibility hypercall;
- the config has CONFIG_HYPERV=y, CONFIG_AMD_MEM_ENCRYPT=y and CONFIG_HYPERV_VSOCKETS=y.

So the channels a VMBus driver opens become host-visible page by page, and nothing else does. Our payload, runtime
binding and TLS are unchanged.

**The guest's own statement.** From the next initrd the monitor's tuple carries `hv_isolation=` and `paravisor=`.
- They are read as Linux reads them: CPUID 0x40000003 EBX bit 22 (`HV_ISOLATION`) gates leaf 0x4000000C, where
  EBX[3:0] is the type and EAX bit 0 is the paravisor.
- It prints a raw `MON hv ...` line beside it.
- It is CONFIGURATION stated by the hypervisor, never a proof, and it never changes `host_excluded=no`.
- Type 16 should read `hv_isolation=none paravisor=yes`; type 1, `hv_isolation=vbs paravisor=yes`.

## 3. The boundary claim, type 1 against type 16, stated so it can be checked

- **Type 16** (what boots today; petri: "OpenHCL but no isolation"). `IsolationType::None`: no page acceptance and no
  host-visibility model. The root maps VTL0 RAM as it maps any child's.
  - Claim: **the root can read every page of the guest.**
- **Type 1** (VBS). OpenHCL accepts every VTL0 RAM page through the hypervisor as **host-PRIVATE**
  (`HvCallAcceptGpaPages`, `hcl/src/ioctl.rs:827-830`; `underhill_mem/src/lib.rs:260`, `init.rs:114-170`). Only the
  shared pool is made host-visible, and only through `HvCallModifySparseGpaPageHostVisibility` (`init.rs:180-200`).
  The guest makes its VMBus rings visible the same way (section 2).
  - Claim: **the root partition cannot read a VTL0 page the guest has not made host-visible. What it can read is
    the ring traffic, which on our path is TLS ciphertext end to end.**

**Who enforces it.** The Microsoft hypervisor, not hardware. Memory is not encrypted.

**What stays trusted:**
- the hypervisor, and the root's VTL1 (the Secure Kernel, which holds IDKS);
- the box's firmware and boot chain;
- OpenHCL (VTL2, inside the IGVM measurement);
- physical access: DMA from outside the IOMMU's protection, cold boot, bus probing;
- side channels.

**How to check it** (bounded, our own probe VM, a documented host API, never a customer app):
1. The guest's tuple reads `hv_isolation=vbs paravisor=yes`.
2. The same host-side read of the probe VM's memory, for example a VM memory dump, is **refused or returns no
   private page contents** on type 1.
3. The same read **succeeds** on type 16. That is the negative control.
4. A marker the guest writes into a private page (the probe's `report_data` buffer, or a page the monitor fills) is
   found in the type-16 dump and not in the type-1 dump.

**Labels until then:** `host_excluded=no` everywhere, T0-hv, monitor-signed, never "attested". A type-1 partition
earns a different label only after sections 1 and 3 both pass on the box.

## 4. On the box (enclave-d1, 2026-09-25), and where type 1 stands

**Type 16, MEASURED** on production medium `ca245eae` (initrd 0d14db23), openhcl.bin `48773995`, boot_ms 307:

```
MON hv hyperv=true max_leaf=0x4000000b priv_high=0x3b8030 isolation_priv=false config_a=0x0 config_b=0x0 (stated by the hypervisor, CPUID)
MON boundary tier=t0-hv vmpl=n/a vmpl_floor=n/a vmpl0=n/a host_excluded=no hv_isolation=n/a paravisor=n/a
MON ready control_port=9000 snp=false transport=hv_sock
```

- Leaf 0x4000000C is not defined on a type-16 partition (the maximum leaf is 0x4000000B), so the fields read `n/a`,
  not `none`/`yes`.
- The app served its 13 pinned bytes on that run.

**Type 1 with an OpenHCL paravisor has not started.** d1's matrix, all on `ca245eae`:

| firmware | type | GuestFeatureSet | result |
|---|---|---|---|
| openhcl.bin 48773995 (isolation None) | 16 | 0x201 | boots, hv_sock, app serves |
| openhcl.bin 48773995 | 1 | 0x201 | refuses to start (Worker 12030) |
| openhcl-cvm.bin cfd40ce2 | 16 | 0x201 | refuses to start (12030) |
| openhcl-cvm.bin cfd40ce2 | 1 | 0x201 | refuses to start |
| openhcl-cvm.bin cfd40ce2 | 1 | 0x601 | refuses to start |
| openhcl-cvm.bin cfd40ce2 | 1 | 0x400 | starts, then 18610 "fatal virtual firmware error" and an 18560 triple fault |

Those runs set `Vtl2AddressSpaceConfigurationMode 1` / `Vtl2AddressRangeSize 1024` / `Vtl2MmioAddressRangeSize 512`
(needed for openhcl.bin on type 16) and used New-VM, then ModifySystemSettings. E2 and E3 are therefore NOT RUN, not
failed: no type-1 guest has booted.

**Reading from source: two of those refusals are expected, and the matrix has not yet tried Microsoft's recipe for
type 1.**
- `openhcl.bin` is an isolation-None build. Refusing to load it into a VBS partition is expected; it says nothing
  about the CVM image.
- `openhcl-cvm.bin` on type 16 is its VBS configuration in an unisolated partition. Refusing that is expected too.
- For type 1, petri (Microsoft's test harness, which runs 28 `hyperv_openhcl_uefi_x64[vbs]` cases) differs from the
  runs above in three ways:
  1. **No VTL2 auto placement for isolated VMs.** `increase_vtl2_memory = is_openhcl && !is_isolated`
     (`petri/src/vm/hyperv/powershell.rs:548`); the three Vtl2* properties are set only then (`hyperv.psm1:274-283`).
     The images agree: `openhcl.bin` carries a RELOCATABLE_REGION and a PAGE_TABLE_RELOCATION_REGION (IGVM header
     types 0x102/0x103), so it needs auto placement. `openhcl-cvm.bin` has **neither**. Its VBS configuration
     (compatibility mask 0x4) requires VTL2 memory at the **fixed** GPA 0x8000000, 128 MiB (REQUIRED_MEMORY
     0x305, flags 0x1). Auto placement of a 1 GiB VTL2 range, asked of a fixed image, is the likeliest refusal.
  2. **No synthetic mouse, keyboard or display** on isolation types 1, 2 and 3: petri removes all three at creation
     (`hyperv.psm1:448-461`).
  3. **Isolation and OpenHCL defined together at creation**: `GuestStateIsolationType` 1 with
     `GuestFeatureSet 0x201` and `FirmwareFile`, in one DefineSystem (`hyperv.psm1:230-268`, "Enable OpenHCL by
     feature"), rather than New-VM followed by a modify.
- A caution: petri's hosts are probably newer than 26200.
  - It gates COM3 on build 27653 or later.
  - It uses VSSD properties 26200 does not have (`GuestStateLifetime`, `GuestStateEncryptionPolicy`).
  - It notes "Hyper-V VBS VMs don't work with COM3 enabled" (`mod.rs:361-380`), falling back to the diagnostics
    client for VBS VMs.

  So "VBS + OpenHCL is not composable on 26200" is possible, but NOT shown until the three differences above have
  been tried. If they fail too, the host's own event channels (VMMS/Worker Admin and Operational) around the 12030
  are the next evidence. `ohcldiag-dev` only helps once VTL2 runs; a partition that never starts has no diagnostics
  server.

**Update, same day: type 1 STARTS with petri's recipe** (enclave-d1, af7aab92). The run: one DefineSystem with
`GuestStateIsolationType` 1 + `GuestFeatureSet` 0x201 + `FirmwareFile` cfd40ce2, **no** Vtl2 trio, the synthetic
devices removed, and a real VMGS (a donor file made by `New-VM -GuestStateIsolationType VBS`). The auto-placement
refusal is confirmed, and "not composable on 26200" is withdrawn.
- The run: Worker 18500 "started" at 19:52:40; at 19:54:40, 18610 "fatal virtual firmware error", an 18560 triple fault,
  then 18508; COM1 zero bytes.
- The host lines `[1540] Gsp server unavailable` / `GspSeedData not set`, present on every booted type-16 run, are
  ABSENT.

**Reading from source.**
- **The 120 s is OpenHCL's own start-failure timer**, not a retry loop. When building the VM fails
  (`underhill_core/src/worker.rs:386-407`, any error in `new_or_restart`), OpenHCL:
  - logs "failed to start VM" (`CVM_ALLOWED`);
  - sends the formatted error to the host (`CompleteStartVtl0`);
  - waits two minutes to be terminated, and then panics with "should have been terminated after reporting start
    failure: {error}" (`vm/devices/get/guest_emulation_transport/src/client.rs:543-566`).

  So the failure happened within seconds of 19:52:40, and **the host was sent the exact error text** then. It is also
  in OpenHCL's kmsg for those two minutes, through `ohcldiag-dev`.
- **No GSP lines puts the failure before the GSP request.** On type 1, OpenHCL gets as far as that request
  (`get_derived_keys`, `lib.rs:1026`) only after:
  - opening the VMGS (`worker.rs:1864`);
  - `validate_isolated_configuration` (`worker.rs:2230`);
  - the non-fatal key release;
  - reading the key protector (fatal on a read error).

  A type-16 VM has no TEE and goes straight to GSP, which is why its runs log those lines.
- **Two candidates, both fatal on this host:**
  1. The VMGS does not open: `try_open(format_on_empty=true, format_on_failure=false)`, since this host has no
     `GuestStateLifetime`. A V1 or otherwise invalid store is fatal; an EMPTY one is formatted.
     `probe/vmgs_check.py <file>` says which the donor is.
  2. `validate_isolated_configuration` refuses the host's settings. For example "additional PCRs must be measured":
     `MeasureAdditionalPcrs` is a required field (no serde default, `get_protocol/src/dps_json.rs`), and the older
     host may send false for this VM.
- **Is a VMGS transferable between VM ids?** On OpenHCL's side, yes, if it is EMPTY or a plain v3 store. A key
  protector written for another VM id only triggers a TPM seed refresh (`lib.rs` "VM Id has changed since last
  boot"). Not if it is V1/invalid, or encrypted for another VM. Whether the HOST binds the file to a VM is not in this
  source.

**Narrowed** (enclave-d1's sweep and one refused test):
- **The 120 s is confirmed from the host side.** Hypervisor-Operational has partition 51 created at 19:52:47 and
  deleted at 19:54:47.
- **No host channel carries the error text.** Every Microsoft-Windows-Hyper-V-* log was swept for 19:52:30-19:55:10.
- **The host refuses an empty store.** A zero-filled 4,194,816 B store is rejected at realize time
  (0x80070570, "corrupted and unreadable"), so "OpenHCL formats an empty VMGS" is unreachable on 26200.
- **The donor store is pristine.** Its first 16 bytes, `GUESTRTS 00 00 03 00 28 ed 2e 6d`, are byte-identical to
  header 1 of a fresh `vmgstool create` (checksum 0x6d2eed28): an untouched, unencrypted v3 store, which OpenHCL
  opens and provisions. So a VMGS open failure is very unlikely.
- **The leading candidate is `validate_isolated_configuration`**, or something else in `new_or_restart` before
  attestation. It emits no host event; VMGS failures do (`vmgs_logger.rs`, `event_log_fatal(VMGS_*)`).

**Surfaces for the reason on type 1:**
- Crash dumps are disabled on a CVM (`underhill_crash/src/lib.rs:277`).
- The host command line is ignored on an isolated VM unless the image's STATIC command line carries
  `OPENHCL_CONFIDENTIAL_DEBUG=1` (`openhcl_boot/src/main.rs:671-672, 699`). No host setting can open a console or a
  debug mode.
- COM3 is absent.
- What remains is `ohcldiag-dev <VM> kmsg -f -r -v` (enclave-53's build `5f25f2e7`, llvm-mingw, from a7b0bd4). The
  "failed to start VM" line and its error chain are `CVM_ALLOWED`. The diagnostics server reads `/dev/kmsg` as-is:
  filtering happens where the logs are produced, and kernel messages remain.
- Its first line on a fresh type-16 boot should be OpenHCL's own kernel,
  `Linux version 6.12.52-microsoft-hcl+ (runner@runnervmrw5os) ...` (openhcl-cvm.bin: `runnervmg397c`).
- The fallback, only if kmsg does not settle it, is a **debug** VBS IGVM whose static command line carries
  `OPENHCL_CONFIDENTIAL_DEBUG=1`: unfiltered, crash dumps on, the host command line trusted. It is a different
  measured image and never a serving candidate.

**ohcldiag-dev on type 1 (03:26): `Error: unknown service diag.UnderhillDiag`, 0 kmsg lines.** On type 16 the same
tool read 354 VTL2 kmsg lines, including OpenHCL's own `6.12.52-microsoft-hcl` kernel. What the type-1 reply
establishes, from source:
- **It is a reply from a running OpenHCL diagnostics server.** `mesh_rpc` looks the requested service up in the
  services it has registered and answers `Unimplemented` "unknown service <name>" (`support/mesh/mesh_rpc/src/server.rs:178-183, 568-575`).
  - A server that never started gives a connect failure, not an RPC reply.
  - Only a `mesh_rpc` server formats the error this way. Our VTL0 guest listens only on vsock 9000 and runs no
    `mesh_rpc`; the diagnostics control port is vsock 1 in VTL2.
  - The same binary works against the same OpenHCL release on type 16 (same kernel 6.12.52, release 2511). A protocol
    mismatch would not produce a clean service-name error.
- **Not registering that service is policy on a confidential VM.** `diag_server/src/lib.rs:101-111`: "Disable all
  diag requests for CVMs". `UnderhillDiag` and `OpenhclDiag` are registered only when confidential filtering is off,
  and Inspect and the profiler always. Filtering is on when `OPENHCL_CONFIDENTIAL=1` and there is no confidential
  debug, and the boot shim writes that variable exactly when `isolation_type != None`
  (`openhcl_boot/src/main.rs:274-280`).
  - So the reply is **positive evidence** that the boot shim saw an isolated partition, and that the kernel and
    OpenHCL userspace came up as far as the diagnostics worker.
  - It does NOT place the failure earlier than the diagnostics server.
- **The diagnostics server starts before the VM worker.** `run_control` starts it (`DiagState::new`) before
  `launch_workers` (`underhill_core/src/lib.rs:490-510`). The VM worker's startup opens the VMGS (`worker.rs:1864`) and
  later runs `validate_isolated_configuration` (`:2232`). So this reply rules out neither.
- **Inspect is registered, but filtered to `Safe` fields, and it is served by `run_control`.** `run_control` is
  blocked inside `launch_workers` for as long as the VM worker's startup has not returned: `launch_worker` "waits for
  the worker to start running" (`mesh_worker/src/worker.rs:312-320`), and a failed startup sits in the 2-minute
  CompleteStartVtl0 wait. So on type 1 an Inspect request is expected to **time out**, where type 16 answers at once.

**The donor store, corrected** (enclave-d1). The file Hyper-V mints is 57 non-zero bytes with no GUESTRTS, and it
changed across a type-1 run (01c2879b → 3e9630e1).
- A fixed-VHD footer alone carries non-zero bytes (42 in a `vmgstool` store), so the fresh file is most likely a
  footer around an **empty** store. A hand-made all-zero file has no footer, which by itself would make the host
  call it corrupted.
- OpenHCL formats an empty store on open (`try_open`, `format_on_empty`) with the same `vmgs` crate `vmgstool` uses,
  which fits the byte-identical header 1.
- After provisioning in a boot, OpenHCL writes a **provisioning marker** (file 18, JSON: `provisioner`, `reason`, and
  its own build revision as `provisioner_version`) at `worker.rs:1909-1919`, before partition and memory setup. A
  marker naming `openhcl` would prove its VM worker ran past line 1911 on type 1.
- That would leave these candidates between there and the GSP request:
  - prototype partition (1974);
  - memory initialization (1996: VTL0 acceptance as host-private, specific to VBS);
  - the DMA manager (2029);
  - the guest-memory self test (2051);
  - measured VTL0 info (2079);
  - `validate_isolated_configuration` (2232);
  - the attestation steps before GSP.
- `probe/vmgs_check.py` prints the marker.

**The debug image and its control** (enclave-53, staged for enclave-d1). The debug image is
`pkg\probe-firmware-81e163ee\PROBE-FIRMWARE-TRUSTS-HOST-never-a-serving-candidate\`, sha `81e163ee...`.
- It is built from openvmm a7b0bd4, the whole `openhcl-x64-cvm-release.json` (SNP, TDX and VBS configs), with
  `--confidential-debug`. igvmfilegen appends `OPENHCL_CONFIDENTIAL_DEBUG=1` to the static OpenHCL command line
  (`vm/loader/igvmfilegen/src/main.rs:366-376`).
- It is **not** "stock plus a flag". Its VTL2 kernel is 6.18.37.5 and its userspace is a7b0bd4's, where stock
  `cfd40ce2` is release 2511 (kernel 6.12.52). The source cited in this file is a7b0bd4.
- So the type-1 order is:
  1. a **control** image, the same a7b0bd4 components without `--confidential-debug`. Failing like stock makes the
     debug image's text attributable. If it boots, the stock failure is specific to 2511.
  2. the debug image, with `kmsg -f -r -v`.
- Neither image is ever a serving candidate.

**THE ERROR** (enclave-d1, the debug image on a live type-1 partition, 81173698):

```
[0.126263] underhill_core::worker: ERROR ... failed to start VM error=failed to initialize memory: cannot safely support VTL 1 without using the alias map
[120.126490] [U] thread 'worker-UnderhillWorker' (45) panicked at vm/devices/get/guest_emulation_transport/src/client.rs:562:25
```

- It is memory initialization at 126 ms (`worker.rs:1996`), not the VMGS and not `validate_isolated_configuration`.
- The panic at +120 s is the start-failure timer, to the millisecond.
- It is proven for the a7b0bd4 debug build. For stock 2511 it is the strongest hypothesis; the control image decides.

The same run shows the partition is isolated:
- the kernel's `Hyper-V: Isolation Config: Group A 0x0, Group B 0x1` (type 1 = VBS);
- `OPENHCL_CONFIDENTIAL=1` on OpenHCL's command line.

**What the error requires, from source** (`underhill_mem/src/init.rs:559-582`, the branch for partitions that are not
hardware-isolated, which includes VBS). OpenHCL bails when **both** hold:
1. **Guest VSM is available**: `maximum_vtl = Vtl1` when `proto_partition.guest_vsm_available()`
   (`worker.rs:1989`). That is the partition's `access_vsm` privilege AND the **host-set** guest VSM partition config
   register allowing VTL 1 (`virt_mshv_vtl/src/lib.rs:2341-2350`).
2. **There is no VTL0 alias map.** The boot shim enables it only if the **hypervisor** reports
   `vtl0_alias_map_available` in its VSM capabilities register for a partition that is not hardware-isolated. Otherwise
   it forces `None`, ignoring even a device-tree value (`openhcl_boot/src/main.rs:703-729`).

The reason, from the source comment: without the alias map OpenHCL cannot enforce VTL0 access protections for a guest
that has VTL1, and it cannot hide Guest VSM from the guest's secure kernel.

**The levers:**
- **The alias map** is a hypervisor capability. No documented host setting is known to turn it on, and OpenHCL ignores
  a host-supplied value without the capability.
- **Guest VSM** is host policy, and our guest (Linux, no secure kernel) does not use VTL 1. The documented host knob
  is `Set-VMSecurity -VirtualizationBasedSecurityOptOut $true` (`Msvm_SecuritySettingData`). That it sets the guest VSM
  config's maximum VTL to 0, and that the host permits it on a type-1 VM, is a PREDICTION to test.
- Guest VSM is VTL 1 inside the guest. It is not the partition's isolation from the host (type 1, hypervisor host
  visibility), so opting out does not touch what is being tested.

**Discriminators:**
- The type-16 kmsg should carry `enabling alias map` (`worker.rs:1933`) if the hypervisor offers it there; the type-1
  kmsg should not. That would show this host withholds the alias map from VBS-isolated partitions.
- In the debug kmsg, `empty vmgs file, formatting` and `failed to write vmgs provisioning marker` say who formatted
  the store. The marker is written at `worker.rs:1909-1919`, BEFORE memory initialization (1996), so a store OpenHCL
  formatted this boot and that stopped at 1996 should carry file 18.

**My error, corrected:** OpenHCL starts the VM worker with `start_worker`, which does not wait (`lib.rs:446-457`).
The blocking `launch_worker` calls I cited are the VNC and gdb workers. So `run_control` stays responsive and reports
`control_state: starting`, as enclave-d1 measured on both images, while type 16 reports `started`.

**Still true:** no type-1 guest has booted, E2/E3 are NOT RUN, `host_excluded=no`, and nothing here is evidence of
isolation.

## 5. Files

- `monitor/hvisolation.go` and `cpuid_amd64.{go,s}`: the stated fields. `hvisolation_test.go`: the mapping, and
  reading them on the test machine.
- `dominit.c`: the `/probe.ko` hook, a no-op without the file.
- `probe/vbsreport.c` + `probe/Kbuild`: the probe module. Build it against the box kernel's own source and config:
  1. Get microsoft/WSL2-Linux-Kernel at tag `linux-msft-wsl-6.6.87.2`.
  2. Make `.config` the kernel's embedded IKCONFIG. The only differences `make olddefconfig` shows are compiler
     capabilities.
  3. Run `make modules_prepare HOSTCFLAGS=-Wno-error=discarded-qualifiers`. That flag is for a host tool,
     resolve_btfids, under gcc 16; it does not touch the module.
  4. Run `make -C <tree> M=isolation/m3/probe KBUILD_MODPOST_WARN=1 modules`.

  There is no Module.symvers, so `__versions` is empty and the loader warns once and accepts
  (`kernel/module/version.c`). Every symbol the module imports is exported. It avoids `hv_do_hypercall`, which
  calls the unexported `hv_tdx_hypercall`.
- `probe/build-probe.sh`: production initrd + `/probe.ko` → a probe initrd.
- `probe/verify_vbs_vm_report.py`: the host half, with `--selftest`.
- `probe/memmarker/memmarker.c` + `Kbuild`: the guest half of the memory-read positive control.
  - It writes a run-unique marker into one private page and one page made host-visible with
    `set_memory_decrypted`, and prints both guest-physical addresses.
  - The host reader (enclave-d1's saved-state decoder) checks exactly those addresses.
  - Validated locally with QEMU's `pmemsave` (`memmarker-check-2026-09-25.txt`). It ships only on a probe medium.
- `probe/vmgs_check.py`: what OpenHCL will make of a VMGS on this host (EMPTY / V1 / INVALID / V3-PLAIN /
  V3-ENCRYPTED, the headers, the allocated files), with `--selftest`. Checked against files made by Microsoft's
  `vmgstool`.
