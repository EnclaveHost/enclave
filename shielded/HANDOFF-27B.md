# Handoff: getting the shielded 27B past 20 tok/s

> **Status 2026-09-23 (wrap-up, `shielded/REPORT.md` 18.50-18.54).** The goal
> moved to **25 tok/s sustained** and is **not reached**. Best validated: the
> official build (llamacpp-toolchain patches, production AVX2 flags) runs the
> shielded 27B at 21.05 / 21.40 / 19.69 tok/s (median 21.05); the development
> fork's clean baseline median is 21.30, and the best single valid run of the
> campaign is 24.51. Nothing from the late CPU-kernel work ships: the register
> row is AVX-512 only; streaming-store snapshots made the op cheaper but the
> verify round ~5 ms SLOWER on the official path. Read 18.52-18.54 before trying
> another recurrent-op kernel, and gate any candidate with
> `wasm/llamacpp-conv-inplace/official-toolchain-check.sh` plus 27B round timing,
> never the op profile alone. The bench harness lives in `shielded/bench-harness/`
> (it used to live in a tmpfs scratchpad and was lost once). Merge readiness,
> the open acceptance gaps (Freivalds rejections, no model-matched quality eval,
> multi-sequence abort in the official graph-slot patch, since FIXED on the branch,
> REPORT 18.55): `shielded/WRAPUP-27B-INTEGRATION.md`.

You are picking up a performance campaign on Enclave's **shielded inference**
tier. Read all of this before touching anything. It is written for an agent
with no prior context, and most of its value is in the parts that say *this
was already tried and it did not work* -- there are a lot of those, and
repeating them costs hours each.

## The goal

**20 tok/s, sustained (median, not peak), on the shielded 27B.**

Where it stands: **17.98 tok/s median, 19.95 peak** with speculative decoding
(k=1) on two V100s. It started the previous session at 14.05. The unmasked
ceiling for the same model on the same two cards is **30.36 tok/s**, so
shielding currently costs 1.72x.

20 is reached as a peak and not as a floor. Closing the last ~11% is the job.

## What the system actually is

Slalom-style additive one-time-pad masking, so an **untrusted GPU** can do the
matmuls without learning the weights or the activations.

- **Model**: `Qwen3.8-27B-UD-Q4_K_XL` (64 layers: 48 gated-delta-net recurrent
  + 16 attention, plus an MTP head used as the speculative drafter).
- **The enclave half** holds the secrets and runs every NONLINEAR op on the
  CPU: embedding lookup, norms, activations, the delta-net recurrence,
  attention, the KV cache, sampling.
- **The card half** does only masked matmuls. The TEE sends `x + r` and
  subtracts a precomputed `W·r`, so `W·(x+r) - W·r = W·x`.
- **Field**: RNS over the byte primes 251/241/239, `M = 14457349 ~ 2^23.8`.
  Weights are int8 with `|w| <= 119`, which is *exactly* `min(prime)/2` -- at
  or below it a weight IS its own balanced residue in all three lanes and
  needs no decomposition. This single fact kills several otherwise-obvious
  ideas; see the dead ends.
- **Integrity**: masking buys confidentiality ONLY. Every product is checked
  with preprocessed Freivalds over the integers mod 2^31-1, which catches both
  a lying worker and a field wrap.
- **Transport**: a `/dev/shm` ring per card, spin-polled on both ends.

## Invariants you must not break

These are security properties, not preferences. Breaking one silently
destroys the guarantee the whole tier exists for.

1. **A fresh pad per (layer, token).** Reuse, or any linear combination of
   pads, lets the host solve for them.
2. **Exact ring arithmetic in Z_M.** No saturation, requantisation or
   rounding anywhere between mask and unmask.
3. **`r` never leaves the TEE unmasked**, and pads are never computed on any
   device outside it, nor derived from a fixed structured source.
4. **Nonlinear ops stay in the enclave.** This is why the CPU half is large;
   it is not an oversight to be optimised away.
5. **Freivalds stays on.** It fails closed, which is your best debugging
   signal: if any arithmetic path disagrees with any other, you get
   `verification FAILED` rather than a wrong answer.

## The budget, and why it is the most useful thing here

A speculative verify pass puts TWO tokens through ONE weight stream, which
splits the token for free. With `W` the per-PASS cost and `C` the per-TOKEN
cost:

