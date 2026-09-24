# Deriving a contract bundle from a catalog version

`derive.go` (package `enclave.host/isolation/contract/catalog`) is the rule. `derive_reference.py` is an independent implementation written from this page. It
generates `derive_vectors.json`, which `derive_test.go` must reproduce exactly.

## The rule, `enclave-catalog-bundle/1`

Inputs. Every one is explicit, and none has a default:

| field | what | in the bundle? |
|---|---|---|
| `derivation` | `"enclave-catalog-bundle/1"` | no; it selects this rule |
| `catalog.app`, `catalog.version` | the catalog's bytes32 app id (`0x` + 64 lowercase hex) and version index | **no** |
| `cid` | the component's CID as the catalog version names it | no; the component's sha256 is |
| `policy.cpuPercent`, `policy.memMiB`, `policy.vcpus` | the domain's pinned share | **yes** |
| `runtimeId` | the 64-hex RuntimeID (`../runtime.go`) the mapping is pinned to | **no**; it is bound in `report_data` by Bind2 |

The component bytes are fetched by CID and verified against it by the host's fetcher. On the M4a host that is
`wasm/ipfs_fetch.py`, the platform's own CAR verifier. The bytes must begin with the component preamble
`00 61 73 6d 0d 00 01 00`. A core module is refused.

Output. The bundle is `Build(Manifest{abi: "enclave-domain-abi/1", world: "wasi:http", policy}, component)`:
- the label is empty, so omitted;
- the artifact kind and sha256 are set from the bytes;
- `AppID = sha256(bundle)`.

This is byte-for-byte what `bundle build -cpu C -mem M -vcpus V <component>` produces, so a publisher, a verifier
and every backend reach the same AppID from the same inputs.

The mapping stored beside it is keyed by `recordSha256 = sha256(canonical JSON of the record)`. It holds
`{record, recordSha256, componentSha256, componentBytes, appId, bundleBytes}` and is immutable.

## Consequences, stated so nobody infers the opposite

- **The same component under another catalog version or app gives the same AppID.** Only the record differs. The
  AppID names the app, not where it is listed. A verifier checks that the catalog version's CID yields the component
  hashed into the bundle.
- **Another pinned policy gives another AppID.** The contract makes the manifest's policy the domain's share
  (`EffectivePolicy`), so the policy is part of what was attested. The supervisor's per-deployment share does NOT
  flow into the bundle; the record pins it.
- **Another pinned runtime gives the same AppID but a different record.** A mapping is refused on a host whose
  runtime is not the one pinned, so a verifier's expected runtime identity is the record's.
- **A new rule is a new version.** Any change to how the manifest is built becomes `enclave-catalog-bundle/2`.
  Records under `/1` keep deriving exactly what they always did.

## Incompatibilities with existing semantics

These are documented, not remapped:

1. **The catalog CID is not the AppID and is not `sha256(component)`.** For a dag-pb CID it is a DAG hash. Nothing
   treats one as the other. The report names the derived AppID, and anyone can recompute it from the catalog
   version's bytes and the record. The chain is unchanged.
