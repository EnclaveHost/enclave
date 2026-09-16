# v52 quiet pair: off vs on

quiet_off **VALID**  quiet_on **VALID**  matched **True**

| | quiet off | quiet on |
|---|---|---|
| status | VALID | VALID |
| requested quiet ms | 0 | 30000 |
| quiet activated | False | True |
| APK sha256 | 51004b0b984dc423d4abe11e2c7a7e7cd87891d64b8f1ed8b36f35a45f553d03 | 51004b0b984dc423d4abe11e2c7a7e7cd87891d64b8f1ed8b36f35a45f553d03 |
| combined tok/s | 0.957329 | 1.06147 |
| steady combined tok/s | 0.988105 | 1.16096 |
| GPU peak MiB | 25866.0 | 25856.0 |
| whole cycle s | 531.191 | 538.334 |
| cleanup s | 9.1559 | 16.1318 |

## quiet_off (VALID)
- trial 1 (rcvbuf enabled=True buffer=4194304): 16 tokens in 1.66008e+07 us, 0.963808 tok/s overall, 0.95398 tok/s steady over 13; offloaded 2441, local 0, pads 6764/0, verify_fail 0
- trial 2 (rcvbuf enabled=False buffer=262144): 16 tokens in 1.68255e+07 us, 0.950936 tok/s overall, 1.02476 tok/s steady over 13; offloaded 2441, local 0, pads 6764/0, verify_fail 0
- pad-budget cards 4, pads_waited [3, 3, 3, 3]

## quiet_on (VALID)
- trial 1 (rcvbuf enabled=True buffer=4194304): 16 tokens in 1.52048e+07 us, 1.0523 tok/s overall, 1.21888 tok/s steady over 13; offloaded 2441, local 0, pads 6764/0, verify_fail 0
- trial 2 (rcvbuf enabled=False buffer=262144): 16 tokens in 1.49421e+07 us, 1.0708 tok/s overall, 1.10829 tok/s steady over 13; offloaded 2441, local 0, pads 6764/0, verify_fail 0
- pad-budget cards 4, pads_waited [5, 5, 5, 5]

## Comparison
Per condition first:
- trial 1 (enabled=True, buffer=4194304): off 0.963808 vs on 1.0523 tok/s (on-off 0.0884883)
- trial 2 (enabled=False, buffer=262144): off 0.950936 vs on 1.0708 tok/s (on-off 0.119867)
Combined over the same balanced sequence: off 0.957329 vs on 1.06147 tok/s; steady combined off 0.988105 vs on 1.16096 tok/s

These are the rates the two cycles measured. Read the per-condition rows first: trial 1 runs the receive window enabled at 4 MiB and trial 2 runs it disabled at 256 KiB, so the two trials of a leg are DIFFERENT conditions. The difference between them is a condition difference and is not a noise estimate, an error bar or a significance test, and nothing in this report performs one. The combined figure is a description of the same balanced two-condition sequence run under each setting. One cycle per setting cannot establish repeatability: whether either leg would land in the same place again is unknown from this data, and this report neither claims nor excludes an effect of the quiet flag.

## Limits
- Trial 1 and trial 2 are different receive-window conditions. Their spread is a condition difference, not run-to-run noise, and this report contains no significance test and no error bar.
- One cycle per setting. Repeatability is unknown from this data.
- The overall rate and the steady rate are different measurements and are reported separately; neither is a sustained production rate.
- A NOT_RUN leg is an absent cycle and an INVALID leg is a failed one. Neither is a zero, a baseline or a result.
- The APK installed_path and the verification command timings are observations, never identity; identity is the recorded status, manifest and APK digests, version code, calibration bytes and digest, and serial.
- Quiet admission describes the observed body markers of that run and carries its own limitation text; it is not proof the pads port was silent.
- GPU memory is a device peak across the whole cycle from the verified own worker, not decode-only utilisation.
