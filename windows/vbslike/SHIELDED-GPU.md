# Masked GPU transport on NucBox

The new Hyper-V guest can reach the Windows Radeon Vulkan worker through
`shielded-bridge`. The bridge is an **untrusted byte transport**, not an
inference service or an admission decision. Masking, pad generation, result
recovery and verification run in the guest using the existing ggml-shielded
implementation. Neither prompts nor a plaintext inference API belong in this
bridge.

Build on Windows with `cargo build --release --bin shielded-bridge` in `host/`.
The diagnostic invocation is:

```
shielded-bridge <partition-guid> 19595 19595 180
```

The final argument bounds its lifetime in seconds. It connects only to
`127.0.0.1:<worker-port>`, binds one explicit partition, checks accepted peer
identity, limits simultaneous connections to eight, and closes stalled links
after 60 seconds. The deadline and idle policy are for qualification; persistent
app reservations need the same lifecycle handling as the existing Linux broker.
It never modifies guest or host admission, opens a public TCP listener, or
enables a retired enclave engine.

WMI-created partitions require a registered Hyper-V socket service. For guest
port 19595 its GUID is `00004c8b-facb-11e6-bd58-64006a7986d3`. Register only that
service under `GuestCommunicationServices`, start the partition before binding,
and remove a diagnostic registration after the test if the test created it.
Do not alter the wildcard security descriptors. See Microsoft's
[Hyper-V socket integration guide](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/make-integration-service).

## Hardware result, 2026-09-29

A disposable type-1 VBS/OpenHCL guest, using the production CPU image's patched
paravisor and TPM transport, ran the C `shielded-probe` through this bridge to
the Radeon 780M worker. Guest output reported:

```
exact=true verified=true lie_rejected=true denylist_refused=true
local_identical=true reply_width=3 packed_identical=true verify_fail=0
K=512 N=256
```

Probe firmware SHA-256:
`551810133aeb0473a601423ff2ed0d0528886dc7ae18b5337c6d7d08fcc1f685`.
VBS launch digest:
`23fdb30db2f30a0f2d387b4418102dcdae1ffd7057fbac8701acb0ed48f3739c`.
The image was built twice with identical output; the pinned debug and mutation
checks were also built. This is a public-fixture diagnostic image, **not an
allowlisted production app image**. The test does not establish malicious-host
exclusion or qualify inference performance.

The host-side reference probe separately measured about 174 G-MAC/s, a 4-GiB
configured budget and a 0.77-ms warm matrix round trip. These are kernel metrics,
not tokens per second. They must not be published as app throughput.

A subsequent native public-fixture inference test in a separate 4-vCPU,
8192-MiB type-1 guest produced 32 tokens from Qwen2.5-0.5B-Instruct Q8 at
**12.37 tok/s**, with 1,783 offloaded nodes, 626 local nodes and zero verification
failures. Five prompt tokens took 2970.6 ms to prefill. The engine reported
contention and used its verified local path for some work. This was a single
short diagnostic run, not a hosted WASI app, production benchmark or 27B result.
The complete model was included in the measured image; accommodating it moved
the paravisor base from 128 MiB to 1 GiB in the diagnostic manifest. The resulting
image passed deterministic twin and measurement-mutation checks.

[`gpu/nucbox-20260929.json`](gpu/nucbox-20260929.json) records image/model/evidence
hashes and counters. `gpu/inference-probe-init.c` is the diagnostic wrapper; it
logs only a fixed public fixture and must stay out of production images.

## Remaining production integration

`PARTITION_OFFERS.gpu` remains false. The current hosted-app runtime has no
model-volume delivery or admitted inference profile. Do not toggle the offer
based on this transport test. A complete release needs:

1. A measured GGML runtime and hash-pinned model profile, reusing the Linux
   Shield engine, with masking and nonlinear work inside the per-app guest.
2. A private, credential-checked guest broker for the runtime (WASI apps must
   not gain arbitrary host socket access), supervised with its partition.
3. Model/allocation binding, atomic GPU reservation and recovery, worker-failure
   withdrawal, and matching node/manager/scheduler capability checks.
4. An actual catalog app performing inference, its full app/TLS evidence chain,
   restart/adoption and teardown checks, before the fleet advertises capacity.

The existing owner-only classification is unchanged by this work.
