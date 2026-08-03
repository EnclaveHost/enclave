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

## UPDATE 2026-08-03 (later still): the batch-cost curve is CONVEX, and
## "k exploration is closed" was WRONG — it was only closed UPWARD

Read this before touching `draft_tokens` again. The campaign's cost model
assumed a **constant** marginal cost per in-batch token (~3.5 ms on the
fleet 27b). That constant was fitted entirely inside the k≥4 regime,
because every bench ever run used k=4 or higher (k=4 means a **5-token**
verify batch). Below that, the curve is much cheaper — and nobody had
looked, because "k exploration closed both directions" recorded two
experiments (fixed k=6, adaptive escalation to k=6) that both went UP.

**Measured cost of one decode vs batch width** (9b MTP — same `qwen35`
hybrid-SSM arch as the fleet 27b — RTX 3070, `tools/specbench/
batch-cost-sweep.py`, medians of 40–60, reproduced at prefill 512 AND
2048; and independently from in-app `feed_all#decode` counters):

| batch | synthetic | in-app | incremental |
|---|---|---|---|
| n=1 (plain) | 18.94 ms | 18.2 ms | — |
| n=2 (k=1) | 20.06 | 20.2 | **+1.1** |
| n=3 (k=2) | 21.50 | 23.3 | **+1.4** |
| n=4 (k=3) | 25.17 | 28.3 | +3.7 |
| n=5 (k=4) | 28.24 | 30.9 | +3.1 |
| n=6 (k=5) | 31.29 | 35.1 | +3.0 |
| n=8 (k=7) | 38.04 | 39.0 | +2.7 |

The first two extra tokens are nearly free; the step lands at n≥4. The
old 3.5 ms/token constant is a good fit for n≥4 and badly wrong below it.

**Break-even acceptance is (round tax)/(plain step)**, so it collapses
with k: **k=1 ≈ 11%, k=2 ≈ 16%, k=4 ≈ 33–40%.** The shipped config needs
~40% acceptance merely to stop losing, which is exactly why it nets only
+5 tok/s on prose and went NEGATIVE on long-form.

**Round overhead outside the decode is NOT the story** (I expected it to
be). From the in-app counters: `rewind` is ~15 **microseconds** per call,
gbuild ~60 µs, galloc ~50 µs, alloc ~40 µs, topk 0.3–1.2 ms. Total under
~1.5 ms. The round tax is the batch width, essentially nothing else.

**Local long-form A/B** (9b, 768-token novel prompt, 2 reps, reps within
0.6 tok/s of each other — new `lookup<N>[g<MIN>][x]` harness kinds):

| config | mean tok/s | vs plain | drafted/accepted |
|---|---|---|---|
| plain | 55.05 | — | — |
| lookup k=4 (SHIPPED) | 59.2 | +7.5% | 36/17 (47%) |
| lookup k=1 | 57.9 | +5.1% | 16/10 (63%) |
| lookup k=1, 3-gram floor | 60.0 | +8.9% | 22/16 (73%) |
| **lookup k=2, 3-gram, gate off** | **60.3** | **+9.5%** | 38/19 (50%) |

k=2/3-gram/gate-off beat shipped k=4 on BOTH reps individually. Two new
default-off config knobs make this sweepable without changing shipped
behaviour: **`draft_min_ngram`** (anchor floor, clamped 2..=6) and
**`draft_gate`** (false disables the EMA pause + anchor escalation). The
gate and the 4-gram floor were both tuned against k=4 economics — at k=1/2
a misfire costs ~2 ms instead of ~12.7 ms, so anchors that were correctly
rejected as "pure round tax" at k=4 can pay for themselves.

**Fidelity caveat found while doing this.** At 768 tokens, batched verify
is NOT byte-identical to plain: plain, k=4, and the small-k configs
produced three DIFFERENT (each internally reproducible) outputs. This is
not a new bug and not caused by the knobs — it is argmax over near-equal
logits where a batch-n decode's reduction order differs from batch-1's, so
sampling ties break differently. It is pre-existing in the shipped k=4
path. The "byte-exact vs plain" golden gate holds at 160–256 tokens and
degrades with length; treat it as length-sensitive, not absolute.

### FLEET VERDICT: small k LOSES on kryptos. The shape does NOT transfer.

