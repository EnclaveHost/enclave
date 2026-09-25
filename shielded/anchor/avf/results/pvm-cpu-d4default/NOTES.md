# The CPU lane's measured decode default on the Pixel 10 (2026-09-23 21:17, build rt5 `e5a0b8b7…`)

One short local run (`tpu/lane-conditions.sh`, 128 tokens max) that names no `decode_threads`: the app now applies the
default measured in results/pvm-cpu-threads1 -- `HOST device profile: ... 6 cores ...; decode on its own pool of 4 (measured
default) -> threads 6` and `LOCAL context ready: ctx 4096, 6 threads (decode 4)`. Turn 1: 14.08 tok/s decode, 78 tok/s
prefill; 4.05 cores busy, 286 core-ms per decoded token (the 6-thread short turn in results/pvm-cpu-p5 pt-01: 13.56 tok/s,
5.69 cores, 419 core-ms). Logs normalized after capture (trailing spaces only).
