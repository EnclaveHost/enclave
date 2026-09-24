# Deriving a contract bundle from a catalog version

`derive.go` is the rule. `derive_reference.py` is an independent implementation written from this page. It
generates `derive_vectors.json`, which `derive_test.go` must reproduce exactly.

## The rule, `enclave-catalog-bundle/1`

Inputs. Every one is explicit, and none has a default:

| field | what | in the bundle? |
|---|---|---|
| `derivation` | `"enclave-catalog-bundle/1"` | no; it selects this rule |
| `catalog.app`, `catalog.version` | the catalog's bytes32 app id (`0x` + 64 lowercase hex) and version index | **no** |
| `cid` | the component's CID as the catalog version names it | no; the component's sha256 is |
| `policy.cpuPercent`, `policy.memMiB`, `policy.vcpus` | the domain's pinned share | **yes** |
| `runtimeId` | the 64-hex RuntimeID (`runtime.go`) the mapping is pinned to | **no**; it is bound in `report_data` by Bind2 |

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
2. **A backend that runs the BARE artifact names the same app differently.** `bundle.go` allows a bare artifact
   whose AppID is `sha256(bytes)` (M3a's monitor accepted one). The same catalog component would then carry two
   identities on two backends. The portable identity for a catalog app is the derived bundle's AppID, so a backend
   meant to be comparable must run the derived bundle and not the bare component. No backend was changed here.
3. **The supervisor's app reference is `ipfs://<cid>` today.** The per-app manager needs the record as well.
   `guestd` takes it as `derive` on `/prefetch` and `/vms`, and refuses a CID without one. The supervisor does not
   send it yet: that wiring is part of C3/C7 in `isolation/DEPLOYMENT-PATH.md`.
4. **Which policy a catalog version pins is not decided by this rule.** The rule takes it as an explicit input. A
   deployment-independent choice (for example, from the version's declared minimums) keeps one AppID per version.
   A per-deployment choice gives each shape its own AppID. Either is sound. Whoever wires the supervisor must pick
   one and record it here.
