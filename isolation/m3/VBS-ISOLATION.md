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

With no attestation agent on the host, `suppress_attestation` (stateless guest state) skips key release
(`underhill_attestation/src/lib.rs:541-640`). A refusal shows in OpenHCL's boot log (COM3).

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

## 4. Files

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
