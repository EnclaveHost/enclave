# Production rollout — 2026-09-29

Eyesoff AI 1.0.69 was published and activated on Base with the owner's hardware
wallet. Runtime release `1bc7ff92385ad8024e47861a8c86ffa6d40c337b9e15a049899b4bfb7c5a74e7`
is running in guest `gdd56619f5`, with 72 GiB and 16 vCPU. The other five app
guests retained their identities and remained running/attested.

- Publish transaction: `0x58c624a354381a83dbb55ac5182bf4a8dbd01a54a5f6a0c1323c8217e9502817`
- Activation transaction: `0xd5e6d58042a2b6b4e69a9c7fcc2244c9ef48691559547423b5d48ff8a5c9498d`
- AppID: `2ab2808111216719dcd361a5f8062fe06ad0d4eb62709a7df686ecbb2da156aa`
- SNP measurement: `3f42dc68700a9b7ff6914d6c4cffb5210a935beed04952631851c152f8fa4dadd2eeefea010e99d4810b2ce02b7155d9`
- Public TLS SPKI SHA-256: `77c1238adfb36aa7df836449f6ae8945b52773765f158f3ed20e89cb7579ce23`

Independent measurement preparation completed before activation, for both
certificate and secret-release admission. The live expectation changed only
when the owner updated the ledger reference. Both `eyesoff.ai` and the app
subdomain passed WebPKI, nonce-bound AMD attestation, expected AppID/runtime/
release/measurement, and HTTP 200 checks. The control node and GPU workers were
not restarted. Config, allocation, MTP, masking and isolation were preserved.

## Matched latency probes

Same authenticated browser, model `qwen3.8-27b-mtp`, tools enabled, Loop enabled,
prompt “Explain confidential computing in one short sentence.” and max_tokens
64. Times are milliseconds.

| Warm repeat | Before, 1.0.68 | After, 1.0.69 |
|---|---:|---:|
| Response headers | 387 | 441 |
| Tool listing | 1,877 | 585 |
| First streamed delta | 2,478 | 1,246 |
| Model prefill | 1 | 1 |
| Total 64-token request | 6,449 | 4,904 |

Warm first-delta latency improved 49.7%; tool listing improved 68.8%. A later
256-token request returned its first delta in 1,239 ms with 1 ms prefill and
zero MTP gate wait, consistent with the warm-repeat result. These are short
latency probes, not throughput benchmarks. Deltas can contain reasoning; the
numbers do not describe time to the first visible final answer.

## Startup limitation observed

The authenticated UI prepared a 3,749-token prefix, finishing in 216.1 seconds.
The automatic anonymous multi-variant startup preparation was still active
when the first chat probe began. That probe took 72,050 ms to first delta,
including 51,593 ms prefill and 29.53 seconds of MTP gate wait during generation.
Once the startup hook reported completion, the warm repeat above had no gate
wait. Do not represent the warm-repeat improvement as removal of cold-start
latency; startup preparation can still contend with early chats.

Full local evidence and transaction payloads:
`/home/steven/enclave-bench/eyesoff-ttft-20260929/`.

The user requested wrapping up and deploying the tested work, superseding the
earlier open-ended optimization instruction. Further tuning was paused.