2. **A backend that runs the BARE artifact names the same app differently.** `../bundle.go` allows a bare artifact
   whose AppID is `sha256(bytes)` (M3a's monitor accepted one). The same catalog component would then carry two
   identities on two backends. The portable identity for a catalog app is the derived bundle's AppID, so a backend
   meant to be comparable must run the derived bundle and not the bare component. No backend was changed here.
3. **The supervisor's app reference is `ipfs://<cid>` today.** The per-app manager needs the record as well.
   `guestd` takes it as `derive` on `/prefetch` and `/vms`, and refuses a CID without one. The supervisor does not
   send it yet: that wiring is part of C3/C7 in `isolation/DEPLOYMENT-PATH.md`.
4. **Which policy a catalog version pins is not decided by this rule.** The rule takes it as an explicit input. The
   branch's working assumption is below. Production policy is a separate decision.

## Reproducing an AppID from the catalog alone

A verifier needs the component's bytes, fetched by its CID from any IPFS gateway and hash-checked against the CID
(the gateway is untrusted: it decides availability, never content). On 2026-09-24 the canary's component
`bafkreibjbefi32gvjrd54lhdizq6zlywym6urcuztzvi455xfv23tyjnza` was NOT served by ipfs.io, dweb.link or Cloudflare, and
WAS served by `https://trustless-gateway.link/ipfs/<cid>?format=raw` with `Accept: application/vnd.ipld.raw` (that
gateway refuses Python's default user agent). Then `derive_reference.py bundle <record.json> <component> <out>` gives
the bundle whose sha256 is the AppID. The platform's own gateway also serves it:
`https://ipfs.enclave.host/ipfs/<cid>` (the verifier lane fetched the 72,989 bytes there, sha256 29090a8d..., and
reproduced AppID 9c3d10f1... with derive_reference.py). A verifier should use either and check the CID itself.

## Production policy for the per-app tier: `enclave-isolation-policy/1` (2026-09-24)

The production canary pins each catalog version's policy by a published rule over the version's IMMUTABLE on-chain
record, so it is explicit, fixed per version, recomputable by anyone, and never read from a deployment:
`vcpus` 1, `memMiB` = the version's on-chain `memMb` (floor 128), `cpuPercent` 100 (supervisor.js
`isolationPolicyFor`). A catalog field for a publisher-chosen policy remains possible later; it would be a new rule
name, so it cannot silently remap an existing AppID.

## Branch design assumption: one fixed, explicit policy per catalog version

Recorded 2026-09-24 as the assumption this branch builds on. It does NOT change the catalog, anything on chain,
or any production policy, and it does not remap any existing identity.

**Where the policy comes from.** Each catalog version has ONE policy (`cpuPercent`, `memMiB`, `vcpus`), supplied
with the version as an explicit, published input and recorded in every derivation record for it. It is never
derived from a deployment, never defaulted, and never changed after the fact. How the platform publishes it (a
catalog field, or a manifest beside the version) is a production decision and is not made here.

**Why per version.** It gives one AppID and one expected measurement per version, and that is what a verifier
pins. Deriving the policy from each deployment's purchased share would give every deployment shape its own
identity, and a verifier would have to know the shape to know the app.

**How each field is enforced, and by whom:**

| field | what it becomes on the per-app backend (guestd) | enforced by | attestable? |
|---|---|---|---|
| `vcpus` | the guest's vCPU count | the SNP launch: it is part of the MEASUREMENT (one VMSA per vCPU), so a guest booted with another count fails verification | yes |
| `memMiB` | guest RAM = max(1024, memMiB + 384) MiB (the kernel and the runtime's floor); the unit's MemoryMax adds 768 for QEMU | the VM boundary (the guest cannot use more) and the host cgroup | no: an availability property the host controls |
| `cpuPercent` | the QEMU unit's CPUQuota | the host cgroup | no: CPU time is the host's to give, and no report can prove it |

**Scaling and resizing:**
- **More capacity means more instances, not bigger ones.** N deployments of one version are N guests with the
  SAME AppID and the SAME expected measurement. What tells them apart is each guest's own transport key, bound in
  its report, never the measurement.
- **A deployment's purchased share does not change the guest.** A claim gate on the per-app tier must refuse a
  deployment whose purchased share is below what the version's pinned policy needs. A larger purchase does not
  enlarge the guest. That check belongs to the supervisor wiring (C3) and is NOT built yet.
- **Resizing a running isolated app is not a share change.** `setShares` cannot alter a running guest's shape
  without changing what was attested. On this tier a different shape is a new version with a different pinned
  policy, and so a new AppID and a new measurement. The supervisor's resize path must refuse it for this tier or
  treat it as a version switch. Not built yet.
- **Rollback to an earlier version returns its earlier policy.** It is the same record, so the same AppID
  (guestd's store returns the identical mapping, `TestVersionsAndRollbackAreImmutable`).
