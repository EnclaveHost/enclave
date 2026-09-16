The calibrated dimensions account for every byte of all 1,574 FIELD exchanges in each 16-token trial. They also reproduce all 2,441 offloaded nodes, 6,764 pad rows, and 720,956,293,120 multiply-accumulates. This is shape-based attribution, not recorded node identities. Attention-output and SSM-output have identical dimensions and remain combined.

| Operation family | Calls | Request MB | Reply MB | Reply share | Baseline socket time, trials 1 / 2 |
|---|---:|---:|---:|---:|---:|
| ffn_gate+ffn_up | 369 | 25.49 | 173.28 | 48.8% | 4.342 / 5.239 s |
| attn_gate+attn_qkv | 240 | 18.44 | 58.98 | 16.6% | 1.831 / 2.485 s |
| output | 49 | 1.06 | 51.40 | 14.5% | 1.359 / 0.955 s |
| attention-output or SSM-output | 369 | 30.59 | 25.49 | 7.2% | 1.926 / 2.852 s |
| ffn_down | 369 | 86.65 | 25.49 | 7.2% | 2.182 / 3.325 s |
| attn_k+attn_q+attn_v | 129 | 7.05 | 19.74 | 5.6% | 0.980 / 1.007 s |
| nextn.eh_proj | 49 | 1.81 | 0.91 | 0.3% | 0.266 / 0.386 s |

The paired feed-forward gate/up projections dominate reply volume. The subsequent feed-forward down projections dominate request volume (50.6%). Together their exchanges occupy 6.52 / 8.56 seconds of the baseline socket intervals. Returning fewer output logits alone would address at most 14.5% of reply bytes, even before accounting for the work needed to preserve privacy and correctness.

The paired gate/up results feed a nonlinear activation and elementwise product inside the trusted guest. Their following down projection therefore cannot be replaced with a single precomputed linear weight product. This does not rule out a different protocol, but simple linear fusion is insufficient.

These wire intervals include transport and host processing. They omit other operation-local computation and must not be added to nested GPU timings. MB uses decimal bytes. Full evidence: `27b-operation-traffic-profile.json`.
