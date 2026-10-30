# Owned permission lifetime: independent acceptance failures

Status: NOT a qualified implementation. This is additional acceptance evidence for the active Claude ownership repair, not a production change.

The actual frozen completion-r3 protocol closure has5 tests:1 positive PASS,4 required refusals FAIL,0 skips. Tests use real EIP712 signatures, collector, witness, permit gate, isolation runtime and actual file/flock journals. Authority, readiness, manager and in-process witness transport are explicit TEST doubles. No external network, real VM, chain, funds or production journals.

- Positive: a real signed permit authorizes serving while its writer remains owned.
- Release the locked gate authority journal, then acquire that lock as a second owner: the old gate still authorizes its installed signed grant.
- Release the writer: an additional resource registered through the real gate.track API receives no close callback.
- Independently, the actual runtime's tracked TEST manager instance remains present after release. This is missing runtime withdrawal through the supplied manager interface, not proof a production VM escaped enforcement.
- Hold actual witness verification at readiness, release its authority-journal writer and acquire a replacement, then continue: the old witness returns a valid signature. The test recovers and matches the signer before failing the required cancellation assertion.

These tests deliberately use the available locked-journal API with the actual consumers. They show that optional journal ownership alone does not implement consumer ownership. Future tests must construct the required owned composition, retain a positive control, and preserve cancellation/resource withdrawal assertions. A test that merely calls gate.close manually after release would not prove automatic lifetime coupling.

The initial4-case fixture called gate.track without its required binding argument. Its callback case therefore failed at API validation, not withdrawal. That failure is retained under initial-fixture-failure. The corrected fixture supplies the exact host/app-generation/authority binding and adds a separate runtime-instance case. No product source changed between runs.

The active repair also needs delayed/rejected withdrawal, in-flight spawn, final awaited authority changes, established-sidecar loss and persistence ambiguity across reopen. Those are separate requirements; this suite does not claim to cover them or qualify production hardware boundaries.

## Execution and provenance

U/host-owner-permit-boundary-r2 ran under enclave-owner-permit-boundary-r2-20261029, invocation17e39940bb0c41e1b6e80bb88e0c8362, terminalexit1/MainPID0 from assertion failures. Bound256MiB/noSwap/220RSS/floor27648/oneCPU/150s/child70s, isolated unshare-Urn; innerpeak105MiB/minavailable33951, outer153/min33959. No owned test process remains. All18 source/runner pins checked before and after. Random keys are ephemeral TEST signers and are not printed or exported.

Sixteen frozen modules are byte-for-byte from the completion-r3 protocol tree. Existing history proves their generation; this suite makes no new generator claim. package-pins.json verifies published files. Original absolute paths in pins.json preserve raw inputs; run.py is retained for review, not a portable blind-retry command. Production remains unchanged and the complete censorship-resistance goal remains active.
