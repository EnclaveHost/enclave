# Startup shared-prefix branches — 2026-09-28

Status: implementation tested; production activation pending owner transactions.

The candidate changes only `template/init` relative to release `16ef43bd`:
large-model shared-prefix slots increase from 2 to 8. Active sessions remain 8,
conversation parks remain 6, and N_BATCH/N_UBATCH remain 64. Total sequence IDs
are 22, below the batch limit. Native inference libraries, masking, MTP, and
model quantization are unchanged. Cache contents stay in private guest RAM.

Eyesoff AI 1.0.68 prepares a bounded set of feature-dependent system prefixes
when the existing guest startup hook calls `/warmup`. A common tool-definition
boundary shares work with Loop mode; exact tokens determine reuse. This is
prefix branching, not concatenation of independently calculated KV blocks.

## Validation

- Eyesoff: 215 Rust tests and 8 browser warmup tests passed.
- Pinned nightly-2026-07-25 production Wasm build passed; artifact identity is
  recorded in artifact.json.
- The actual Wasm completed all five startup branches on a public 0.5B model,
  using four unique prefix boundaries after deduplication. Startup took 3153 ms.
  Repeated selected prefills took 0–12 ms; full request plans took 165–210 ms.
  This is a synthetic CPU integration test, not a production 27B performance claim.
- Native fixture `test/fixtures/wasi-nn-prefix-branches.rs` exercises eight
  active contexts (ninth refused), cache pressure, cold seed, shared-prefix
  borrowing, and a borrower surviving unrelated eviction pressure. Attention
  Qwen2.5 0.5B and recurrent Qwen3.5 0.8B passed with 512 and 8192 token pools.
- Strict logit comparisons use the same learned weights dequantized to F32,
  F32 KV, four CPU threads, and flash attention off. Q8 tests showed numerical
  deviations under different cache layouts, including cold cache misses;
  argmax stayed equal in the observed failures. State tracing found identical
  shared-prefix KV and later divergence consistent with quantized rounding.
  Full-precision references isolate state-management correctness from that
  numerical sensitivity. These tests do not promise bit-identical quantized
  logits across cache layouts. Production quantization is unchanged.

## Rollout

Nan has the verified candidate release and admission entries. The guest manager
candidate passes adoption checks for all six running guests. Before activation,
independent Nan measurement prediction must match the locally reconstructed
measurement. The owner publishes 1.0.68 and updates only Eyesoff's catalog
reference. No shares, config, domain, balances, or other app references change.
Production startup timing and attested endpoint checks remain pending.
