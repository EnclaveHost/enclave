# VBS-like isolation on nucbox-k11: the blocker list

One list, kept current. Integration owner: this session (enclave-d1).

## The blocker

**1. The Hyper-V role is not installed.** This is the only hardware/host dependency and everything
else waits behind it. The supported way to give a VM a custom IGVM is
`Msvm_VirtualSystemSettingData.FirmwareFile` applied through
`Msvm_VirtualSystemManagementService.ModifySystemSettings`, in the WMI namespace
`root\virtualization\v2`. That namespace answers "Invalid namespace" here, `vmms` is not installed
and `Get-VM` does not exist; only `VirtualMachinePlatform` is enabled.

- Needs: `Microsoft-Hyper-V-Hypervisor`, `Microsoft-Hyper-V-Services`,
  `Microsoft-Hyper-V-Management-PowerShell`, then **one machine reboot**.
- Eligibility is settled: Windows 11 Pro, 26200.9457, hypervisor already running for VBS.
- Plan, with the boot probe and rollback: `windows/vbslike/manager/HYPERV-ROLE.md`.
- Status: **prepared, not approved.** Steven approved a node PROCESS restart, not a machine reboot.

## Not blockers, stated so nobody waits on them

- Security proof. Boot first; tests and hardening follow the working path.
- The `vmchipset.dll` crash on HCS isolated starts. That is the unsupported path; the supported path
  is WMI and is untested here. It may be irrelevant.
- Attestation format `hyperv-vbs-partition-v1`. Agreed as a sibling judge branch with the Linux
  lane, to be defined against a real report rather than guessed.
- `enclave-catalog-bundle/2` serving. Derived and matching; serving needs the partition first.

## The no-role HCS path: a development vehicle, not the target

`backend-hcs.mjs` drives the existing Rust launcher to run one Hyper-V child partition per app
today, with no role and no reboot. It exists so the stack ABOVE the boundary - bundle delivery,
readiness, the data plane, a real app on a real route - can be built and proven while the reboot
decision is pending.

It is **not** the completion target and must never be presented as one. An HCS child partition does
not exclude the host; the guest says so itself (`boundary tier=t0-hv partition=hcs-child
host_excluded=no`) and the backend carries that word up rather than letting it be lost. Nothing it
runs may be advertised as eligible, verified or host-excluded capacity. The moment the role is
approved, the custom IGVM boot takes priority over anything further on this path.

## What is ready and waiting on that one thing

| piece | state |
|---|---|
| WMI launcher (create, pin, verify read-back, start, guest console, exact-name cleanup) | written, 68 tests, all mocked |
| manager `/vms` contract, policy, refusals | written and tested |
| `guestd-control/1` server | written, proved against the supervisor's own client |
| derivation `/1` and `/2` | byte-for-byte against the shared vectors |
| CID-verified component fetcher | written and tested against a local fixture |
| bounded PowerShell runner, entrypoint wiring | written |

## Live service, kept separate from all of the above

All six apps on nucbox-k11 are serving as of 21:33Z. The node runs the deployed bytes recorded at
`ef1b2077` (`170a0db0…`, `d2595f35…`, `6ec96d19…`), NOT this branch's `windows/node/` - shipping
those puts it into owner-only scope. Do not run `sync.sh` as part of the role change.
