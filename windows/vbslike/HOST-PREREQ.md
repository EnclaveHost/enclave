# Host prerequisite for a custom paravisor image

**Superseded as a procedure by `pkg/win/host-prereq.ps1` (package v41).** That script makes the M3 prerequisites a
permanent install with a verified rollback: this setting, plus the 9001 hv_sock service
(`00002329-facb-11e6-bd58-64006a7986d3`). Approved by enclave-87 under Steven's authority; run by enclave-d1 only; see
`pkg/README.md` (v41 and "Limits"). The original note follows unchanged.


Scope: the NucBox K11 lab only. This file records the single host-wide setting that Microsoft
documents for loading a developer-built OpenHCL image, so that the change can be reviewed before
anyone makes it. Nothing here has been run.

- Setting: the OpenVMM guide, page user_guide/openhcl/run/hyperv.md, section "Enable loading from
  developer file", names one registry DWORD under HKLM\Software\Microsoft\Windows NT\CurrentVersion\Virtualization.
- Effect: the VM worker may load a firmware image named by the VM configuration instead of the in-box one.
  It applies to VMs created on this host afterwards; the guide says to set it once before starting the VM,
  and does not call for a reboot.
- Not needed: the Hyper-V role, the Windows Hypervisor Platform feature, EnableHardwareIsolation (SNP/TDX
  hosts only), Secure Boot, BitLocker or boot configuration changes. The phase-2 probe constructed and
  started isolated partitions without any of them.
- Preflight: record the current value of that key (absent on the box on 2026-09-23), confirm the live
  node task is running and leave it untouched, confirm no lab partitions exist (`vbslike-host probe`).
- Rollback: delete the value again. No other state is changed by it.
- Acceptance, when someone decides to apply it: run `isoprobe --only vbs-igvmpath` with our image and
  expect the create step to succeed; then the phase-1 lab with the isolation option.