Measured immediately after the above (3 samples × 2 prompts per config,
plain run first in the same window as a contention guard, $1.07 of lease):

| config | quote | prose | verify decode |
|---|---|---|---|
| plain | **63.4** ± 1.0 | 61.6 ± 0.5 | — |
| lookup k=4 (SHIPPED) | 60.5 ± 0.8 | **66.1** ± 4.5 | ~32 ms (batch 5) |
| lookup k=2 | 58.2 ± 0.2 | 62.2 ± 2.7 | ~29 ms (batch 3) |
| lookup k=1 | 59.4 ± 0.3 | 64.8 ± 2.2 | ~27 ms (batch 2) |

**The fleet's batch-cost curve is the INVERSE of the local one.** Back out
the verify decodes: batch-1 ≈ 15.4 ms, but batch-2 already costs ~27 ms —
an **~11.6 ms penalty for the FIRST extra token** — after which each
further token adds only ~1.8 ms (27.0 → 29.3 → 32.4 for batch 2 → 3 → 5).
Locally that first step cost 1.1 ms. Break-even acceptance therefore runs
the other way on the fleet: **k=1 needs ~75%** (measured lookup acceptance
is ~73%, i.e. right at the edge) while k=4 amortises the cliff over four
proposals.

**Why:** batch-1 decode is the CUDA-graph REPLAY path; any wider batch
leaves it and pays a fixed re-entry cost that the CC/MPS stack makes
large. The 3070 has no such cliff. So on this hardware, once you have paid
to leave replay you should buy as MANY tokens as the acceptance supports —
which is precisely what k=4 does.

**Net: the shipped `draft_tokens: 4` is CORRECT for the fleet and the
"k=4 sweet spot" conclusion stands.** What was wrong was only its stated
*reason* (a constant ~3.5 ms/token marginal). The real structure is a big
fixed cliff plus a small slope. Small k remains the right shape on
hardware WITHOUT the replay cliff (consumer GPUs, self-hosted metal), and
the `draft_min_ngram` / `draft_gate` knobs stay useful there — but do not
ship them to kryptos expecting a win.

**The lever this actually identifies:** the ~11.6 ms replay-cliff, not the
per-token slope. If a verify pass of stable width could replay a captured
graph as cheaply as batch-1 does, every speculation config improves at
once — including the quote workload where ALL configs currently lose to
plain. That is the engine campaign worth mounting, and it now has a
number attached to it.

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
- **mm23 OPENER (specified, not built): why cudaMallocHost fails in
  tenants.** ggml's host alloc short-circuits on GGML_CUDA_NO_PINNED
  (nothing sets it) or a real cudaMallocHost failure. Prime suspect:
  CUDA_MPS_PINNED_DEVICE_MEM_LIMIT in the tenant env (the manager's nn
  probe even has a 'nopin' mode that drops exactly that var when cuInit
  hangs under it). Supporting evidence: the d2h probe's pinned and
  pageable timings are IDENTICAL (686 vs 652 us/MB) - its "pinned"
  buffer silently fell back too (pinned_ok=true cannot detect the
  fallback; fix the probe to check ggml_backend_buffer_name). The
  experiment: run one tenant without the MPS pinned limit (or
  cudaHostRegister the fallback region in ggml), then read the mm22
  boot-log line 'output buffer = ' - CUDA_Host means out_get drops
  ~1-4 ms/token platform-wide. Everything needed ships in mm22 already;
  mm23 is a manager-env experiment plus at most a 15-line ggml patch.
- **THE FINAL CORRECTION (mm23): no overhead was left at all.** The
  fleet boot log (capture: resume -> one title probe -> pull logs before
  request spam floods the window) reads 'output buffer = CUDA_Host' -
  pinned all along, cudaMallocHost fine. With a bare-cudaMemcpyAsync
  get_tensor_async and a pinned dst still blocking 14.2 ms, the driver
  itself forces synchronous D2H under the CC stack: the memcpy waits for
  the stream (the whole forward pass), invisible to every sync counter.
  Final reconciled batch-1 budget: ~13.5 ms GPU exec (bandwidth at the
  25% SM cap) + 0.65 copy + 1.7 CPU = the measured 15.6-16. **62 tok/s
  is the share's physics.** The only lever over physics is
  tokens-per-exec - speculation - which is shipped and winning
  (lookup-rs). mm23's hostRegister rescue stays as insurance for nodes
  where pinned alloc DOES fail. Bonus discoveries: GGML debug lines
  reach tenant logs ('CUDA Graph id reused' x248/window = production
  replay confirmed without any instrument), and the boot-log capture
  recipe above. The mm7->mm23 arc is complete: every theory tested,
  every millisecond named, and the one config that beats physics is the
  one already recommended for the catalog.
