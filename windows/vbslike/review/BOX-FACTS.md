# nucbox-k11, measured facts (independent review lane, enclave-99)

Read-only, from this workstation over `ssh minipc-zt`, with the manager's own modules at 8327498e run from a private
directory (`C:\Users\claude\review-99\manager`, `box-probe.mjs`): no port bound, nothing created, nothing under
`C:\Users\claude\vbs` touched. Raw answers: `box-probe-2026-09-24T2155Z.json`.

## 2026-09-24 21:47Z (survey) and 21:55Z (the manager's own preflight)

| fact | value |
|---|---|
| node bytes running | `host.mjs` 170a0db0…, `agent.mjs` d2595f35…, `appzone.mjs` 6ec96d19… = the deployed copies recorded at ef1b2077; written 21:19:29Z; node pid 936 since 21:19:33Z, ee-host pid 4824; task `EnclaveWindowsNode` Running |
| Hyper-V features | Hypervisor, Services, Management-PowerShell all **Disabled**; VirtualMachinePlatform **Enabled**; HypervisorPlatform Disabled |
| services | `vmms` NOT INSTALLED; `vmcompute` Running; `hvhost` Running |
| WMI | `root\virtualization\v2` "Invalid namespace"; `Get-VM` absent |
| WMI launcher preflight (real PowerShell) | ok=false; missing: vmms service, root\virtualization\v2, Hyper-V PowerShell module, Msvm_VirtualSystemSettingData.FirmwareFile; hypervisor present=true |
| guest image | `C:\Users\claude\vbs-like\openhcl-ownguest.bin` sha256 2d7353760b89b81b6f47759382bb2e83c325d73ed0825734f30fc4051183dfb3, 124,962,164 B; `verifyImage()` accepts it against that pin |
| manager `/health` (WMI backend) | canStart=false, cannotStart=the prerequisites, derivations `["enclave-catalog-bundle/1"]`, no `boundary` field |
| one spawn through the real backend | state `failed`, reason "the Hyper-V role is not usable on this host: missing …", **no `attestation` field**; `survey()` before and after: `{"vms":[]}` |
| HCS dev backend preflight | ok=true (launcher, kernel, initrd present); `host excluded`=false; boundary tier t0-hv, hcs-child, hostExcluded=false, attested=false |
| `vbslike-host.exe` | sha256 6040fc6b4e06c667a00c8e3418eab811c7fbf7d6357432bda8d0fe4852a3fa3d, 1,004,544 B, mtime 2026-09-24T19:51:20Z (the owner's message said "built 11:38"; the file's own time is 12:51 PDT) |
| `wsl-kernel` (VTL0 kernel, bzImage) | sha256 7fe3edb5b5dd2435545f611607b1c80e0cbc0e92b83e0cc0a25c07dc7d5ecddd, 15,876,096 B (= the packager's input for vmlinux 363b3553…) |
| `mon.cpio.gz` (VTL0 initrd, the m3 monitor) | sha256 44abb52b1486dd2aae344e021a0d8049dfb2015d137c22a6e336051c4db5a0cf, 24,008,350 B, mtime 2026-09-24T03:08:23Z (= the only initrd the IGVM reproduces with, per enclave-53) |
| manager on the box | `C:\Users\claude\vbs\manager` ABSENT (not deployed) |

## What these facts do and do not say

- The WMI path cannot start a partition here, by the host's own answer, and the manager says so rather than pretending.
  That is the single boot blocker (BLOCKERS.md), and its remedy is a role change plus one reboot, which is Codex's call.
- The HCS path can run TODAY with these files; it does not exclude the host (t0-hv) and nothing about it is attested.
- `survey()` answering `{"vms":[]}` on a host with no `Get-VM` is not "no VMs": `Get-VM -ErrorAction SilentlyContinue`
  yields nothing when the command does not exist, so survey and teardown read as clean on a host where they cannot
  enumerate at all (defect 7, low, sent to the owner).
- No SNP, no VMPL, no TEE on this box. Nothing here is "attested" or "verified".
