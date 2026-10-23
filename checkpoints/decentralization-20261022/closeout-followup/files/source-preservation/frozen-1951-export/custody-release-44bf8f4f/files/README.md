# Corrected custody image: build and hardware evidence

Frozen source c95dcd3aee901b503751c02918a687c83b227511 preserves the original production vault and administrator-controlled address book. Two independent clean offline builds produced byte-identical images. Measured launch identity e01206d386011e8fe925bf81f3a69246eb1b094aec36c22c34e7313b45e2e4690cd8de7cf46a992dc286dc5083b8ff71.

On October23 at19:31UTC a fresh disposable SNP guest on the production machine passed nonce binding, exact launch measurement, AMD VCEK signature/TCB, VMPL0 and debug-off checks. The canary had no registry/submitter key, genesis, committee or existing state. Existing QEMU process identities stayed unchanged; canary state was removed and no canary processes survived. Scope-stop returned5 because the scope had already exited; the actual verifier and job exits were0.

This proves that the corrected image boots and attests on this hardware. It is NOT production activation, lifecycle testing, or decentralized custody. The old one-seat custodian remains untouched. Enrollment, new committee setup, owner policy migration, relay route configuration, dashboard activation, dedicated secret lifecycle and failure tests are still required.

The root hardware canary reuses the reviewed October21 exclusive hardware allocation (5120MiB capped,3072MiB guest,16GiB host reserve, both test lanes); ordinary build/test queue limits are unchanged. Source manifests and redacted verifier outcomes are versioned; images, raw logs, temporary sealed state and raw hardware quotes are excluded.