- **Adaptive-k (hot-streak escalation to k=6): tried, soft NEGATIVE,
  reverted.** Quote 60.7 vs the flat-k 63.1 baseline (unguarded daytime
  window - kryptos contention suspected, but the direction agrees with
  fixed k=6's clean negative). The physics explains it: each in-batch
  draft token costs ~3.5 ms of sequential hybrid-scan regardless of
  acceptance, so k>4 needs >70% MARGINAL acceptance at depth 5-6 to
  break even, and lookup's tails don't deliver that on this model.
  llm-chat 0.35.5 reverts to flat k (gate + backoff kept) and is the
  deployed bench build. K EXPLORATION IS CLOSED both directions.
  **CORRECTION (same day, see the cost-curve update above): the stated
  REASON was wrong, the conclusion was right. Both experiments went UPWARD
  (fixed 6, escalation to 6), so k=1/k=2 were never benched — they have
  been now. On the fleet the cost is a ~11.6 ms cliff at the first extra
  token plus a ~1.8 ms/token slope, NOT a flat 3.5 ms/token; small k loses
  (prose: k4 66.1, k1 64.8, k2 62.2) and k=4 stays the sweet spot. Small k
  wins only on hardware without the CUDA-graph replay cliff (measured
  better than k=4 locally on a 3070). K exploration is now closed in both
  directions FOR REAL, with the measurement to back it.**
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

## The harness is now IN-REPO: tools/specbench/

ab-serve.sh (local byte-exact A/B), fleet-bench.sh (fleet golden + 3-sample
matrices), the measured cfg-*.json, session.mjs (bearer minting), and a
README carrying the measurement discipline. The session-scratchpad copies
this doc used to reference die with the workstation; these do not. Gate
every future engine/pin bump through them.

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

## STEVEN'S PUBLISH CHECKLIST (2026-08-03, everything staged)

The one action worth more than the whole campaign, now a copy-paste:

1. `~/llm-chat-fast-config.json` is CURRENT (draft lookup k4, tokenizer
   host, **nnRsSeq 4** added 2026-08-03) - the measured-best config on the
   mm18+ engines (prose 66.9 pooled vs plain 62.8, parity floor elsewhere,
   long-form protected by the 0.34.5/6 gate).
2. Build is current in the repo: enclave-apps llm-chat **0.35.5**
   (`cargo build --target wasm32-wasip2 --release`) - same source the
   bench validated all night.
3. Publish with YOUR wallet (the bench throwaway cannot):
   `enclave publish .../llm_chat.wasm --slug llm-chat --version <next>
   --config "$(cat ~/llm-chat-fast-config.json)" ...` (match the current
   catalog entry's mem/vram; catalog numbering is its own - map by CID).
4. Existing deployments pick the version config on upgrade; the
   `nnRsSeq` knob reaches the engine via the deployment config
   (manager v0.5.360+, engine mm18+ - the whole fleet qualifies).
5. Expected user-facing delta: the 2026-08-01 A/B measured the shipped
   catalog config (mtp k16/.3) at ~39 tok/s vs plain ~59-62; this config
   benches 62-69 with TTFT roughly halved (host tokenizer). Verify after
   with tools/specbench/fleet-bench.sh against any deployment you own.

## The thing to do first, before any of this

Publish a current llm-chat build with `~/llm-chat-fast-config.json`
(`draft: "lookup"`, `draft_tokens: 4`, `tokenizer: "host"`). Users are on the
old catalog version at ~39 tok/s; this puts them at ~62 with TTFT roughly
halved. Needs Steven's publisher wallet. **That single publish is worth more
than everything the 17 engine builds produced**, and none of it depends on
speculation working.
