# RPC app contract qualification

Previous turn made progress: actual EL recovery and local RPC response, bounded
shutdown, retained state, and committed evidence. Current turn implements the
missing distinct CPU RPC app identity rather than another standalone VM trial.

Actual invocation 1db72e4016ed4ce789b333d2fb2c3291 completed exit0/MainPID0.
313 test/subtest PASS, zero failures; 18.736s compile+suite;
37 frozen pins unchanged at completion. Fresh authenticated admission
92255 - 718 pending - 640 allowance >= 27648 MiB.
512 MiB hard/450 RSS/CPU1/noSwap, network-isolated bwrap and read-only source;
120s suite/150s outer, no retry. Actual compiler Go1.27.2, no toolchain download.

Tests cover legacy canonical vectors and V8, new V9 RPC identity, distinct
volume/deployment/profile bindings, CPU budget, closed peer-port allowlist,
fixed chain/startup policy, hostile fields and real exclusive output files.
Empty component is explicitly synthetic wire data, not a running controller.
No contract publication, deployment, signer, manager, native workload or funds.
Only README and catalog documentation edited after the tested source freeze.

Ordinary and desktop runtimes continue refusing the new profile. The producer
cannot confer launch authority or attest a native process. Remaining concrete
work: actual portable controller/native supervisor, pinned measured runtime,
authenticated writable app state, manager and release/ingress integration,
then native fit/sync/finality and production consumer qualification. The full
objective remains active and unachieved.