```
plain  (1 token) : W + C  = 58.4 ms
verify (2 tokens): W + 2C = 93.4 ms
  =>  W = 23.4 ms/pass,  C = 35.0 ms/token
```

Independently confirmed at k=2 and k=3 (predicted verify 163.4 ms at m=4,
measured 161.3). Use this decomposition for every estimate you make.

- `W` = 12.7 ms streaming (21.6 GB of int8 field weights over two V100s at
  ~850 GB/s, halved because the columns are split) + ~10.6 ms of per-exchange
  launch-and-sync (241 exchanges at ~44 us).
- `C` = ~17 ms of CPU graph ops (delta-net dominant) + the serial
  mask/encode/unmask field arithmetic + scheduler.

**The GPU half is nearly spent. `C` is the wall.** Anything that buys part of
`W` -- more cards, a narrower lane, a faster card -- buys none of `C`.

It also explains why drafting barely pays: an accepted token saves `W` but a
drafted token costs a full `C`, and `C > W`. If you cut `C`, speculation gets
better *and* the token gets shorter; they compound.

## What is shipped (all on main, all output-verified)

| change | where | effect |
|---|---|---|
| Graph-cache default 256 -> 1024 | `shielded/worker-cuda/captured-graphs.h` | It was silently hiding the column split: 24 hits vs 17,733 misses, 68 capacity flushes. Policy is clear-at-capacity, so a pass that does not fit reuses NOTHING. The 27B needs 274 keys per split pass, 514 for a speculative round. |
| Recurrent state aliased + updated in place | `wasm/llamacpp-rs-inplace.patch` | The state was copied FOUR times per delta-net layer per token. plain 15.4 -> 17.1, token-identical. |
| GEMM epilogue writes into the shm ring | `shielded/worker-cuda/worker.cu` | The kernel already wrote into mapped host memory; the reply was then memcpy'd into the ring (~14 MB/pass). spec median 17.60 -> 17.98. |
| Column split over both cards | **SCRATCHPAD ONLY -- see below** | plain 13.4 -> 15.2. Cards used to alternate by LAYER, and layers are sequential, so the second card was idle half the time. |
| REPORT section 16 | `shielded/REPORT.md` | ~350 lines, every measurement including the negatives. **Read 16.1-16.11 first.** |

### Do this first

**The column split exists only in the session scratchpad
(`$SCRATCH/gs-split/`), not in the repo.** It is worth +13% on plain decode
and it will be lost when that directory is cleaned. Port it into
`wasm/ggml-shielded/` before you do anything else. It touches
`ggml-shielded.cpp` (`sh_split_cols`, `sh_split_worker`, `sh_split_post`,
`sh_split_exchange`, placement in `sh_plan`) and `shielded-tee.{c,h}`
(`sh_link_gemm_stride`, `sh_link_gemm_local_stride`). Env: `SHIELDED_SPLIT_COLS=1`,
`SHIELDED_SPLIT_WEIGHTS=45,45,10` for relative shares.

## Dead ends -- measured, do not repeat

Every one of these was run against the same build on an idle box.

