# Speculative decoding on Enclave — handoff

Written 2026-08-03 after a ~12-hour campaign (engine builds mm7 → mm17).
Everything below is measured on the live fleet unless marked otherwise.

## UPDATE 2026-08-03: mm18 landed the no-branch verify — first real win

The "next real idea" below (verify without a scratch branch) shipped as
**mm18** and it works. Fleet numbers (3-sample, 27b, same harness):

| config | quote prompt | prose prompt | verify decode |
|---|---|---|---|
| plain | 63.8 ± 1.3 | 62.8 ± 0.2 | — |
| lookup k=4, branch-commit | 56.3 ± 2.7 | 60.0 ± 1.2 | 36–41 ms |
| **lookup k=4, rewind-commit** | **62.4 ± 0.2** | **68.0 ± 3.5** | **30–32 ms** |

Prose: all three rewind samples (66.0/72.9/65.0) beat plain's best sample.
First mean-above-plain result of the campaign. The win decomposes as:
gbuild/galloc collapsed (1.7–1.9 → 0.3–0.4 ms — llama graph reuse finally
HOLDS on verify passes), verify decode −9 ms, and the partial-accept
re-feed pass is gone entirely.

How: llama's upstream `n_rs_seq` recurrent-snapshot support (in the pin all
along, arch-gated to qwen3.5) — the engine reads `ENCLAVE_GGML_N_RS_SEQ` at
server-context creation (deployment-config `nnRsSeq` → process env, mm18
shim exports `ell_rewind_depth`, caps[6] surfaces it), and llm-chat 0.34.0's
lookup loop verifies on the REAL sequence, rewinding the rejected tail
(depth covers k). Costs ~1.2 GB VRAM per unit of depth on the 27b.
Correctness: mm18 plain is byte-identical to the mm14 golden archive on the
fleet; locally (full logits rows) rewind-mode output is byte-identical to
plain decode — branch-verify itself is NOT (re-feed numerics flip sampling
ties), so the new path is also more faithful.

