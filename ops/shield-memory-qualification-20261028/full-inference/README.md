# Full-inference qualification — incomplete

October28 2026. Claude prepared the harness; root reviewed and tested it.44offline fixtures pass, including reservation consistency, ownership/cleanup, unknown GPU processes, timing and measured-resource accounting. The probe and supporting tools built offline. Both new CUDA workers initialized under PrivateNetwork and were removed with production process identities intact.

The first actual baseline56GiB/16vCPU boot FAILED before Linux/model loading: EFI could not load the canonical approximately724MiB initramfs (`0x8000000000000009`). The owned guest and both workers were cleaned up. Minimum sampled host MemAvailable80.116GiB. No full-model attestation, inference, pressure or throughput result exists. Source-cache savings remain loader-only evidence in the sibling loader-bench package; no production runtime/floor change has been made.

The active local verifier policy was reused without relaxation. Public trust pins, build identities, test logs and failed-boot receipt/serial are included. The source helper's relative bench-harness dependency links to the already-reviewed sibling loader-bench package. Build scripts retain this installation's explicit paths; execution requires fresh resource review and new outputs, never replay the failed plan.

The first Cargo build failed on cargo-component's absent offline lockfile. The successful retry used vendored WIT/cache and a private network namespace. The first additional consistency test failed because an older fixture omitted corresponding pool totals; the fixture was corrected and all44passed. These failures are retained as evidence, not hidden/skipped.

Pending: diagnose pinned firmware/initrd allocation, complete fresh-quote verification and full-model A/B performance/pressure tests, reconcile live73728MiB advertisement with installed source51200MiB, then decide measured admission and rollout. Normal RPC stays off; this work does not complete decentralized RPC replacement.