| lever | result (plain / spec k=1, tok/s) |
|---|---|
| decode threads 6 / **8** / 10 / 12 / 16 / 24 | 17.07 / **17.11** / 16.19 / 14.62 / 11.56 / 6.43 |
| speculation depth k = **1** / 2 / 3 | **17.67** / 14.83 / 15.41 |
| `GOMP_SPINCOUNT=infinite` + `OMP_WAIT_POLICY=ACTIVE` | 16.41 / 17.37 vs 16.83 / 18.00 |
| `GOMP_SPINCOUNT=1000` (park decode threads early) | 15.26 / 15.11 vs 16.37 / 16.74 |
| `OMP_PROC_BIND=close` + `OMP_PLACES=cores` | **2.19 / 2.12** -- an 8x collapse |
| `SHIELDED_REFILL_THREADS=2` | **5.26 / 5.37**, `refill-on-path=24467 ms`, 12451 missed pads |
| delta-net inner loop fused, 4 sweeps -> 1 | 17.22 / 17.70 vs 16.98 / 17.78 (bit-identical, +1%) |
| mask+encode split over helper threads | neutral at best; first attempt hung at 226% CPU |
| workers off MPS, and MPS at 100% SMs | no measurable change |
| a THIRD card (the desktop's RTX 3070) | median 17.65 vs 18.71 -- **slower** |
| packed int6 weight lane | **3.2x slower kernel** -- see below |
| Freivalds RHS overlapped into the ring spin window | **verification FAILS** |

Four of these carry information worth more than the negative result:

- **The box looks saturated but is not.** 16 physical cores (EPYC 9115,
  SMT2), 8 decode + 8 pad-refill threads. Pinning collapses it 8x and starving
  refill collapses it 3x -- but the bench only uses ~728% of 1600% CPU. **The
  CPU half is SERIAL, not throughput-bound.** More cores do not help; less
  serial work does.
- **The refill threads are not spare capacity.** They are what keeps pads
  ahead of the decode. Take them away and the pool dries and every miss is
  generated on the request path.
- **A third card is slower because an exchange is not done until the SLOWEST
  card answers.** More cards only pay while streaming dominates the ~10.6 ms
  of launch-and-sync, which at two V100s it no longer does.
- **The int6 lane is dead on sm_70, measured twice over.** (a) REPORT 15.5's
  2.07% error figure is not implementable in this field: its 16-bit block
  multiplier raises weight magnitude ~550x, and going past `|w| <= 119` is
  paid for in the ACTIVATION's calibrated exponent, since the field only
  recovers `|W·x| < M/2`. The field-compatible form measures 2.87-3.08% vs
  1.32-1.41% for int8. (b) Decisively, the card cannot collect the bytes:
  `shielded/lane/i6_kernel_bench.cu` measures packed 6-bit at **137-153 GB/s
  against 546-717 for int8**, even with the +32 bias folded into a per-block
  correction and LOP3-shaped field extraction. One byte per weight is what
  dp4a wants. This is sm_70's ALU:bandwidth ratio -- **re-run that benchmark
  before assuming it holds on a bandwidth-limited card.**

## The harness

Everything lives in the session scratchpad under `b27/`. Recreate it if gone.

```
run6.sh LABEL [K] [THREADS] [N]    one run; extra env passes through
bench-spec2                         the bench (prints "[bench] plain tokens: ..."
                                    so two builds can be diffed exactly)
workers-shm.sh start|stop           the two V100 workers on /dev/shm rings
reset-harness.sh                    kill EVERY chain/queue/runner/bench
kill-tree.sh <pid>                  kill one queue AND its runner, not another
```

A typical run:

```bash
SHIELDED_MAX_M=64 BENCH=$B/bench-spec2 WARM=1 PREFILL_REPS=0 \
SHIELDED_REFILL_BATCH=64 SHIELDED_POOL_DEPTH=64 \
ELL_DIR=$S/ell-alias CPU_SO=$S/llama-alias/bin/libggml-cpu.so \
SHSO=$S/gs-split/libggml-shielded.so SHIELDED_SPLIT_COLS=1 \
$B/run6.sh label 1 8 64
```

### Measurement hygiene -- this bit me hard

- **Check `pgrep -x bench-spec2 | wc -l` is 1 before trusting any number.** A
  chained queue once left a second bench running (load 12 on 16 cores) and
  produced a 19.64 and a 13.1 in the same hour, neither real. I nearly
  reported the 19.64.
- **Never `pkill -f` a pattern that appears in your own command line.** It
  kills your shell. Put kill logic in a script file with anchored patterns.
- **45 s between runs.** The worker holds a 20 GB reservation until the link
  fully closes; start too early and you get
  `VIOLATION: reservation exceeds the budget`.
- Run-to-run spread is **+-1.2 tok/s**. Take medians of >= 5, report the
  spread, never a single best run.
- Diagnostics: `ENCLAVE_OP_PROFILE=1` (per-op CPU profile),
  `ENCLAVE_RS_DEBUG=1` (audits that every graph built with the state alias
  really faced an identity gather), `SHIELDED_PROFILE=1` (link phase timings;
  **note the profile lines are CUMULATIVE snapshots -- read the LAST pair, I
  wasted an hour reading the first**).

### Trap worth knowing

The state alias SHAPES the graph, so every `can_reuse` path must check it.
`llm_graph_input_rs::can_reuse` is **not** the path a hybrid model takes --
three other input classes duplicate the same rs checks inline. Fixing only the
first left graphs being replayed across a speculative rewind: still fluent
output, acceptance drifting 0.83 -> 0.73, caught only by `text_identical`. **A
plain-decode A/B cannot catch that class of bug**, because plain decode never
rewinds.

## Where to be creative

The cheap knobs are exhausted. What is left needs an idea, not a sweep. In
rough order of how much I would bet on them:

1. **Dealt pads.** The 8 refill threads exist only because the enclave mints
   its own pads (`u = W·r` is a matmul). The architecture for pads minted by a
   separate user-trusted dealer and shipped in **already exists** (P1-P4a
   built, GPU mint path exists) and was never wired up for this model. If it
   works, half the machine's committed cores come back for decode. This is the
   largest structural lever I did not get to. Note the constraint: a dealer is
   allowed, the untrusted host is not.
2. **Cut the serial field arithmetic.** `C` is serial, and the box has idle
   cores. Parallelising the elementwise mask/encode across helper threads
   failed on dispatch overhead -- but the diagnosis was dispatch, not the idea.
   A design where the helpers never sleep (or where the work is handed to the
   *existing* decode threadpool rather than a private one) is still open.
3. **Fewer exchanges.** 241 per pass at ~44 us is 10.6 ms. Each is forced by a
   CPU op in between (norm, GLU, the delta-net). The residual add is LINEAR and
   could in principle fold into an adjacent matmul; `SHIELDED_FUSE_LOCAL=1`
   is an existing, off-by-default matcher for exactly that island and my only
   measurement of it was contaminated -- re-run it cleanly. RMS norm needs a
   sum of squares of secret data and is genuinely hard; do not burn a day on it
   without a new idea.
4. **Batching.** Everything above is single-stream latency. `W` is per-PASS,
   so at m>1 the weight stream amortises across users -- the whole 21.6 GB is
   read once for the batch. If the product goal is aggregate throughput rather
   than one user's latency, this is by far the biggest lever and it is
   completely untouched here. Check what the product actually needs before
   optimising latency further.
5. **The delta-net kernel.** It moves 288 MB/token and achieves ~69 GB/s
   effective, roughly 3x off what the memory system can do. Fusing the four
   sweeps into one was bit-identical and bought 1%, so the win is not call
   overhead -- it is blocking/prefetch, or a narrower state dtype (bf16 halves
   the traffic; quality risk, needs an eval not a norm check).
6. **Asymmetric split shares.** The two V100s are not identical (80 SM /
   2197 G-MAC/s vs 72 SM / 2500). `SHIELDED_SPLIT_WEIGHTS` takes relative
   shares and only 50/50 was tested. Cheap, possibly 1-2%.
7. **Fix the Freivalds overlap.** The ring publishes the request before it
   spins and takes a work callback for exactly this; the RHS depends only on
   the trusted input, so it is ~3.6 ms/pass of dead time. It currently fails
   verification with AND without the split, so the gate excluding it is
   load-bearing and the path has never worked. Someone who finds the bug gets
   ~6% for free.
8. **Hardware.** `W` is 12.7 ms streaming + 10.6 ms launch. An H100-class card
   cuts the first ~3x and the second not at all, landing around 24-25 tok/s by
   this model. Worth MEASURING before anyone buys one.

And the meta-point: **the two biggest wins of the last session were both bugs
in something that looked like a tuning parameter** -- a cache default one
entry too small, and a permutation of one element implemented as a 3 MiB copy.
Before optimising a number, check whether it is measuring what you think.

## Pointers

- `shielded/REPORT.md` section 16 -- the full record, including every negative.
- `shielded/lane/lane_error.py` -- weight-lane error on real 27B tensors.
- `shielded/lane/i6_kernel_bench.cu` -- what the CARD pays to read a lane.
- `wasm/llamacpp-rs-inplace.patch` -- the recurrent-state change, wired into
  `.github/workflows/llamacpp-toolchain.yml` (manual dispatch; it is INERT
  until someone runs that workflow with a fresh tag).
- llama.cpp source: `/home/steven/q4-calib-work/llama-src` (pinned `ddd4ec14`),
  built to `$SCRATCH/llama-alias`.
- Unmasked baseline: `~/gvs5h/llama.cpp/build/bin/llama-bench`, needs
  `LD_LIBRARY_PATH=/home/steven/.cache/sd-gpu-repro/cuda-home/lib64`.

Report honestly. A negative result with a number in it is worth more than an
optimistic one, and several of the entries above are load-bearing precisely
because someone measured them and wrote down that they did not work.
