# pVM CPU p5: load-phase timing and the supervised restart, Pixel 10 Pro XL, 2026-09-23 (20:52-21:04)

The protected pvm-cpu build p5 (DeviceProfile sizing + the supervised restart + load-phase timing), E2B Q4_0.

## pt-01: where the cold start goes (tpu/lane-conditions.sh, one short turn)

`HOST device profile: cpu_capacity [207, 207, 824, 824, 824, 825, 825, 1024] -> 6 cores at >= half the largest; RAM 15575 MiB
-> threads 6, VM mem 8192 MiB` (the platform granted 7,168 MiB). Sized from the kernel, not the device name.

| phase | time |
|---|---|
| model stage: whole-file + per-tensor SHA-256 in one read of the cached model in the encrypted store | 18.3 s (~190 MB/s) |
| engine load, total | 59.5 s |
| of which: reading the tensors back from the encrypted store (4 threads) | 36.8 s (~95 MB/s) |
| of which: hashing each tensor against the staged table | 2.2 s |
| of which: placing + repacking (316 repacked, 286 plain) | 2.3 s |
| self-test (32-token prompt at 129.8 tok/s, 64 tokens at 13.50 tok/s) | ~7 s |
| first turn | TTFT 300 ms, 96.7 tok/s prefill, 13.56 tok/s decode |

The model crosses the encrypted store's decryption twice (stage, then load) and the second pass is the slower half. That is
the lever for the cold-start target (PVM-CPU.md target 3, <= 60 s): stage into private memory, judge the whole-file digest,
then build the tensors from that memory -- no second read, and no per-tensor re-hash of bytes the host can no longer reach.
Not built yet.

## rs-01: the supervised restart (cpu/restart-test.sh)

The VM (crosvm_anchorlocal) was killed during turn 2. **PASS**: turn 2 is reported INTERRUPTED with no answer line; the app
ran the VM again on its own; the new VM attested again, re-verified the model (MODEL ok) and served turn 3; the capture
closed complete. Recovery: kill -> engine ready 122.7 s, -> turn 3's first token 123.1 s (the restarted load took 81.0 s,
the first 61.7 s): the recovery time is the cold start, so the same lever shortens it.

Logs normalized after capture (trailing spaces stripped; nothing else changed).
