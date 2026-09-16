# V100 integer-kernel confirmation

The G4 candidate beat the current G8 setting in all84 matched pairs. Across all seven actual27B matrix-group shapes at8 and16 rows, median CUDA-event stream intervals fell by5.98–18.57%. Complete worker-exchange testing is now in progress; no serving policy has changed.

Each shape used six pairs on identical weights, inputs and reference output: three pairs ran G8 first and three ran G4 first. Every candidate output was checked byte for byte against an independent int64 reference before and after each timed interval. All168 measurements and the host capture passed.

| Group | Rows | Current G8 median (µs) | Candidate G4 median (µs) | Reduction | G4 pair wins |
|---|---:|---:|---:|---:|---:|
|attn pair|8|216.695|202.685|6.47%|6/6|
|attn pair|16|415.795|365.310|12.14%|6/6|
|triple|8|174.250|163.360|6.25%|6/6|
|triple|16|366.695|322.135|12.15%|6/6|
|ffn_gate pair|8|420.015|373.315|11.12%|6/6|
|ffn_gate pair|16|825.910|723.115|12.45%|6/6|
|ffn_down|8|188.860|172.205|8.82%|6/6|
|ffn_down|16|370.195|348.075|5.98%|6/6|
|ssm_out|8|79.960|71.425|10.67%|6/6|
|ssm_out|16|160.120|144.930|9.49%|6/6|
|output head|8|2788.200|2554.420|8.38%|6/6|
|output head|16|5846.375|4934.400|15.60%|6/6|
|mtp head (eh_proj)|8|122.110|107.570|11.91%|6/6|
|mtp head (eh_proj)|16|268.575|218.710|18.57%|6/6|

Both settings use WR4 and unchanged integer arithmetic. Only the MR8 instantiation is covered by this confirmation:16-row requests execute two8-row launches. MR5–7 are separate, untested instantiations; they will retain their current policy. The earlier fixed-order sweep found the current G8 setting faster at4 rows.

U2 was the selected Tesla V100-PCIE-32GB. All14 contexts reported80SM in device, property and planner checks, and every owned PID was observed on U2. A private MPS pipe was used, with existing service contexts resident. This is not exclusive GPU ownership or a matched serving-MPS test. All owned processes exited.

The48.381-second capture passed with187 readings per card. Intentional context holds and CPU reference generation are inside that window; its average GPU utilization does not measure steady compute utilization. The recorded CUDA-event intervals include host enqueue gaps and exclude worker framing, input transport, pad generation, masking, protected verification and model execution. They cannot be converted to phone tok/s.

The first fixed-order sweep and this confirmation are distinct runs. Their absolute values do not all agree within1%; the FFN gate/up G4 eight-row interval differs materially. The paired results within this confirmation are the basis for proceeding to complete exchanges.

[Detailed confirmation evidence](/home/steven/Documents/Codex/2026-09-07/i-w/outputs/v100-kernel-confirmation-evidence.json)

The subsequent full-worker A/B/B/A comparison passed: mean host exchange time decreased 7.54% at eight rows and 9.33% at sixteen rows. See [the complete-worker report](/home/steven/Documents/Codex/2026-09-07/i-w/outputs/v100-full-exchange-mr8-g4.md) for the separate complete-worker evidence.
