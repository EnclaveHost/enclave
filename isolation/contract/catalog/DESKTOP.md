# Experimental masked desktop contract

`enclave-catalog-bundle/8` describes a portable Wasm controller with a fixed,
measured native desktop companion. V8 remains absent from the ordinary
`DERIVATIONS`, and ordinary `contract.Parse` refuses desktop bundles. The
native build uses `ParseDesktop`; the Windows manager has a separate opt-in
admission path. Identity validation alone establishes neither a working
desktop nor permission to release owner secrets.

The separate version is necessary because the existing V5–V7 configuration and
sealed-secret rules refuse the inference profile. Those rules retain their
meaning. V8 does not permit arbitrary inference or an unmasked device: it names
one desktop profile with a reserved GPU share and separately delivered owner
credentials. The artifact remains a Wasm component; native binaries are inputs
to the measured platform image.

## Identity

Every record field is required. Unknown fields are rejected, including nested
profile/policy/catalog fields. No shell, image path, passthrough device or
caller-selected security mode exists in this contract.

| Field | Requirement |
|---|---|
| `derivation` | `enclave-catalog-bundle/8` |
| `catalog` | Exactly `app` (`0x` plus 64 lowercase hex) and `version` (uint32) |
| `cid` | Existing catalog CIDv0/base32-CIDv1/base58-CIDv1 syntax |
| `runtimeId` | Nonzero 64 lowercase hex; separately bound in report data |
| `policy` | Exactly `cpuPercent` 400–1600, `memMiB` 8192–65536, `vcpus` 4–16 |
| `http` | 8000, the controller's `wasi:cli` HTTP listener |
| `ports` | Exactly the ordered destinations below |
| `secretDeployment` | Nonzero `0x` plus 64 lowercase hex |
| `configBase64` | Canonical padded base64 of 1–32768 bytes of UTF-8 JSON object text, without NUL bytes |
| `desktop` | Exactly `profile`, `profileSha256`, `gpuMilli` |

`desktop.profile` is `kvm-box-masked-v1`; `gpuMilli` is an integer from 500 to
1000. `profileSha256` is a nonzero lowercase SHA-256 of the **pre-image input
descriptor**, which must commit the kernel, companion root filesystem/SDK,
controller component, model and public-weight policy, and measured launch
inputs. It cannot be the final image hash: embedding that would be circular.
An independently authenticated release must pair this descriptor with the
final image measurement and runtime identity. The hash is a commitment, not
proof that a caller's selected profile is approved.

The protected tunnel destinations, in order, are:

```json
["tcp:47984","tcp:47989","tcp:48010","udp:47998","udp:47999","udp:48000"]
```

Public configuration bytes are preserved exactly, including JSON whitespace.
JSON object/array nesting is limited to 10000 levels, including the root object,
matching the guest Go decoder; duplicate keys cannot hide excessive nesting.
Base64 is an encoding, not encryption. Passwords and credentials must use the
sealed-secret channel; they must not be placed in the public configuration,
profile descriptor or shared image. The contract binds a deployment identity
but does not establish wallet ownership or secret-release authorization.

The manifest contains `abi`, `artifact`, `world`, `policy`, `http`, `ports`,
`desktop`, `configBase64`, and `secretDeployment`. It has no label. The artifact
kind is `wasm-component`, and `world` is `wasi:cli`. Canonical encoding and the
bundle envelope are unchanged. AppID is SHA-256 of the whole bundle. Catalog
reference/CID and RuntimeID affect the mapping record hash; they do not enter
the bundle. Changing the descriptor, GPU share, configuration, deployment,
component or resource policy changes AppID.

## Required runtime integration before admission

The deployment planner, manager, image selector, guest monitor, native companion
supervision, worker reservation and release verifiers must all agree on the
same approved profile. A minimum implementation must:

- Match the catalog component, descriptor, runtime and final image against
  authenticated release pins before launch and before secret delivery.
- Bind owner authorization to the actual deployment; no host-generated random
  label or embedded password hash substitutes for that authorization.
- Enforce one desktop domain per boot and tie companion/bridge lifetime to the
  controller. Desktop processes must not access monitor/TPM/report channels.
