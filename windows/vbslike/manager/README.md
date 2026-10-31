# The Windows app manager

The supervisor's `/vms` contract, backed by one Hyper-V partition per app. It is the Windows
counterpart of the Linux SNP tier's manager and shares its rules rather than paralleling them:
same derivation, same AppID, same policy rule, same refusals, same backend-name field.

| | |
|---|---|
| backend | `hyperv-partition-per-app` |
| derivations (the gate) | `enclave-catalog-bundle/1` only - what this backend can SERVE |
| derives (information) | `/1` **and** `/2`, both byte for byte against the shared vectors |
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

## Physical allocation observations

`GET /health` includes `allocation` (`enclave-manager-allocation/1`). This is
manager-local information, not a shared host allocator or a reservation for the
caller. `managerEpoch` identifies the manager incarnation; `revision` is a decimal
string that changes as requests enter, acquire a domain reservation, finish, or
release a domain, and around inventory recovery. Compare the full observation as
well as the epoch and revision; the revision is not an authorization token.

Every `spawn()` is registered before its first await, including configuration and
component fetches. `requests` contains opaque request identifiers and either
`preparing` with no domain, or `reserved` with the already-held domain identifier.
No request bodies, config URLs or secret values are published. A reserved request
and its matching domain are the same allocation, not two reservations.

`reservations[].physicalMiB` comes from the physical amount reserved before the
native start, not the launcher's later `memory.vmMiB` response. Ambiguous starts
and failed removal keep that reservation. Confirmed removal releases it.
`heldMiB` includes held domains already running; it is **not additional future
growth** to subtract from a fresh free-memory measurement.

`known` is false during preparation or recovery, for unknown/recovered domain
sizes, or without a configured physical pool. Even `known: true` only describes
this manager at this instant. Router queues, other managers, direct RPC VM starts
and future submissions remain outside its authority. A composite router must not
be summed as another independent manager. Existing equal per-manager physical
limits do not establish one shared limit. RPC coexistence still requires a real
shared reservation at every allocator, or enforced disjoint budgets; this field
alone cannot authorize a production RPC start. This source change is not a live
manager upgrade and does not authorize a service restart.

## What is derived but NOT served: `enclave-catalog-bundle/2`

`/2` is a COMMAND that serves HTTP on its own socket (`wasi:cli` plus the version's one declared
`http:N`), rather than a `wasi:http` proxy the runtime serves. The rule is implemented and agrees
with the shared vectors, so an AppID computed here equals the one the Linux tier computes - which is
the whole reason to implement it before it can run.

Serving one is a different thing, and this backend cannot: it needs `wasi:sockets` inside the
partition and an in-guest TLS front proxying to `127.0.0.1:N`.

**So `/2` is absent from `catalog.derivations`, and that absence is the point.** The supervisor
reads that list as "can derive AND run" and acts on it before this process is ever consulted: a
listed rule passes the claim gate, the node takes the lease ON CHAIN, and only then would the spawn
refuse - leaving the deployment to churn through claim, fail and release, possibly sitting Queued
while a Linux box that can serve it is free. Silence in the list is the refusal the gate
understands. The capability is still reported, as `catalog.derives` and
`runtime.v2SocketServer: false`, so nobody has to guess whether the identity would match; and a `/2`
spawn that arrives anyway is refused with its reason.

**One header rule, taken from the Linux tier's open finding F13 and adopted deliberately.** Their
front appends the transport peer as `X-Forwarded-For`, which names the hypervisor rather than any
client. No client address reaches a domain on this path either, so the right header here is NONE.
This backend must not synthesise `X-Forwarded-For`, and must not copy one in from the tunnel, on the
isolated path. Certificate reuse is supervisor-side and needs nothing from a manager.

## What is not

`backend.mjs` is the seam, and it cannot start a partition. That is established, not assumed:

- Microsoft's supported way to give a VM a custom IGVM is **WMI, not HCS**. Their own
  `openhcl/Set-OpenHCL-HyperV-VM.ps1` uses `root\virtualization\v2`, setting
  `Msvm_VirtualSystemSettingData.FirmwareFile` and `GuestFeatureSet = 0x00000201` and applying it
  through `Msvm_VirtualSystemManagementService.ModifySystemSettings`, on a VM of version >= 12.0
  from the Hyper-V PowerShell module. **Superseded for type 1:** a VM made that way never started
  as VBS on nucbox-k11, so `wmi-launcher.mjs` now defines the VM with the recipe that booted and
  served there (`windows/vbslike/ops/uefi-dev-boot.ps1` e0de58cf, type-1 branch): petri's
  `New-CustomVM` from a pinned `hyperv.psm1`, one DefineSystem, read back. Not yet run on Hyper-V
  from the manager.
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
