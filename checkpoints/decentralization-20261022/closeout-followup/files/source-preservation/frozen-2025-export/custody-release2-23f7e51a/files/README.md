# Corrected custody image: build and hardware evidence

Frozen source c95dcd3aee901b503751c02918a687c83b227511 preserves the original production vault and administrator-controlled address book. Two independent clean offline builds produced byte-identical images. Measured launch identity e01206d386011e8fe925bf81f3a69246eb1b094aec36c22c34e7313b45e2e4690cd8de7cf46a992dc286dc5083b8ff71.

On October23 at19:31UTC a fresh disposable SNP guest on the production machine passed nonce binding, exact launch measurement, AMD VCEK signature/TCB, VMPL0 and debug-off checks. The canary had no registry/submitter key, genesis, committee or existing state. Existing QEMU process identities stayed unchanged; canary state was removed and no canary processes survived. Scope-stop returned5 because the scope had already exited; the actual verifier and job exits were0.

This proves that the corrected image boots and attests on this hardware. It is NOT production activation, lifecycle testing, or decentralized custody. The old one-seat custodian remains untouched. Enrollment, new committee setup, owner policy migration, relay route configuration, dashboard activation, dedicated secret lifecycle and failure tests are still required.

The root hardware canary reuses the reviewed October21 exclusive hardware allocation (5120MiB capped,3072MiB guest,16GiB host reserve, both test lanes); ordinary build/test queue limits are unchanged. Source manifests and redacted verifier outcomes are versioned; images, raw logs, temporary sealed state and raw hardware quotes are excluded.

Update: this c95 image is superseded for activation by root source a5eae96c, which fixes startup storage errors being treated as absent state and completes host authority selection and direct owner-read routing. The historical byte-identical builds and quote evidence above remain valid for c95 only. The new source must be rebuilt and hardware-tested separately; do not activate e012 as if it contained these later fixes.

The replacement build is now available in out-r2 from ab589bf80b669c9671b53573d489b6c6c45779ea. Two independent builds are byte-identical, with launch measurement 70aadff5455fd65f752c1dcec2d6f1ac4984bebf6c63b284d15fcf47851fb96def231af40c39a3bca6fbf9748f01c429. RESULT-R2.md and evidence-r2 record the exact source, runtime closure and tests. This new image has not yet passed the hardware startup-recovery canary and is not activated.