- Preserve authenticated public-model storage, trusted pad/verification state,
  masked-only GPU transport and CPU fallback for unsupported operations.
  An integrity failure after offload must terminate the operation.
- Supply native llama.cpp/sd.cpp and the normal GPU-facing API, Firefox,
  Fluxbox, FreeDoom, Sunshine, protected Moonlight transport and desktop input.
- Refuse stale/wrong images, profiles, runtimes, components, account bindings,
  unreserved workers and unauthorized tunnel destinations before use.

V8 by itself supplies none of those mechanisms. Unit vectors are identity
checks, not attestation, isolation, numerical-quality or speedup evidence.
The current NucBox physical operator/hypervisor trust assumptions also remain;
this contract does not turn its VBS backend into SNP operator exclusion.

## Independent check

`desktop_reference.py` is Claude's independent implementation from the spec,
with an explicit decoder-depth bound added during integration;
`desktop_vectors.json` is generated by it. Go and JavaScript compare complete
bundles and mappings against those vectors and enforce all refusal cases.
Legacy vectors remain unchanged. The experimental parser split also tests
that existing runtimes refuse V8 rather than silently running only its Wasm
controller and discarding the desktop requirements.


## Dedicated Windows launcher

The optional `WmiHyperVLauncher` desktop role now validates the complete V8
mapping against `desktopPlatform` before its first asynchronous operation. The
configuration pins the IGVM, RuntimeID, canonical profile text and digest, and
three ISO descriptors. Payload hashes and geometry must match the profile;
the controller, public-web configuration and runtime must match the rederived
bundle. Configuration is public metadata, not owner authorization.

The launcher requires the native worker service registration, pinned Hyper-V
utilities and VMGS master, worker/egress transports, and app delivery. It creates
a separate type-1 partition, attaches the three pinned read-only optical media,
and requires the monitor's ready signal before opening transports. A missing
or already-exited transport refuses app delivery. Other image roles refuse
desktop mappings. The measured guest repeats profile and capacity checks.

Host RAM uses `align2(appMiB * 3 / 2)` rather than the ordinary launcher rule.
The 8192-MiB app / 12288-MiB partition case is qualified on NucBox; larger sizes
are an allocation policy, not measured capacity evidence. The manager must
reserve the full partition size and the desktop's GPU share before calling the
launcher, and hold those reservations until removal and transport cleanup are
confirmed. The optional manager admission path now enforces both reservations;
it is not enabled on production hosts by these source changes.

The manager's optional `NODE_VM_RAM_GB` budget now accounts for the full VM
allocation of its currently served images, separately from purchased app RAM
(`NODE_APP_RAM_GB`). The operator must subtract Windows and unrelated workloads
before choosing this budget; it is not a probe of free host memory. Reservations
are made synchronously before launch and remain held after launch, readiness or
cleanup failures. Recovered or ambiguous allocations block further admission.
The launcher must report the reserved allocation exactly; a discrepancy fails
the domain and retains a conservative or unknown reservation until removal.
Native admission requires this budget and uses the desktop allocation rule
instead of the ordinary type-1 rule. V8 is advertised only when its separately
configured image, worker and host preflight are available.

Failed launches retain private cleanup handles, including the worker carrier,
for the manager to retry on removal. VM absence alone cannot release a GPU
reservation when carrier closure remains uncertain. These capabilities are
excluded from public records and error serialization.
CPU launches without a returned VM handle also require a successful inventory
before removal can release their record. Concurrent deletes share one cleanup
attempt. Liveness checks only evaluate handles present before the host survey
began, so an earlier snapshot cannot fail a newly started VM.

NucBox qualification exercised this launcher through `MON ready` and then an
intentional failure before worker admission. The exact VM was removed and its
VMGS archived; the existing VMs and master remained unchanged. This is boot and
cleanup evidence, not owner-release, controller-execution or GPU acceptance.
The detailed evidence is retained in `native-launch-integration` alongside the
previous native platform and media qualifications.

## Native manager configuration and remaining qualification

`ENCLAVE_DESKTOP_CONFIG` and `ENCLAVE_DESKTOP_CONFIG_SHA256` select a public JSON
file bounded to 64 KiB. Its exact fields are:

