# Dynamic Shield model memory admission

The 70 GiB usable-RAM cutoff for 27B and the 7 GiB cutoff for the small model are removed. The guest reads its own `MemAvailable` and creates a root-owned cgroup v2 memory limit for the verified model-copy helper and application runtime. Its budget is available RAM minus platform headroom (5% of usable RAM, at least 256 MiB). This is not a model minimum or permission to exceed the deployment's RAM share. Swap is disabled for the group; the existing outer VM/share limit remains in force.

The real loader now determines whether initialization fits. Private model pages, masking allocations, inference caches and runtime allocations charged to this group compete within the same limit. TLS, init and the broker stay outside it. Model validation, private-copy authentication, source reclamation, masking and runtime libraries are unchanged.

If copying or inference exhausts this budget, init observes a kernel cgroup OOM event, discards the private model copy and starts the application without the inference graph. Runtime OOM recovery is a single restart with the same released configuration and security filters; the triggering request can fail during that restart. The attesting front and its key remain alive. An ordinary crash or model-authentication failure is not treated as permission to keep running with an unchecked model. If the memory controller cannot be established, model loading is disabled.

This avoids a guessed model-specific floor and an endless OOM/reboot loop. It does not promise that a model fits an allocation merely because its weight file fits, or that eight concurrent sessions are qualified by a single inference test.

## Candidate and tests

Release: `d4fab4c8727ce0d07cc850d29236ec2365903789dd8c81fb008210934b22f4c8`. Only the measured init differs from `38d14410`; native engine/backend libraries and all masking optimizations are identical.

- Budget arithmetic covers zero/insufficient headroom, small and large allocations, inconsistent available/total readings, and integer overflow boundaries.
- Init handoff, hardening mutation suite, and seccomp-statement mutation suite pass.
- A 6,691 MiB SNP guest reached the actual model-copy memory limit and then served Eyesoff successfully without the model. Independent fresh attestation and HTTPS checks passed.
- A final-candidate 20 GiB guest served Eyesoff's interface successfully. This checks startup, not generation.
- A fixed public MTP inference probe at the owner's 45,440 MiB allocation exhausted its dynamically computed 40,587 MiB group limit. Init restarted the app without the graph, and a new attestation plus `/ping` check passed on the same guest TLS key.

Evidence: `/home/steven/enclave-bench/dynamic-model-ram-20261001`. Larger-allocation inference testing and production activation are recorded below once complete.

## Successful larger-allocation generation

The exact final runtime completed the public 32-token decode probe in a 57,344 MiB (56 GiB) SNP guest: 320 ms prefill and 1,629 ms decode (19.03 tok/s for the 31 subsequent tokens). Both masked GPU workers held the model. Host-accounted VM peak was 56,237,813,760 bytes (52.38 GiB); this includes guest pages already freed and is not a model-size measurement. The dynamically enforced group limit was 51,647 MiB. This establishes a working allocation for this short test, not an exact minimum or eight-session capacity guarantee.

The archived speculative probe first reached an obsolete `rewind` API and returned a structured `rewind_unsupported` error. The production application uses branch/copy speculation instead. The successful result above is ordinary decode; do not report it as a production MTP benchmark. The speculative probe did exercise model/context initialization, and the runtime stayed alive after that ordinary application error.

The 44.4 GiB probe's post-OOM attestation and liveness check passed with the same TLS key. The 56 GiB canary was stopped before production activation, releasing its GPU and RAM resources.
