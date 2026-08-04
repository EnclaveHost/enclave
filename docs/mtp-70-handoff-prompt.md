# Prompt for the next instance

Copy everything below into the new session.

---

## Goal

Get **MTP speculative decoding above 70 tok/s on the live fleet** (kryptos,
fable-fusion-27b, 25% GPU share). Do not stop until a fleet-measured MTP
config clears 70. Current best: **62.0 tok/s quote / 60.4 prose** with
`draft:"mtp", draft_tokens:1, nnRsSeq:1` — already committed as
`tools/specbench/cfg-mtp1rs1.json`.

Read `docs/speculative-decoding-handoff.md` FIRST — the top section
("MTP WANTS k=1") is this campaign's state of the art. Trust its numbers;
they are all fleet-measured this session. The memory index also has
`enclave-spec-batch-cost-curve` and `enclave-medusa-heads-verdict`.

## Why 70 is in reach

The k=1 round is **31.1 ms for 1.92 tokens** = verify 20.5 ms + **10.6 ms
draft-side**. 70 tok/s needs the round under ~27.6 ms, i.e. cut ~3.5 of
that 10.6.

Profiling (instrumented shim, local 9b) split one head step as:
`llama_decode` 3.67 ms / host 248K argmax 0.150 / p_min gate 0.078. A
no-logits decode drops 3.67 → **0.77 ms**: ~2.9 ms/step is the 248K-vocab
logits D2H, which the CC stack makes driver-forced-synchronous, so the
fleet saving should be ≥ local. 2.9 of 3.5 comes from that alone; the rest
likely comes with it (the WIT reply also stops carrying a 1 MB row).

## The change in flight (your first task: land it)

**On-device draft sampling** — shim-only, committed as `621056e1`
(`wasm/llama-shim/enclave_llama.c`). llama already skips the logits copy
when every output seq has a backend sampler CHAIN
(`needs_raw_logits`, `llama-context.cpp`); the shim now attaches greedy
chains via `llama_context_params.samplers` (bare `llama_set_sampler` is
refused — must be chains, must outlive the context, freed after
`llama_free`). Reads env `ENCLAVE_MTP_DEV_SAMPLE=1`; deployment knob
`nnMtpDevSample: true` (wasm_manager.py, same pattern as `nnLoadMtp`).
**Default OFF** because it suppresses the p_min gate (needs the raw row) —
harmless at k=1, measured-worse at k>1 (forcing full drafts: acceptance
75%→57%). Correctness proven on CPU: device path engages
("`llama_context: setting backend sampler for seq_id 0/1`" in the serve
log) and output is byte-identical, same draft counts. An 8 GB local card
CANNOT host the sampler graph next to the 9b (falls back cleanly), so the
perf number can only come from the fleet.

### Cascade state at handoff

1. ✅ Shim + knob committed and pushed (`621056e1`).
2. 🔄 **Engine build running**: workflow "llama.cpp Toolchain", run
   **30917277870**, tag `enclave-llamacpp-ddd4ec14-mm24` (~29 min typical).
   ⚠️ A prior argument-less dispatch CLOBBERED the mm17 release asset
   (default tag trap — since removed, commit `3e60784b`). Never dispatch
   this workflow without an explicit fresh `-f release_tag=`.
3. ⬜ When it succeeds: take ELL_SHA256 from the run log tail
   (`gh run view 30917277870 --log | grep ELL_SHA256`), then run
   `$S/pin-ell.py <sha>` (already staged for mm23→mm24), commit+push.
   `$S` = the session scratchpad of the PREVIOUS instance — if gone, edit
   `wasm/Dockerfile.wasmtime` ELL_URL/ELL_SHA256 by hand (asserting
   script preferred; never bare sed).
4. ⬜ Wait ≥3 min after that push (pushes spaced ≥3 min — release runner
   race), then `gh workflow run toolchain.yml -f wasmtime-version=v45.0.0`
   (that is the "Wasmtime Toolchain" workflow file).
5. ⬜ Take the image DIGEST from that run's log, run
   `$S/pin-wasmtime.py sha256:<digest>` (generic, regex-based), commit+push.
6. ⬜ Push = production deploy (~5–10 min repoint). Watch the new release
   tag appear, then require **attest PASS ×2** (two-stage: new tag first,
   then attest — attest alone false-positives against the prior release).

### The measurement (your second task)

