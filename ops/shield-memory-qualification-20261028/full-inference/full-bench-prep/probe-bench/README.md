# probe-bench (source only, not built)

`src/lib.rs` is the evidence probe
(`PGI/isolation/m4/evidence/shield-target25-2026-09-27/probe/src/lib.rs`), extended with
deterministic public synthetic prompts. The fixture route is unchanged: `GET /` with no
`prompt=` still uses the historical 17-token prompt. New query keys:

| key | meaning |
|---|---|
| `prompt=N` | N synthetic ids from `seed` (1..=16384 total with `shared`) |
| `seed=S` | xorshift64* seed for the unique part |
| `shared=M`, `shared_seed=T` | M ids from `shared_seed`, placed **before** the unique part (same bytes for every session, so a prefix cache *may* reuse it; not assumed) |

Ids are drawn from `[1000, 100000)`, inside Qwen3.x's vocabulary. They are public and carry no text.
Responses add `ttft_ms` (request start → first generated id, i.e. load_by_name + context init + prefill),
`tokens_fnv1a64` (16-hex string) and `prompt_tokens`. Synthetic prompts prefill in chunks of 64 (N_BATCH);
the fixture keeps 16, as before.
Errors are JSON with no echo of the inputs.

Build (root, shared queue). Do not edit the evidence copy:
```sh
P=/home/steven/Projects/enclave/.consolidation/2026-10-24/worktrees/enclave-padgov-init/isolation/m4/evidence/shield-target25-2026-09-27/probe
S=<new stage dir>; mkdir "$S/probe-bench"
cp -r "$P/Cargo.toml" "$P/Cargo.lock" "$P/wit" "$S/probe-bench/"; mkdir "$S/probe-bench/src"
cp full-bench-prep/probe-bench/src/lib.rs "$S/probe-bench/src/"
(cd "$S/probe-bench" && cargo component build --release --target wasm32-wasip1 --offline)
```
Then wrap it as a contract bundle with `Inference{Model: "qwen3.8-27b-mtp-q4-vl-gguf", GPUMilli: 500}`,
`Policy{Vcpus: 16, CPUPercent: 1600, MemMiB: 51200}`, serve mode (FULL.md §6 P6). Use whatever
`contract` command or `contract.Build` caller root already uses for probe bundles. I didn't find
a CLI `build` verb in what I read.
