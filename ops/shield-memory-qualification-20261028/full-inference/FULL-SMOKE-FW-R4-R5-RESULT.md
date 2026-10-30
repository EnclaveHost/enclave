# Baseline application failed; candidate launch yielded to production

r4: original-loader A56GiB/16CPU passed fresh SNP attestation, exact model hash, runtime/W^X/seccomp/minTCB, pinned TLS, second nonce and replay checks. Correct graph request returned pinned HTTP502 after113.52seconds. Client exited0 with empty stderr; no inference tokens. Guest sampled peak59,906,166,784bytes (~55.79GiB), final hostavailable28,830,056,448bytes. No serial app-exit/capacity-decline line. This is below client840s and front180s deadlines; neither timeout explains this result. Memory exhaustion is a hypothesis, not proven by these observations. Cleanup clean.

r5 B-only fresh plan was REFUSED before any worker or VM launch: guestd production allocations changed between planning and execution. The normal controller had lost image-generator's lease after gas-reserve affordability failures and then claimed Qwen/EyesOff. Readonly guestd showed65,049MiB pending and80% GPU allocation. No production teardown was performed by the canary. New canaries remain off while that commitment exists; do not reinterpret current idle usage as free capacity.

The tests still do not establish successful full inference or steady-state RAM/throughput savings. Continue source diagnosis and resource coordination; preserve all floors and original app/runtime settings.
