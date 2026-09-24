# The Windows app manager

The supervisor's `/vms` contract, backed by one Hyper-V partition per app. It is the Windows
counterpart of the Linux SNP tier's manager and shares its rules rather than paralleling them:
same derivation, same AppID, same policy rule, same refusals, same backend-name field.

| | |
|---|---|
| backend | `hyperv-partition-per-app` |
| derivation | `enclave-catalog-bundle/1` |
| policy | `enclave-isolation-policy/1`: vcpus 1, memMiB = the version's on-chain memMb (floor 128), cpuPercent 100 |
| supports | `gpu`, `secrets`, `egress`, `config`, `ports`, `configCid` all false |
| attestation format (reserved) | `hyperv-vbs-partition-v1`, a sibling branch in the judge, agreed with the SNP lane and **not yet defined** because no report exists to define it against |

## What is finished

`derive.mjs` is a third implementation of `enclave-catalog-bundle/1`, after the Go rule and the
Python reference. It is allowed to exist only because `isolation/contract/catalog/derive_vectors.json`
can refuse it: `derive.test.mjs` reproduces every accepted case byte for byte (AppID, record hash,
bundle size, component hash) and every refusal, including the CID rule, so a Windows domain and a
Linux domain name the same app identically.

`server.mjs` is the contract surface: `/health`, `POST /vms`, `GET /vms`, `GET /vms/:id`,
`DELETE /vms/:id`. It pins the policy from the version's declaration with no default, and it
refuses a GPU share, app config, secrets, declared ports, volumes, a private deployment and
protection rules **again** on this side of the wire - the supervisor's gate already refuses them,
and two gates in two processes is the point.

## What is not

`backend.mjs` is the seam, and it cannot start a partition. That is established, not assumed:

- Microsoft's supported way to give a VM a custom IGVM is **WMI, not HCS**. Their own
  `openhcl/Set-OpenHCL-HyperV-VM.ps1` uses `root\virtualization\v2`, setting
  `Msvm_VirtualSystemSettingData.FirmwareFile` and `GuestFeatureSet = 0x00000201` and applying it
  through `Msvm_VirtualSystemManagementService.ModifySystemSettings`, on a VM of version >= 12.0
  from the Hyper-V PowerShell module.
- This host has none of it: every Hyper-V feature `Disabled`, only `VirtualMachinePlatform`
  enabled, `vmms` not installed, `Get-VM` absent, `root\virtualization\v2` answering
  "Invalid namespace".
- HCS accepts `SecuritySettings.Isolation.IgvmFilePath` and the worker then logs
  `Loading IGVM file from default location` for every partition. That acceptance is meaningful:
  an invented key in the same object is refused as an invalid document, so the schema *recognises*
  the field and the worker does not act on it here. **Our image has never been loaded.**

So `start` throws with that reason and names the prerequisite. A domain that did not run is
`failed` with the reason attached and **no `attestation` field at all** - not null, not "pending".
Nothing here produces a report, and `running` is not `attested` either.

## Running it

```
node windows/vbslike/manager/main.mjs        # loopback only; the supervisor reaches it over guestd-control/1
node --test windows/vbslike/manager/*.test.mjs   # derivation vectors + the contract surface
```
