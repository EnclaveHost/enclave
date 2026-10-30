# Native admission source review and cross-compilation, October 29

Status: source and Linux cross-compilation reviewed; **NOT installed, executed on Windows, or qualified for native admission**. No production configuration, payment, VM, manager or journal changed. No new author is active. All frozen author source and earlier failures remain preserved.

## Author and immutable source

Claude Max on the independently verified account completed invocation `b12c9fa6f7354559910659fee488ffbd`, rc0, session `61368cf8-32b4-4dfc-97a1-9d074e33a3a5`. The single collector completed after the known processes exited. It must not be repeated. Frozen delivery has 10 files, seven changed, none removed; 15,319 readonly inputs have no drift and mutation replay found no outside edits. Manifest SHA256 `ee373193d616bff0eaf7cc58f5c789742fab88af1c26929c65dc78928031ee04`. Root independently checked the frozen files. The full original is committed in `../native-admission-closure-delivery-r1` at `21e31b767359`; `candidate/` here preserves that exact source too.

The delivery explicitly leaves the creator and shared capacity interface unimplemented. Its JSON refusal cases are authored specifications, **not executed tests**. The previous 140 passing JS/operator cases apply to the separate R4 tree, not this C delivery.

## Current defect and separate root repair

Original standalone observer mode branches before creator, domain, image and capacity checks. Given a caller-arranged observer Job and a terminate-capable handle with matching PID/creation, it can terminate a process without proving that target belongs to this test invocation. This is an owned-target authorization defect, not evidence of a privilege escalation: the caller already supplied the handle. The main path's constant `CapacityInterfaceAbsent` refusal does not protect observer mode.

Root changed exactly one product file in the separate `repaired/` tree: `admission-envelope.c` now requires `observer_invocation_provenance()` before observer entry. That independent gate returns `ReadyIdentitiesNotProven`; no argument, JSON, environment setting or future capacity implementation bypasses it. Actual one-shot creator/observer/descendant provenance still must be implemented. This repair disables the unsafe path; it does **not** complete a functioning death observer. Original source and original executable are retained as unqualified evidence and must not be run.

## Actual validation

Both the unchanged original and the separate repaired tree cross-compile successfully with warnings treated as errors using the previously installed clang-cl/LLD, Wine headers and import libraries. `BUILD-REVIEW.md`, both 1,027-input pin lists, commands, output and PE inspection are retained. The author's proposed llvm-mingw toolchain was not used or represented as used. No Windows executable, Wine process or native test was run, and no artifact was uploaded to Windows.

Original build: invocation `2573fe0032b64154b31b407e79f2c928`, exit0, inactive MainPID0; inner peak93 MiB, minimum available32,006 MiB. Repaired build, justified by the source change: `48aeacd901d34845af96f1dc1fc40748`, exit0, inactive MainPID0; inner peak91 MiB, minimum32,010 MiB. Both used the shared queue, 512 MiB hard/450 MiB RSS limits, 27,648 MiB floor, one CPU, no swap and a local network namespace. No automatic retries occurred.

The original envelope imports `TerminateProcess`; the repaired executable imports neither process creation nor termination APIs, nor dynamic lookup. This static compiled evidence confirms that the guarded effects are absent from the current output. It is not an OS execution or death-proof test. Several prospective launch imports are optimized out by the constant capacity refusal, so the author's prospective import list is not an exact match and is not claimed to pass.

Repaired envelope SHA256: `05a483f5345a7338ba78547bf94d6cca4d2a3374d414660d94cc22c1ef94c262` (11,264 bytes). Its launcher is `c5533a1004d904980e4d4e53177fb948ec9898354e1c50b7762a1e0c60d3c058`; the reused probe is `6c8d02e90b5596122095021d9a51f6b77d11487f1610e2f32eca84010a0f660b`. Original launcher differs only in COFF timestamp bytes128–129 despite identical launcher source. Each envelope pins its own exact output; this is not a reproducible-build claim. See both artifact manifests for all original/repaired hashes.

## Remaining source and installation gaps

- The configured outer Job enforces an aggregate384 MiB commit cap, not a separate64 MiB envelope-process cap. Before children start the envelope can consume the aggregate. Parent, kernel and other overhead remain unbounded by that claim. Do not present E=64 as individually enforced or silently assume unmeasured overhead is zero.
- Matching parent identity and immediate Job properties does not prove assignment before entry, actual parentage or exclusive ownership of the Job handle. A real already-accounted creator must configure and assign a suspended child before resume and retain exact process/Job ownership.
- `capacity_hold()` is absent. Its prospective incarnation/sequence fields are not consumed by the current admission logic. An actual shared reservation must cover both managers and direct launch paths, pending asynchronous create/start outcomes, fresh physical and commit counters, and the live floor of at least18,432 MiB. A raw caller value or router-only flag is insufficient.
- The prospective readiness loop may block ten seconds without rechecking pressure, creator or hold continuity. Counting three process-create notifications does not establish executed readiness or distinct pinned descendants. These paths remain unreachable pending real capability implementation, but must be repaired before enabling them.
- Current installed managers have no demonstrated live replacement hook. Editing files is not evidence that resident modules changed. A non-disruptive extension or serving-manager ownership handover remains an installation dependency; do not restart managers or drain existing VMs by assumption.

`peer-readonly-source-review.json` preserves the detailed review. `next-real-interfaces-r1.json` identifies the concrete shared reservation and native creator join points, historical versus current source proof, and the separate install boundary. It is PREPARE ONLY; it authorizes no remote observation, new author, tests, builds, native execution or production change. A further refusal-only wrapper does not close these interfaces.

Next root review must select a functional, bounded implementation and its installation path. Preserve current apps, old financial journals and the 18,432 MiB floor plus pending/observer/bootstrap commitments. Qualification uses a distinct disposable TEST operator domain with no production key, configuration, funds, journal or assignment. Neither a zero-balance app on the old operator nor a global drain is the required isolation.

## Conservative admission alternative — subsequent root review

A dynamic shared reservation service is not a logical prerequisite to the first isolated native test. A fresh, process-bound upper envelope of **all** possible additional physical and commit demand could suffice if it fits for the entire test interval. `conservative-pool-bound-r1.json` records source pins, conditional arithmetic and missing coverage. Root checked all ten input hashes and the illustrative arithmetic, and read the direct request/fetch path and historical native wrapper.

Historical per-manager VM caps are finite (84,992 MiB), enforced before backend start with synchronous starting reservations. These are VM-accounting bounds, not total host-memory or system-commit bounds. Direct request bodies and pre-reservation fetch concurrency, helper/relay growth, Hyper-V overhead, other host work and creator/observer budgets remain unbounded by this evidence. Historical inventory cannot be deducted as current physically reflected allocation. The illustrative thresholds are neither a current fit nor an impossibility result.

Accordingly the real requirement is a complete interval capacity bound, obtainable through a proved conservative envelope or effective shared admission control. The independent bounded creator/provenance requirement remains. No remote observation or native run is admitted by this alternative. Root requested PREPARE ONLY final task/runner/pins for the smallest positive shared allocation implementation and actual two-manager integration; no new author has been launched. Installed live activation remains unproved.
