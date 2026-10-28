# Baseline diagnosis limitations

Claude report-only task exited0; it wrote M/BASELINE-502.md under a nested M directory, copied to the main stage for discovery. It used test-scratch/base-9fa02e1bc instead of the requested installed iso source. Treat its control-flow claims as hypotheses pending exact comparison. It did not review all harness/ring/runtime configurations.

Corrections: r3 GETunreachable occurred at the client's60s cancellation, whereas r4 returned an actual pinned502 at113.5s. They do not prove the same failure. A later runtime=1 attestation could not by itself rule out priorOOM/restart or nativechildfailure. Any later /ping is diagnostic only and cannot turn failedinference into success.

Live production after recovery uses original firmware142589cc and kernel1a3a02d5 (kernel path mentions release-b9 but bytesmatch5cab). Its64,281MiB QEMU successfully booted765,790,607-byte initrd. Therefore the isolated small-guest firmwarefailure does not prove productionrequiresnewfirmware. Reconcile exact launch/image/provenance before rollout.
