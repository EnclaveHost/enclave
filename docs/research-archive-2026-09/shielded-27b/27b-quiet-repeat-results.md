# v52 quiet pair: off vs on

quiet_off **INVALID**  quiet_on **VALID**  matched **False**

| | quiet off | quiet on |
|---|---|---|
| status | INVALID | VALID |
| requested quiet ms | 0 | 30000 |
| quiet activated | False | True |
| APK sha256 | 51004b0b984dc423d4abe11e2c7a7e7cd87891d64b8f1ed8b36f35a45f553d03 | 51004b0b984dc423d4abe11e2c7a7e7cd87891d64b8f1ed8b36f35a45f553d03 |
| combined tok/s | 0.963954 | 1.0973 |
| steady combined tok/s | 0.986281 | 1.13221 |
| GPU peak MiB | 26136.0 | 25856.0 |
| whole cycle s | 530.299 | 546.567 |
| cleanup s | 8.33233 | 24.5497 |

## quiet_off (INVALID)
- the dealer bank is 'QUARANTINED_NOT_REUSED', not CLEAR
- trial 1 (rcvbuf enabled=True buffer=4194304): 16 tokens in 1.29863e+07 us, 1.23207 tok/s overall, 1.27281 tok/s steady over 13; offloaded 2441, local 0, pads 6764/0, verify_fail 0
- trial 2 (rcvbuf enabled=False buffer=262144): 16 tokens in 2.02104e+07 us, 0.791673 tok/s overall, 0.805052 tok/s steady over 13; offloaded 2441, local 0, pads 6764/0, verify_fail 0
- pad-budget cards 4, pads_waited [4, 4, 4, 4]

## quiet_on (VALID)
- trial 1 (rcvbuf enabled=True buffer=4194304): 16 tokens in 1.39619e+07 us, 1.14597 tok/s overall, 1.17939 tok/s steady over 13; offloaded 2441, local 0, pads 6764/0, verify_fail 0
- trial 2 (rcvbuf enabled=False buffer=262144): 16 tokens in 1.52005e+07 us, 1.05259 tok/s overall, 1.08867 tok/s steady over 13; offloaded 2441, local 0, pads 6764/0, verify_fail 0
- pad-budget cards 4, pads_waited [2, 2, 2, 2]

## Comparison
NOT_COMPARED: leg status: quiet_off=INVALID quiet_on=VALID

## Limits
- Trial 1 and trial 2 are different receive-window conditions. Their spread is a condition difference, not run-to-run noise, and this report contains no significance test and no error bar.
- One cycle per setting. Repeatability is unknown from this data.
- The overall rate and the steady rate are different measurements and are reported separately; neither is a sustained production rate.
- A NOT_RUN leg is an absent cycle and an INVALID leg is a failed one. Neither is a zero, a baseline or a result.
- The APK installed_path and the verification command timings are observations, never identity; identity is the recorded status, manifest and APK digests, version code, calibration bytes and digest, and serial.
- Quiet admission describes the observed body markers of that run and carries its own limitation text; it is not proof the pads port was silent.
- GPU memory is a device peak across the whole cycle from the verified own worker, not decode-only utilisation.
