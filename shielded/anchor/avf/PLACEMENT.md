# Experimental trusted CPU / shielded GPU placement

The default engine pins every weight in a calibrated layer to ordinary CPU
rows, so the shielded backend can encode the q8 weights. Set
`ANCHOR_FINE_PLACEMENT=1` to pin only calibrated group members. Other weights
can use the ARM CPU's repacked kernels. Operations absent from calibration
remain inside the trusted VM. GPU operations retain masking and verification.

Generate an experimental calibration from the existing Q8 calibration:

```sh
python3 shielded/anchor/avf/calib-profile.py input.calib local-output.calib --profile local-output
```

`local-output` leaves attention QKV and FFN gate/up groups on the GPU; attention
output, SSM output, FFN down, and vocabulary projection stay local. `gpu-ffn`
leaves only FFN gate/up groups on the GPU. For the Qwen3.5 0.8B test calibration
these retain 48 and 24 of the original 97 groups, respectively. Retained
exponents and outlier lists are unchanged. These are test profiles, not measured
recommendations for the production 27B model.

Measure against a full-calibration baseline using the same prompt, model,
thread counts, draft depth, device state, and wire path. Record generated text,
verification failures, offloaded nodes/MACs, wire exchanges, and steady decode
time. Repacked local arithmetic can change numerical rounding; compare output
quality as well as speed. An all-CPU result does not satisfy the shielded GPU
throughput target. Neither profile enables Q4 support or changes production
placement defaults.