Still unconverted: verify b5 costs 30 ms against ~24 ms for a pure replay
(the gap is plausibly the K snapshot writes per layer), and the quote leg
is drafting-limited (n-gram matches are scarce — MTP drafts every round at
77–79% acceptance and is the obvious next port; the loop change is
mechanical, mirror generate_lookup's two-strategy split).

### Same-day follow-ups (also 2026-08-03, later)

- **k=6 / depth-6 is a NEGATIVE** (config-only probe): quote 60.9, prose
  60.8 — marginal lookup acceptance collapses past k=4 (40–46% of drafted)
  and verify climbs back to 37–44 ms (bigger batch + 7 snapshot slots
  written). **k=4 / depth-4 is the lookup sweet spot.** Do not re-probe
  without new information; depth 8 exceeds the 25% share's VRAM anyway.
- **MTP + snapshots: the wedge was VRAM, not kernels — and MTP is closed
  by head overhead, not by strategy.** The depth-4 wedge ("prefilling 768
  prompt tokens" then nothing, decode turn held, /title fine) reproduced
  locally as a CLEAN NULL at head-context creation once the sm_86 card
  freed up: weights + snapshot groups + the head's own full-window KV
  exceed free VRAM; on the fleet the same sum lands at the 25% share's
  MPS pinned limit (~35.2 GB), where an over-limit alloc BLOCKS instead
  of failing — that block, inside the decode turn, is the wedge. Proof
  chain: depth-4-no-mtp runs (lookup-rs), mtp-no-depth runs (34.9/33.5
  tok/s), local depth-1/2 mtp-rs runs FAST (80.7/87.2 vs plain ~53 on the
  3070, rewind-commit, 80–90% acceptance), and fleet depth-2 mtp-rs runs
  with NO wedge. But the fleet number is the tell: **36.8/36.5 tok/s at
  90% acceptance** — identical to every fleet MTP config all campaign.
  ~73 ms/round of which only ~39 is the verify; the rest is k sequential
  head steps + harvest/observe + 4 guest↔host WIT round trips per round,
  all launch-latency-bound on the SNP H200 (locally head steps are
  compute-cheap, hence 87 tok/s there). MTP on this fleet needs a FUSED
  host-side round verb (draft k + verify + accept + rewind in ONE WIT
  call, one CUDA-graphable sequence) — a real engine design item, the
  main unexplored lever. llm-chat 0.34.3+ allows mtp at depth ≤ 2 and
  refuses deeper (the VRAM-calibrated guard); the rewind-commit MTP loop
  is live and correct, just not profitable on CVM hardware yet.
- The bench meter: ~$1.3 remains on the bench deployment
  (0xed05dd04…, throwaway wallet key at ~/.config/enclave/key). It is
  suspended; llm-chat-bench 0.34.2 is the deployed version.

- **0.34.4 (4-gram lookup anchor) closed the session**: quote 63.1 ± 0.4
  (drafting up ~50%, now AT plain with the tightest variance of any spec
  config ever) and prose 69.1/59.2/68.9 — replicating the headline (the
  59.2 is a lookup-found-nothing trajectory; the floor works as designed).
  Pooled prose across both windows: 6 samples, mean 66.9 vs plain 62.8.
- **The verify pass REPLAYS — confirmed by direct trace, and it closes
  the last engine question.** A temporary `ENCLAVE_CG_TRACE` print at
  ggml-cuda's evaluate-and-capture (local sm_86, 0.8b, lookup-rs k4/d4;
  the traced clone lives in the b7e62e01 session scratchpad as
  llama-mm19/, and the clang-CUDA CMake fix needed to build it locally
  is saved there as clang-cuda-build.diff): batch-1 key = 98 replays /
  1 capture, verify key = 16 replays / 1 capture over 16-18 rounds.
  Batched verifies ride full CUDA-graph replay on mm18. Consequence:
  the planned mm19 (batch the K conv-snapshot copies, 240→48 nodes) is
  CANCELLED — those copies are inside a replayed graph, their launch
  cost is already amortized; and the fleet's 30 ms verify vs the ~24 ms
  estimate is EXECUTION cost (wider batch + keep_rs GDN + snapshot
  stores under CC), not overhead. Lookup-rs is at its replay floor for
  this engine generation. (Deferred with it: the ell_mtp_available
  tensor-verification hardening — still worth bundling into whatever
  the NEXT real toolchain cut is.)
- **THE MTP DOSSIER (2026-08-03, Steven asked for every option): correctness
  is DONE, profitability is measured to a parity ceiling.** Correct today:
  rewind-commit MTP validated local + fleet (90% acceptance, no wedge at
  depth ≤ 2, guards hold). The fleet round decomposition (k=2, from the
  mtp2rs2 frames): verify 36–43 ms (gbuild 0.3 → llama reuse fine; local CG
  trace shows the nextn graph REPLAYS, 56/59) + mtp_draft 10–14 ms (2 head
  steps; softmax only ~2.7 ms/step of it — p_min=0 probe made things WORSE,
  32.4 vs 36.8, by forcing full-k drafts) + mtp_accept (head observe)
  9.5–14 ms + topk 1.3 + 4 WIT trips ≈ 70 ms for 2.7 tokens. Head-side
  llama reuse verified locally (LLAMA_GRAPH_RESULT_DEBUG: 228 reuse / 28
  refuse). Options costed: GPU-side argmax for draft steps (−4-6 ms),
  observe folded into next draft call (−8-12 ms), fused round verb (−2-6
  ms), depth-4 k=4 via the new nnCtx knob (+1.4 tokens/round IF the 90%
  chain holds). ALL of them together: round ~45 ms → 60 tok/s at k2,
  65–71 at k4-optimistic — **parity with shipped lookup-rs, never above**,
  because the nextn verify itself (~35 ms replayed, +20% graph vs lookup's)
  eats the winning budget. Head-on-CPU: worse (~30-60 ms/step). Batched
  multi-token head: impossible at depth-1 nextn (sequential by
  construction). VERDICT: park MTP behind lookup-rs on this hardware
  generation; the resident head VRAM is reclaimable via nnLoadMtp:false;
  revisit on (a) an upstream multi-token/eagle-style head, (b) cheaper
  launch/sync under CC, or (c) a model whose nextn verify graph is not
  +20%. If Steven wants the parity-tying bundle built anyway, it is:
  [observe-fold + GPU argmax + fused verb + nnCtx/k4], one toolchain
  cascade + one llm-chat minor, est. 2-4 h + one canary window.
- **mm19 BUILT AND MEASURED the two best MTP fixes — and found the true
  floor.** Shipped fleet-wide (ELL mm19 sha 8f81eb16, image e5a62224,
  release v0.5.364): ell_mtp_draft2 folds the round's accepted tokens
  into the draft call (one WIT trip + ONE arbiter grant instead of two,
  verified locally: 62 draft calls / 2 explicit accepts, byte-identical
  output) and the draft confidence gate went exact-but-cheap (exp only
  within 16 of max — was ~2.7 ms/token of vCPU exp()). llm-chat 0.35.0
  drives it and allows depth 3-4 with MTP when nnCtx <= 128K. FLEET
  RESULT: mtp2rs2 35.5/35.6 (vs 36.8/36.5 pre-fold — nothing), and the
  first-ever depth-4/k4/128K run (no wedge — the nnCtx unlock works)
  managed 37.8/32.9 at 74-76% acceptance with verify 49-55 ms.
  CONCLUSION, now measured to the bottom: the mtp_accept cost was never
  the trip — it was the head decode itself. Every llama_decode on this
  stack has a ~5-10 ms floor regardless of model size (sync + output
  path + launch under CC), and MTP pays it k+1 times per round. Beating
  it needs the whole draft loop inside one decode-free CUDA-graphed
  multi-step head sequence — deep llama surgery, for a mode
  prompt-lookup beats for free. THE MTP FILE IS CLOSED on this hardware
  generation, now with the fixes actually built rather than argued.
  mm19 stays shipped (semantics-identical, strictly cheaper CPU-side,
  depth-4+nnCtx proven safe; plain and lookup paths untouched).
- **THE DECOMPOSITION ARC (mm20→mm22): the per-token budget finally has
  names.** mm20 (sync-instr, ggml proc-registry export): total stream-sync
  waits = 0.18 ms/token on the fleet — no CC sync tax exists. mm21
  (llama_graph_perf2 + the gperf verb): plain decode's 15.6 ms/token =
  **out 14.35–14.75** (output reserve + logits extraction) + comp 1.6
  (sched CPU) + everything else < 0.1. The d2h probe acquits the copy
  itself (pinned AND pageable ~0.6 ms/MB in-CVM). Remaining suspect: a
  PAGEABLE output buffer makes cudaMemcpyAsync a hidden full-stream wait
  (invisible to the sync counter) — llama tries the pinned CUDA_Host buft
  but ggml silently falls back to malloc on cudaMallocHost failure. mm22
  logs the buffer type obtained at every output_reserve (the verdict is
  in every boot log now) and isolates the get_async call (gperf out_get).
  Two endgames: (a) fleet buffer non-pinned → fix the allocation, and the
  ceiling moves from 62 toward the SM-cap bandwidth limit; (b) buffer
  pinned → out_get≈0 relocates the wait, and the 14 ms is GPU exec
  reality (27b batch-1 at a 25% SM cap ≈ 1.2 TB/s achievable ≈ 14 ms) —
  in which case 62 tok/s IS the bandwidth wall, speculation (lookup-rs)
  is precisely the right mitigation (more tokens per weight pass), and
  the per-share ceiling becomes a pricing/SM% conversation, not an
  engineering one.
- **THE VERDICT (mm22): one blocking memcpy.** out_get = 14.20 of the
  14.21 ms `out` bracket - the whole constant is the logits
  tensor_get_async, and blocking-on-pageable is the only CUDA mode that
  fits (pinned submission is microseconds; the mm20 sync counter stayed
  at 8 us because the wait hides inside the driver). The fleet's llama
  output buffer is PAGEABLE - the CUDA_Host attempt silently fell back
  (locally it pins and out_get = 0). Final fleet token model:
  exec-at-SM-cap 9-13 ms (weights / achievable bandwidth at 25% SMs -
  physics) + pageable staging 1-4 ms (mm23 candidate: cudaHostRegister
  the fallback region, bounded ~+20%) + llama CPU 1.7 + WIT 0.6. The
  62 tok/s wall is ~85% share physics: speculation was the right lever
  all along, buffer pinning is the one bounded engineering item left,
  and the rest is SM%/share sizing. Boot logs now name the buffer type
  at every output_reserve - grep "output buffer =" on any node.
- **Do the fused-round-verb arithmetic BEFORE building it** (it looked
  like the next mountain; the numbers say no). Best case — one WIT call
  per round, head steps CUDA-graphed at ~3 ms: the mtp verify itself
  still costs 39–42 ms (harvest of nextn rows is inherent to MTP), so a
  k=2 round lands ≈45–48 ms for ~2.7 tokens ≈ 58 tok/s, k=4 ≈ 63 —
  BELOW lookup-rs's 68. Same wall for a small draft model (0.8b steps
  are launch-latency-bound ~10–15 ms on the CVM like the head's).
  **General law of this hardware: sequential per-token draft steps of
  ANY size lose to the launch-latency floor; only free proposers
  (prompt-lookup) and the trunk's own batched verify come out ahead.**
  What would actually move the needle next: an upstream pin bump that
  cuts the 15.4 ms batch-1 replay floor (benefits plain AND every spec
  round), or batched/tree drafting where k proposals come from ONE
  pass — neither is a knob, both are engine campaigns.

**Current best config on mm18: `draft:"lookup", draft_tokens:4,
tokenizer:"host"` + deployment `nnRsSeq:4`, llm-chat 0.34.6.** The
complete workload map (fleet, 27b, all measured this session):

| workload | plain | lookup-rs | note |
|---|---|---|---|
| short explainer (256 tok) | 62.8 | 68.0 | +5.2; 6-sample pooled 66.9 |
| quote-structured (256) | 63.8 | 63.1 | parity, tightest variance ever |
| turn-2 of a conversation | 62.9 | 64.2 | +1.4 at ~50% acceptance |
| long-form novel (1024) | 64.4 | 62.8 | was −2.6 ungated; 0.34.5 EMA
gate + 0.34.6 exponential probe backoff + 2048-token scan cap restored
it to noise-range; best leg 64.4 with acceptance RISING to 53% (the
gate drafts only where drafting works) |

Byte-exact plain-fidelity held on every app version (local golden gate).
The catalog publish (Steven's wallet) is still the item worth more than
any of this. Bench deployment: suspended, ~$0.35 escrow left,
llm-chat-bench 0.34.6 deployed — refund or refill before the next
campaign.

## The one-line status (pre-mm18, kept for context)

Speculation went from **-40%** (the published config, MTP k=16, ~39 tok/s
against plain decode's 62–66) to **parity** (prompt-lookup k=4, ~61.5 mean
against plain ~62.5, individual samples to 70.0). It is no longer a mode
that costs throughput. It is **not** a durable win, and the last ~15 ms per
verify pass never converted.

## Why speculation is hard on this specific stack

The target is `fable-fusion-27b` — **dense** (GGUF arch `qwen35`, no expert
tensors; the 122B is the MoE) and **hybrid-SSM** (48 recurrent linear-attention
layers + 17 full-attention layers). Two consequences drive everything:

1. **Partial rewind is impossible.** Recurrent state keeps no per-token
   history, so a rejected draft cannot be rolled back. The engine therefore
   verifies on a **scratch branch**: `ell_seq_copy(real → scratch)` each round
   (`seq_rm` + `seq_cp`), verify on the branch, adopt on full accept, re-feed
   accepted tokens on the real sequence on partial accept.
2. **That branch churns memory state every round**, which is what defeats
   graph reuse (below).

## The cost structure (measured, this is the important part)

| pass | cost |
|---|---|
| batch-1 step, CUDA-graph replayed | **15.1–15.8 ms** |
| batch-1 step, un-graphed (`feed_cold`, first step only) | **30.5 ms** |
| verify batch 2 | 32.1 ms |
| verify batch 3 | 43.3 ms (best ever measured: 28.8 ms under mm15) |
| verify batch 5 | 41.2 ms |
| verify batch 8 | 47.1 ms |

Read it as: a verify pass is **fixed-cost dominated** — a ~16 ms step just to
leave batch-1, then only ~2.5 ms per additional token. And that fixed step is
almost exactly **the value of CUDA-graph replay (15.4 ms)**, because batched
passes never replay while batch-1 does.

**The arithmetic that motivated the whole campaign:** a replaying batch-5
verify would cost ~24 ms → a k=4 lookup round ≈ 29 ms for ~3 accepted tokens
≈ 9–12 ms/token ≈ **85–115 tok/s** against plain's 62–66. That is the prize,
and it is still unclaimed.

### Why batched passes don't replay

Chain, each link verified in source or by measurement:

- ggml-cuda replays when `cgraph->uid` is unchanged (it then skips property
  checks entirely). Batch-1 achieves this because llama **reuses** its graph.
- llama reuses only when `llm_graph_result::can_reuse` passes, which requires
  `llm_graph_params::allow_reuse` (compares ubatch shape **and participating
  sequence ids**) plus every graph input's own `can_reuse`.
- On hybrid models `llm_graph_input_rs::can_reuse` requires
  `head == mctx->get_head()` — the **recurrent memory head must not move**.
  The scratch branch moved it every round (stock `seq_cp` hands the
  destination the source's tail cell, and `find_slot`'s "gather and re-order"
  then swaps cells). → fixed by **mm14**.
- `can_reuse_kq_mask` only needs `n_kv` to match, and llama pads `n_kv`, so
  attention was **not** the blocker (verified — do not re-chase this).
- The remaining blocker was slot keying: verify batches (scratch seq) and
  equally-sized partial-accept re-feeds (real seq) shared a cache slot and
  alternated. → fixed by **mm15** (key by `(n_tokens, seq_id)`).

After mm14+mm15 the CPU-side rebuild cost dropped (gbuild 2.66 → ~1.1–1.6 ms)
and verify decode reached 28.8 ms once — but never held there.

## What shipped and what it bought

Live on the fleet now (all in-repo, all with kill-switches):

| build | change | effect |
|---|---|---|
| mm13 | `wasm/llamacpp-cuda-graph-ptr-update.patch` — classify topology-vs-pointer-only graph changes; let pointer-only churn capture + `cudaGraphExecUpdate`. Kill: `GGML_CUDA_GRAPH_PTR_UPDATE=0` | +12–18% on spec configs |
| mm14 | `wasm/llamacpp-rs-pin-cells.patch` — pin each sequence's recurrent state cell to index == seq_id (copy-on-write via `cell.src`). Kill: `LLAMA_RS_PIN_CELLS=0` | gbuild 2.66 → 1.46 ms |
| mm15/16/17 | `wasm/llamacpp-graph-slot.patch` — LRU ring of graph slots keyed by `(n_tokens, seq_id)`, 12 slots, per-shape reserve; plus 300 s graph idle retention (`GGML_CUDA_GRAPH_IDLE_SEC`). Kill: `LLAMA_GRAPH_SLOT_ALT=0` | best single verify 28.8 ms; net ≈ neutral |

Current pins: ELL `enclave-llamacpp-ddd4ec14-mm17`
(`3afa504f5cc9a809e8e6891cbb69b5e75797fec99275f3d1905f33600bbe173c`),
image `sha256:9e7124ee5fe22c6fbfdb081ff024618f8671d7f03b181950736abf4729dc9386`.

**Plain decode is unaffected by all of it** (62–63 tok/s, sd 0.6) — that has
been re-checked on every build and is the guard to keep.

## What did NOT work (do not repeat without new information)

- **mm7 / mm10** — shape-keyed CUDA-graph capture, and a graph slot ring keyed
  by shape alone. Null or regressive.
- **mm14 alone** — pinning recurrent cells without sequence-keyed slots.
- **mm16** — widening the ring 3 → 12 without understanding eviction: fixed
  k=4, regressed k=2 by the same amount.
- **mm17** — 300 s graph retention. No gain; eviction was not the blocker.
- **Kernel selection** — batches ≤ 8 already take the fast MMVQ path on
  NVIDIA (`ggml_cuda_should_use_mmvq`, `MMVQ_MAX_BATCH_SIZE == 8`). Not the
  problem.
- **q8_0 KV dequant on the MMA attention path** — real (`fattn-common.cuh`
  ~1022) but small (~25–30 µs/op). Also batch ≤ 2 stays on the VEC kernel
  anyway, and the big step is 1 → 2.
- **D2H / logits transfer** — measured in-CVM: pinned memory works
  (`pinned_ok=true`), 0.63 ms/MB linear. Not the problem.
- **The arbiter, the decode gate, allocation, MPS capping** — all measured
  innocent via the `phase_us` instrument.

## The next real idea (a different class of change) — DONE, see the mm18 update above

Every remaining approach in the "make the branch stable" family is exhausted.
The one structural idea left: **verify without a scratch branch.**

Run the verify pass on the *real* sequence (stable seq id, stable head, stable
KV geometry → graph reuse → replay), and on partial accept restore the
recurrent state from a **depth-1 snapshot** rather than rebuilding a branch.
llama has `llama_context_params.n_rs_seq` snapshot support, arch-gated to
QWEN35/QWEN35MOE. Cost measured earlier in the campaign: the RS buffer
multiplies by (1 + depth), i.e. ~1.2 GB extra at depth 1 for the 27B
(1197 MiB base). That is affordable on an H200 share where depth 8+ was not.

If that lands, the verify pass should replay and the arithmetic above says
85–115 tok/s. It touches the shim (`ell_seq_*`), the wasi-nn ggml backend's
speculative verbs, and llama context creation — a design change, not a knob.

## How to work on this without wasting the budget

Hard-won process rules, each of which I violated at least once:

1. **Never conclude from a single fleet sample.** Identical configs range
   55–70 tok/s. Run ≥ 3 samples and report the spread
   (`scratchpad/multi.sh` does this). Effects smaller than ~4 tok/s are
   inside the noise floor.
2. **Never treat the repeat-guard / looping reasoning as a corruption
   signal** — it is long-standing behavior of this model and is why the guard
   exists. The only valid correctness gate is a **temperature-0
   golden-transcript diff** (`scratchpad/golden-diff.sh`): same prompt, same
   config, engine A vs engine B, compare text byte-for-byte. Plain decode
   should be identical across engine changes; speculative configs legitimately
   differ from plain (topk sparse logits is a documented approximation).
3. **Verify that a pin edit actually applied.** A `sed` silently no-opped once
   and nearly caused a whole build to be measured under the wrong label. Use
   Python with assertions; check `git diff` before pushing.
4. **Space the releases.** Every push to main cuts a release and repoints the
   fleet; two within ~3 minutes wedge the Tinfoil updater
   ("an update is already in progress"). Recovery is `fleet-op.yml`
   stop → start, not retry/relaunch. Watch the publish job explicitly.
5. **Suspend the bench instance when done** — it bills $1.62/h and drained
   twice while builds ran.
6. **Local validation is necessary but not sufficient**: the CVM's vCPUs build
   graphs ~1000× slower than the workstation (0.008 ms vs 2–3 ms), which is
   why CPU-side costs are invisible locally and dominant on the fleet.

## Test assets

- Bench deployment `0xed05dd0468e32a3a379f33b1ef5f11224d49d8dd550dd40351edde04676e045d`
  (private, owned by the throwaway wallet `0x3977E339…`, 25% GPU on kryptos,
  ~$3.55 banked). Access: `https://api.enclave.host/x/<id>` with an owner
  bearer from `scratchpad/session.mjs` (bearers expire ~1 h — re-mint per leg;
  app restarts rotate the in-enclave JWT keys).
- App `llm-chat-bench` (slug), currently 0.33.4 = llm-chat with `phase_us`,
  `feed_cold`, and per-verb timing. Private versions deploy without catalog
  approval.
- Scratchpad harnesses: `multi.sh` (3-sample), `golden-diff.sh` (correctness),
  `scaling2.sh` (batch sweep), `verdict-mm15.sh`, `parse-scale.py`.
  `llama-pin/` is the pinned llama.cpp checkout with all patches applied;
  `build/` is CUDA (sm_86), `build-cpu/` is CUDA-free for GPU-independent
  correctness runs.
- Instrument reference: the `/chat` done frame carries `verb_us` with
  `feed_cold` / `feed_warm` / `feed` (batch-1: un-graphed, mixed, replayed),
  `feed_all[_mtp]` (verify) and its `#gate #alloc #turn #decode #harvest
  #topk #gbuild #galloc #ginput #slot` split.

## The thing to do first, before any of this

Publish a current llm-chat build with `~/llm-chat-fast-config.json`
(`draft: "lookup"`, `draft_tokens: 4`, `tokenizer: "host"`). Users are on the
old catalog version at ~39 tok/s; this puts them at ~62 with TTFT roughly
halved. Needs Steven's publisher wallet. **That single publish is worth more
than everything the 17 engine builds produced**, and none of it depends on
speculation working.
