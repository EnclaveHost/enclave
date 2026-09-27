# Explicit catalog resource profiles (staged; not deployed)

The current policy fixes every isolated app version at one vCPU. That prevents
a SET worker from running concurrently with its emulator even when the
deployment purchases enough CPU. RISC Box's local streaming tests average
about 20 game FPS in this shape. This proposal enables an explicit larger shape;
it does not claim a measured frame-rate improvement yet.

The publisher may put this metadata in a **new immutable catalog version's**
inline config (the on-chain routing manifest when bulk config uses a CID):

```json
{"_isolationPolicy":{"rule":"enclave-isolation-policy/2","vcpus":2}}
```

Other app config may coexist with it. Deployment config overrides, purchased
shares, host reports and fallback sizing never select the shape. There are
exactly two fields in the metadata object: the rule above and an integer vCPU
count from 1 through 16. Unknown rules, extra fields and malformed explicit
profiles are refused. Memory is still the immutable on-chain `memMb`, with
the existing 128 MiB floor and the bundle format's 65536 MiB ceiling. CPU quota is
100 percent per vCPU. No metadata means the unchanged policy/1. Existing
valid versions retain byte-identical policies and AppIDs.

This selects inputs to the existing catalog bundle derivation; it does not
change the bundle format. A different shape produces a different AppID and
SNP measurement. A verifier reconstructs the bundle and expected measurement
from the approved version, verified component bytes, policy and pinned runtime
release before releasing configuration or secrets.

## Rollout gates still required

The selector, independent Python reference and supervisor integration are staged
here. They are **not deployed to live scheduling**, and this is not yet a
published resource policy. The inline routing manifest is authoritative; a
profile hidden only in bulk config cannot change the shape.

The staged supervisor carries the immutable inline config separately from a
deployment override through prefetch, claim, launch, restart and version changes.
Persisted older records recover it from the approved catalog before relaunch.
Explicit profiles require sufficient purchased CPU at claim and launch; share
sizing includes that quota, and the existing pool gate reserves the actual
shape. The Windows planner refuses explicit profiles until its matching path
is implemented. CLI and browser publishing retain the metadata in the inline
routing manifest when bulk config moves to a CID.

Remaining gates:

- Update and exercise the production owner's independent expected-identity
  derivation and release preparation with the new version metadata. Verify
  the measurement tool's vCPU input agrees with the bundle policy.
- Validate the full published-version path and restart/migration on a staging
  deployment before rolling out the supervisor. Unit and scripted-manager
  tests do not establish that a production migration has succeeded.
- Benchmark the same RISC Box artifact, guest snapshot, resolution, sound and
  input workload. Do not report synthetic worker throughput as game FPS.
- Publish the new version through the owner's normal signing flow and release
  secrets only to its independently verified identity. Preserve rollback and
  the original gameplay snapshot.

## Staging evidence (2026-09-27)

The unchanged RISC Box 0.6.54 component and all its declared HTTP, SSH and
GameStream ports were bundled independently in Go and Python. The complete
bundle bytes agree for 1-, 2- and 4-vCPU shapes. The one-vCPU bundle reproduces
the existing production AppID exactly.

An isolated **unconfigured** two-vCPU canary used the pinned production domain
release, 3072 MiB app memory and a 200% CPU quota. Its fresh AMD-verified report
matched the independently reconstructed measurement, pinned runtime and AppID;
the verifier also checked the runtime W^X/seccomp evidence. Supplying either
the old one-vCPU measurement or AppID refused access with zero application
requests. The canary was stopped after the checks. It received no production
configuration or secrets and did not replace the live app.

This confirms that the candidate shape boots and attests, **not** that Doom is
faster. Full-workload benchmarking and the rollout gates above remain pending.
The experimental derivation records use version 54 to compare only the shape;
they do not change or authorize the actual catalog version's policy.

The staged integration passes 61 resource-policy, claim, reservation, release,
restart-input and cross-platform tests, plus 31 existing sizing, version-switch
and publishing regression tests. These include refusing an underfunded launch
and missing immutable metadata before posting any VM request.