```
cd ~/Projects/enclave/tools/specbench
CFGS="mtp1rs1 mtp1ds" timeout 2400 bash fleet-bench.sh multi
```

`cfg-mtp1ds.json` = mtp1rs1 + `nnMtpDevSample: true` (already written).
The script resumes deployment `0xed05dd04…` (private llm-chat-bench,
app 0.35.5 — already fold-capable, no app publish needed), runs 3×2
prompts per config, prints tok/s + `vdec` + acceptance, and suspends the
deployment itself. Balance was ~$5 (≈3 h); the bench wallet
(`~/.config/enclave/key`, 0x3977E339…) holds ~$11 more —
`node cli/enclave.mjs resume <id> --yes` then `fund <id> --usdc 5 --yes`
if needed (fund fails with "inactive" unless resumed first).

Success = mtp1ds ≥ 70 on either prompt with sane acceptance (~90%).
Compare `mtp_draft` per-ROUND (divide verb total by feed_all_mtp round
count — per-call averages deceive; that mistake is documented in the
handoff doc). Expect ~7.6 → ~4.5 ms/round if D2H died.

### If it lands 63–70 (likely band): next levers, in order

1. **Fused round verb** — one WIT call per round instead of
   draft+verify: ~2–3 ms. The engine bridge is
   `wasm/wasmtime-nn-ggml.patch` (regenerate via the wt8 worktree flow in
   memory `enclave-ggml-backend`; arbiter patch collides — `git apply
   --reject`, hand-merge, regen).
2. **Quote/prose asymmetry**: k=1 quote 62.0 vs prose 60.4 — probe
   whether prose acceptance (93%) is prompt-limited or think-block-limited
   (`thinking` is ON in the bench config; a `mtp1think`-style off-variant
   is a config-only probe).
3. k=2 + device sampling: batch-3 verify was 40.8 ms (the width penalty
   returns), so only worth it if acceptance × width beats the penalty —
   arithmetic first, in the handoff doc's style.

## Ground rules (non-negotiable, from Steven + memory)

- Test ONLY on the private bench deployment `0xed05dd04…`. The public
  llm-chat catalog publish is STEVEN's action, never yours.
- NEVER fund/import/sign with burner `0x337Ecab…7319` (compromised).
- kryptos is shared production: probe llm-chat only via `/title`; never
  abandoned streaming curls. Run a `plain` leg in the same window if
  numbers look off (contention guard); daytime windows are suspect.
- Bearers expire ~1 h and rotate on app restart — re-mint per leg via
  `tools/specbench/session.mjs` (fleet-bench.sh does this itself).
- Suspend the bench (`stop <id> --yes`) after every run — fleet-bench.sh
  does it, but verify (`status` → terminated).
- Commit and push after every repo change (standing rule; push = deploy,
  so verify first). Space pushes ≥3 min. Never `git add -A` in this repo
  (a bearer token and Steven's scratch file got swept in that way — use
  targeted adds).
- Byte-golden discipline: plain output must stay byte-identical across
  engines; device-sampling MTP must match host-path MTP byte-for-byte
  (it did on CPU). Note: batched verify vs plain is NOT byte-stable at
  768+ tokens (pre-existing tie-flips, documented) — golden-gate at
  160–256 tokens.
- Record every result (positive or negative) in
  `docs/speculative-decoding-handoff.md` and the memory files; correct
  wrong claims in place rather than deleting them.

## Cost/physics cheat sheet (all fleet-measured)

- plain 62–63.4 tok/s; lookup-rs k=4: 66.1 prose / 60.5 quote (ships).
- verify decode by batch: MTP 20.7 / 40.8 / 52.9 ms at n=2/3/5; lookup
  27.0 / 29.3 / 34.6. MTP is CHEAPER at n=2; premium explodes with width.
- MTP acceptance: 92–93% at k=1, ~89% k=2, 76–85% k=4.
- Snapshot tax: nnRsSeq>0 costs 0.78 ms on EVERY decode (cause unknown,
  candidates + refuted theories in the handoff doc). rs must be the
  MINIMUM covering k (rs=1 for k=1 — that's the shipped cfg).
- The 10.57 ms batch-width cliff = SM starvation (reproduce locally with
  `CUDA_MPS_ACTIVE_THREAD_PERCENTAGE=25`); it is why lookup needs k=4 and
  MTP needs k=1.
- Local A/B does NOT predict the fleet (opposite cost curves) — use the
  SM cap for shape, the fleet for truth.
