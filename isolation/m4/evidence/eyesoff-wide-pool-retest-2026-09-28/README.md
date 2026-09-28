# Production retest of the twelve-worker CPU pool, 2026-09-28

Decision: reject the twelve-worker profile. It improves isolated attention tests but is much slower through the production Eyesoff chat path. The exact prior six-worker release is restored and remeasured.

## Matched conditions

Baseline release `f7fae72afbddbcb3f8b29782f34ae2ce49410a0a53ad6a6d7bb5a3b988270e43` already includes grouped F16 attention, the shared native CPU pool and GPU handoff affinity repair. Candidate `65bb936887301d362a26d7c8a18ba0ea86f2eb2e013076d917d2af34a36d7ecb` changes only the measured init and an opt-in marker. It selects twelve compute workers on guest CPUs 0, 2–12, helper 1 and remaining work on 13–15, instead of six workers on 0, 2–6 and remaining work on 7–15. See `candidate-init.patch` (experiment only; not applied to official source).

Both guests have the same 16-vCPU host placement 0–15. Same model, CPU/GPU libraries, firmware, kernel, application/configuration, full tool definitions, MTP k=1 and session capacity. The V100s kept memory/SM clocks 1107/1380 and 877/1380 MHz. No microbenchmarks ran alongside the chat measurements.

`benchmark-request.json` was sent through the authenticated production `/chat` endpoint. It renders 3,781 prompt tokens and generates 384 tokens per request. Four initial baseline and candidate warm repeats, followed by three restoration warm repeats, are compared; the first request on a fresh guest is reported separately. Decode tok/s excludes prefill and application overhead. Whole-request tok/s includes them.

## Production results

| Condition | Warm decode tok/s | Warm whole-request tok/s |
|---|---:|---:|
| Current production, six workers |18.298|15.808|
| Candidate, twelve workers |7.696|7.303|
| Restored six-worker production |18.186|16.197|

Each rate is total output tokens divided by total measured time, not an average of rounded display rates. The candidate loses 57.94% of baseline decode throughput. Warm cache prefill remains 1–2 ms, so cache loss does not explain this result. Its cold request took 408,844 ms to prefill and 52,380 ms to decode (466,227.5 ms total). The earlier grouped-attention six-worker cold test took 247,808 ms to prefill; the fresh restoration cold test took 247,859 ms to prefill and 22,322 ms to decode (274,761.2 ms total).

All thirteen completed requests returned HTTP 200, produced identical 1,757-character outputs (including reasoning), and accepted 166 of 218 draft tokens. SHA256: `734bc8f0fcda21c12e64ada36fadc957858be54a828888b8c5ddb3b5d617e511`. Candidate responses contained no error/notices.

## Qualification and interpretation

Fresh AMD attestation and ordinary public WebPKI passed for the candidate. CPU shared-pool tests at 6 and 12 workers preserve caller affinity, repair GPU handoff affinity, preserve external pools and serialize eight concurrent callers with exact outputs. The hybrid model fixture exercises eight resident sessions, branching, speculative rewind and slot recycling; all 699,269,120 bytes of logits match the qualified six-worker output, SHA256 `603649f6f9c6ac3bbab78bd0bc01a8455fdd6ca9ea8417608e2f7ad81276ad64`.

Repeated attention-only benchmarks still favor twelve workers. The 16-layer medians are: 4,096 KV / 1 token, 10.571→8.603 ms; 4,096 KV / 2 tokens, 10.656→9.154 ms; 4,352 KV / 2 tokens, 11.000→9.801 ms. This does not represent whole-model performance. A three-second candidate prefill sample shows nearly all vCPUs saturated while only three cores are reserved for non-compute work. That is consistent with refill/service contention; it is not direct proof attributing every lost millisecond to mask generation. The larger team also affects CPU operations outside the attention-only fixture.

The rollback returns to the exact prior measured release; it does not disable masking, weaken attestation, change the model, reduce tools or disable MTP. Other five guest identities remain unchanged.

## Restored state

Guest `gd3b4fd898` is running release `f7fae72a` with the original measurement. Fresh AMD attestation and normal public TLS passed. The three final warm decode results are 18.0, 18.5 and 18.1 tok/s, with 1 ms cached prefill each. Other five apps retain their original guest identities and running states. No experimental CPU profile is selected in production. Historical measured release artifacts and admission pins remain available for reproducibility; the rejected candidate is not the manager default. The 20 tok/s production target remains unmet.
