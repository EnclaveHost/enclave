# Startup barrier and attestation succeeded; graph selection failed

Both arms passed the unchanged fresh SNP measurement, runtime/W^X/seccomp, minimum TCB, pinned TLS key, second nonce and replay-rejection checks. Both app requests returned HTTP500: `load_by_name: ErrorCode::NotFound: failed to find graph with name: model`. No tokens or inference throughput were produced.

The receipt labels these `model_declined`, but that classification is incorrect: neither serial contains a capacity-decline line. The probe defaults to `model`; the measured app profile preloads the named Qwen model. The next source-only task verifies registry naming and corrects query selection/classification. No production change or relaxed gate.

Startup-only guest cgroup sampled peaks: A 40,098,422,784 bytes, B 22,756,630,528 bytes. Copy/hash: A28.294s, B19.617s, zero cache-advice failures; both verified the exact17,559,178,144-byte public model. These remain loading/startup measurements, not full inference savings.

Both arms cleaned all owned units/rings/pad banks. Production preserved. Session spend zero. Raw receipt retained unmodified, including its incorrect outcome label.
