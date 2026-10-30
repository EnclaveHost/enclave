# Canonical verifier source build recipe validation

Root integrated and pushed the six recipe/source/doc changes as 2b8894a37 on fix/rpc-attested-verifier-20261025. The runtime pin, image pin, and guest test comment are unchanged from the tested c61dbe5fd integration.

The first test run root0116 failed two static assertions: it matched the word fetched in a shell comment and expected a disclaimer across a hard documentation line break. Both real Cargo closure checks passed in that run. Their original outputs and exit records remain intact. The test-only repair ignores full-line comments and normalizes documentation whitespace. First repair at512MiB was killed, no pass claimed; root0119 at1024MiB passed all11 plumbing checks, with the original successful real closure checks hash-bound. It peaked52MiB RSS, minimum host available21538MiB. Original failed and killed runs are retained.

These are source preparation and dependency-resolution tests, not a new native build. The source recipe now carries the exact reviewed canonical patch and uses a separate CLI tree while preserving helper/listener source. Because this recipe remaps build paths, a resulting native digest may differ from8250f08a; no new binary is accepted or deployed by these changes. No independent reproduction, measurement, live proof, or finality qualification is claimed.