| Field | Meaning |
| --- | --- |
| `imagePath` | The dedicated native IGVM path. |
| `platform` | Raw `desktopPlatform` configuration: IGVM and runtime hashes, canonical profile text/hash, and the three pinned ISO descriptors. |
| `runtime` | Complete runtime identity; its digest must equal the platform RuntimeID and describe an x86_64 JIT. |
| `bridge` | Exactly `{exe, sha256}` for the authenticated native worker bridge. |
| `workerPort` | Local worker TCP port; the guest reaches only the authenticated per-VM bridge. |
| `workerBudgetGb` | Worker budget in GiB, checked against its non-reserving HELLO. |

The existing legacy image, runtime identity, pinned wmiserve/egress utilities,
VMGS master and Hyper-V utilities remain required. Native configuration also
requires `NODE_APP_RAM_GB`, `NODE_VM_RAM_GB`, and all four of
`ENCLAVE_CONFIG_BUNDLE_V5`, `ENCLAVE_SECRETS_V1`,
`ENCLAVE_CONFIG_SOCKET_SERVER_V1`, `ENCLAVE_PROTECTED_PORTS_V1` set to `1`.
Native launch always uses linux-direct boot, even if the legacy image uses a
UEFI medium. All routed launchers share the VM inventory and cleanup paths.

The manager rederives the bundle against the pinned controller/profile/runtime,
binds its sealed-secret deployment name, checks purchased GPU share, and takes
an owned request snapshot before fetching the component. Both reservations
exist before the launcher starts. Returned image, runtime, profile, allocation
and transport statements must match. A launcher `appReady` flag cannot bypass
native readiness: the judge receives the desktop runtime identity and its
linux-direct image statement. Existing owner-secret verification is unchanged.

Desktop preflight and worker availability are separate from existing roles.
Worker HELLO must report reservation-capable protocol 1.3 or later in major 1,
and the configured budget. This proves protocol availability only. A read-only
NucBox probe reported protocol 1.4.0, Radeon 780M, a 12-GiB budget and zero
reservations; it did not execute GPU work or authorize a deployment.

Unit and injected lifecycle tests cover malformed or contradictory requests,
wrong images/runtimes, simultaneous reservations, worker revocation, late
readiness, cleanup failure and legacy regressions. Native node planning,
owner-release/controller execution, Moonlight routing, real GPU quality and
performance, and wallet publication still require completion and end-to-end
qualification. The app remains a draft and the existing compute menus remain.

## Independently approved desktop release

The shared `relay/shield-desktop-release.mjs` validates an explicit public
`enclave-desktop-release/1` record. Its exact fields are `schema`,
`controllerCid`, `controllerSha256`, `runtimeId`, `igvmSha256`,
`profileSha256`, `launchMeasurement`, `minimumCpuMilli`, and
`policy: {cpuPercent, vcpus}`. Hashes are nonzero lowercase SHA-256 values;
the IGVM file hash and VBS launch measurement are distinct pins. This record
does not authorize a host or attest hardware.

`desktopRecordFor` builds the V8 identity from that release and a public catalog
purchase. It checks CPU/GPU shares, catalog memory, the exact HTTP/Moonlight
port set, `egress: "public-web"`, and absence of external volumes. Configuration
uses the existing `appConfigText` serialization, with store `_media` omitted;
the serialized bytes are measured as base64. `deriveApprovedDesktop` separately
checks the record's release pins and the portable Wasm controller's content
hash. Callers must build from independent ledger/catalog inputs; supplying an
arbitrary record to the derivation function is not purchase authorization.

The node's `isolationPlan` accepts an optional independently approved
`desktopRelease`. Only an exact controller CID match selects V8. The native
planner preserves the common tenant, public-app and catalog gates, compares
manager health against the approved runtime/image/profile/controller hashes,
requires native capabilities and staged secrets, and emits the measured V8
body without separate configuration fields. Existing CPU and inference
planning remains the default when no desktop release is supplied.

These are preparatory interfaces: the node Host does not yet load or pass a
desktop release, and relay expectation, evidence-policy and sealed-secret
release integration are still pending. No live admission policy is enabled by
these changes. Manager/relay derivation parity and native planner-to-manager
request checks are automated; real owner release and GPU execution remain
acceptance gates.
