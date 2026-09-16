# Metal0 pooled GPU verification

Implementation: `281e02bf` plus capability-probe correction `bcfff6f1`.
Release: **v0.5.570-cpu**, installed on Metal0 and verified in Chromium.
All six deployments returned `running` and all six HTTPS endpoints returned 204 with certificate validation.
The Chromium dashboard shows one GPU row: 68.5 GiB / 235.1 TFLOPS, $0.54/hour, 2% available (1.4 GiB / 4.7 TFLOPS shown).
The on-chain GPU price is 151 micro-USDC/second, matching availability.
The compiled measured backend SHA-256 begins `8533cd40dff4c7b3`.
The final CI run passed its unit, contract, and end-to-end jobs.
115 focused regressions passed across the allocator, manager, pricing and routing test suites.

## Product and pricing

One GPU pool combines the dedicated RTX 3070 slice (20.4 dense FP16 TFLOPS,
6.5 GiB), Tesla PG500-216 (101.7 TFLOPS, 31 GiB), and V100 PCIe (113 TFLOPS,
31 GiB). Total: **235.1 rated TFLOPS / 68.5 GiB**.

Price = TFLOPS × $0.001/hour + GiB × $0.0045/hour, rounded once to
micro-USDC/second: **151 micro-USDC/s = $0.5436/hour for the pool**.
A 10% share reserves 0.65 + 3.1 + 3.1 GiB, and costs $0.05436/hour for GPU
capacity before per-second billing rounding. CPU is priced separately;
existing wallet-owned self-hosted deployments retain the free-hosting rule.

## Numerical and failure checks

The existing public Qwen2.5-0.5B Q8_0 model and its measured calibration were run
through the production shielded backend against temporary CUDA workers on all
three physical GPUs. The prompt was “The capital of France is”. Tests did not
send private data or use existing tenant credentials.

- All three workers actively exchanged masked products; 73 calibrated weight
  tensors were placed (25 / 24 / 24 in the equal-budget test).
- The 24-token pooled, single-card, all-CPU-exact, and one-unavailable-worker
  runs produced **identical bytes for every logit** (14,585,856 bytes each),
  SHA-256 `d5e555f3b7dd9ac7dafecffc3b51693e29361cad262e40cea5d1b8346b7a413d`.
- Small budgets forced CPU overflow while all three GPUs still participated.
  Its logits matched the equivalent exact-CPU placement byte for byte:
  SHA-256 `ea6c547a2c41205da2c78a47b11332068ac137962f973185d9cfeb4f184bc389`.
- A worker was stopped during 120-token generation and restarted on the same
  endpoint. The backend fell back to CPU, reconnected with its original
  512 MiB reservation, and every logit matched the uninterrupted reference.
- Zero verification failures in all runs; nonlinear operations stayed on CPU.
- A 120-token run crossed the periodic profiling boundary without deadlock.
- The existing mixed ggml FFN test used separate cards for gate/down when a
  layer exceeded either reservation, and kept SiLU on CPU.
- All temporary workers were stopped and their reservations released.

Evidence: `model-tests.json`, `logit-tests.json`, `reconnect-result.json`,
`ggml-numeric.log`, per-run logs and binary `.f32` captures in this directory.
The captures contain only this public test prompt’s output scores.

## Scope

Multi-card offload applies to calibrated Q8_0 linear weights supported by the
existing shielded backend. Unsupported/uncalibrated weights run on the enclave
CPU. Entire layers stay together where possible; larger layers can split by
activation group. q/k/v and gate/up members remain together under one pad.
Plaintext activations, KV, pads, nonlinear operations and verification remain
inside the enclave. Each link has an independent reservation and recovery path.
One process-wide refill-thread budget prevents multiplying CPU thread counts.

These are functional/numerical checks, not a promise that sequential inference
reaches the sum of the GPUs’ rated TFLOPS. The host-loopback test’s token rate is
not a Metal0 SNP/vsock production benchmark.

Current Eyesoff AI model: `qwen3.8-27b-mtp-q4-vl-gguf`. It has no shielded calibration and remains CPU-only; this task does not change its selected model or quantization.

Automatic Metal0 updates were restored after successful verification.
