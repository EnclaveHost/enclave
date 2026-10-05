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
identity, limits simultaneous connections to eight, and bounds stalled writes to 60 seconds. Lifetime zero uses supervisor stdin
EOF to close every link. Idle reads remain open so an idle app retains its
reservation; the partition lifecycle owns the bridge.
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

## Hosted-app release, 2026-09-29

The production manager accepts V4 measured inference bundles when its pinned
Shield profile and worker are ready. The same model and allocation are checked
by the scheduler, manager, and guest. The initial profile serves public
`wasi:http` apps with `wasi-nn`, Qwen2.5-0.5B Q8, 500–1000 GPU milli,
at least 250 CPU milli, and 8192 MiB of declared app memory. This is not an
arbitrary model-volume service, a graphics/encode API, or a 27B profile.

The CPU runtime and image remain separately pinned. Inference runs in measured
Wasmtime 49 with the existing ggml-shielded engine, model, and a private
UID-checked Unix broker. Masking, nonlinear operations and result verification
stay in the app guest. The host bridge binds one VM and transports masked
worker messages. The broker uses `/run/enclave-shield/gpu0`; the TLS front and
report socket remain inaccessible to the app UID under `/run/front`.

The native engine treats Shield as an ACCEL backend, so `N_GPU_LAYERS=0` is
intentional: setting -1 demands a normal GPU and refuses the graph. The budget
variable is `ENCLAVE_VRAM_BYTES`; neither knob is supplied by the app or host.

The manager reserves shares before launch, retains them on uncertain failures,
and releases them only after confirmed removal. Recovered or unattributed VMs
hold all GPU capacity until reconciled. A manager restart requires controlled
partition relaunch; recovery does not rebuild live relays. Worker failure
withdraws the profile on the next health refresh (15 seconds). The node only
advertises a fresh ready profile, and cannot claim the entire physical 16-GiB
UMA allocation. The current worker pool is 12 GiB, leaving 4 GiB outside
the hosted budget. The initial rollout used a 4-GiB pool.

A real WASI canary generated 16 tokens at 15.69 tok/s (single short warm run).
The worker confirmed a 4-GiB reservation; full fresh-nonce app/runtime/TLS
hardware evidence verification passed. Build and model pins are recorded in
[`gpu/hosted-nucbox-20260929.json`](gpu/hosted-nucbox-20260929.json).

Certificate selection uses the runtime pinned for the deployment's CPU/GPU
profile. Preserve the production `certNameFor`/`--cert-name` handoff: the
monitor needs it to expose CSR and certificate-install endpoints. The raw-CID
fetch path hashes the bounded raw block directly; DAG-PB continues to use CAR
block verification. A gateway's inability to export a raw CID as CAR cannot
bypass content verification.

The existing owner-only T0-hv classification is unchanged. Successful app
binding verification does not establish malicious-host exclusion and does not
enable general marketplace admission.

Production acceptance: two owner-created catalog deployments (`fa8d0ea5` and
`2bad651c`) each ran with 500 GPU milli / 2 GiB. Both public HTTPS names passed
WebPKI verification and the full fresh-nonce app evidence check, then generated
16 tokens. Short warm responses measured 15.62 and 9.12 tok/s respectively;
these are not comparable to a sustained dedicated GPU benchmark. Both CPU
apps remained served after the controlled relaunch, with HTTP 200. Killing the
worker withdrew availability; confirmed teardown released all reservations.
With both inference apps loaded the worker reported 4 GiB reserved / 0 free.
Secure Boot remains enabled, testsigning is absent, and the legacy engine is
not started.

The certificate naming patch is preserved from `enclave-m4name` (719133eed);
its existing production launcher binary is pinned at
`10547aca82ad48be021828164cd11a649cd324e37932b388449f3f44530929ba`.

## Twelve-GiB pool update, 2026-09-29

The guest, manager profile, and worker now use the same 12-GiB pool. The guest
derives a 6-GiB reservation for each existing 500-milli app from its measured
allocation; this is not a dashboard-only capacity override. Shares and deployment
identities are unchanged, so two half-pool apps still reserve 100% of the pool.
The guest image was rebuilt deterministically with debug and measurement-mutation
checks. The prior 4-GiB image and worker/profile configuration are retained for
rollback. Current pins and production checks are recorded in
`gpu/hosted-nucbox-12g-20260929.json`; the preceding figures document the initial
4-GiB release.
