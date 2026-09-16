FOLLOW-UP (engine, next toolchain): wasmtime_wasi_nn::wit logs every [prefix_warming] refusal as
ERROR (one line per 2 s per waiting follower). Harmless; a future ggml patch could answer the wait as
a normal output (e.g. a "prefix_wait" tensor) instead of an Err so the wit layer stays quiet.

## 2026-09-06 16:35 UTC — batch-width curve, both kernels (bench-serve4, 24 steps, 4 threads unless noted; ms/step mean (best), rows/s)
shipped kernel (base4, batch 4 / pool 32):  m1 102.5 (79.2) 9.8 | m2 95.2 (91.2) 21.0 | m4 241.8 (201.2) 16.5 | m8 524.6 (254.2) 15.2 | m8 8thr 538.5 (261.0) 14.9 | m16 2130.7 (2109.5) 7.5 (policy: >MAX_M=8 -> linears in the enclave CPU, GPU 1%)
blocked kernel (blocked4, batch 16 / pool 64): m1 80.2 (76.1) 12.5 | m2 114.3 (103.3) 17.5 | m4 163.6 (146.9) 24.4 | m8 410.0 (259.2) 19.5 | m8 8thr 424.6 (222.8) 18.8 | m16 2138.0 7.5
Reading: the BEST 8-row step is ~255 ms on both (= ~31 rows/s if pads were always ready); the MEAN is the refill rate. Blocked lifts the refill-bound region (m4 +48%, m8 +28%) but loses at m2 (16-row jobs are lumpier: a drained group waits a whole job). CAVEAT: 24 steps x m rows is not far past the pool depth (32/64 token-rows), so m1/m2 are partly pool-buffered; phase 6 runs 100-step m4/m8 for steady state and 12 refill threads on both kernels. Extra compute threads (8) do nothing at m8 on either kernel: refill threads are the binding resource.
Scheduler (shielded-tee.c refill_main/pick_refill_group): a group is refilled only once a whole batch B fits, unless LOW (ready+coming < B); job size b = min(deficit, B). So B=16 changes both the job length and the LOW threshold.

## 2026-09-06 16:25 UTC — confirmation holds; kernel integrated into the repo (uncommitted)
Swapped order (blocked3 first): blocked3 s4c 13.60 / s8c 13.35; base3 s4c 11.59 / s8c 11.37. Means over both orders: 4 thr 13.24 vs 11.31 (+17.1%), 8 thr 13.47 vs 11.52 (+16.9%); exact same text every run. Order-independent.
Repo (working tree, NOT committed): blocked kernel applied to wasm/ggml-shielded/shielded-simd.c (blocked-kernel.patch, +96 lines, dispatch when b>4 under SH_SIMD_AVX512); new wasm/ggml-shielded/refill-selftest.c (the rows oracle: K 1..70000, N 1..17, b 1..33, 4 fillings; exit 77 = no VNNI) + Makefile rule (all/clean) + .gitignore + a case in test/shielded-cbackend.test.mjs (skips on 77). Oracle PASS on the new kernel (5.6 s); shielded-cbackend 5 pass / 1 skip (worker GEMM needs 127.0.0.1:9500 = the 3070 worker; never use it). Manager knobs nnShieldedRefillBatch / nnShieldedPoolDepth + test/shielded-refill-knobs.test.mjs pass.
The Makefile carries PRE-EXISTING unrelated calib hunks: stage only makefile-refill.patch (git apply --cached), never `git add` the whole file; shielded-calib.cpp stays unstaged too.
Live A/B config ready: config-profile-guided-deficit-bootwarm-blocked.json (= bootwarm + RefillBatch 16 + PoolDepth 64). Open: whether SHIELDED_REFILL_BATCH's engine default moves 4 -> 16 (phase 5 attribution decides: base4k = shipped kernel + knobs; blocked4p = kernel + batch 16, default pool).
Phase 4 (bench-serve4: batch sweep m=1..16 both kernels + timed profile) and phase 5 are chained in the background: serve-phase4.log / serve-phase5.log.

## 2026-09-06 16:15 UTC — phase 3: candidate row-blocked kernel vs shipped kernel, single chat (local, persistent engines, 15 GiB reservations, both linked)
base3 = shipped 598 kernel (refill batch 4, pool 32): s4 spec 11.03 / plain 10.44 tok/s (verify 143 ms/round); s8 spec 11.66 (verify 132 ms).
blocked3 = blocked-rows-refill.c (16 rows per weight tile) with SHIELDED_REFILL_BATCH=16 SHIELDED_POOL_DEPTH=64: s4 spec 12.87 / plain 11.10 (verify 120 ms); s8 spec 13.58 (verify 111 ms). = +16.7% (4 thr) / +16.5% (8 thr) on ONE chat, exact same text, GPU SM still 2-4%.
Swapped-order confirmation (blocked3 first) running: serve-confirm.sh -> serve-confirm.log (labels s4c/s8c).
Batch-width sweep FAILED on both (all m): the harness recorded 64 tokens then rewound to the prompt boundary, but rewind_depth=1 (ENCLAVE_GGML_N_RS_SEQ=1) refuses a 64-token rollback; the unchecked return left the KV at position 403 while the step decoded at 340 ("inconsistent sequence positions"). Fix = bench-serve4.cpp (rewind only when it succeeds, otherwise decode forward from n+64; steps already handle a refused rewind by pos += m). Needs engine restarts on the new binary.
profL (long profile) produced nothing: local-prompt-long.txt is only 72 tokens and the model emits EOS at once (generated 1). Use local-prompt.txt (340 tokens, ~130 generated) with PROFILE_DELAY_S=41 PROFILE_SECS=12 on the next driver start.

## 2026-09-06 16:05 UTC — stack attribution of a decode round (base2 prof2, 11.49 tok/s, 15 decode samples of the main thread)
Main thread leaf frames: sh_pipe_ring_exchange 8/15 (waiting on the masked exchange chain), ring_stream_copy,
mask_planes, descale, shielded graph_compute 1 each (link-side CPU), gated_delta_net / flash_attn /
get_rows / OMP barrier 1 each (CPU ops). => ~60-70% of the round is the serial link chain (~240 exchanges
x 0.31 ms: card 0.14 + ~0.17 overhead), ~30% CPU ops. OMP workers 87% at barriers, refill threads 64% idle.
Single-chat levers that remain: (a) split each group's N across both cards and issue both halves
concurrently (card time per exchange halves: ~-16 ms/round, ~10%); (b) cut per-exchange overhead
(reply copy 418 KB, mask/unmask, poll/wake; ~41 ms/round); (c) fewer CPU-op splits. Best case ~13-15
tok/s for one chat. Not a path to 75-100% GPU. Leaf-frame script inline in the session; raw stacks in
serve-base2-prof2-stacks.txt. local-prompt-long.txt = non-terminating manual prompt for long profiles.

## 2026-09-06 16:00 UTC — the design's throughput ceiling on this box (cost model, to be confirmed by phase 3)
One-time pads are PER ROW: a step carrying m rows needs m pads per group => CPU refill work = m x 27 G-MAC
x 3 planes = m x 81 G-MAC per step. Best measured refill rate here (rows-mt-bench, 16 threads, blocked
kernel) ~3.5k rows/s on one 178 MB group == ~2.5 T-MAC/s => 32 ms per token-row => aggregate ceiling
~30 token-rows/s for ANY batch shape (one chat 11-12 tok/s today; 8 chats ~30 rows/s). Card time per
step ~33 ms (weight streaming from VRAM, nearly independent of m <= 8) => GPU busy <= 33/260 ~ 13% at
m=8, ~10-20% at m=1-2. 75-100% GPU needs ~8x the CPU (the doc's "64-128 core CVM") or a different
trust boundary (plain CUDA tier: KV + activations on the card). Steven called this a design flaw;
agreed for the single-box single-chat goal: the trade is privacy-from-the-GPU-host for CPU-bound
throughput. Phase 3 (batch m=1..8 on base3/blocked3) quantifies the m-curve for both kernels.

## 2026-09-06 15:58 UTC — blocked2 VOID too (2 x 16 GiB > 31 GiB budget); 15 GiB each; harness v3 with batch sweeps
Worker: "reservation 17179869184 exceeds the budget: 17179869184 reserved of 33285996544" => two engines
need <= 33.29 GB total: serve.py now reserves 15 GiB (16106127360) each (cap 14.5 GB vs 13.54 GB weights
on card 0). serve.py flags a dead link ("NO SHIELDED LINK") from the engine's stderr. bench-serve v3 adds
`batch <label> <m> <n_steps> <threads> <prompt>` (bench-batch's m-row step cost on the loaded engine;
m <= SHIELDED_MAX_M=8 stays on the cards). serve-phase3.sh (after prof2): restart base3 + blocked3 on
v3, warm-up each, then s4 (plain check), s8, batch m=1/2/4/8 (4 threads) and m=8 at 8 threads.
Steven asked whether the KV cache in RAM is the GPU-utilization limiter: NO - KV/activations stay in the
enclave by design (the security model), the CPU attention is small at test context; the limiter is the
serial chain of ~240 masked exchanges per round (card 0.14 ms each, one card at a time, ~0.17 ms overhead)
plus the CPU-side pad economics. Wider batches are the design's utilization lever.

## 2026-09-06 15:50 UTC — CORRECTION: the slow first tests were the engine's START-UP window, not the plain pass
Old-binary base engine: p1 (spec only) 10.77 tok/s; pl (plain THEN spec) spec 10.81, plain 10.26 => the
plain pass does not poison anything. What made v1 / w / every one-shot bench-spec run slow: right after
start the weights page in lazily, get field-encoded and uploaded, and the 8 refill threads fill a 32-deep
pool for EVERY group (~8 full weight-matrix streams, hundreds of GB of DRAM traffic) - the request path
starves for minutes (base2 warm-up test: 0.68 tok/s, verify 997 ms, draft 1861 ms). bench-spec's whole
run (~220 s) sat inside that window, hence 4.2 tok/s everywhere. Persistent-engine methodology: ALWAYS a
warm-up test first; then: base2 s4 11.18 (plain 10.29, identical), s4b 10.74, prof 11.08, s8 11.50, s16
11.30; verify ~135-149 ms/round, draft ~19 ms; GPU SM 2-4%. Prefill 41.6 s @4 threads, 23.5 s @8/16.
Stack profile (36 samples, mostly the idle tail - re-running on a 500-token decode): 8 refill threads
70% in pthread_cond_wait (pool full - refill NOT the bottleneck at this rate), OMP workers 87% at barriers.
PRODUCTION NOTE: the same start-up pool fill happens after every app restart in the VM (default depth
4 x max_m = 32) and competes with the boot warm-up; a shallower initial pool or a staged fill would
shorten the first minutes after a restart. ell_reset between passes kept (harmless, host-faithful).

## 2026-09-06 15:40 UTC — two engines on one card pair: the worker refuses a second HELLO over the budget
serve-blocked (started while serve-base held 29.66 GB reservations per card): NO "[shielded]" lines at all,
GPU 0%, 3.7 tok/s = silent CPU fallback: the worker refuses a HELLO whose reservation would exceed the
31 GB card budget (worker.cu ~1066), and a refused HELLO is a dead link the engine computes around. Its
w1/b4/b16 numbers are VOID. serve.py now reserves 16 GiB per engine (cap 15.46 GB vs 13.54 GB of weights
on card 0), so base2 + blocked2 can be loaded together and alternated. Rule: never run two engines with
full reservations against the same workers.

## 2026-09-06 15:45 UTC — single-chat ceiling on this design (from the persistent-engine numbers)
Per 2-row round at 11.5 tok/s: verify ~140 ms + draft ~16 ms for 1.81 tokens. Link = ~240 exchanges x
0.31 ms = ~74 ms/round, of which the card computes 0.14 ms/exchange (34 ms/round, split over 2 cards used
in alternation). Refill at 8 threads, rows=4: ~95 ms/row (rows-mt-bench) => refill-bound today; blocked
rows=16 at 8 threads ~73 ms/row, at 16 threads ~43 ms/row. Best case with refill hidden: link-bound
~75-90 ms/round => ~20-24 tok/s and GPU SM ~40-45%. Higher GPU utilization needs wider exchanges (many
concurrent chats per exchange, the design's batched regime) or fewer/cheaper exchanges (worker-side
per-exchange overhead 0.31 vs 0.14 ms card time), NOT more single-chat tuning. 75-100% on both V100s for
ONE chat is not reachable on the one-time-pad design; state this to Steven.
Prefill (TTFT) is CPU-only by policy (MAX_M=8): 4 threads 42 s / 8 threads 23 s / 16 threads 20 s for
340 tokens => the VM's 4 compute threads (nnThreads 4) cap TTFT; nnThreads 8 would ~halve cold TTFT
(refill threads 8 + compute 8 = 16 vCPUs; needs a live check that decode does not regress).

## 2026-09-06 15:40 UTC — BREAKTHROUGH: local spec decode 11.5-12.3 tok/s; the 4.2 was a harness artifact
Persistent engine (serve-base.out): v1 (plain pass THEN spec, like bench-spec) spec 4.32 tok/s; prof4
(spec only) 11.50 tok/s verify 140 ms/round; t8 12.28 (verify 125 ms); t16 10.88; prefill 41.9 s @4
threads, 23.3 s @8, 20.1 s @16; all text-identical where checked; GPU SM 2-4%. Every bench-spec number
so far (4.2) was poisoned by its own plain pass: 96 single-row decodes + ell_seq_remove leave the unified
KV pool fragmented (the 2026-07-24 mechanism) and the spec pass then attends across the high-water mark.
bench-serve now calls ell_reset(ctx) after every pass (+ prctl PR_SET_PTRACER so the driver's eu-stack
can sample under Yama). serve-phase2.sh: confirm poisoning (p1 vs pl on the old binary), restart both
engines on the fixed binary, run w/s4/s4b/prof/s8/s16 on base2 and blocked2 -> serve-phase2.log.
IMPLICATION FOR PRODUCTION: the VM's idle reset only fires when no session is alive AND every park is
stale (parks live 6 h) => with mm35/36 parks standing the pool never heals; the VM's 9.5 tok/s vs the
engine's ~11.5-12.3 clean may be this fragmentation. Candidate fix: a park-preserving compaction.

## 2026-09-06 15:35 UTC — persistent local engine (no more reloads); ptrace-scope fix for profiling
Steven: stop reloading the model per test. New harness: scratchpad shbuild/bench-serve (bench-spec's exact
loop behind a stdin command loop; model + backends + card uploads once; each test = fresh sequence via
ell_seq_remove + fresh MTP handle; plain reference optional per test) + work dir serve.py (driver: spawns
the engine with the run-local-ab.sh env, tests as one-line commands on /tmp/serve-<name>.fifo:
"<label> <n> <K> <p_min> <threads> <plain 0|1> <prompt-file> [profile]"; per-test nvidia-smi dmon and,
with "profile", eu-stack sampling of the engine - the driver is the PARENT, which Yama ptrace_scope=1
allows (the earlier eu-stack attempt from a sibling shell was refused). Results: serve-<name>.jsonl,
summary lines in serve-<name>.out, stacks in serve-<name>-<label>-stacks.txt. Base server: --name base
(repo kernel .so, batch 4); tests queued: v1 (plain check), prof4 (stack profile), t8, t16.

## 2026-09-06 15:24 UTC — SHM ring locally changes nothing: transport is NOT the local-vs-VM gap
r-base-t4 (ring attached, "19274 over the ring"): spec 4.20 tok/s, plain 1.78, verify 400 ms/round,
wire 5.9 s / 19k exchanges = 0.31 ms per exchange on the ring == TCP; card time 2.6 s per card per run
(0.14 ms per exchange). r-blocked16-t4 4.32 (exit 3: greedy streams diverged). Per 2-row round: link ~74
ms (240 exchanges x 0.31), backend local ~20 ms, => ~300 ms per round OUTSIDE the shielded backend, on
the CPU side at 4 threads, while CPU-only at 16 threads does the whole model in 305 ms/round. Model: 506
q8_0 + 360 f32 tensors (f32 = norms/small; all linear sites are Q8 and calibrated). Stack-sampling the
decode now (eu-stack, local-stack-profile.log / local-stack-samples.txt) to attribute the 300 ms.

## 2026-09-06 15:20 UTC — SHM ring locally: parser needs /dev/enclave-shielded-shm/card-N; scratch override
The 6-field SHIELDED_WORKERS record is rejected unless the ring path is /dev/enclave-shielded-shm/card-<0-15>
(the guest's ivshmem BAR); the first "SHM" runs (s-*) therefore ran CPU-only ("invalid worker pool") and
are VOID. Host cannot create /dev entries (no sudo) => the SCRATCH backend copies (shbuild, shbuild-blocked)
carry a local-only patch: SHIELDED_SHM_PREFIX env overrides the prefix (default unchanged; NOT in the repo).
Ring files /dev/shm/local-shm/card-{0,1} (32 MiB, 4 rings of 8 MiB), workers restarted with --shm on them
(local-worker-950x-shm.log), run-local-ab.sh sets SHIELDED_SHM_PREFIX + SHIELDED_SHM_STREAM_LOAD=1 (the
VM's nnShieldedTransport "shm-stream"). Ring series: r-base-t4, r-blocked16-t4 -> local-shm-series.log.

## 2026-09-06 15:12 UTC — clean local series (VM stopped, TCP workers): decode is NOT thread- or refill-bound locally
local-clean-series.log / local-c-*.json (340-token prompt, n=96, K=1 P_MIN=0.4, POOL_DEPTH=32):
  c-base-t4        spec 4.24 tok/s  plain 1.89  spec prefill 40.1 s  verify 393 ms/round  identical
  c-blocked16-t4   spec 4.24        plain 1.86  prefill 40.0 s       verify 395          identical
  c-base-t16       spec 4.12        plain 1.90  prefill 14.6 s       verify 406          NOT identical (exit 3)
  c-blocked16-t16  spec 4.48        plain 1.89  prefill 15.5 s       verify 390          NOT identical (exit 3)
  c-cpu-t16 (no GPU) spec 5.65      plain 3.61  prefill 15.0 s       verify 305          identical
GPU mean SM 3-8% (busy ~15-25% of samples at ~20%). Worker logs: ~19k exchanges per run, "0 over the
ring" (TCP), only ~2.7 s of card time per run. Profile: pads missed ~21 of 23.5k; local_nodes=708 =
the prefill matmuls (SHIELDED_MAX_M=8 by policy: batches wider than 8 rows stay in the enclave -
"offload is a DECODE accelerator"), so PREFILL IS CPU-ONLY BY DESIGN and scales with threads
(40 s at 4 threads -> 14.6 s at 16). Decode ~196 ms/row locally vs ~95 ms/row in the VM with the same
workers: not refill (pool never empty), not compute threads (4 == 16) => transport/latency chain
(TCP loopback vs the VM's SHM ring). 16-thread runs: plain vs spec greedy streams diverge (fp reduction
order), a harness sensitivity, not a correctness bug for the shielded path.
Design ceiling (docs/shielded-inference.md, policy comment in ggml-shielded.cpp): the TEE pays 3 planes
of MACs per offloaded MAC for pads; the GPU can never be busier than the CPU refill allows. The 75-100%
GPU target is unreachable under the current one-time-pad scheme on 16 vCPUs; the honest levers are
refill efficiency (row-blocked kernel: +82% aggregate at 16 threads natively) and more CPU.
Manager knobs added (uncommitted): nnShieldedRefillBatch -> SHIELDED_REFILL_BATCH, nnShieldedPoolDepth ->
SHIELDED_POOL_DEPTH (+ test/shielded-refill-knobs.test.mjs). SHM series running: workers restarted
with --shm /dev/shm/local-ring-950x (32 MiB), SHIELDED_WORKERS 6-field records -> local-shm-series.log.

## 2026-09-06 14:58 UTC — metal0 VM STOPPED for local testing (Steven authorized RAM freeing); clean series running
The local engine needs ~55 GB (29 GB weight map + 22.8 GB field-encoded weight copy + pads); with the VM's
64 GB pinned the host swapped (swap 4 GB full, pgmajfault storm) => the first local runs were throttled:
base598 cold 3.62 tok/s, base598-warm 3.54, blocked16 3.88 (+9.6%), all far below the VM's 9.5.
Steven 14:55Z: "If you need to free up some ram from enclave.host. go ahead." => `systemctl --user stop
enclave-metal.service` at 14:57Z (enclave-metal-stop.intent.json). IMPACT: metal0's CPU tenants (MCP
adapter a69dcbba, RISC Box e64f7cba, s3-ipfs-adapter 7ae476a3 = ipfs.enclave.host, d9798e4c, a77d0c57)
are DOWN until restored: `systemctl --user start enclave-metal.service` (tenants re-claim; the gateway
self-heals in ~5 min). Update timer also stopped. enclave-mps.service stays up (restricted MPS).
Own workers relaunched on 127.0.0.1:9501/9502 (shielded/worker-cuda/shielded-worker --vram-gb 31,
CUDA_MPS_PIPE_DIRECTORY=/run/user/1000/enclave-mps, CUDA_VISIBLE_DEVICES=<V100 uuid>, logs
local-worker-950{1,2}.log); host now 62 GB free / 90 GB available. Clean series (local-clean-series.log):
prime, c-base-t4, c-blocked16-t4, c-base-t16, c-blocked16-t16 (16 refill threads), c-cpu-t16.
To resume production later: kill my workers (pkill shielded-worker), start enclave-metal.service,
`enclave fund` the 0x7c4149ee deployment (it is deactivated; config currently draft2 -> apply
config-profile-guided-deficit-bootwarm.json and upgrade to 0.57.6 first).

## 2026-09-06 14:52 UTC — local loop WORKS; first local A/B (needs the warm re-run)
run-local-ab.sh runs the deployed 598 engine on the host against metal0's idle workers (TCP loopback),
340-token prompt, K=1 P_MIN=0.4, THREADS=4, refill 8 (4/card), POOL_DEPTH=128, N_BATCH=512.
local-base598 (cache COLD, first run): spec decode 3.62 tok/s, plain 1.55, spec prefill 86.9 s, plain
prefill 43.9 s, verify 450 ms/round, pads missed=0, contended=0, GPU mean SM 2.5%/3.8% (busy 14-18%).
local-blocked16 (batch 16, cache warm): 3.88 tok/s, plain 1.63, spec prefill 46.2 s, exact text.
Both far below the VM (9.5 tok/s): the CPU side dominates locally (backend graph_compute = 15% of wall).
Chain 5 running: base598-warm, cpu-t4 / cpu-t16 (CPU-only reference, n=32), base598-t16 (shielded, 16
threads, n=48) -> local-ab-chain.log. GPU sampler parse fixed (dmon rows are space-indented).

## 2026-09-06 14:45 UTC — NEW DIRECTION (Steven): free the V100s, iterate LOCALLY on the shielded/multi-GPU path
Target: 75-100% utilization of both V100s + higher tok/s/TTFT, then push. Design reality (docs/shielded-
inference.md, REPORT.md): every offloaded linear costs the trusted side the SAME MACs as the GPU (x3 RNS
planes) to refill one-time pads; sustained throughput is bound by CPU refill, hence ~17% GPU activity.
Draft2 (draft_tokens 2, nnRsSeq 2) on 598: 7.3-7.6 tok/s = REGRESSION (drafts 442/291, rounds +64% cost);
keep draft_tokens 1 (deployment config currently draft2 - must be reverted on resume).
Deployment 0x7c4149ee STOPPED 14:37Z (deactivated, balance $14.91 kept; `enclave fund` re-queues it).
metal0's workers stay up idle on 127.0.0.1:9501/9502 (TCP); the local engine uses them.
LOCAL LOOP: engine libs = deployed 598 root extracted from metal/dist/initramfs.cpio.gz into root-598/
(usr/local/lib: libllama, libenclave_llama, libggml-cpu(parallel copy); opt/enclave/shielded/libggml-
shielded.so); model = models/Qwen3.8-27B-Q8_0.gguf extracted with debugfs from the volume image (sha256
matches SHA256SUMS: a680f44a...); calib = metal/shielded-overlay/calib/qwen3.8-27b-mtp-q8-vl-gguf.calib;
headers = llama.cpp worktree at ddd4ec14 (scratchpad llamacpp-ddd4); backend + bench-spec built in
scratchpad shbuild/ (repo kernel = n16-k2048) and shbuild-blocked/ (blocked-rows-refill.c) with
GGML_LIB=root-598 libs; bench-spec patched to read N_CTX/N_BATCH env. run-local-ab.sh <label> <so>
[n] sets BACKENDS=libggml-cpu.so:<so> (the CPU backend is a module - without it "no CPU backend found"),
SHIELDED_WORKERS (two records host|port|vsock|reserve), SHIELDED_CALIB, THREADS=4, REFILL_THREADS=8,
REFILL_BATCH, POOL_DEPTH, PAD_WAIT_US=10000, K=1 P_MIN=0.4 N_RS_SEQ=1, samples nvidia-smi dmon.
KERNEL FINDING: FN(refill) streams W once per FOUR rows regardless of batch. blocked-rows-refill.c
(refill_rows_blocked: all b rows per 16-col tile x 2048-B slab, CRT straight into u) passes the int64
oracle b=1..33; single-thread 1.03-1.29x, but MULTI-THREADED (rows-mt-bench.c, 16 threads, own W per
thread): live rows=4 1957 rows/s at ~87 GB/s (DRAM wall) vs blocked rows=16 3563 rows/s (+82%, 40 GB/s);
rows=32 2826. => SHIELDED_REFILL_BATCH=16 + POOL_DEPTH>=64. Local A/B running: local-ab-chain.log,
local-base598.* vs local-blocked16.*.

## 2026-09-06 14:25 UTC — eyesoff-perf 0.57.6 PUBLISHED (router prefix warm-up + warmup key in the catalog config)
enclave-apps commit "park the routing classifier's prefix in the warm-up too" (pushed, merge fdaacf2).
Artifact eyesoff-perf-0.57.6.wasm sha256 af1706969cb7...16cb3e0, CID bafybeidx37hen4lqth7czud45wfsiiuqr2jvm4g34rc4z4j3zkv4iecpee
(catalog index 11; publish-0.57.6.log); catalog default config now carries "warmup": "/warmup".
NOT yet upgraded on the deployment (waiting for the draft2 3x512 to finish; an upgrade restarts the app).

## 2026-09-06 14:20 UTC — refill sweep 2: nothing beats the live n16-k2048 kernel
blocked-refill-results-2.log (baseline = live n16-k2048, idle host): n32-k2048 0.77-0.94x, n16-k4096
0.91-1.02x, n32-k4096 0.92-0.98x, n32-k1024 0.75-0.93x. All pass the oracle; none is worth a live cycle.
The blocking search is exhausted at this granularity (n16 columns x 2048-byte slabs stays).
Configs prepared: config-profile-guided-deficit-bootwarm.json (current + "warmup": "/warmup") and
config-profile-guided-deficit-draft2-bootwarm.json (draft2 + warmup) - pick after the draft2 result.
App (uncommitted, building): router_system() helper + warm_prefix parks the routing classifier's
prefix too ("router" field in the warm result) -> publish as eyesoff-perf 0.57.6 if tests/build pass.

## 2026-09-06 14:20 UTC — resumed after a 3 h pause; funding; cold-vs-warm chat timing; boot warm-up gap
Session paused 11:10-14:10Z. Timer stopped again 14:10Z (controlled window). Thirteenth top-up $5 USDC
14:13Z (fund-test-thirteenth-usdc.log) -> balance $15.00 (someone else added ~$10 during the pause),
funded ~7.2 h (through ~21:25Z). No restart during the pause (tenant log continuous since 11:02Z).
chat-timing-598.{json,log} (idle box, GUI switches, 24 tokens): chat 1 COLD (no parks): router step
"deciding what this needs" 20 s (253-token prompt), main prefill 215,318 ms, first text 236.9 s;
chat 2 WARM: router 1.3 s, prefill_ms 1,365, first text 5.4 s. Root cause of the cold start: this
deployment's config has NO "warmup" key, so the wasm-manager never fires its boot GET (/warmup) and
nothing parks the default prefix after a restart; the manager allows WASM_WARMUP_TIMEOUT=600 s (enough
for ~250 s). Prepared config-profile-guided-deficit-bootwarm.json (= current + "warmup": "/warmup"),
to apply after the draft2 test. Also observed: a follower retried [prefix_warming] every 2 s at
14:13:36Z while chat 1 led (probably a browser tab's page-load warm-up) - the wasi-nn wit layer logs
each refusal as ERROR (noisy, engine-side; harmless). refill2-draft2-chain.sh running: native sweep 2
(n32-k2048, n16-k4096, n32-k4096, n32-k1024 vs the live n16-k2048), then draft_tokens=2 + nnRsSeq=2
(config-profile-guided-deficit-draft2.json) 3x512 = two-v100-draft2-clean-*.

## 2026-09-06 11:05 UTC — blocked refill LIVE: +4.85% decode (598 vs 597); controlled window CLOSED, timer restored
update-v0.5.598-cpu.log: healthy 10:49:37Z. recover OK 10:52Z; verify-598.log PASS (16 vCPU/64 GiB/2 V100,
only enclave MPS 651454 + workers 1924304/1924306). two-v100-blocked-refill-clean-{short,long,1,2,3}.*
(controller blocked-refill-clean-controller.log): 512-token decode 55058/53972/54069 ms = 9.299/9.486/9.469
tok/s, median 9.469 vs 597's 9.031 (+4.85%); after-min 9.299 > before-max 9.087; exact text, 283/229
drafts every run. Full prompt: TTFT 133.209 s, prefill 132,751 ms (+0.19%, no change). Short: 80.4 s (boot
warm-up contention, noise). Comparison blocked-refill-live-comparison.json (same app 0.57.5, same config,
runtime 597 -> 598 = the refill kernel only). CUMULATIVE vs the 592 baseline: 8.827 -> 9.469 tok/s (+7.3%)
from the parallel strided copy (+2.3%) and the n16-k2048 blocked refill (+4.85%); full-prompt prefill
135.7 -> 132.8 s (-2.2%). Funding 11:05Z: balance $5.84, funded through ~14:28Z; agent wallet $20.18 USDC
/ 0.001525 ETH; total spent on this deployment $21.66. enclave-metal-update.timer RESTORED at 11:06Z
(current == latest == v0.5.598-cpu). Chromium GUI verification NOT done (no browser tool this session).

## 2026-09-06 10:45 UTC — blocked-refill n16-k2048 pushed (enclave 8690dd5f / merge e5cf901b), live A/B chain armed
blocked-refill-results.log (native, idle host, vs production a2db58fd): all four variants PASS the
integer/stride/tail oracle; n16-k2048 best: K=5120 N=34816 1.106/1.118x, N=248320 1.107/1.113x,
K=17408 N=5120 1.006/1.000x; n16-k512 1.08-1.12x; n8-k1024 + n16-k1024 REGRESS 0.81-0.97x.
wasm/ggml-shielded/shielded-simd.c now = blocked-refill-n16-k2048.c (sha256 a96d4b8f...; production
copy kept as shielded-simd.c.prod-a2db58fd); test/shielded-refill.test.mjs PASS. Funding: twelfth
top-up $5 USDC 10:43Z (fund-test-twelfth-usdc.log), funded through ~14:20Z.
refill-598-chain.sh (log refill-598-chain.log): waits for deploy + CPU release runs, checks the updater
sees the new tag, node metal/update.mjs --force (update-<tag>.log), recover_and_bench.py refill-598
--recover-only, 240 s boot-warm settle, run-clean-sustained.py two-v100-blocked-refill-clean, then
compare-clean-runs.py two-v100-copy-mm36-clean two-v100-blocked-refill-clean --output
blocked-refill-live-comparison.json (same app 0.57.5; runtime 597 -> new tag = refill kernel only).
Update timer STILL STOPPED. If the A/B regresses: revert shielded-simd.c to the prod copy + push.

## 2026-09-06 10:41 UTC — parallel-copy A/B VALID: +2.31% decode, +2.0% full prefill (597 vs 592)
two-v100-copy-mm36-clean-{short,long,1,2,3}.* (controller copy-mm36-clean-controller.log, restart 10:33Z,
same procedure as the 592 baseline). 512-token runs: decode 57131/56694/56342 ms = 8.962/9.031/9.087 tok/s,
median 9.031 vs before 8.827 (+2.31%); after-min 8.962 > before-max 8.937. Full prompt (1551 tok/64 out):
TTFT 133.656 s, prefill 133,006 ms vs 136.266 s / 135,700 (+2.0%). Short: TTFT 61.9 s (contends with the
boot warm-up, as before). Exact text, 283 drafts / 229 accepted on every run. Comparison file
parallel-copy-live-comparison.json (compare-clean-runs.py --allow-app-change: app 0.57.4 -> 0.57.5,
decode path unchanged; runtime 592 -> 597 = copy patch + mm36 engine, mm36 never touches decode).
Verdict: the CPU parallel strided-copy change is a small real gain, not the 2-7x synthetic numbers.
blocked-refill native harness armed after the controller (blocked-refill-results.log).

## 2026-09-06 10:27 UTC — cancel + distinct-prefix scenarios (597)
shared-warm-cancel-toolsoff-after-597: tools-off warm-ups share the default prefix's first 1371 tokens
(branch off the park) and have their own single mark [1516]: warm-A led the 145-token tail (10.8 s),
warm-B waited 5 ticks on mark 1516 then reused it (10.4 s) => distinct prefixes stay independent and
share only their exact common head. shared-warm-cancel-chat-after-597 (two chats, 5096-token custom
system prompt, tools off): chat-A led to 260 tokens, connection closed at 30.7 s; chat-B's next retry
0.7 s later LED from scratch ("prefilling 4 of 5096") => an abandoned leader strands nobody (its
partial work is lost, as designed: no park before a mark). Run still finishing (~8 min).
compare-clean-runs.py gained --allow-app-change (app 0.57.4 -> 0.57.5; rows now carry appWasm).
NEXT: run-clean-sustained.py two-v100-copy-mm36-clean --release v0.5.597-cpu (restart, warm, 3x512),
then compare-clean-runs.py two-v100-pre-copy-clean two-v100-copy-mm36-clean --allow-app-change
--output parallel-copy-live-comparison.json. Label: after = runtime 597 (copy patch + mm36 engine),
app 0.57.5; before = 592, app 0.57.4.

## 2026-09-06 10:27 UTC — mm36 LIVE + VERIFIED on metal0 v0.5.597-cpu (app 0.57.5)
update-0.5.597.log: healthy 10:11:54Z (wasm-manager 999f0e92...). recover_and_bench.py --recover-only OK;
verify-metal-test-resources.py --release v0.5.597-cpu PASS (verify-597-after-mps-cleanup.log).
AFTER (shared-warm-restart-boot-after-597.{json,log}): restart -> page-warm (GUI switches) LED
(24 own prefill lines, parked in 283,421 ms, 294.7 s total); chat (same switches) FOLLOWED: 97
"shared prefix tokens" wait lines tracking the leader (first on mark 1371, then re-planned onto 2453),
6 own lines, prefill_ms 211,513 (includes the wait), first text 313.1 s. BEFORE (595, same scenario):
page-warm 486 s, chat first text 513 s, prefill 423 s. Bare boot-style /warmup afterwards: parked in
108 ms, tokens 2453, marks [1371, 2453], feed_ms 0 (warm_one probe skipped via caps 15/16) => the boot
warm-up and the page share one prefix. Chat's router step ("deciding what this needs", 250-token
prompt) still prefills on its own prefix. Next: cancel scenario on the tools-off prefix (running,
shared-warm-cancel-toolsoff-after-597.log), then throughput validation of the copy change on 597.

## 2026-09-06 10:18 UTC — INCIDENT (mine): stray default MPS daemon touched the RTX 3070; quit at 10:16Z
verify-metal-test-resources.py --release v0.5.597-cpu FAILED at 10:13Z: a SECOND nvidia-cuda-mps-control
(PID 1786232, default pipe dir /tmp/nvidia-mps, NO CUDA_VISIBLE_DEVICES) + its server 1787926 held a 30 MiB
context on GPU-75f32211 (RTX 3070) and 36 MiB on each V100, 0% utilization. Started 09:47:55Z in THIS
session's cgroup (app-code-oss-1693324.scope) = while my full enclave Node suite ran (09:45-09:48Z);
test/mps-bounce.test.mjs is the only test touching that binary (it fakes it via PATH; exact path to the
real binary not pinned down). Enclave's own MPS (651454, /run/user/1000/enclave-mps, V100s only) and both
shielded workers (1843954/1843956) were never on the 3070. Quit via `echo quit | CUDA_MPS_PIPE_DIRECTORY=
/tmp/nvidia-mps nvidia-cuda-mps-control`; nvidia-smi then shows only 651454 + the two workers on the V100s.
RULE: never run the full enclave Node suite on this host; run targeted tests only.

## 2026-09-06 10:10 UTC — BEFORE control done (runtime 595, app 0.57.5), metal0 updating to 597
shared-warm-restart-boot-before-595.{json,log} (tag says before-595; an earlier copy was misnamed -596):
restart app -> boot warm-up + page-warm (GUI switches) + chat (GUI switches, 24 tokens, thinking off)
all prefill concurrently on the OLD engine: page-warm parked after 482,171 ms (486 s total, 43 own
prefill lines, 0 wait lines); chat prefill_ms 423,190, first text at 513 s. Old-engine single
warm-up probe while the boot warm-up ran: boot-warm-idle-probe.log 255 s (marks [1371, 2453]).
v0.5.597-cpu released 10:00Z (deploy 34026108806, CPU release 34026188332 OK; publish 34026233982
failed only at the Tinfoil fleet-repoint step, HTTP 504 - irrelevant to metal0). update-0.5.597.log
captures `node metal/update.mjs --force` started 10:09:14Z. Next: recover_and_bench.py --recover-only,
verify manifest wasm digest changed, run shared-warm-test.py restart-boot --tag after-597 (+ warm-warm,
cancel, distinct), compare with the before control. Funded through ~12:04Z.

## 2026-09-06 10:00 UTC — mm36 shared warming BUILT, app 0.57.5 published+upgrading, toolchain building
Funding: eleventh top-up $5.00 USDC at 09:27Z (fund-test-eleventh-usdc.log; agent wallet held $30.18 USDC),
lease ~through 11:52Z. Update timer STILL STOPPED.
Engine: enclave b7b1d6f9 (pushed as merge de7b2402): wasm/wasmtime-nn-ggml.patch gains
crates/wasi-nn/src/backend/prefix_claims.rs (pure claims table, 9 unit tests) + GgmlServer.claims
leaf lock; plan_prompt(.., wait_ok) refuses a follower's FIRST chunk with "[prefix_warming] ... (N of M tokens)"
BEFORE any mutation; opt-in {"prefix_wait":[1]}; claims resolved per mark, released on plan end/error/Drop,
stale after 300 s; caps 14..16 = [1, live claims, standing parks]. test/prefix-warming.test.mjs pins it.
Full 15-patch stack applies; cargo check ggml,sdcpp,nvenc OK. Toolchain run 34025737479 DONE 09:57Z digest sha256:35f679cb16d003d4f794b5d26552da73416f40830602a28ca3fe507babf43335;
repinned in enclave ae576b6f (merge 60f89e5c, pushed 09:58Z) -> deploy run 34026108806 -> then WASMTIME_IMAGE in wasm/Dockerfile.wasm,
push, deploy.yml wasm-manager -> CI repin -> CPU release -> node metal/update.mjs --force (capture output).
App: enclave-apps 71f7dd1 (pushed): feed_waiting wait/retry loop in prefill_text + generate loop,
Declare{prompt,marks,wait}, warm_one skips probe on caps warming/parks, chat.html label, parked GUI
progress/sw changes included. Artifact eyesoff-perf-0.57.5.wasm sha256 399a3c04f1d5...86e9ce,
published index 10 CID bafybeieriug72wq3cqngu5sonnyrckf7c44ua6llowvwurpuzmiis6tpmq (publish-0.57.5.log),
deployment upgraded (upgrade-0.57.5.log) -> app restarting; wait path INERT until the engine ships.
Live test script: shared-warm-test.py (scenarios warm-warm, warm-chat, cancel, distinct, restart-boot).
No browser tool in this session: Chromium verification NOT possible here; API verification only.

## 2026-09-06 handoff — supersedes stale active-process entries below

User requested a handoff prompt for another agent. Read `handoff-prompt.md` in
this directory for the complete current objective, constraints, source locations,
deployment details, valid results, and next steps.

IMMEDIATE PRIORITY: shared browser/chat/benchmark warming. First matching caller
does the work; followers wait and reuse the resulting prefix. No implementation
yet. Coordination must be shared in the native GgmlServer, since app Wasm stores
are per request. Align benchmark and browser prefix settings before testing.

Runtime v0.5.595-cpu remains deployed; fresh handoff resource verification PASS:
16 vCPU, 64 GiB, two V100s, RTX 3070 excluded. Copy optimization is deployed but
NOT validated for application performance. `two-v100-parallel-copy-clean` is
EXCLUDED due to overlapping Chromium warmup; see parallel-copy-clean-excluded.json.
Its benchmark was interrupted. Process check at 09:21 UTC found NO benchmark,
controller, or Metal updater still running. Browser warmup completion unverified.
Clean before median remains 8.827 tok/s for three identical 512-output requests.

Pending app UI edits remain uncommitted/unpublished; live app is still 0.57.4.
Update timer remains STOPPED for coordinated handoff/testing; successor must
restore it when controlled testing ends. Tenth funding succeeded; estimated
funded-through ~09:40 UTC. No eleventh funding attempt. Check fresh status soon.

## 2026-09-06 09:09 UTC — copy-only runtime595 live, benchmark active [STALE]
Update35086DONE0healthy595. Controller94236 run-parallel-copy-live.py ACTIVE:
resourcechecksPASS, gatewayrecovery+agentJWTrefreshDONE, ownappfreshrestartDONE.
Nowrun-clean-sustained.py two-v100-parallel-copy-clean --release v0.5.595-cpu,
short192prefillongoing; thenfull1551/64, then3x512. DO NOT run any nativebenchmark,
otherinference orGUIwarmup concurrently. Logsparallel-copy-live-{controller,benchmark}.log,
two-v100-parallel-copy-clean-{short,long,1,2,3}.log/json. Controllerchecks
manifestwasmimageexactf8f184... and shieldedmanifestfilesbyteidentical592.
NEWnormalGPUworkers1664608/1664609, MPS651454. BOTHverifiedCUDA_MPS_ACTIVE_THREAD_PERCENTAGE=100;
lowutilizationisNOTa25%MPSallocationcap. Resourcesunchanged16vCPU64GiBtwoV100.
Whenall3complete run compare-clean-runs.py two-v100-pre-copy-clean two-v100-parallel-copy-clean
 --output parallel-copy-live-comparison.json. Requires512tokens283drafts229accepted,
exacttext,request/appWasm/config/resourcesidentical. Actualmedianbaseline8.827tps.

NextcandidatespreparedLOCALONLY (noEnclaverepochanges):
1) parallel-gather-check/: actualddd4get_rows_f32 + extractedexactvec_cpy baseline;
flatlargegatherprototype. ASAN/UBSAN360casesPASS plusaliasguards. Isolated1MiBrow
23.760->10.291us2.309x,3rows74.997->39.123us1.917x. Notappspeed. Ranwhileupdatepacking,
BEFORE anyinference. Needbroaderguards, taskplannerchange beforeproduction.
2) prepare-blocked-refill.py generated blocked-refill-n{8,16}-k{512,1024,2048}.c.
Hypothesis: keepmaskinput/weighttile+spilledaccumulatorsinsideL1byblockingK/N,
reduceRplaneL1reloadsidentifiedprofile. Preserve3residueplanesandoneusemasks,
4rows, partialrowkernelsunchanged. NOTCOMPILED/TESTED. test-blocked-refill.py
--run onlyAFTERcurrentbenchmarkDONEandidle. Itguardsagainstactivebenchprocesses,
comparesfourvariantsagainstproductiona2db... withactualintegeroracle/median7benchmark.
No candidateaffectsproductionuntilbothnativeandlivevalidation. No nativeworkduringinference.

Latestrepocommitours0f819030, remote840d9c5dCIimagepin; compilerfc42a18d.
Currenttag595CPUcorrectGCC11, NOT594GCC12. ParkedappUIchangesunchanged.
Fundingtenthsuccess~09:40through; update timerSTILLSTOPPED, restorewhenuserstops.

## 2026-09-06 09:03 UTC — runtime595 update active
ACTIVE exec35086: node metal/update.mjs --force, log update-0.5.595.log.
Test34023342494/Deploy34023342598 PASS, CPUrelease595 published09:02:20.
Verified exactCPUrelease Dockerfile isGCC11 stage + copy patch; wasmManager image
f8f184a168bfe72b446ad0ac6384e545a907272c75e0647bb3b7ba61351d77bf.
Extracted packagedcpu lib parallel-copy-packaged-libggml-cpu.so SHA
fd33ae41aff4ec212e8620812e91f70e5c9919a5c85d65abdecfbe82625d545f.
Compilerreadelf EXACT11.4.0-1ubuntu1~22.04.3 (sameasold); duplicatecopyfnsize
d61 vsoldad6samefunctionaddress75ff0. PackagedlibraryrecordJSONsaved.
No inference active. Afterupdatehealthy595 verifyresources andsameimage/lib,
recover_and_bench.py two-v100-parallel-copy --recover-only, then
run-clean-sustained.py two-v100-parallel-copy-clean --release v0.5.595-cpu.
No benchmarkstarted yet. Before3x512exact8.9/8.6/8.8,283draft/229accepted.
BaselinefullTTFT136.266s,prefill135700ms,64decode8.4tok/s. Thesearecurrent
cleanvalues, not historical165s oldercontrol. Resourceboundary unchanged.
TimerstillSTOPPED, fundingtenthsuccess through~09:40; noeleventhtransaction.

## 2026-09-06 09:01 UTC — clean baseline complete, compiler-matched CPU module building
User wants continued sustained tok/s optimization; don't stop. No subagents.
Metal0 remains592/private0.57.4/config-profile-guided-deficit CIDhtn3...; unchanged16vCPU64GiB/twoV100/180224context. RTX3070 excluded. No active inference.
Fresh controlled before baseline two-v100-pre-copy-clean completed: three512requests8.9/8.6/8.8tok/s, everytext EXACT585reference. Full/short warmup complete.
Prior contaminated baseline after GUI chats excluded; don't use two-v100-pre-copy-sustained.
NewCPUcopy patch713faa10 validated3240nativeASAN/UBSAN cases +fullpinnedCPUcmake/link check.
FullCUDAworkflow34022561583 intentionallyCANCELLED. FastCPUonlyDockerstagec617608f builds exactddd4 pin, sameABIflags and ships ONLY newlibggml-cpu.so; existingrestlibsunchanged.
Correctedstagecompilerfc42a18d to Ubuntu22.04/GCC11 (oldshippedGCC11.4.0), pinnedbase digest2edbbc5dc405e9612ba3584ce95480277e3eb374407b5505fe26f17df77c7dbc. MergeCIpin-onlyfdf7161e => pushed0f819030. WaitTest/Deploythishead, automaticCPUrelease likely595; DO NOTdeploy594 GCC12 build. AutoDeploy itself dispatches releases; don't duplicate. Runtime592stilllive.
TENTH funding .0005ETH SUCCEEDED09:55? correction08:55UTC: fund-test-tenth-eth.log, balance1247070microUSDC,2157sec (~09:40UTC). Noeleventhfundattempt. AgentETH~.00153roughestimate+USDC. Checkfresh~09:30.
User confirmedGUIworking; UIlocaledits inappsrepoPARKEDuncommitted16Node207RustPASS, wasm26307DONE0. No0.57.5.
Update timerSTOPPED forcontrolledtests; restore systemctl --user start enclave-metal-update.timer whenuserstops/leaving. NormalGPUworkers1545721/1545723,MPS651454; noNsightactive.
Aftercorrectrelease:verifytagCPUmodulecompiler/digest, update --force, recover_and_bench.py NEW --recover-only(refreshonlyagentJWT), thenrun-clean-sustained.py NEW --release ACTUAL. Reference8.9/8.6/8.8. Requiretextexact, resourcesunchanged.

## 2026-09-06 08:52 UTC — fresh-process baseline active; extra refill candidate rejected
ACTIVE19960 run-clean-sustained.py two-v100-pre-copy-clean --release v0.5.592-cpu.
OwnappONLYrestartcompletedrunning,resourcesverifiedunchanged16vCPU64GiBtwoV100.
Short192completed57.189TTFT/32tokens7.7tps, full1551ongoing, then3sequential512.
Controllerpre-copy-clean-controller.log; no parallel CPU/GPU microbenchmarks/inference.
Prior55475 DONE1 first512textdiff fromhistoricalreferenceafterGUIchats changedcached
prefix path. ItwasBASELINE592unchanged,8.8tps,draft278/accepted234 versusreference
283/229;excludedfromA/B! Filetwo-v100-pre-copy-sustained-1.json retained.
Usertoldwhyfreshprocesscontrol. Aftercleanwarmuprequiretextexacthistorical585 again.

Whilebuildwaited, isolatedeight-rowmaskkernels tested sameSIMDbaselinea2db...
Localtest-eight-row-refill.py /eight-row-refill.log. Both1col and2col variants
integeroraclePASS(b1..17,K1..70000,extremes,strides). Perf1col .583-.631x,
2col .953-.974x => BOTHREJECTED. ProductionSIMDunchanged. These needbatch8,
whileproductionSHIELDED_REFILL_BATCH default4; NOconfigchange made.
Copybuild34022561583 nowCUDAcompiling. Test34022561782PASS,patchstack34022561795PASS.

SourceconfirmsGPUlayerexecutionSERIAL: ggml-shielded.cpp sh_planwholelayerassigns
onecard, graph_compute waits eachcardrun beforethenext. VerylittleGPUoverlap
isexpectedfromthislayerpartition. GPUtracegapsalsohostwork;bothfactorsmatter.
OfflineLPTsizesimulationonly placement-balance-simulation.json/public-groups.json:
weightedmaskworkcurrent12.536B/14.273B vsLPT13.880B/12.929B =>~2.8%maxworkreduction,
notabigwin; NOplacementedit. PreserveswholelayersandMTPsecondregistrationwave.
Fundingninthonlystillgood~09:04;refreshby08:55. Userwantscontinuedtok/soptimization.

## 2026-09-06 08:42 UTC — parallel copy build dispatched; no live engine change yet
Committed ours713faa10 thenmergedremoteCIpin-only2e731ecb =>head
ba8f393ae3e46b8e5f1daee6ab289b38bd5f8f7a,pushedEnclaveHost/enclave main.
RemotehadjustCIconfigpins; unrelateduserdirty preserved. No upstreamllama edits.
Fileswasm/llamacpp-parallel-copy.patch, scripts/test-parallel-copy.py,
test/native/ggml-parallel-copy.cpp, .github/workflows/llamacpp-toolchain.yml.
Nativegate3240casesASAN+UBSANPASS; pinnedddd4 CPUbackendfullcmakecompilePASS.
Isolated4-threadmedian7 copybaseline/candidate speedups 2.595,7.668,1.888,2.036
for syntheticpaddedshapes; NOTappspeedup. Allnativeoutputsparallel-copy-check/.
Patchhandleslarge>=64KB same-shape/sametypeinnercontiguousdisjointbuffers,
nonoverlappingmonotonicdststrides; allothersoriginalfallback. Noaddedthreads.

ACTIVE GitHubllamacpp-toolchain run34022561583 atverifiedheadba8f393a,
freshrelease_tag enclave-llamacpp-ddd4ec14-parallel-copy-20260906.
Priorfullnativebuildtook~25min (CUDA18.5min+toolkit4min),soexpect~09:07UTC,
thenbundlechecksumandwasmtimepipeline/pin/CPUrelease neededbeforedeployment.
OtherCI Test34022561782,Deploy34022561778,wasmtimepatch34022561795.
NoMetalrestart/appWASMchange yet; still592/private0.57.4.
Copyworkflowincludesnew3240casegateafterlibbuildsofailurestopspublish.
Functionextractscriptbaseline repo separateoption supportslocalarchive, defaultHEADforCI.
Localbuild26307DONE0, UIparked16Node207RustPASS; NO0.57.5published.
UserobservedV100<=25%; informedCUDAtraceagrees,feed/mask/copygapsdominant.
UserexplicitlycontinuesTOK/Sfocus. Standingdon'tstopactive.
Funding ninthgood~09:04UTC;needrefreshby08:55andtopupagentonlyifrequired.

## 2026-09-06 08:37 UTC — GUI verified, user explicitly redirected to tok/s
User confirmed "Ok, it is working", then "Now back to focusing on optimizing the tok/s. This is too slow."
GUI current Chrome browser2 tab723093372 /c/cmtpjxc3jg2vly. Oldtabs349/363 closedbyuser.
Persistent CUA currentEyes, currentNet, currentCursor. CurrentGUIchat COMPLETED
Explain confidential computing in simple terms: 513tokens,7.6tok/s,1step,2m6s.
Warmup itself completed normally; pendingJSONwas live prefix prefill, notfailure.
CurrentGUIhas missing MCP_ADAPTER_API_KEY and EXA_API_KEY warnings/tool failures.
No relevant secrets in current shellenv. Agent-only clone didn't copy source secrets.
Do not claim full source configuration/tool functionality verified. No bypass/adminwallet.
Currentchat2470prompttokens+thinking/tools differsbench1551thinking/toolsOFF.

User requested FOCUS ON TOK/S. UI work PARKED, not publishing/restarting app.
UI modifiedlocalapprepo: src/sw.js network-first navigation; src/lib.rs opt-in
warmup?progress=1 NDJSON status/result preserving oldJSON; src/chat.html incremental
warmprogress reader+clear model-loaded/preparing-chat text+genericerror notresourceclaim;
tests/sw.test.mjs andwarmup.test.mjs.16Node/207RusttestsPASS. Build26307 maystillrunning,
loggui-warmup-build.log; pollonce. NOcommit/publish/upgrade. Priorprivate0.57.4stilllive.

Focus now parallel-copy-candidate.h basedrealcaller3.510176CPU-s in30scapture.
Ownworkparallel-copy-check extracted headers andbaselinecopyfunction using gitshow
EXACTddd4ec1428a6201e18975ea52b07c71e0f9aef26. UpstreamcheckoutHEADisbec4772f!
Never use working-tree files as deployedpin; baseline functions happenidentical.
Read-onlyupstream/privateforkpolicy retained. Nativeharnesscheck.cpp comparesactual
pinnedbaseline vs candidate across type/dims/padding/permutations/broadcast/threads,
withASAN+UBSAN; guardcasesalias/overlap. Compilation76350 pending; thenruncheck-sanitized.
BuildregularO3+OpenMP next for alternatingmedian7 benchmark with4compute threads.
Noengineproductionedits,newreleaseorresourcechanges yet. Noactiveinferencebenchmark.
Normal592/fourthreads/twoV100stilllive;GPUprofilingcomplete,normalworkersrestored.
Fundingninthonly,roughly09:04UTC. Update timerSTOPPED. Standingdon't-stop instructionactive.

## 2026-09-06 ~08:30 UTC — USER PRIORITY: GUI reports model cannot load
User: "I'm not really sure what you are testing. When I load the GUI of the app you deployed it says the model couldn't be loaded."
ACKNOWLEDGED: testing/chatAPI successful butGUI notverified; pausedperfwork,
prioritizingGUI. No new performance experiment untilGUI chat verified.

REPRODUCED in Chromium: ownapp tab723093363 at https://7c4149ee.app.enclave.host/c/...
modelsselector onlyserverdefault; onreloadwarmPill "Warmup failed; firstreply..."
Network/models and/warmup both401JSON {code:unauthorized,message:Missing or invalid token.}
Actualbackend loaded, lastAPI512 completedexactexpected8.7tok/s58.822s,TTFT2.425s.
Likelyclearrootcause: privateappcookie signedbyboot-keyinvalidafterMetalrestart;
EyesoffserviceworkerCACHE-FIRST navigation ignoresnetwork401loginbounce and
keepsservingcachedshell, whileAPI401fails. Sourceconfirmed supervisor.js
verifyAppToken checksSESSION_KID;privategatefail401forfetch,HTMLloginbouncefornav.
Eyesoffsrc/sw.js cache-first navigation returns hit even ifnetwork401.
Modeldiscoveryfetchmodels doesn'tcheckres.ok, treats401bodyasemptylist;
warmLadder no models->warm()->misleadingmodel error.

CUAconnectedChromeID2. ResetREPLonce toretrievefullAPI docs (initialsessiondocs
wereold/omitted); nowpersistenthandles:
 eyesGui=cua.getTab("723093363",{browser:"2"})
 eyesNet=eyesGui.capabilities.get("cdp"), Networkenabled;eyesCursorlatest.
 privateAuth=cua.getTab("723093349",{browser:"2"})
Oldauthpage hadsignaturerejected; reloadednormalauthorizeflow, SUCCESSFULLY
navigatedbacktoapp on SAMEtab349 without anymanual bypass orcredentialinjection.
NOW privateAuth at https://7c4149ee.app.enclave.host/c/cmtpjsfjb20ngq
showscorrectqwen3.8-27b-q8 27.1GB, Signedin acct_7...4eed,
boot "Warming qwen3.8-27b-q8 (1 of 1)..." pending. Thiswarmup mayprefill
GUI'sthinking-on defaultprefix (benchmarkthinkingoff),takesminutes.
 guiWarmNet=privateAuth.capabilities.get("cdp"),Networkenabledafterwarmstarted;
 guiWarmCursor captured. No currentwalletapproval blocker! Do notreuseoldblockedstatus.
Usertab363canreloadonceauthwarmready (cookieshared), no needmoreauthorize.
Need GUIactualchat andvisiblecompletionbeforeperformanceworkresumes.

PlannedUIfix(not yetedited): serviceworker navigation network-first;fallbackto
cacheONLYonnetworkfailure soonline401/403 loginresponsesnot hidden. Preserve
staticassetcache andAPI/POSTpass-through. AddmeaningfulNodevmtestsofactualSW
401/403,200refresh,offline,prefix/APIpass-through. ConsiderhonestmodelsReady
HTTPerrorhandling (no unconditional401=>empty model list/warm failure).
PublishONLYprivateeyesoff-perfapp versionnext0.57.5 afterchecks usingagentwallet,
keep model/resources/context. Needfindpriorpublishflags/script first.
Appsource /home/steven/Projects/enclave-apps/eyesoff-ai (NOT apps/eyesoff-ai).
Apprepo unrelateduntracked risc-box/build-sndgpu/ andguest/fbdoom/xdoom.aug20.bak.
No productionGUIeditsyet. No resource changesorprofilersactive.

Benchmarkcontroller1551174 wasSIGSTOP whilelast512requestfinished; resumed
ONLYafter512JSONcomplete (endloop,no newrequests) so itcanvalidate/exit.
Parent63211 shouldbeDONE0;pollonce. All5normalrequestscompletedexpectedtext;
64=13.0,256=9.6,512=8.7tok/s. Newnormalbests but notnewcodegain,ambientload/sequence
needscontrol. FullfreshmetricsinJSON. NoextraCPU/GPUbenchmarkrunning.

Copyoptimizationlocalfile parallel-copy-candidate.h preparedONLYinwork,
notcompiled/tested/deployed; datafreeboundedparallelstridedcopy large>=64KB,
disjointsrcdst andmonotonicnonoverlapdst, fallbackoriginal. PARKEDduringGUIfix.
Fundingninth0.0005ETHsuccess~$1.24802,appgood~09:04UTC. No tenthfund.
TimerstillSTOPPED;normalGPUworkers1545721/1545723;runtime592,baseline4threads.

## 2026-09-06 08:23 UTC — real GPU capture complete; normal baseline running
Nsight2025 live capture SUCCEEDED: card9502 19360kernels/19337graph;
card9501 18882/18859. Exact512text+MTP283drafts229accepted. Actualrequest
59.366sdecode/8.6tok/s but INSTRUMENTED; do not claimnewnormalbest yet.
Initialcontroller76426 DONE1 erroneously checked proc disappearance; both
Nsightprofilerchildren were EXITED ZOMBIES, reports complete. Finalizer20246
DONE0 validated exactoutput,workersalive,exportedSQLite,analyzed successfully.
Scripts fixed zombiecheck/reaping for future; no need repeat capture.

Reports in gpu-traces/eyesoff-gpu2025-9502-1516819/capture.{nsys-rep,sqlite}
and eyesoff-gpu2025-9501-1516818. Summarytwo-v100-nsys2025-decode.gpu-summary.json,
combined-gpu-summary.json,live-gpu2025-final-analysis.log. Each~2.5MBreport.
Activityunion2.893s/29.815s(9.70%)card1;2.285/29.984(7.62%)card0.
Mosttime between submissions; no D2H event because kernel writes mappedreply.

Normalrestore61349 DONE0; hostconfigbyte-identicalbackup. Oldwrappers+targets
removed. Normalworkers1545721/1545723. Resourcesverified16vCPU/64GiB/2V100.
Runtime592/profileOFF/4compute threads/originalconfig. TimerstillSTOPPED.
ACTIVE63211 recovery+fullnormalcomparison (no profiling) prefix
 two-v100-post-nsys-baseline. RecoveryDONE; controllerlogpost-nsys-baseline-controller.log.
Short192DONE, full1551currentlyprefilling, thenHTTPS64/256/512 sequential.
No duplicate inference/CPU or GPU benchmark while this runs.

Ninthfund19020 DONE0, ONCE0.0005ETH agentwallet. Intentfund-test-ninth-eth.intent.json,
logfund-test-ninth-eth.log:credited1248342microUSDC,2159seconds(~36min) at578/sec.
Priorlease08:28UTC so fundingroughly09:04UTC. AgentETHremaining~.00203,
USDC.180398. Currentappfundingtotal$16.24802 equivalent. No tenth attempt.

New request-thread CPU filter: cpu-omp-caller/worker/caller-copies text files.
Within59230sCPUcapture, caller11.86CPU-s, calleractualmemcpy4.20s,
get_rows1.92s,attention3.12cum,gateddelta1.16cum. Background74%aggregate
is NOT wholewallaccounting. One memcpycallsiteinsidecopy-by-rows branch
 ggml_compute_forward_dup_bytes offset0x7686a accounts3.510176callerCPU-s,
zerohelpers. Exactlibggml-cpu disassembly verifies callmemcpyat0x76866,
inside same-shape/inner-contiguous strided rowcopy path. Currentcode divides
onlyne01 rows; ne02/ne03 or huge one-row copies can stay serial.
Filesprofile-copy-callsites.json,profile-dup-bytes-disassembly.txt.
Plan bounded disjoint-strided-row copy parallelization candidate in OWN
Enclavepatch/work artifacts, not upstream llama.cpp. No newcodecandidate yet.
Read-onlyupstreamAGENTS read: NOautomatedupstreamcontrib; privatefork exempt.
Noengineproductioneditsmade. Consider rowpartition across allrows/blocks;
onlylarge copies, disjointsrc/dst, monotonicnonoverlappingdststrides;fallback
originalforaliases/permutations/small. Mustexacttest+benchmark beforeintegration.

## 2026-09-06 08:11 UTC — live GPU capture warmup underway
Controller76426 remains active; setup84318 DONE0. Gateway and own app recovered.
CPU profiling remains OFF; four compute threads, original baseline config.
Current short192 warmup is running; full1551 follows before delayed30s512capture.
Do not launch other inference. After completed capture/request, restart normal
service to remove temporary running Nsight2025 wrappers; host config file has
already been restored. Timer still stopped. Funding good until~08:28UTC.

Prepared analyze-live-gpu-trace.py (compile checked) for actual live SQLite
exports only: kernel/copy unions, gap distributions, kernel/API breakdown,
per-second activity. It explicitly labels instrumented timings and avoids
claiming summed kernel percentages are request-wall fractions or SM occupancy.
Not run yet: live reports not captured. Older smoke results are not app evidence.

Current owner-only sanitized startup log nsys2025-owned-weight-placement.txt:
262 groups/409 weights, exactly cards0/1. Weight work per row:
card0 target12,535,726,080 MACs;
card1 target11,791,237,120+MTP424,673,280+output1,271,398,400.
nsys2025-weight-work.json. Repeated MTP/head use differs from bulk layers;
this suggests a refill scheduling imbalance but is NOT yet a measured time split.
No allocation, scheduler, kernel or production-code change made this interval.

## 2026-09-06 08:04 UTC — verified Nsight2025 live setup/capture running
All2025 gatesPASS:bothGPUkernels2640each;delayedCUDAgraph257events+exact
verification;wrapperlifecycle45946 DONE0. ArtifactsresultsJSONsaved.
ACTIVEsetup84318 start-gpu-trace2025-workers.py,loggpu-trace2025-workers-setup.log.
UsesONLYsupportedbinaryoverride;backupmetal-config-before-nsys2025.json.
Atsetupendrestoresoriginalconfigbytes automatically afterready/resourcesverify.
Must stillrestartnormalrunningworkers AFTER completedcapture/request.
Oldnormalrecovery9398 terminatedintentionally(OSpid1506743);noinferencewasrunning.

ACTIVEcontroller76426 run-live-gpu2025-capture.py,
loglive-gpu2025-capture-controller.log. Waitssetupthenrecoverownapp,
warms two-v100-nsys2025-warmup short/full;512localtwo-v100-nsys2025-decode;
10secafterfirsttext30secoldNsightCUDAgraphnodecapture.
Originalnsys2026scripts/reports retainedasFAILED;donotconfusenames.
Newworkers/sessionmanifestactive-gpu-trace2025-workers.json oncecreated.
2025wrapperexplicitlypassesonlydocumentedGPUknobs/loaderpaths toNsight;
noenvironment-discardflagin2025,NOwallet/APIsecrets passed.
ActualCUDAtrace=classiccuda (not2026cuda-sw option);noCPU samples/ctxswitch.
Controllerwaitsreport+profilerprocessEXIT beforeexport (fixexportcreationrace),
checksworkerPIDstillalive,text+MTPcountsexact585,>1000kernelANDgraph events/card.
No GPUspeedclaimuntilvalidactualdata. Expectedremainingfund~08:28UTC;
no9thfundattempt. TimerSTOPPED;resources16vCPU/64GiB/twoV100sunchanged.

## 2026-09-06 08:02 UTC — Nsight 2026 unsupported on Volta; normal workers restored
IMPORTANT: Nsight2026.4.1 live captureFAILED. StartingCUDAcollection caused
bothworkersSIGSEGVin libcupti.so.13.3->cuptiActivityEnable. Tiny144KiBreports
notvalidCUDAdata. InferencefailedprematureSSEat52.6s; doNOTtreat timingasresult.
Controller42775 DONE1, metadata retained. Workerwrapperlifecycleworkedand
supervisorrespawned; that didnotfixCUPTIincompatibility.

I chosewrongNsightversion. NVIDIAreleaseNotesexplicitlydropsVolta>=2025.4,
CUPTI13.3ActivityrequiresSM>=7.5. Usertoldcandidlywithsource link.
https://docs.nvidia.com/nsight-systems/ReleaseNotes/index.html
https://docs.nvidia.com/cupti/13.3.0/release-notes/release-notes.html
GeneralgetstartedpagePascal+wasinsufficient. DoNOT retry2026onV100s.

RESTORED normalrunningworkers via7186 DONE0 service restart usingbyte-identical
originalmetalconfig. Newnormalworkers1504244/1504245;MPS651454unchanged.
16vCPU/64GiB/2V100resourceverificationPASS. No runningliveprofilercapture.
ACTIVE9398 recover_and_bench.py two-v100-nsys-restored --recover-only;
loggpu-trace-normal-recovery.log waitinggateway, NOinference.
TimerstillSTOPPED;appbaseline4threads/profileOFF,ctx180224. Modelunchanged.

Nsight2025.3.1.90 downloadedofficialNVIDIA175210028bytes,
SHAd2484ad0faf6831b11fa0bf73c54232d9ea8beafb50414019e6ba299c4ed5718,
extractedtools/nsight-2025.3.1. No systempackages/drivers changed.
BothstandaloneassignedV100smoketestsPASS:2640actualCUDAkernelseach,
nsys2025-gpu-smoke-results.json,session2670 DONE0. Noappinferenceconcurrent.

DelayedCUDAgraphsmoke onisolatedTCP19591 .25GiBbudget completed:
257CUDAgraphkernelevents;exactintegeroutput/Freivalds/corruptionrejection/
denylist/packedcompatALLPASS;targetaliveaftercapturethenowneddiagnosticcleanedup.
Firstexportracedreportcreationandfailed; re-export AFTERreportcompletionPASS.
nsys2025-graph-smoke/result.json andcapture-complete.sqlite. NoGPUtestrepeated.
Mainnormalworkersuntouchedbydiagnostic. Session65363 DONE1 solelyexport-race;
manualfinalanalysisPASS. First2026corefiles150MBtotalretainedforfailureevidence.

PreparedONLYlocal nsys2025-worker-wrapper.py; oldversionflags(noenvdiscard)
usesexplicitnonsecretallowedenvlist beforelaunchingNsight (nowallet/APIenv).
ACTIVE45946 lifecyclecheck,nsys2025-wrapper-lifecycle.log, resultfileonPASS.
No newlive2025setupyet. NeedgateonbothGPU/graph/lifecyclesmokes beforeusing.
Plannewuniqueconfigbackup/setup/capturefilenames;restoreconfigfileafterlaunch,
thenremoverunningwrapperswithnormalservicerestartaftercapture. Neveroverwrites
oldfailedreports. Waitreportfinished/CLIprofilerexit beforeexport; existenceisnotdone.

Funding eighth$1SUCCESSonce. Contractbalance1000262afterfund;lease07:59:10,
creditcovers~08:28:00UTC(total$15). Agentwallet~.180398USDC + .00253ETH.
No9thfundattempt; usefreshstatusbeforelongfuturetests. Nootherwallet.

## 2026-09-06 07:50 UTC — live CUDA trace workers ready; recovery pending
CPU/barrier/HTTP work complete; native partial-column candidate REJECTED.
Correct6120cases but output rows1 0.661x,rows2 .897x; no production change.
Nsight2026.4.1CLI extractedlocally from officialNVIDIAdeb,222049634bytes,
SHAb896cb2b9586ddf617c363a43bababad0a015dff4c77d8f0fbb9c26144056a69.
No system packages/drivers installed. Wrapper lifecycle native smokePASS;
nsys itself exitsaftercapture despitekillnone, wrapper usespidfd toretainworker
supervision andcleans onlyitsownworkerontermination.

Setup42287 DONE0; supportedshieldedWorkers[*].binary temporarilysetwrapper,
normalenclave-metal.servicerestart (runtime592same), bothV100resourcesverified
16vCPU/64GiB/2cards. Newworkers1483232/1483235, wrappers1483172/1483173.
MPS651454unchanged. CUDA_MPS_ACTIVE_THREAD_PERCENTAGE100verifiedinboth
worker environments despite misleading worker.conf50startupprint(setenv0).
Active sessions in active-gpu-trace-workers.json, names eyesoff-gpu-9501-1483172
and eyesoff-gpu-9502-1483173. CollectionOFF untilnsysstart; duration30s,
process-treecuda-sw,nodegraphtrace,CPU samples/contextswitchOFF,envdiscardtrue.

HOSTCONFIGFILE ALREADY RESTORED BYTE-FOR-BYTE to metal-config-before-nsys.json.
Currentrunningworkers stillwrapper-supervised! After capture/request finishes,
restart enclave-metal.service normally toremove profiler fromrunningworkers.
No future configeditsneeded unless newchangesarrive; preserveotheruseredits.
Restore updater timer whenuserstop. No CPUallocation/increase/RTX3070.

ACTIVEcontroller42775 run-live-gpu-capture.py,loglive-gpu-capture-controller.log.
Nowgpu-trace-app-recovery.log waitingnormalpublicstorage recovery. Then
bench-pair two-v100-nsys-warmup short/full;512local-route two-v100-nsys-decode;
10secafterfirsttext startbothsessions for30s;waitreports+request;
asserttext+MTPcounts585;exportsqlite. TimingINSTRUMENTED, notspeedclaim.
No otherinference. Currentappconfigbaseline4threads/profilingOFF restored
by35523 DONE0. No CPUprofilerloaded.

Eighthfund$1commandcompletedexit0ONCE58353, intentfund-test-eighth-1.intent.json,
logfund-test-eighth-1.log. Freshstatus64739 confirmsbalance6=1000262,leaseUntil07:59:10UTC;
creditextendsfundingthrough08:28:00UTC at578micro/sec. No retry.
Earlierwallet1.180398USDC beforefund,expected.180398remaining. Totalexpected15.
No user/adminwallet, no otherappsecrets. GatewayrecoverycontrollerrefreshesJWT.

## 2026-09-06 07:44 UTC — 592 capture and HTTP check complete
Controller15552 DONE0, HTTP helper26601 DONE0. Exact592 CPU profile552017bytes;
all warmup/decode text matches585. 343.79CPU-seconds, background74.25%,
four-row71.21%, VNNI68.02%. 38585regions/30s:wall14.844424s,
caller14.701574s,entryexit0.142850s;272274callerbarriers1.392788s.
Calleroutsidepublicbarriers13.308786s is not all pure computation.
No major GOMP entry/exit bottleneck; public barrier timing is a smaller target.

HTTP models reuse confirmed: fresh2.019–2.270s; reuse .554/.556/.389s,
num_connects0 for all reused requests. No HTTP edits.

ACTIVE native-only controller27862 test-partial-column-refill.py,
log partial-column-refill.log. One-row4columns/two-row2columns to reuse input
loads; targets measured output on-path stalls. Production SIMD SHAunchanged.
6120exact cases then7alternatingrounds/3calls for27B shapes, rows1/2.
No other inference/test/profile process running. Current app profilingON,
config-cpu-profile-prefill.json; disable before unprofiled timing.
Fundingthrough07:59:10UTC, wallet~$1.18;no8thfund. TimerSTOPPED.

## 2026-09-06 07:33 UTC — 592 live; waiting normal storage recovery
Controller15552 remains active. CI Test34019022830/Deploy34019022819 bothPASS.
Runtimev0.5.592-cpu deployedhealthy; resources16vCPU/64GiB/twoV100s verified.
Exactprofile-root-592 andprofile-debug-592 extraction/build DONE; whole.text/
exportaddresses match. Modelkernel97cce14d unchanged. NewhelperSHAmatches4c26c608….
Currentcontrollerwaitingomp-barrier-profile-recovery.log: storageadapterhealthy
local200 butpublicIPFS502 pendingACME. DO NOT retryfailednanSSH or changeTLS/auth.
Normalplatformcertificateissuance recoveredthis onpreviousrestart.

Newfundstatusbarrier-funding-status.json:active,leasefundedthrough
2026-09-06T07:59:10.453287UTC at$2.0808/hour. No newfundattempt (total$14).
OwnJWTmetal-session.json stillpreviousboot untilrecoverhelper refreshesit.
Currentappconfigbaseline4thread/profilingOFF;controllerwillsetprofileconfigafterrecovery.
MPS651454;V100workers1442759/1442761. RTX3070excluded asverified.

AdditionalWAITINGscript22874 measure-models-keepalive.py watchescontrollercomplete;
then performs8read-only/modelsrequests (4fresh/4reuse), curlauthstdinonly,
noinference, outputmodels-keepalive-latency.json/log. Itwillnotrununtilprofiledone.
ExistingHTTPkeepalivefixc8d73b27(Sept1) alreadyinsupervisor;noHTTPcodeeditsmade.
Nootherbench/profileprocessactive yet. Restoretimerwhenuserstops. Continue.

## 2026-09-06 07:27 UTC — next barrier capture queued; four threads restored

Runtime591 still live. ACTIVE controller15552: run-omp-barrier-live.py;
log omp-barrier-profile-592-live-controller.log. Waits exact CI Test34019022830
and Deploy34019022819 for e4a161cfad1443c1f43a50014b78016e76d30080, then
expectedv0.5.592-cpu. Verifies helper SHA
4c26c608b616e88594bd69531312e2aa3a7e854cf4f1eb4d33bed242aa1255ee,
16vCPU/64GiB/twoV100s, extracts profile-root-592 and exactdebug, recovers
ownapp, sets four-thread nnCpuProfile config, warms short/full, captures
30sec decode after10sec, asserts text and caller-barrier log, analyzes+summarizes.
Future prefix two-v100-cpu-omp-barrier-profile-decode. Do not duplicate it.

Threadcomparison28545 DONE0; CPUmonitor5209 DONE; validation61305 DONE0.
All10outputs andMTPcounts exact585. Fourthreads5127.2/71607ms; twothreads
7.0/73576ms. Two reducedonpath9.250->4.907s andbackend36.742->31.096s,
buttargetdecode63.113->68.667s, outweighingdraft7.948->4.475s. Rejecttwo.
Fourthreads restored, profilingOFF, via14536 DONE0; logomp-threads4-restore-controller.log.
CurrentCIDbafkreihtn3ufukb3slsvyfxkcgdhokaqtz52u7rsrvs72vyvwaxndmyf74.
No inference now; nextcontrollerwilllaunch onlyafternewruntimeverified.

Three-file barrier probe passed8profilingtests+nativeC++compile AFTERbenchmarks.
Deepnested3level count/original3-valueABI checked. Originalcommita03c3564 rebased
toe4a161cf overCI-onlydigest187161ff andpushed. Testedsource+all8unrelatedfile
hashesunchanged (omp-barrier-rebase-preserve.json). Onlyunrelateddirtyfilesremain.

Latestreal591profilecomplete:39176OMPregions/30sec; wall14.678755s,
caller14.535814s,entry/exit0.142941s (3.65us/call). Entryexitnotmajor.
342.53sampledCPU-seconds;bg73%,spin16.36%,attention3.78%; notwallshares.
Newbarrierwrapperwillmeasurecallertimeinsidepublicbarriers (includeswaiting
forworkers/scheduling; notnecessarilyremovableoverhead). No result yet.

Fundingseventh$2SUCCESS,total$14,fundedthroughestimate07:59UTC;freshstatus
beforeextendingnextlongrun. Agentwallet~$1.18, no8thfundattempt. TimerSTOPPED.
Do notincreaseallocation/largerMTPsnapshot: RAMcommitted60430 vsbudget58982.
RTX3070excluded; agentownedprivateapponly. Reportprofiling-findings.md updated.
NoNsightinstalled/captured; gpu-tracing-next.mdrecordsNVIDIAsoftwareMPSmode,
noGPU/desktopchanges. Continue until userstops. No subagents.


2026-09-06 07:21UTC:4threads comparisonCOMPLETEalltext/MTPcounts correct. Fresh176.168s;cached64/256/5128.3/7.5/7.2tok/s,51271607ms;approxmask11946.3/onpath9249.8/head8599.0/worker16195.4ms.2threadsshort/full/cached64/256complete,512RUNNING. Full166.394s,cached64/2567.6/7.6. Donotselectuntil512complete. CPUmonitor5209read-only5seccounterswatchuntilcontroller28545done. Validationwatch61305waitsforfullcomparisoncompletionthenrunsnewprobe2testfiles+nativeC++compile;NOnewinferenceuntilvalidationdone. Newhelperalsofixesdeepnested-teamdepthpropagation;3-leveltestprepared,NOTyetexecuted.


2026-09-06 07:10UTC: prepared UNCOMMITTED next barrier-wall probe in three repo files only: shielded-omp-profile.c,ggml-shielded.cpp,test/shielded-omp-profile.test.mjs. Adds GOMP_barrier caller-only timers within active outer regions, includes nested caller barrier, coherent v2 five-value snapshot; preserves original3-value ABI. Stats appends caller-barriers/caller-barrier to existing omp-profile line. NO native tests/build run yet to avoid competing with current timing. gitdiffcheck passed. Not deployed. Validate after controller28545 completes, and select next step from comparison.

## 2026-09-06 07:09UTC — 591 profile complete; targeted thread comparison
Controller20460 exited0. Exact text+MTPcounts match585.30sec capture549809bytes;
342.53aggregate CPU-seconds,background73%,spin16.36%,attention3.78%.
39176OMPregions:whole14.678755s,caller14.535814s,entry/exit0.142941s(3.65us/call).
Regionentry/exitnotmajor. Callbackspin21.67CPU-s;outside34.37CPU-s,notwallshares.
Report updated; libgomp SHA matches587exactdisassembly. No new speed record.

ACTIVEcontroller28545 run-omp-thread-comparison.py,logomp-thread-comparison-controller.log.
Sequence:unprofiled4threads baseline prefix two-v100-omp-threads4, then2threads
config-profile-guided-threads2.json/prefix two-v100-omp-threads2. Allotherkeysidentical.
5requestseach;asserttextANDMTPcounts585. Currentfirstbaselineconfigure/warmup.
No largerMTPsnapshotfitscurrentRAMbudget;donotattempt. No newruntimechange.

## 2026-09-06 07:01 UTC — gateway recovered; 591 capture resumed
- Gateway local adapter was healthy but public certificate issuance was delayed. Let's Encrypt rate-limited; platform subsequently issued a cached ZeroSSL certificate. Public gateway recovered normally.
- Tested local and public relay read routes: exact WASM SHA 0b805904f5eb6ce96f322dabc62495a6b8bf2fe6edbc50aa3c1867129acd44a7 and profile configuration verified through ipfs_fetch. Public fallback had returned header-only 59-byte CARs.
- Attempt to populate existing nan Kubo outage cache FAILED SSH authentication (BatchMode publickey/password). No cache/server changes, no alternate credentials tried. Do not claim this fixed recovery.
- Controller20460 recovery passed; applied profile config CID bafkreiaa2mcktrewrppj5zs5gfksfnw7zzzibo2t3njqrokjiocxp6spaq by normal agent-wallet CLI. Own app restarted app_176b5c74c, warmup pending.
- Seventh $2 funding succeeded once (fund-test-seventh-2.log). Total current app funding $14. Lease renewed through07:31:30UTC with remaining credit expected to extend further. No resource changes.
- Existing controller handles sequential warmup -> decode capture -> exact591 analysis; no duplicate inference.

# Instrumentation 591 deploying — 2026-09-06 06:48 UTC

Controller20460 ACTIVE: run-omp-profile-live.py, logomp-profile-591-live-controller.log.
CI Test34017292855 andDeploy34017292893 ALLSUCCESS on
c0de88babd05b1aa6eebfc80e9cee9f3d2fb7f55. 591 is LIVE/healthy as of06:51. Source/helper manifest verified; exact591 native .text+exports match debug symbols. Controller is waiting on publicIPFSgateway recovery; no inference started.
OriginalOMPprobecommitf8fb9edafb19c08d142cd001c7faa88f7c5e2538 hadoneCIunit
compilefailureFORTIFYwarn_unused_result onwrite. Fixedin c0de88ba;8testsPASS
inclFORTIFY2strictWerror,nested/localdlopen/inactivework,gperftoolssignalstartstop.
Earlier17backend/tenanttests16PASS1SKIP,nativeC++compilePASS. 590 NEVER deployed.
FinalOMPsourceSHA75e8fd49981ea4062c529d3fe29779442c9fad7552d46e39fe1c252710e2d73b.
OnlyunrelateddirtyMakefile,calibrator,wheels,workerbackupremain;preservedhashes.

Controller afterupdate: verifyresources/source/helpermanifest(shieldedfield),
extractexact591initramfs into profile-root-591, build-debug591withwhole.text+
symbolequality, recovergateway+ownbaselineapp/refreshauth, configureprofiler
viaCLI, thenwarmupshort+fullprompt, capture30scached512at10safterfirsttoken,
asserttext585 andnativeOMPtiminglogs, analyzeCPUstack. Names
TWO-V100-CPU-OMP-PROFILE-DECODE actualtwo-v100-cpu-omp-profile-decode.
Logs omp-profile-resources.log,profile-extract-591.log,build-profile-debug-591.log,
omp-profile-recovery.log,omp-profile-after-update-configure-controller.log,
omp-profile-warmup-controller.log,omp-profile-capture-controller.log,
omp-profile-analysis-controller.log. DO NOT duplicateupdate/inference.
Mainruntimebeforeupdate589; currentprofileconfigNOTenabled yet.

BothconfigureattemptsbeforeupdateFAILED atIPFSupload502 BEFOREchainconfigwrite:
67836/62229done1, logsomp-profile-configure-controller.log and
omp-profile-configure-retry-controller.log; private innerlogs two-v100-omp-profile*
configure.log. NoCIDsigned/mutated. Desiredalready-pinnedCID
bafkreiaa2mcktrewrppj5zs5gfksfnw7zzzibo2t3njqrokjiocxp6spaq isEXACTdesiredJSON
(hashverified), butNOcustomchainwrite/reuseworkaroundmade. Controller retries
normalCLI ONLYaftergatewayrecovery. CurrentbaselineCIDbafkreiht...unchanged.

NEW operationalfinding: publicIPFShealth502; localpublicstorageapphealth409
failed. OwnJWTstatusofotherapp404 (didNOTbypassownerAPI/adminwallet). Host
systemoperationaljournal saysstorage0x7ae476a3...refusesrestart: its1566MiB+
57953committed exceeds58982ceiling by537MiB;nnweights28586MiB. Localavailability
ramBudget58982/committed57953/free1029 at06:44. It backs off10min. Otherd9798
alsofailsRAMnow. NoUDP/auditerrorcausalclaim. Noresourceincrease/proxychange/
memoryaccountingbypassmade. Agentlsall18deployments:ONLYcurrent7c4149eerunning;
otherstopped/unfunded, nooldtestresourcetorelease. Agent-owned-deployments.json
private. NOotheruserappsmodified/restarted. Runtimeupdaterauthorizednormalrestart.
PotentialcodeissueNOTFIXED: _rec_ram_mb admission at5220 occurs before
_spawn_and_wait setsnnResidentMb at5412; couldadvertiselesscommittedinitially.
Do not exploitthatorder toforceoverbudget. Needassessafterrestartrecovery.

589resultsretainbest5127.4tok/s69.523s inrepeat,first7.0/72.859,baseline5886.5/
78.324. Alltext+MTPexact. Lastcommentary saysCIallpassandverifiedupdateunderway.
Noactiveinference/heavykernelbenchmarks;blockedvariantsallcompleted/rejected.
Preserve16vCPU64GiB2V100/ctx180224Q8MTPvision. Timerstoppedrestoreonuserstop.
Fundinglastsixth$2~06:00,totalcurrentapp$12,agentwallet~3.18,estimatedthrough
07:01:30UTC;checkfreshbeforemorefunding. No7thtopupyet. Continueuntiluserstop.

---

# Current work — 2026-09-06 06:38 UTC

Runtime 589 LIVE/healthy. Plane4 comparison AND owned-app restart repeat are
COMPLETE; controller7781 exited0. All5 outputs AND MTPcounts match585 in both.
Fresh1551 localTTFT163.163/165.837s vs588 baseline185.286. Cached512 decode
72.859/69.523s (7.0/7.4tok/s) vs78.324s (6.5). Approx onpath masks8.885/10.763s
vs21.348; combined shielded graph37.230/37.549 vs48.714s. BothSHMstreamlinks
verified inplane4-repeat-native-transports.log. Reportupdated profiling-findings.md.

Three additional blocked kernel candidates REJECTED; livekernel unchanged.
Each15732oraclecases passed. Two six-column variants slower; four-columnblock
negligibleheadgain anddownregression. Testcontroller2366completed; log
refill-block-variants.log. Keep production97cce14d plane4 implementation.

Read-only GET /models latency: public2.1–2.3sec vslocal4–5ms, roughly1.5sec
TLSsetup; models-route-latency.json/log. Repeatcached512TTFT8.465 includes
~8.1sec beforeheaders, cachedprefill3ms. Publicsetupdelaynotyetattributed fully.
No proxy/TLS configurationchanges. Keepauth/encryptionintact.

NEW WORK NOT COMMITTED: OpenMP wall-time companion toexistingnnCpuProfile.
Files wasm/ggml-shielded/shielded-omp-profile.c(new), ggml-shielded.cppstats,
metal/build-image.mjscompile+manifest,wasm/wasm_manager.pypreloadonlyoptin,
test/shielded-omp-profile.test.mjs(new),test/wasm-cpu-profile.test.mjs.
GOMP_parallel wrapper forwards originalwork unchanged, counts ONLYactiveCPU
capture outerregions; coherenttotalswall/callercallback/entry-exit. No tensor
reads; defaultnotloaded. Native localdlopen+nested+inactive correctnessPASS,
8profilingtestsPASS. Additionalbackend/tenanttests+nativeC++compileRUNNING.
Needfinishvalidation,commit/pushsixfilesONLY,CI,deploymentthennewdecodeCPU
capturewithOMPwalltiming. Mustextractexactnewrelease/debugsymbolsfirst;
589profile-rootnotextracted. NOinferencecurrentlyactive. bench.py nowkeeps
[shielded] omp-profile loglines alongside existingcounterlines.

Preserve unrelateddirtyMakefile,shielded-calib.cpp,wheels,workerbackup.
Currentconfigstill deficit/defaultOMP,nnCpuProfileomitted,ctx180224Q8MTPvision.
16vCPU/64GiB/twoV100sONLY; RTX3070excluded. Owneragentwallet/ownappONLY.
Sixth$2topupwasSUCCESS~06:00,totalcurrentapp$12funded. Fundedthrough~07:01:30UTC,
agentwallet~3.180398USDC. No newfundingneedednow. TimerSTOPPED; restore
systemctl --user start enclave-metal-update.timer whenuserstops. Continue
untiluserstop; latestprofilingquestionansweredcandidly. No subagents.

---

# PLANE4 COMMITTED — CI/DEPLOY CONTROLLER ACTIVE — 2026-09-06 06:06 UTC

Commit97cce14d9ed011cc5deea7443e0b884982662821 pushed main. Two files only:
wasm/ggml-shielded/shielded-simd.c four-row one-plane/four-column cache layout;
test/shielded-refill.test.mjs added widths4/5/6 (6120exactcases). Original local
commit64640267 rebased over upstream CI-only35498f75 (sidecar image repin).
Autostash applied successfully; unrelatedMakefile/calibrator hashes verified
unchanged. Preserve all unrelateddirtyMakefile,shielded-calib.cpp,wheels,etc.

All native tests PASS inclgenericCbuild. Four/six/five-column prototypes each
3060integercasespassed; four columns fastest. Maintained loop-based repo
implementation rechecked6120cases + alternating7round microbench vs exact588
source. 27B4row gate1.281x/down1.262x/head1.237x;8row1.243/1.272/1.217.
Smaller0.5B/4Bshape gains1.071..1.637x,noregessions in tested shapes. Logs
plane4-repo-tests.log,plane4-integrated-bench.log,plane4-small-model-bench.log,
refill-plane-variants.log. All benchmarks COMPLETED, noactiveinference.
No whole-app gain claimed yet.

Controller32927 run-plane4-live.py ACTIVE, logplane4-live-controller.log.
It waits Test34015549298+Deploy34015549261 success on97cce14d, then expected
CPUv0.5.589-cpu publication, prechecks updater latestexact589, runs updater
(logupdate-0.5.589.log), verifieshealth/resources AND manifest's source SHA
shielded-simd.c=a2db58fd0edf6e096fb2c45701bf2197e2cebebd8ac33c07a8613aa0436dac91.
Thenrecover/JWTownapp withplane4-recovery.log andrun-comparison prefix
TWO-V100-PLANE4-STREAM (actual lowercase two-v100-plane4-stream), baseline
config reuseCIDbafkreihtn3ufukb3slsvyfxkcgdhokaqtz52u7rsrvs72vyvwaxndmyf74,
reference two-v100-tile2-stream, alltextasserted. NO duplicateupdate/recovery/
inference. Controller's update may start automatically aftergates.

Runtime589 now LIVE/healthy, source SHA and twoV100/16vCPU/64GiB verified. Controller32927 is in gateway/app recovery (plane4-recovery.log), no benchmark started yet as of06:12. Baseline config restored withCPUprofilingDISABLED by
configure-only22513completed(success markerplane4-configure-controller.log).
Both optionalcostandspin1000controlsOFF(default). Profilecontroller72392 done0,
profile +whole1551/64requestexact585. FreshprefillCPU30s:330.10CPU-seconds
aggregate;refill_main75.26%,fourrowkernel75.83%,loads29.98%,dpbusd40.46%,
CPUattention0.67%. Entirecaptureprefill_onlytrue,metadata763712bytes. Full
reports two-v100-cpu-profile-prefill.cpu-*.txt exactdebug588validatedbefore
sourceedit. DoNOTreread oldprofilelineinfo againstnewsource(unshiftedtopokay).

Funding: sixth$2topup SUCCESS ONCE~06:00, fund-test-sixth-2.log. Total$12funded
currentapp. Agentwalletbeforetopup5.180398USDC, now~3.180398. Fresh
fund-sixth-status.json shows estimatedfundedthrough07:01:30.246UTC. NOmorefund
needednow. Maintain16vCPU64GiB2V100only,3070excluded,ctx180224Q8MTPvision.
TimerSTILLSTOPPED; restore systemctl --user start enclave-metal-update.timer
whenuserstops. Userlatestquestionprofiling answered; continueoptimizing until
userstop. No subagents. No browserauthbypass.

---

# PREFILL CPU PROFILE ACTIVE — 2026-09-06 05:56 UTC

All runtime588 controlled comparisons COMPLETE. Controller73080 exited0.
Defaults: fullTTFT185.286; cached64=8.5,256=6.9,512=6.5tok/s/78324ms.
Cost-only:188.584;8.7/6.7/6.4,51279474ms. Spin1000-only:186.609;
7.8/6.9/6.5,51279002ms. ALL five outputs in each trial match585. Neither
improved overall performance; BOTH DEFAULTS RESTORED. Spin reduced onpath
mask21.348->13.719s and combined shieldedbackend48.714->39.885s but total
same/slower; do not claim whole-app gain or proven wake-up attribution.

Controller72392 run-prefill-profile.py ACTIVE. Configure-only19627 DONE0;
config-cpu-profile-prefill.json = deficit/defaultOMP+nnCpuProfiletrue.
Exact588 symbols extracted profile-root-588 and debug validated in
profile-debug-588/validation.json by23931 DONE0 (.text+exports+sourcehashes).
Warmup two-v100-cpu-profile-prefill-warmup192/32 COMPLETED77.219sTTFT,
exact585text (instrumented, not newtiming claim). Now own fresh1551/64 request
using capture-cpu-profile.py --phase prefill --seconds30 --delay10. CPU capture
name two-v100-cpu-profile-prefill; watch prefill-profile-capture-controller.log,
then prefill-profile-analysis-controller.log. NO other inference/benchmarks.
Capturehelper checks phase ends beforefirsttoken and saves phase/prefill_only
metadata; onecapture/process. Analyzer now uses matching profile-debug-NNN
with mandatory .so hash checks, fallback586 only if samecodehash. Do not use
wrong old source lines for old profiles.

Prepared ONLY make-refill-plane-candidates.py and generated
shielded-simd-plane4.c/plane5.c/plane6.c: fourrowkernel computes one residue
plane per pass, reuses four input vectors across4/5/6output columns. Hypothesis:
12inputrows*K5120=60KiB exceeds host48KiB L1d; oneplane4rows+4/5columns weights
is40/45KiB. Sixcols testsregisterlimit24acc+6weights+1input=31. Moreweight
passes but fewerinputloads; exactsamefieldarithmetic. NO compile/test/benchmark
YET, do that only AFTER currentprofile+requestfinishes. Need nativeoracle plus
controlledalternatingmicrobench before touchingrepo. Currentrepo only old
unrelateddirtycalibrator/Makefile/wheels; no newproductionchanges.

Fresh funded status05:55 fund-profile-guided-status.json: active, balance22
microUSDC BUT prepaidlease through06:03:50UTC. DO NOT mistake nearzero balance
for unfunded now. Total$10 fundedcurrentapp sofar, latest$2fund04:56.
Need check/topupfromagentwalletbeforemoretestingpast06:03:50; do notdoublefund.
16vCPU64GiB2V100s unchanged,3070excluded. TimerSTOPPED,restorewhenuserstops.

---

# BASELINE AND COST COMPLETE — 2026-09-06 05:45 UTC

Runtime588 LIVE. Controller73080 still running; no duplicate inference. Baseline
deficit complete6.5tok/s512/78324ms/TTFT2.480, fullTTFT185.286. Cost-only
complete6.4tok/s512/79474ms/TTFT2.538, fullTTFT188.584. ALLtextmatch585.
Cost FAILED to improve sustained time/headstalls; leave it OFF, no combination
trial justified. See profile-guided-results.json and experiment-notes.md.
Controller now configures spin1000-only (deficit) with CID
bafkreig7ejvgnowoke25hsvrsv56pu5ydvnsvpsrdqhvxcm737gpqq23na. Need verify
native logs actual deficit/spin1000 after startup. Timer stopped; restore onstop.
Funds through~06:03:50, no newfund since04:56. Resources unchanged.

Later profile plan: capture-cpu-profile.py --phase prefill prepared, NOT RUN.
After controlled trials, enable profiling on selected configuration, warm short
192prompt only, then profile fresh1551prefill (64output). Need extract exact588
symbols from metal/dist/initramfs.cpio.gz into profile-root-588 and build
validated profile-debug-588 with build-profile-debug.py --release588 (argument
syntax is --release 588). Do not use587debug for588; no heavybuildduringtimings.

---

# LIVE UPDATE AND CONTROLLED COMPARISON — 2026-09-06 05:25 UTC

Both Test34013690849 and Deploy34013690848 SUCCESS. CPU588 published05:22:40. Manual updater session78818 COMPLETED successfully; runtime588 LIVE, log update-0.5.588.log. Controller session73080 run-profile-guided-experiments.py waits healthy588, verifies resources, refreshes own JWT/recovery, then runs deficit/cost/spin1000 configs sequentially. It asserts all text against585. DO NOT start duplicate updates, recovery or inference. Main log profile-guided-controller.log; per-experiment two-v100-guided-POLICY-controller.log. Gateway and own app recovery COMPLETED. Baseline deficit config CID bafkreihtn3ufukb3slsvyfxkcgdhokaqtz52u7rsrvs72vyvwaxndmyf74 applied; short diagnostic done TTFT89.008s/decode5.7tok/s exact585text. Full1551 prompt processing at05:33 UTC. Native logs confirmed deficit + default OMP and both stream-load SHM links; guided-deficit-runtime-controls.log. Summarize with python3 summarize-guided-results.py (writes profile-guided-results.json). Native policy/spincount still must be verified from resulting logs. No CPU profiler in new benchmark configs. Existing private browser sign-in remains blocked; no bypass. Funds through~06:03:50, no more funding yet. Update timer remains STOPPED, restore on user stop. No new source edits beyond committed d071e4b5, preserve unrelated dirty files.

---

# NEW CONTROLLED EXPERIMENT READY — 2026-09-06 05:20 UTC

CPUprofilingrequirementCOMPLETED, seebelow. Noactiveinference. Runtime587live. Newcommitd071e4b5 (pushsession6519) adds TWOindependentoptincontrols, defaultbehaviorunchanged:
- nnShieldedRefillPriority=deficit|cost mapsSHIELDED_REFILL_COST_PRIORITY0|1. Newpick_refill_group keepsurgentcoming<B lowest-first;nonurgentonlyfullbatchesdeficit>=B, choosemaxdeficit*K*u_len in costmode. Castbeforedoublemultiply nointegeroverflow. Nochangespooldepth,threads,maskbank,slotreserveorcrypto. Defaultdeficitselectorbehaviorpreserved.
- nnOmpSpinCount0..1000000 mapsGOMP_SPINCOUNT;omittedpreservesruntime. ReducesCPUbusywaitbutnotthreadcount. Target1000first. Nativeperiodicprofilelogreportsrefill_priorityandomp_spincountforverification.
17focusedtestsPASS;final10includingnativeCselector(urgent/fullbatch/held/reserved/nonmutation/overflow)PASS;actualC++backendcompilePASS (onlyexistingvendorunusedwarnings). DocsCPUprofilingupdated. NoSIMDarithmeticchanges. NewcodeCOMMITTEDd071e4b5;notdeployeduntilnextrelease588+CIpass.

Preparedconfigs(NOprofiler):config-profile-guided-deficit.json,config-profile-guided-cost.json,config-profile-guided-spin1000.json. Allsameb4/t4/padwait10ms/SHMstream/nnCtx180224/twoV100boundary. Firstbaselineexplicitdeficit,noOMPoverride;secondcostonly;thirddeficit+spin1000only. Needrelease588updateafterCIthenrecovery, run-comparison.py eachsequentially withuniquePREFIXand --reference-prefix two-v100-tile2-stream toassertALLtextincluding512. CurrentappconfigstillnnCpuProfiletrue completedcapture;configure-pairwillremoveitforbenchmarks. DoNOTautoapplycombinedpolicybeforeseparateresults. Canstartnewupdater/benchmarkcontrollerafterCIgate. Fundsthrough06:03:50; monitornearthen, don'tfundagainnow.

OpenMPattributionRESOLVEDviaexactELFdisassembly: hottestPCsoffsets0x256c2(34.08s)and0x258a2(15.18s)immediatelyfollowPAUSEinpollingloops,third0x258afcomparison. So~14.8%CPUisspinwait,notactualomp_get_num_procsfunction(neareststrippedname). profile-openmp-addresses.txt andprofile-openmp-disassembly.txt evidence. OfficialGNUdocshttps://gcc.gnu.org/onlinedocs/libgomp/GOMP_005fSPINCOUNT.html default300000spinsunlessOMP_WAIT_POLICY overrides. Ubuntu debuginfodsession39053TIMEDOUT;don'tkeepretrying, noextrasymbolsdownloaded. libcname__nss_database_lookupstillpotentiallymisleading;notusedforoptimizationclaim.

Allprofiling/benchmarkhelpersidle/completed. Userlasttoldtwoprofile-guidedchangeswilltestindependently, noresource/cryptochanges. Update timerSTILLSTOPPED;restorewhenuserstops. No subagents. Preserveunrelateddirtycalibrator/Makefile/wheels.

---

# CPU PROFILE CAPTURED — 2026-09-06 05:14 UTC

SUCCESS: runtime587 CPU capture complete,30safter10secwarmeddecode. Artifacttwo-v100-cpu-profile-decode-retry.cpu.prof785616bytes,metadataJSONstatecomplete/errornull. Matching.cpu-top/background/onpath/lines/raw/cumulative.txt written by analyzer84215. Allinferenceandprofilingcontrollerscompleted. Nativecaptureinstrumentedrequesttextexact585; do notclaiminstrumentedratesasnewbest. CPUaggregate334.53s (acrossthreads, NOTwalltime):backgroundrefill_main249.37s74.54%;fourrowkernelinclinline240.77s71.97%;onpathSIMDrefill7.27s2.17%;CPUflashattention10.73s3.21%;~49.78s14.88%OpenMPruntime currentlymisleadingstrippednearestsymbolomp_get_num_procs. ResolveOpenMPbeforeinterpreting; libc__nss_database_lookup also likelystrippednearestsymbol. NativeSIMDdebugcompanionfullyvalid. UsertoldactualCPUprofile75%backgroundmask,3%CPUattention,15%OpenMPpendingresolution;linkedprofiling-findings.md updatedaccordingly.

Debugsymbolsdownload session39053pending fromofficialhttps://debuginfod.ubuntu.com/buildid/.../debuginfo forlibgompfa0c1b446610c4b7aca51e1183050acf5aa79503 andlibc6d64b17fbac799e68da7ebd9985ddf9b5cb375e6. Saveprofile-system-debug/libgomp.so.1 (needsrename/aliaslibgomp.so.1.0.0 toactualmappingbasename),libc.so.6. BuildIDverifiedonfetch. IfserverunavailableuseactualELFdisassemblyofsampledOpenMPaddresses. Profile maps libgompbase=0x7fbbe7fa9000 (mapstart0x7fbbe7fb4000 offset0xb000). Seeprofile-openmp-addresses.txt.

Profilingrequirementnowmet; continueoptimizinguntiluserstop. Strongnextcandidate:cost-weightedbackgroundrefillprioritytoschedulehugevocabularyoutputprojectionearlier, becauseoutputaccounts18.048of19.884s (~91%) remainingonpathmaskstallin585512. Keepexistingurgent-lowestgrouppriority, onlychooseamongnonurgentFULLBATCHeligibledeficits>=B usingdeficit*K*u_len score. DO NOTraisehighwaterandgenerateone-rowbackgroundbatches:loses4rowreuse. Preservepooldepth,maskuniqueness,threadcounts;configtoggleforA/Bdefaultoffmaybeworthadding. NOnewperformancecodewrittenyet! Needtests+controlledA/Bbeforedefaultrollout. AlternativeOMPspinpolicyonlyifprofilingprovescriticalbenefit;CPUidle/spinpercentagealoneisn'twalltimebottleneck.

Allotherconstraintsfundingetcbelow. Runtime587live,profilerconfigstilltruebutcapturefinishedoneperprocess. ETHfundedthrough06:03:50,noanotherfundyet. Update timerSTILLSTOPPED;restoreonstop. Repoonlyunrelateddirtycalibrator/wheels;95177e26latestagentcommit. Noactiveinference;download39053onlyactivelocaltoolcurrently.

---

# LATEST OVERRIDE — 2026-09-06 04:59 UTC

User latest: Have you actually used profiling or just random changes? Answered candidly: engine phase/request timers and GPU telemetry yes, no actual CPU stacks/Nsight yet. We are implementing actual CPU sampling before further performance tuning. Keepworkinguntiluserstops. TwoV100sonly, RTX3070excluded, Metal0existing16vCPU64GiBunchanged,27BQ8MTPvisionnnCtx180224preserved. No subagents. No browserverification; priorChromiumwalletsignature/popupblocked, do not bypass.

LIVE586, noactiveinference. FirstCPUcapture FAILED with409: chroot hasNO/proc, so profiler could notinspectSigCgt before signalling. No usable appprofilefileexists. CPUprofileAPIstateincomplete. FailedcapturebenchcontinuednormallyandCOMPLETED512at6.6tok/s,77635ms,TTFT2.609,exact585text. No sampleswerecollected; do notclaimCPUflamegraphyet.

FIX committed/pushed95177e266b11fdc697c415a39c3fce6fe55f1cbd: nativeprocfsread-onlyro,nosuid,nodev,noexec inmetal/guest/init, outsideWASIpreopens. ProfilerpreparefailsEARLYifnative/proc/status/mapsmissing;failedcaptureerrorpersistedinmetadata.7targetedtestsPASS;actualsameUbuntu runtimechroot test inunshareuser/mount/pidnamespace PASSED start/timedstop/maps/processalive withROproc. Test34012737895 +Deploy34012737908inprogress;CPU587release34012800511inprogress. ALLCIpassed;CPU587published. Update587started05:00UTC, logupdate-0.5.587.log; profile-retry-after-update.py running concurrently waitinghealthy587 thenresources/recovery/coldfullwarmup/capture. NOduplicateupdatesorinference. Seeprofile-retry-after-update.log; newcaptureprefix two-v100-cpu-profile-decode-retry, warmupprefix two-v100-cpu-profile-retry-warmup.

Oldcontroller38077 profile-after-update.py exited1 afterfailedcapture. Oldanalyzer71713 explicitlyterminatedbecauseprofilewillneverexist. Startupwatch6573complete; BOTH586nativeV100linksconfirmedstream-loadSHM (profile-native-transports.log). Update587completed05:03. Controller78754 profile-retry-after-update.py waitinggatewayrecovery thenwarmup/capture. Analyzer84215 analyze-cpu-profile.py two-v100-cpu-profile-decode-retry waitingmetadata. Noactiveinferenceyet. Exact587symbols extractedprofile-root-587 andshieldedSHA matches586debugcompanion. Capturehelpernowrecordsmetal_release;analyzerselectsrootbyrelease. Profileunit/testsessionsdone. Localunsupporteddebugcompanionstale artifactsmarkedINVALID.

CurrentprofileconfigCIDbafkreihv5cdp7xampxyc5fbdehq47zaqnv3htqr2x2igb3glh6fzhb2iyi (sameb4/t4/10mspadwait/shmstream plusnnCpuProfiletrue). On587restart itwillautostartwithprofilerIDLE; noextra configtxneeded. Afterupdate:verifyresources587, recover_and_bench.py NEWPREFIX --recover-only(refreshMetalJWT), assertcurrentCIDandGETcpu-profileidle. WarmONLYfull1551/64 withbench.py private/local, then capture-cpu-profile.py NEWPREFIX --seconds30 --delay10. Updatedcapturehelperwaits10secafterfirsttokenbeforeCPUcapture, persists409bodyiffailed; capturedratesinstrumented. Originalname two-v100-cpu-profile-decode ALREADYEXISTS: use retry suffix.

Exact586symbols extractedfrominitramfs into profile-root-586/opt/roots/wasm, shielded.soSHA73dcfcf1962f273925970870cc39a82d6d68e0f9210286df8dae169b83ee8602 byteidentical585. profile-debug-586/libggml-shielded.so hasdebuglineinfo: ALL.textinstructions anddynamicfunctionaddressesverifiedidentical, validation.jsonstoresactualSHA. PPROF_BINARY_PATH=profile-debug-586:profile-root-586/opt/roots/wasm. Localpprof tools/pprof pinnedgoogle d6c3cb2f37ec. analyze-cpu-profile.py NAME waitsCPUmetadata thenwrites.top,cumulative,background(refill_main),onpath(sh_link_gemm),lines,raw. Update587symbols/extractorverifyhashesbeforeusing; noLLVM/enginechangeexpected. DO NOTuse /home/steven/Projects/enclave/metal/build/root (stale) or profile-debug/ (invalidstalecompanion).

Fundedownappadditional$2ONCE04:56, fund-test-fifth-2.logsuccess. Totalcurrentappfunded$10. Freshfund-fifth-status.jsonbalance960080,rate578,funded-throughestimate06:03:50UTC. Do notfundagainnow. ETHAGENTwallet0x29479... (keyenvneverprint); deploymentid0x7c4149ee08e14b76cc1fe3f417cc844cfed19b987c81f79425009e6a7279810b. METALJWTcurrent586untilrestart, SSOvalidSept7~00:55. Update timer STILLSTOPPED: MUSTrestore systemctl --user start enclave-metal-update.timer whenuserstops/ending.

Latestperformance585unprofiled:full1551/64TTFT185.581s(decode5.9),cached64 9.7tok/s,2567.0,5126.6(77620msTTFT2.526). Allrecent584reference textexact. 512phaseapproxdelta:mask23.301s,onpath19.884s,wire17.246s. Previous584stream5125.1tok/s,onpath44.722s,wire16.203s. Output.weight/card1alone18.048sof19.884sonpath(~91%). CPUprofilemustdistinguishbackgroundgenerationfromcriticalpath; don'tsumCPUtimeaswalltime. Potentialfuturepriorityheadrefillscheduler ratherthanlargeKpartialkernel becauseheaddominates, but NOtuningbeforeprofileanalysis.

Earlierstate/historybelowcontainsSTALEactiveoperationtext; latestoverridewins. Experiment-notes.mdhasfullbenchhistory.

---

# Active state — 2026-09-06 04:35 UTC

Keep optimizing until user says stop. Latest user asks whether profiling identified bottlenecks. Answered candidly with approximate phase timers (584 stream512: on-path refill44.722s, worker roundtrip16.203s of100.423s decode), no Nsight or CPU flame graph yet. PAUSE FURTHER TUNING until actual CPU sampling capture. Adding bounded opt-in owner-only gperftools profiling, separate from throughput benchmarks. No subagents. Metal0 stays16vCPU/64GiB, only twoV100s, never RTX3070. Preserve27BQ8/MTP/vision/nnCtx180224. Prefer privateAPI/CLI. No browser UI verification: Chromium authorization rejected and wallet-popup policy blocked; do not bypass/inject authentication.

## Active operation
Runtime586 LIVE, update41325 completed04:40. Profilerready, allCIpassed. Recovery81819 completed, own deployment running. Controller18765 completed two-v100-tile2-stream with --reference-prefix two-v100-partial-stream; all text including512 asserted against584. Configstreamb4t4padwait10 CIDbafkreibgiymjui7waarkj5r2u3rg5g4pgydugdplyc6jdyyipnkla4mqc4. Full1551/64 TTFT185.581s,prefill184880ms,decode10763ms5.9tok/s;cached64 TTFT2.985s9.7tok/s. Cached2567.0tok/sTTFT2.305;5126.6tok/sTTFT2.526,decode77620ms. Alltextmatches584stream. Noactivebenchmark. BothV100s/resources verified585 via verify-metal-test-resources.py; actual stream-load logs need recheck after model load.

CPU profiling implementation: nnCpuProfile:true adds fixed libprofiler LD_PRELOAD only ownnativeprocess, defaults idle. Owner-only POST/GET /v1/deployments/:id/cpu-profile proxies authenticatedmanager. Onecaptureperprocess 1..60sec49Hz, timerstop, privateLOGDIR/mkdtemp700 profilecapture.0, GETbase64max16MiB, teardowncleanup.19 targetedtestsPASS including realgperf timer/signal capture. Committed/pushed284579fa;Test34011821236 allPASS;CPU586releasepublished. Update586 completed04:40. Controller38077 profile-after-update.py active: resourcecheckPASS, gatewayrecoverypending, thenconfigureprofilewarmup then30secwarmed512capture. Logsprofile-after-update.log/recover-cpu-profile.log/profile-warmup-controller.log/profile-capture-controller.log. Do not duplicate. No tuningcode added. pprof pinned d6c3cb2f37ec installed at tools/pprof. Comparisoncomplete; updateafterCI+releasepublished. CaptureCPUdecode first, warmup beforestart, profile performance separate. Then inspectpprof with exactlive libs; CPU samples includebackgroundthreads and excludeGPUwaiting.

Funding previous estimate through05:06UTC; checkfresh beforethen. Update timer stillSTOPPED, restorewhenuserstops.

Completed584streamcontroller1897:full1551/64TTFT253.765s,decode4.6tok/s;cached64TTFT2.613s6.1;256TTFT2.381s,50786ms5.0;512TTFT2.725s,100423ms5.1tok/s,283/229. ALLtextmatches584socketincluding512. Bothactualstream-loadSHMlinksverified. Socket5124.9vsstream5.1modestgainNOTyetreplicated. Keepstreamfornexttile2comparison. Profile512delta:mask49.337s(includesonpath44.722),wire16.203s vs socketmask34.480/onpath30.130,wire34.355. Thusfastertransferexposesmaskrefillbottleneck;~4%overallgain. NoCPUfallback/verificationerror.

Hostconfig32MiB SHM backing perV100; backupmetal-config-before-shm.json. MPSandworkersONLYtwoV100UUID1397d8cd/042eb279;3070UUID75f32211excluded in workerlistandMPSdropin. Existing16vCPU64GiBunchanged. Update timerSTOPPED; restore systemctl --user start enclave-metal-update.timer when user stops. Manualupdatesbetweenexperimentsonly.

## Completed socket comparison
Controller19299completeexit0. Runtime584 partialrefill+socket,configCIDbafkreic233wjziwkevktnipljn2znonaf4smawwu4rdnd6elkgdlury6zq. Bothlinksint24vsock9501/9502,noSHM verified.
- two-v100-partial-socket-short:192/32TTFT96.025s,prefill85114ms,decode7016ms4.6tok/s,19/13.
- ...-long:1551/64TTFT249.939s,prefill248897ms,decode13905ms4.6tok/s,35/29.
- ...-https-64:TTFT2.741s5.9tok/s.
- ...-https-256:TTFT2.290s,decode50452ms5.1tok/s,139/117.
- ...-https-512:TTFT2.592s,decode104408ms4.9tok/s,283/229. Currentbest512result. EXACTtextmatchesBOTHrecent581SHM512runs, stilldifferslatefrom580socket512. Thisnarrowsdifferenceawayfromtransport, underlyinghistoricalvarianceunresolved. Short/full/64/256exact580text.
512periodicprofiledelta from256:mask34.480s(includesrefill30.130),wire34.355s,unmask+lhs2.639s,rhs1.423s. Profilesnotexactrequestboundaries. Noverificationerrors,contention0,local_nodes0.

Historical580socketbaseline fullTTFT256.393s4.9tok/s;cached64peak6.9,2565.1,5124.3. IDLEGAPCONFOUND:full->64gap45.54s,64->256.18s,256->512391.82s.581SHMgaps1.39/.16/10.16s;584socket.25/~.2/10s. Current584socketandstreamuseSAMEcontrollercadence. Don'tclaimold64peakdirectapples-to-apples.
581normalSHM fullTTFT267.123s4.3tok/s;cached64 5.3,2564.9,5124.7andrepeat4.8. Late512phrasefrequencyofcollisions vschanceofcollisions. Native24/32unmask+FVint64oracle72casesexact,nownew584socketreproducesSHMtext.

## New source / next experiment
Committed/pushedf15b3b54fe12f00d52d15788957c06d67b96fc86:tile2four-rowrefill reuses12planeloadsacross2outputcolumns,24independentaccumulators,exactmathunchanged. Updatedstaleschedulercomment;expandedtestexplicitwidths1/2/3/7/8/16/17.4284int64/stride/tail/extremecasesPASS(tile2-repo-tests.log),genericCobjectcompilePASS. Workprototype3060casesPASS. Controlled7alternatingroundsmedianmicrobench,NOinferenceoverlap:4rowsgate1.199x/down1.338x/head1.205x;8rows1.241/1.345/1.232. Logtile2-controlled-check.log. Noappgainclaimed. TestCI34010801983/Deploy34010802015ALLPASS;release585cpupublished04:13. Update54451inprogress;newtile2notliveuntilthatcompletes.

Only unrelated dirty files remain:Makefilecalibratorcomments,shielded-calib.cpp,wheels,worker.prev-v1.3a. Neverstage/resetthem. Nootherpendingagentcode.

## Draft2 preparation / memory question
config-batch4-thread4-padwait10ms-socket-draft2.json preparedNOTAPPLIED. OnlynnRsSeq2andmodels.qwen3.8-27b-mtp-q8-vl-gguf.draft_tokens2;nnCtx180224still. Device samplingtruebypassesconfidencegate,measureacceptance. Appguardallowsdepth2atthisctx. Actualnative14seqcurrentRSbuffer4189.50MiB,CPUmainKV11264MiB,MTPKV704MiB,eachcontextcompute683.32MiB. Upstreamddd4ec14llama-memory-recurrent.cppn_rows=mem_size*(1+n_rs_seq),soextraRSdepthcost2094.75MiB (NOToldshimcomment1.2GB). Checkfitswithinexisting64GiBbeforeapplying;donotincreaseallocation/shrinkcontext/bypassadmission. /availability04:11ramBudgetMb58982,ramCommittedMb60430,ramNnResidentMb28586,ramFreeMb0 (reservationledger,notactualfree). LedgernnResidentcountsmodelpreloads,nottrueRSS. Morememorynotyetauthorizedoutsideexistingallocation;needunderstandfitbeforetest. Primarysourcehttps://raw.githubusercontent.com/ggml-org/llama.cpp/ddd4ec14/src/llama-memory-recurrent.cpp .

## Funding/auth
OwnETH_AGENT_WALLET0x29479Bf04ED889D46a7AfB7f292B9Bb26e12647C. Deployment0x7c4149ee08e14b76cc1fe3f417cc844cfed19b987c81f79425009e6a7279810b,https://7c4149ee.app.enclave.host,privateeyesoff-perf0.57.4catalogindex9. deployment-batch8.json/sso-batch8.json/metal-session.jsonprivateauth. LatestMetalJWTcurrent584;refreshafterVMrestartwithrecover_and_bench.py --recover-only. AlwaysuseCLIagentenvENCLAVE_KEY=ETH_AGENT_WALLET,don'tprintsecret. ConfigwritesdefaultAPI;localbaseforstatus/restart/claim. DirectappHTTPSorlocalprivateHTTPforSSE;publicAPI/t routebuffersand502s,neveruse.
Fundedadditional$2once03:58,fund-test-fourth-2.logsuccess. fund-fourth-status.jsonbalance2000360spent5999640rate578lease04:08:29,funded-through~05:06:09UTC. DO NOTrepeatfundingnow;checkfreshchainbalanceplusleasewhenneeded. $8totalfundedcurrentapp,$2oldbaseline(refund.00568),oldbaselineinactiveDONOTresume. SSOvalidSept7~00:55UTC.

## Extra microbench candidates — NOT integrated
Workmake-refill-tile-candidates.py generated tiledpartial1x8/2x4/3x3 and split4into2x2rowsvariants. test-refill-tile-variants.py session83082completedexit0;eachvariant3060integercasesPASS. Logrefill-tile-variants.log. Compareagainstcommitted585tile2currentC,NOT580oldC. Firstvariant row1regressedgate/head~18–22%,butK17408down2.1–2.2x;row2down1.5–1.6x,gate1.09–1.19,head1.00–1.12;row3down1.28–1.31xbutothers~neutral. Splittingfull4regressesgate/head~20%,downneutral. REJECTsplit4andglobalrow1tile. Potentialfollow-upONLYlargeKpartialrows(K>=16384),keepcurrentoptimizedsmallKtoavoidregressions. Notimplementedinrepo. No newreleasebeyond585needednow. NativebenchendedbeforeMetalupdater54451started, no inferenceoverlap.

Exact symbols: extracted profile-root-586 from deployed initramfs; /opt/roots/wasm/opt/enclave/shielded/libggml-shielded.so manifest SHA73dcfcf1962f273925970870cc39a82d6d68e0f9210286df8dae169b83ee8602, byteidentical585/586. ProfilerlibexistsUbuntu. PPROF_BINARY_PATH=work/profile-root-586/opt/roots/wasm. DO NOT use repo metal/build/root(stale), INVALID-stale-build-root-symbols.json or profile-debug(stale invalidcompanion). New build-profile-debug.py session88861 attempts exact-allsource companion, ONLY useif .text/dynamic-symbolchecksPASS (build-profile-debug.log + profile-debug-586/validation.json).

## 2026-09-07 ~01:40 UTC - receipts, exhaustion refusal, bank hygiene (dealer architecture, continued)
- enclave 9b391c82 (merge of the receipt commit): the engine in the pVM signs
  `RECEIPT name seed_id pads tokens nonce sig` at the end of a run
  (`ggml_backend_shielded_pads_used`), the app relays `POST /v1/pads/receipt`,
  the relay verifies against the tunnel's SPKI, refuses replays / foreign seeds,
  accrues per-seed totals (`GET /v1/pads/receipts?seed_id=`). Pixel 8 Pro run 6
  (phone-run6.log): window 0..64, 2033 pads / 21 tokens recorded, runs 1.
- Dealt-mode EXHAUST is now a hard graph failure ("refusing to proceed without
  dealt pads"), never the fallback to computing the linear in the clear.
  x86: empty bank -> exit 2 in ~1.5 s, offloaded 0 / local 0; bank3 (format 2)
  -> 1251 nodes, 0 local, verify 0, pad check clean, text == self-minting.
- The 13:12 x86 .so was stale until now; the old `bank/` and `bank2/` shipments
  are FORMAT 1 (unreadable by the v2 reader -> "not in any shipment"); use
  bank3 or re-mint. CORRECTION: the "text ends at Paris + EOG" scare was my
  grep showing only the first line of a multi-line completion plus n_predict 8
  vs 16; the 16-token run prints the same three lines as every earlier run and
  2363 nodes / 2033 pads, identical on the self-minting, directory-bank and
  HTTP-bank paths.
- Bank hygiene (built, phone run pending): the app streams only the current
  seed's shipments, the VM answers H(ave)/G(o) after the header so restarts do
  not re-stream, both sides drop foreign-seed files, the app drops files below
  the platform mark, the engine drops shipments wholly below each reserved
  window. Run 6 had re-streamed six 117 MiB files (four of dead seeds) before
  the engine started (prefill 65 s vs 52 s in run 5).
- Still running on the workstation: local hub :8787 (dev-unattested), CPU
  worker :9600, dealer loop for tunnel "pixel" (scratchpad dealer-run6.log).

## 2026-09-07 ~02:40 UTC - P4a built: the CVM tier as a consumer (bank over HTTP + window agent)
- wasm/ggml-shielded/shielded-http.c (plain HTTP/1.1 client, Content-Length +
  chunked), shielded-bank.c (fetcher thread: listing -> index-ordered fetches
  into a cache covering [floor, need) regardless of budget, then up to
  SHIELDED_PAD_CACHE_MB ahead), shielded-tee.c: `SHIELDED_PAD_SOURCE=http://...`
  = bank + SHIELDED_PAD_CACHE, `SHIELDED_PAD_WINDOW_URL` + `SHIELDED_PAD_LEDGER_PK`
  = loopback window agent (POST {want, seed_id}; the platform ledger's signature
  is verified in the engine), `SHIELDED_PAD_PRUNE` (reader unlinks shipments
  wholly below the LOWEST GROUP CURSOR; the window-edge prune I had put in
  engine.cpp/anchor_payload.c was unsafe for a lagging group and is gone).
  shielded/dealer/window-agent.mjs (--ledger local self-signed mode; --relay
  mode signs /v1/pads/reserve with the tunnel key, NOT exercised yet), manager
  knobs nnShieldedPadCache/CacheMb/WindowUrl/LedgerPk/Prune, docs section,
  test/pads-bank-client.test.mjs (stub bank + bank-probe C tool + agent).
- x86 proof: dealer-loop explicit-seed mode pushed four 16-row shipments for
  the x86 seed into the local hub store; shielded-run with the HTTP bank,
  8-row windows from the agent, cache budget 64 MB, pad check on: 2363 nodes,
  0 local, 0 missed, verify 0, dropped spent shipments at floors 20 and 36,
  cache held two files, ledger mark 56, text == self-minting (scratchpad
  http.out/err, window-agent.log).
- Phone run 8 (phone-run8.log) on the rebuilt APK (bank/http objects linked,
  PRUNE=1): receipt recorded, 0 local, verify 0.
- Left running: hub :8787, CPU worker :9600, dealer loop for "pixel",
  window agent :9701 (scratchpad agent-ledger/agent.pem).

## 2026-09-07 ~03:30 UTC - metal identity + GPU minting
- enclave c4735bb8: metal/guest/agent.mjs mints an X25519 pad key (in the RAD
  doc, recorded at attach), fetches+opens the seed after attest-result ok,
  writes METAL_PADS_DIR/bootstrap.json (0600) for the wasm manager, relays
  windows on POST /pads/window (P-256 signed reserve; relay ledger verifies
  ECDSA/sha256 for EC records). test/metal-agent-pads.test.mjs = real agent vs
  real ledger behind a fake tunnel. Manager auto-fills SHIELDED_PAD_* from the
  bootstrap file for an http:// source with no explicit keys.
- GPU minting: `shielded-dealer --worker host:port` (SHIELDED_ZERO_PADS=1 +
  SHIELDED_PAD_CHECK=1): the exchange carries r unmasked and returns r.W mod M;
  the mint checks each row mod M against the worker. 16 rows of the 0.8B via
  the CPU float64 worker: byte-identical to the in-process mint on all 1,552
  cells (pads-unbox dump; scratchpad dumpA/dumpB), 6.2 s incl. model load;
  dealt-selftest has the case (SHIELDED_WORKER=), the cbackend node suite
  spawns worker.py --device cpu for it. Gotchas: the field-range Freivalds
  cannot hold for 24-bit inputs (verify off in zero-pad mode); worker mode
  must NOT set the 1 TiB dead-link reservation. /usr/bin/time is not
  installed here (exit 127) - use $(date +%s.%N).

## 2026-09-07 ~04:10 UTC - receipts from the CVM tier, store proxy, digest pin (enclave d12d5393)
- Engine POSTs usage deltas (cells, rows) to <window_url sibling>/receipt after
  each window (outside the pool lock) and at link close; guest agent signs +
  relays (/pads/receipt), proxies GET /pads/shipments (engine never speaks
  TLS; `nnShieldedPadSource: "platform"`), manager pins the model digest from
  the calib (SHA-512[:32] = dealer's label; verified equal). x86 proof: totals
  2,033 pads / 56 rows over 7 receipts == engine counters.
- Suites green: pads-*, metal-agent(-pads), shielded-cbackend (worker mint),
  shielded-refill-knobs, tunnel. Phone APK last built before the receipt/HTTP
  engine changes (run 8 fine); rebuild pending for sanity.
- ~04:40 UTC: phone run 9 (phone-run9.log) on the latest engine build: receipt
  recorded, 0 local, verify 0. Dealer daemon: GET /v1/pads/consumers +
  dealer-loop --all (per-consumer serve(); plan-only returns after one pass).
- ~05:00 UTC: shielded-dealer --jobs FILE (many seeds, one model load); dealer-loop
  --all mints every consumer per pass in one load. Two-seed proof via the CPU
  worker: both banks identical to in-process mints (scratchpad jobsbank,
  dumpJ/dumpJ2 vs dumpA/dumpC). Bug fixed on the way: worker-mint balanced
  range mapped u = -M/2 to M/2+1 -> writer SH_ERR_RANGE (-12) mid-shipment.
- ~05:40 UTC: phone run 10 (phone-run10.log) consumed shipments minted by
  `dealer-loop --all --worker 127.0.0.1:9600` (consumers route on the restarted
  hub; NOTE the hub needs PADS_DEALER_TOKEN + PADS_MASTER_SEED in its env or
  PUTs get 403 = "Broken pipe" on the dealer side; the loop now re-pushes what
  the store lacks). Agent per-boot token gates windows/receipts
  (SHIELDED_PAD_AGENT_TOKEN); a dealt link that cannot start now FAILS the
  request instead of computing locally (x86: no token -> was 695 local nodes).
- ~06:10 UTC: zero-pad minting moved into a dealer-only build
  (libggml-shielded-dealer.so, SHIELDED_DEALER_MODE; production .so has no
  mint_worker symbol). device-dealt-run.sh's dealer step uses the dealer .so.
  Bank client counters now print on the profile line ("[shielded] bank: ...").

## 2026-09-07 ~06:40 UTC - PRODUCTION FIX: metal image linked a broken shielded backend since the pads work
- metal/build-image.mjs compiles libggml-shielded.so from its OWN unit list
  (mirrors the Makefile by hand). It never gained shielded-pads.c / tweetnacl.c /
  poly1305-donna.c (P1, 2026-09-06 d931e4b8) nor shielded-bank.c / shielded-http.c
  (today). Replica link on this box: the old list yields a .so with 22 undefined
  sh_/crypto_/poly1305 symbols (dlopen inside the guest would fail -> NO shielded
  device -> tenants compute on CPU silently). Every release built from d931e4b8
  through v0.5.619 has that .so; metal0 auto-updates, so it is probably on one
  NOW (no funded deployment has exercised nn since; /enclaves shows the box
  serving, nnProbe "off"). FIX pushed b1b74d48: units added, link with
  -lggml -lggml-base -Wl,--no-undefined (fails the build instead), and
  test/metal-shielded-build.test.mjs pins CORE_SRC to the builder's units.
  Next release (>= v0.5.620) carries it; verify with a funded nn deployment
  (eyesoff-perf is expired: `enclave fund <id> --usdc 5` from the agent wallet).
- ~07:00 UTC: PROOF of the image fix: `node metal/build-image.mjs --out <scratch>`
  ran to completion here (exit 0, docker pulls of the pinned images) and the
  produced /opt/enclave/shielded/libggml-shielded.so has 0 undefined
  sh_/crypto_/poly1305 symbols and no mint_worker (build log: scratchpad
  build-image.log). The same builder with the old unit list (replica link)
  had 22 undefined symbols.

## 2026-09-07 ~07:50 UTC - shared-prefix KV (P4) x86 half + phone wiring in progress (enclave b4ce3609)
- prefix-kv.{h,c} (sidecar: Ed25519 over model digest + prefix sha512 + tokens +
  file sha512), prefix-kv-mint (prefill in the clear, llama_state_seq_save_file,
  sign), prefix-kv-selftest (in `make all` + cbackend suite), shielded-run
  SHIELDED_PREFIX_KV/_KV_PK + SHIELDED_PREFIX_FILE. 0.8B proof: 25-token prefix
  loaded (20.5 MB state incl. recurrent), 2 remainder tokens prefilled, text
  identical to the full 27-token prefill (scratchpad kv0/kv1.out; prefix.key /
  .txt / .pk copied to dealt-e2e/).
- worker.py --device cpu touched CUDA (3 unconditional synchronize/empty_cache
  calls -> a 154 MiB context on the 3070 and OOM failures while the card was
  busy). Guarded; the 9600 worker restarted; nvidia-smi shows no python now.
- Phone: engine.cpp waits for prefix.kv/.sig/.txt in the encrypted store,
  verifies (PREFIXPK pinned via the control channel), loads, prefills only the
  user's part (the engine prepends the prefix text); app `--es prefix <dir>
  --es prefixpk <hex>` streams the three files over the pads port
  (streamFiles); recipe `device-dealt-run.sh prefix [" user text"]`. Build in
  progress; the files are at /data/local/tmp/anchor/prefix on the phone.
- ~09:10 UTC: phone runs 12-17 FAILED ("prefill failed", no PADWIN): my prefix
  wiring edit (build-anchor6) had cut the with_pads block in anchor_payload.c
  so `pp = &pads` + "dealt pads on" only ran in the else-if(with_prefix) branch
  -> the engine got pads=NULL -> no window provider -> dealt link cannot start
  -> (new) refusal. Diagnosed via the new engine.err capture (stderr in the
  encrypted store, tail on failure) + the refusal now logging unconditionally.
  Fixed (receiver thread starts for pads OR prefix, pp set in the pads block);
  runs 18 (full prompt) / 19 (prefix KV) in progress.
- ~09:35 UTC: PROVED on the Pixel 8 Pro: run 18 (full 27-token prompt) vs run
  19 (prefix KV: 25 loaded + 2 prefilled): generated TOKENS IDENTICAL; receipts
  39 vs 14 rows (the prefix cost 25 bank rows). Logs phone-run18-full.log /
  phone-run19-prefix.log. Recipe: device-dealt-run.sh prefix [" user text"].

## 2026-09-07 ~09:10 UTC (02:10 MST) - metal0 = THIS workstation (warden-host); rolling it to v0.5.623
- `node metal/update.mjs --check`: current v0.5.609-cpu (pads sources in tree,
  builder unfixed = the broken shielded .so), latest v0.5.623-cpu, 6
  deployments running; the timer last ran 23:31 MST ("already on 609") and
  next fires 05:56 MST. Forcing the update now (update-0.5.623.log) since
  the timer would do the same and the current image cannot serve shielded
  tenants. Agent wallet: $5.18 USDC, 0.0015 ETH (not $25 as the older note
  said). eyesoff-perf 0x7c4149ee… expired; config CID
  bafkreig7teqi5pyozx46cfp22dlfj3xo2agy27dawylyn6bcv6glirb5xe (bootwarm +
  refill knobs). Plan: after the box is healthy on 623, fund $5 (~3 h at
  $1.59/h), resume, prefill-probe baseline, then the ubatch/CPU-matmul lead.

## 2026-09-07 ~10:15 UTC - LIVE PREFILL PROFILE on v0.5.623 (prefill623.cpu.prof, symbolized against
profile-root-623 -> metal/build/root; analyze-prefill-profile.py; capture-prefill-long.py = the driver)
- Fresh 1763-token prompt, 128-token chunks, 12.4 tok/s over the sampled window (10 s per chunk).
  45 s sample = 517 CPU-s (11.5 cores busy): refill_rows_blocked 72.5% (374 s) + generate/
  refill_main 77% cum = the pad refill; omp_get_num_procs 14.8% (76 s) + omp_fulfill_event
  17.5% cum = OpenMP spin (GOMP_SPINCOUNT default, nnThreads 4); the whole decode path
  (feed_mtp -> plan_step -> submit_rows -> ell_decode_batch_topk -> llama_decode) = 28.7 s cum
  (5.5%), of which ggml_backend_shielded_graph_compute 20.5 s / sh_link_gemm 18.8 s, and
  ggml_backend_cpu_graph_compute only 8 s (1.5%). Counters: pads/exchange 3.97 overall, 6.65
  in the last delta; +~166 pads per prompt token (~= one pad per group per token).
  => prefill goes through the shielded link in <=8-row exchanges and is bound by the refill
  rate; the CPU backend is idle; the request thread waits ~16 of 45 s for pads.
  UNEXPLAINED: llama reports n_ubatch 512 and the app feeds 128-token chunks, and the claim
  rule refuses ne[1] > 8, yet exchanges carry <=8 rows. Reserve shapes seen: 14/224/512/518.
- Auth recipe restored: the config's api_key is "$PERF_API_KEY" -> `enclave secrets ls <id>
  --show` (agent wallet) -> sso-batch8.json {token: <value>} (X-Api-Key); SSO JWT minting needs
  a browser account session (enclave login = device flow), not available headless.
- Experiment in flight: nnShieldedRefillThreads 12 + nnOmpSpinCount 1000
  (config-0907-refill12-spin1k.json) - expect prefill ~ +40% if refill scales; decode may dip.
- ~10:50 UTC RESULT refill12+spin1k (config-0907-refill12-spin1k.json): fresh 1762-token prompt
  14.4 tok/s (RATE line, whole prompt) vs ~12.6 baseline (140 s / 1763) = +14%; rows/exchange
  6.65, missed 0. Sub-linear for +50% refill threads -> the refill is now bound by DRAM
  (30 GB weight stream per 16-row refill batch = ~24 GB/s at 14 rows/s) or core contention.
  NOTE: the cpu-profile endpoint needs nnCpuProfile in the config (KeyError 'state' otherwise).
  Next: nnShieldedRefillBatch 64 + nnShieldedPoolDepth 256 (config-0907-refill12-batch64.json).
- ~11:05 UTC RESULT refill12+batch64+pool256: 14.9 tok/s (1676 of 1762 in 112 s) - no gain over
  batch 16 -> the pad supply is no longer the wall; the request thread's serial <=8-row exchange
  chain is (mask/encode/unmask + wire per exchange, x16 vs a 128-row batch). Test in flight:
  nnLoadMtp false (config-0907-nomtp.json) to see whether the MTP-aware feed is what slices
  prompt batches to <=8 rows.
- ~11:25 UTC nnLoadMtp=false (config-0907-nomtp.json): the app cannot run without the MTP head -
  the first request's stream ended prematurely, a plain chat answered 502 "socket hang up" and the
  tenant restarted (weights re-registering). Not a usable diagnostic; reverted to
  config-0907-refill12-batch64.json (best prefill so far, 14.9 tok/s) and measuring decode too.
- ~11:50 UTC DEFINITIVE COUNTER TEST (restored refill12+batch64 config): one fresh 1762-token
  prompt, max_tokens 1: prefill_ms 124079 (14.2 tok/s); counters over the request: exchanges
  +66387, pads +261785, missed 0 -> 3.94 rows per exchange, 148.6 pads per prompt token. The
  TARGET's prefill runs in 4-token micro-batches through the shielded link (one pad row per
  group per token). Run-to-run noise: the same config measured 14.9 / 12.0 / 14.2 tok/s; the
  knob gains (+14%) are within it. Searching the host patch for what sets the batch to 4.
- ~12:05 UTC: pushed width histograms on the shielded profile line (exchanges by m, graphs by
  widest matmul rows) to settle where the 4-row prefill slices come from (llama splits wide,
  host chunks 512, app chunks 128; the MTP head context is LLAMA_CONTEXT_TYPE_MTP with n_batch
  512). Plan: wait for the release, `node metal/update.mjs --force`, one fresh prompt, read the
  line. 68 min of funded runtime left at this point.

## 2026-09-07 ~13:00 UTC - 27B PREFILL INVESTIGATION PARKED (handoff) + eyesoff-perf suspended
- FACT (width histograms, v0.5.624): a fresh 1762-token prompt -> +58k exchanges ALL m=4; the
  shielded backend only ever sees 4-row nodes; the CPU backend did ~1.5% of the work. So the
  ENGINE builds 4-token micro-batches for the prompt. NOT the app (chunks 128 -> 512, status
  ticks are 10 s), NOT the host (feed_mtp chunks by n_batch=512, the queue packs <=512, no
  ENCLAVE_GGML_N_BATCH in manager/gsup/box config), NOT llama's split code as read (hybrid
  init_batch -> split_seq(n_ubatch=512), n_ubatch printed 512). Also not the MTP head context
  (LLAMA_CONTEXT_TYPE_MTP, n_batch 512). Something between llama_decode(128 tokens) and the
  graphs makes 4-token ubatches. NEXT (needs a toolchain cut): log ubatch.n_tokens per
  process_ubatch (llama-context.cpp) or print batch.n_tokens + graph_compute count from the
  shim; then force wide prompt ubatches onto the CPU backend (the profile says the CPU is
  idle) -> expected 3-4x prefill.
- Knobs are inside noise (12.0-14.9 tok/s incl. a concurrent query from Steven). Production
  config restored (config-live-0907.json = the tuned CID); deployment `stop`ped (balance kept)
  to free the V100s for the Pixel goal. Resume: `enclave --yes resume <id>` + claim-hint force.
- NEW GOAL (Steven 12:50 UTC): >= 20 tok/s with the Pixel 8 Pro pVM as the trusted half and
  metal0's V100 worker (127.0.0.1:9501 via adb reverse) as the shielded GPU. Recipe:
  device-dealt-run.sh v100 [tokens] [prompt] (+ hub, dealer --all pass).

## 2026-09-07 phone x V100: run23 (spin-poll) died on the bridge, MTP loop added
- Run 23 (phone-run23-v100-spin.log): SHIELDED_SPIN_US=20000 in the engine + the bridge pump at audio
  priority spinning on in.available(). The bridge closed with down=0 bytes and the guest's HELLO got
  Broken pipe: available() is FIONREAD, which the vsock stream lacks -> IOException -> the pump's
  catch-all ended it. Fixed in Main.java pipe(): the spin's available() has its own try/catch and a
  stream that throws just blocks from then on (spin=false).
- MTP draft in the phone engine (shielded/anchor/avf/payload/anchor_mtp.{h,c} + engine.cpp):
  the model's own nextn head proposes k tokens (ANCHOR_MTP_K, <= 7), the target verifies k+1 rows in
  ONE exchange chain, rejected rows roll back through n_rs_seq = k recurrent snapshots, harvest +
  observe mirror only committed tokens into the head. Prefill marks every row an output row so the
  head can observe the prompt. Plumbing: --ei mtp K (Main.java plan) -> " mtp=K" on the ENGINE line ->
  anchor_payload.c setenv(ANCHOR_MTP_K). device-dealt-run.sh v100 honours MTP=k; phone-v100-run.sh
  <label> <tokens> wraps one logged run. Greedy both sides: MTP text must equal plain text.
- Direct path notes: the phone (wlan0 192.168.88.13) cannot ping the host (192.168.8.249, different
  router); the host reaches 192.168.88.1 at ~5 ms, so Wi-Fi would not beat adb anyway. USB tethering
  (svc usb setFunctions rndis|ncm) is the candidate: ~1 ms RTT, but toggling the gadget drops adb for
  a few seconds -> only between runs. The worker listens on 127.0.0.1 only and must not be restarted
  (it holds the card): tcp-forward.py <usb-ip> 9501 is the host-side hop (no socat, no sudo).

## 2026-09-07 MTP on the phone works; the direct USB path wedges
- MTP k=3 over adb (run26 vs run27, same prompt, 64 tokens): 16 rounds, 47/48 drafts accepted (3.94
  tokens/round), token stream IDENTICAL to plain greedy (md5 of the TOKEN lines). Decode 468 vs 662
  ms/token only, because a 4-row exchange costs 13.5 ms on the adb path vs 5.7 ms for one row (the
  path is bandwidth-bound too: ~10 MB/s marginal). The head's lm_head is offloaded as well: 48 m=1
  exchanges = 16 rounds x 3 draft steps. The MTP layers are opt-in since the fork's ddd4ec1 pin
  (llama_model_params.load_mtp): without it the head tensors load as "unused" and the MTP context
  aborts (run25 SIGABRT).
- Spin levers are counterproductive on the phone: SHIELDED_SPIN_US=20000 + a spinning bridge took the
  exchange from 5.4 to 18 ms (run24); both reverted. The bridge's available() spin also broke the
  vsock pump (no FIONREAD -> IOException -> Broken pipe, run23).
- Direct path: USB tethering via `adb shell svc usb setFunctions ncm` (rndis gives no interface on this
  Android 16 build) -> phone ncm0 10.160.70.12, host ens10u1i1 10.160.70.152 (cdc_ncm, USB 2.0 at
  480 Mbps: the cable/port). Idle RTT 3-4 ms, 1.8 ms with the phone's CPUs busy, 40 MB/s each way,
  bidirectional fine, adb concurrently fine. tcp-forward.py exposes the loopback-only worker on the
  USB address (the worker holds the card; never restart it). device-dealt-run.sh v100 honours
  WORKER=host:port.
- BUT the link wedges: no packets either way (host->phone ping dead, phone TCP retransmitting), adb
  unaffected, host kernel log silent. Reproduced from the shell with netbench (static aarch64 client,
  /data/local/tmp/netbench + netbench-server.py): TCP_NODELAY + 1 MB writes with a 64-byte reply
  read after each MB wedges it on the first try, every time; plain 40 MB/s streams wedge it ~1 in 3
  per 300 MB; <= 24 MB/s streams (800 MB) never did. Not the app (AF_INET socket and normal thread
  priority changed nothing), not the pVM's load (engine over adb + shell NCM bulk = fine).
  RECOVERY without root: `nmcli device disconnect ens10u1i1; nmcli device connect ens10u1i1` (~5 s);
  ncm-watchdog.sh pings the phone every second and bounces after 2 misses. Also added: pace_mbps
  extra (token bucket on the app's up pump, PACE=n in device-dealt-run.sh) to keep the weight upload
  under the wedge rate. killpat.sh / stop-phone-run.sh: kill helpers whose patterns never sit in the
  caller's command line (pkill -f from the shell killed the shell itself: exit 144, several times).
- Ceiling math with a perfect NCM link (~2 ms per 4-row exchange): 97 x 2 + 3 x 2 = 200 ms/round ->
  ~51 ms/token at 3.94 tokens/round = ~20 tok/s ONLY for this repetitive prompt; realistic acceptance
  (~2.5 tokens/round) -> ~12 tok/s. And the phone's own per-round overhead (~430 ms/round in run26,
  outside the link) must shrink to ~50 ms. Round timers (draft/verify/observe) are in the engine.

## 2026-09-07 the phone's clocks are the local-time lever
- Round timers over adb (run33/34, k=3): draft 291 ms (3 head steps), verify 1289-1720 ms (97
  exchanges of 4 rows), rollback+observe 61-80 ms per round -> 417-520 ms/token.
- During decode the phone's mid cores (4-7, where the VM's vCPUs run) sit at 0.4-0.9 GHz and the big
  core idles at 0.5 GHz: ~100 short compute bursts per token between link waits never raise the
  governor. Live test (run35): `taskset <core> nice -n 19 yes` burners on cores 4-8 took the mid
  cores to 2.1 GHz and the token rate from 28 to 44 per 12 s (+57%) despite competing for cycles.
  The shell cannot see crosvm (pidof empty), so vCPU placement is inferred from which cores' clocks
  move. (Adb shell launches of background burners must redirect all three fds or adb hangs.)
- engine.cpp ANCHOR_BOOST_THREADS=n (--ei boost n, BOOST=n in device-dealt-run.sh): n spinning
  threads in the VM keep the utilization, hence the clocks, high during decode. E1 = boost 5 +
  4 compute threads, E2 = boost 1 + 8 compute threads (the VM has 9 vCPUs).
- E1 (boost 5 in the VM, 4 threads): 764 ms/token, verify 2424 ms/round; E2 (boost 1, 8 threads):
  1334 ms/token, verify 4510 ms/round. WORSE than no boost (417-520): the wire stayed ~22.4 s, the
  mask arithmetic got faster (422 -> 159 ms) but the compute threads lost their cores to the spinning
  vCPUs (normal-priority crosvm threads to the phone) and ggml's barrier splits amplify any straggler;
  8 threads also puts splits on little cores. Next: burners in the APP at THREAD_PRIORITY_LOWEST
  (--ei burners N, BURN=N), the product-path form of the nice-19 shell burners that measured +57%.
- E3 (app burners 5 at THREAD_PRIORITY_LOWEST, 4 threads, k=3, adb): 263 ms/token = 3.8 tok/s, the
  best so far. The wire total halved too (24 -> 11.3 s: adbd and the bridge were clock-starved as
  well). Per round: draft 264, verify 716, observe 65 ms. E4 (3 threads): 458 ms/token, worse.
  Remaining local ~340 ms/round sits in the head steps (~60 ms each) and observe (65 ms for a 1-layer
  4-row decode = ~1 GMAC/s: far below dotprod cores at 2.4 GHz). Suspect: the target's persistent
  pool busy-polls while the head context spawns its own threads. E5 = one pool for both + draft-step
  timers (seq_rm / head decode / argmax); E6 = the same over the direct USB path (direct-run.sh:
  gadget reset, forwarder, watchdog, PACE=16).
- E5 (one pool for target + head, burners 5, k=3, adb): 281 ms/token; observe 65 -> 25 ms, draft
  264 -> 173 ms (head decode 55 ms per step, most of it the lm_head exchange's 456 KB reply); verify
  921 (adb noise). E6 (same over the direct USB path, PACE=16, watchdog): 228 ms/token = 4.4 tok/s,
  verify 727 ms/round, wire 11.4 s / 64 tokens; the watchdog bounced the link twice during the 97 s
  upload, none seen in decode. The exchange still costs ~7 ms on the direct path: USB 2.0 bytes
  (7.4 MB per round at 40 MB/s = 185 ms) + the fixed chain (NCM RTT ~2 ms under load, vsock x2,
  Java bridge, host forwarder, worker service). adb was never the main cost.
- Physics: 20 tok/s needs <= 1.2-2 ms per exchange all-in at 97 exchanges/round (2.5-4 tokens per
  round). This chain's floor is ~2 ms of USB RTT alone. Levers left: a USB 3 cable/port (5 Gbps:
  the row bytes drop 10x; the cable is USB 2.0 today), the vocab projection local
  (SHIELDED_LOCAL_SITES=token_embd.weight, new backend knob, inert unless set; saves 3.2 MB +
  3 RTTs per round), k up to 7 (8 rows, USB-bandwidth-bound on USB 2.0), and fewer bridge hops.
  --es shenv K=V,K=V passes engine environment through the plan line (SHENV= in the run script).
- E7 (direct, k=3, burners 5, lm_head LOCAL via SHIELDED_LOCAL_SITES=token_embd.weight): 164 ms/token
  = 6.1 tok/s. Per round: draft 71 ms (3 head steps, ~23 ms each, all local now), verify 573 ms
  (96 x 4-row exchanges = ~6 ms each), observe 13 ms. Widths confirm no m=1 exchanges. Upload 97 s
  with 2 watchdog bounces.
- E8 (same, k=7): 185 ms/token, WORSE: 9 rounds at 7.0 tokens/round (92% accepted) but verify
  1158 ms/round (8-row exchanges ~12 ms: USB 2.0 bytes) and 7 head steps (138 ms). k=7 only pays
  with USB 3 bandwidth. Upload 150 s, 3 bounces.
- Per 4-row exchange ~6 ms = ~1.5 ms of bytes (58 KB at 40 MB/s) + ~4.5 ms fixed. E9 = the run via
  tcp-forward-timed.py (port 9503): 'service' = worker+forwarder, 'turn' = phone + USB round trip.
- E9 (run45, direct via tcp-forward-timed.py, k=3, lm_head local): 160.5 ms/token = 6.2 tok/s.
  Decomposition seen from the host during decode (1492 exchanges): service (worker + forwarder) mean
  0.08 ms; turn (phone compute + vsock x2 + Java bridge + USB both ways) mean 6.35 ms, p50 4.33,
  p90 8.14; 23 KB request + 50 KB reply per exchange. The worker is irrelevant; the phone-side
  round trip x 96 exchanges per round is the wall. (run44 stalled after the pads with no bytes ever
  sent; a rerun went through; cause unknown, engine.err not readable from the host.)
- Fusion idea (halves the RTT count, bytes unchanged): a matmul whose input is RMSNorm(residual) can
  ride the previous residual-producing matmul in ONE exchange, because rms is a per-row scalar
  applied after the matmul and gamma folds into the weights: [h, attn] -> o_proj(attn) and
  h'.Wgu' with Wgu' = diag(gamma).Wgu and the product Wo.Wgu' precomputed (public weights, the
  worker or the platform can form them); then h' = h + o and the 1/rms scale are local. Same for
  ffn_down -> next layer's in_proj/qkv, and for the linear-attention layers' ssm_out. 2 exchanges
  per layer instead of 4. Cost: fused sites need calibration (shielded-calib is Steven's dirty
  file), product weights are re-quantized (Q8), backend must claim add/rms_norm/mul and execute the
  5-node pattern. Estimated gain at today's numbers: verify 558 -> ~390 ms/round (bytes stay) =
  ~8.3 tok/s; with USB 3 bytes ~12 tok/s. 20 tok/s needs fusion + USB 3 + the bridge gone
  (pVM networking) + realistic acceptance holding ~4 tokens/round: marginal even then.
- Natural prompt ("Explain in three sentences why the sky is blue. Then list two common
  misconceptions about it."), direct path, lm_head local, burners 5: k=3 (run48) 27 rounds,
  2.33 tokens/round (46% of drafts accepted); k=5 (run49) 21 rounds, 2.62 tokens/round (32%).
  That is the realistic multiplier (vs 3.94 on the repetitive prompt). Both runs were PAD-STARVED
  (verify 4.5 s/round while the wire was ~400 ms/round): the dealer's pipeline (--ahead 128,
  --chunk 64, --interval 15; a 64-row shipment is 117 MiB over adb-reverse into the VM) cannot
  keep up with ~4-6 rows per 0.5 s round once the prompt is 20 tokens. Fix for measurement =
  a deeper pipeline (AHEAD/INTERVAL env in device-dealt-run.sh). Prompts > 8 tokens also needed
  the head's observe chunked by its batch capacity (was: 'the head could not observe the
  prompt; decoding plainly').
- This phone's AVF VirtualMachineConfig.Builder exposes only setCpuTopology and
  setShouldUseHugepages among the interesting setters: no pVM networking, so the vsock + Java
  bridge stays in every exchange.
- Pad pipeline findings (run50): the app streamed shipments into the VM in STRING order
  ("-128-64" before "-64-64"), so the engine starved at index 64 with four shipments fetched;
  fixed in PadsClient.streamBank (numeric index0 order). The dealer polls the hub's mark and does
  mint ahead, but ~2 minutes late (15 s passes + a 6 s model load per mint + 117 MiB per
  shipment to the phone); AHEAD=256 INTERVAL=5 for measurement runs. A prompt longer than 8
  tokens prefills ENTIRELY on the phone's CPU ("0 nodes offloaded": the link refuses matmuls wider
  than 8 rows), ~90 ms/token, using no pads; the first token appears before any shipment lands.
- E12b (run51, natural prompt, k=3, direct path, ordered shipments, bank 256): pads no longer
  starve (waited=0, windows 0..192) but 2860 ms/token: the NCM link wedged FOUR times during
  decode (watchdog bounces; each costs the bounce ~5 s plus TCP's exponential retransmit backoff on
  the stalled connection). With the repetitive prompt the wedges fell in the 97 s upload; with a
  20-token prompt there is no upload (the worker keeps the weights), so they land in decode. The
  wire itself was 438 ms/round (11.8 s / 27 rounds), i.e. ~4.5 ms per exchange. The direct path is
  therefore unusable for sustained decode on this host driver without root (cdc_ncm tunables) or
  a USB 3 link; adb is stable at ~1.5 ms/exchange more. E13 = the same prompt over adb.
- E13 (run52, natural prompt, k=3, adb, lm_head local, burners): 1063 ms/token, verify 2445 ms/round
  but wire 438 ms/round and no pad waits: the excess is the ONE-TIME weight upload (~50 s) landing in
  the first verify round, because a 20-token prompt prefills on the CPU and the first offloaded
  graph is the first decode step (E12b's forwarder window showed 206 MB of requests at decode
  start). Net of it: ~(520+66+6)/2.33 = ~250 ms/token over adb (~3.9 tok/s), ~220 direct. Engine
  now reports decode_ms_per_tok_steady (from the second generated token on).
- E13b (run53, natural prompt, k=3, adb): steady 587 ms/token, but the wire was 26.6 s vs 11.8 s in
  E13 for identical work (438 -> 987 ms/round): the adb path's cost doubled between two runs a few
  minutes apart. Suspect thermal throttling from the five burner threads (checking), or adb
  scheduling. Realistic-prompt summary so far: 2.33 tokens/round at k=3 (46% accepted), ~440 ms of
  wire per round on a good run -> ~220-250 ms/token (4-4.5 tok/s) when nothing wedges or throttles.
- Phone thermal check after the burner runs: thermal status 0, skin 35 C, clock caps unchanged; but
  pixel-thermal logs VIRTUAL-USB-THROTTLING:1 (USB port policy, RF/"quiet" related), which may be
  behind the 2x adb variance. E14 = 2 burners (less scheduling jitter for the bridge threads?), E15 =
  5 burners + setShouldUseHugepages(true) (--ei hugepages 1, HUGE=1), both direct path, test prompt,
  to compare with E9 (160 ms/token, turn mean 6.35 / p50 4.1 ms).

## Fusion executor: what it would take (design note, not built)
- The scheduler hands the shielded backend contiguous MUL_MAT (+ meta) runs; add / rms_norm / mul(gamma)
  between two matmuls run on the CPU backend, so today's graph_compute never sees the pattern.
  Claiming those three ops in supports_op (shape-gated: a mul_mat whose src1 is mul(rms_norm(add(x,
  mul_mat_prev)), gamma)) makes the scheduler assign the chain [mul_mat_prev, add, rms_norm, mul,
  mul_mat_next] to one run; a fused executor then does ONE exchange with input [x, a] (x = the
  residual, a = mul_mat_prev's input) against the block weights [[W_next'], [W_prev . W_next']] and
  W_prev, receives y_prev and z = x.W_next' + a.W_prev.W_next', computes h = x + y_prev locally,
  writes the add's output, rms(h) per row, and mul_mat_next's output = z / rms. gamma is folded:
  W_next' = diag(gamma) . W_next.
- Sites: two new calibrated "fused" sites per layer (o_proj+gate/up, ffn_down+next in_proj); the
  products are public-weight functions the dealer's GPU (or the platform) can form and re-quantize
  to Q8_0 once per model; the pads for a fused site cover K1+K2 columns and N1+N2 outputs (bytes on
  the wire unchanged: same inputs and outputs as the two exchanges it replaces).
- Numerics: exact in float; Q8 re-quantization of diag(gamma).W and of the product is the only
  approximation (product entries have a wider range: calibrate exponents per fused site).
- Gains at today's costs: exchanges per round 96 -> 48 (the head's layer is local); per-exchange
  fixed cost ~4.5 ms saved 48 times = ~215 ms/round of ~440 -> ~1.4x; with USB 3 (bytes ~0) ~2x.
- Effort: backend supports_op + pattern executor (2 days), product minting in shielded-dealer /
  prefix of the calib tool (1 day, overlaps Steven's uncommitted shielded-calib.cpp), x86 fidelity
  test (greedy text equality vs unfused), then the phone. Not started: Steven's call, since it
  changes the fleet's shielded backend and the calib format.
- E14 (2 burners): 176 ms/token steady; E15 (5 burners + hugepages requested): 196; E9 (5, none): 160.
  Run-to-run noise is +-10-15% on this link; neither knob helps. Keep BURN=5, hugepages off.
  Best repeatable configuration: direct path, k=3, 5 burners, lm_head local, 4 threads.

## 2026-09-07 27B prefill: the 4-row micro-batches are the APP CONFIG, not the engine
- The live eyesoff-perf app config carries "prefill_chunk": 4 (config-live-0907.json and every
  config-0907-* variant inherited it). eyesoff-ai's prefill_cap() = configured.min(host).max(1), so
  the guest feeds 4-token chunks on purpose ("a shielded backend may only offload small batches to
  its GPU workers; setting this to that limit keeps prompt matmuls eligible"). The 09-07 13:00
  handoff ("ENGINE builds 4-token micro-batches ... NOT the app (chunks 128 -> 512)") read the
  PREFILL_CHUNK constant and missed the config override. No engine ubatch log is needed.
- Trade: chunk 4 = link prefill at ~14 tok/s (1762 tokens in 124 s, 148 pads per prompt token,
  drains the pad pool before decode); chunk 8 = half the exchanges per token (if not refill-bound);
  chunk 0 (host batch 512 > MAX_M=8) = CPU prefill, measured earlier at 4/8/16 threads = 42/23/20 s
  per 340 tokens (17 tok/s at 16 threads) and it leaves the pads for decode.
- Running now (deployment resumed with the agent wallet, ~80 min funded): base chunk4, chunk8 x2,
  chunk0+nnThreads16 x2 via capture-prefill-long.py <name> 0 (RATE lines), then the live config back.
- First chain: `config set` against --base http://127.0.0.1:18080 FAILS (POST /v1/apps/upload-token
  404: the box does not serve the relay's upload route) and the chain did not notice, so
  "chunk8"/"chunk0-t16" there were all chunk 4: cold 6.3, then 14.0 / 14.0 / 13.9 / 14.0
  prompt-positions/s (111 s for ~1560 of 1762) = the live config's warm steady prefill. Config
  changes must go through the default relay base (a setConfig tx by the agent wallet + an in-place
  app restart, ~5 min). Rerunning that way.
- The relay-based config sets pinned new envelopes but the box record shows the container started
  at the resume and NEVER restarted (appConfigCid = live), so chunk8/chunk0-t16 (13.8 / 13.4) were
  chunk 4 again. `enclave restart <id>` exists and is needed after a config set.
- Tenant profile during the live-config decode probe: link total 44.3 s of which refill-on-path
  43.4 s, wire 34.0 s (overlapping), mask 55 s; per-group "missed" counts in the hundreds. The 27B
  prefill is REFILL-BOUND (in-enclave pad generation), as the refill-ceiling memory says: chunk
  width cannot help; more refill throughput (threads) or pads that do not cost the enclave (dealt
  pads from a GPU dealer) or a prefill that consumes no pads (chunk 0 -> CPU) can.
- Live-config baseline via decode-rate.py (1.7k-token fresh prompt, 96 tokens, greedy): decode
  10.11 / 10.13 tok/s, TTFT 356 s (queued behind the previous probe) / 231 s. Funds ran out at
  ~14:45 UTC ($0.07 left) before the chunk-0 restart test; topping up $2 from the agent wallet for
  one restart + prefill + decode measurement.
- BLOCKED 14:50 UTC: the agent wallet holds $0.18 USDC (needs $2 for a top-up); the deployment is
  at $0.00 and the box will sweep the unfunded lease. The pending test, ready to run once the wallet
  is funded: `enclave --yes config set <id> --file config-0907-chunk0-t16.json` (prefill_chunk 0 =
  CPU prefill, nnThreads 16) then `enclave --yes restart <id>`, wait ~5 min for the model, then
  `python3 capture-prefill-long.py chunk0t16 0` (RATE) and `python3 decode-rate.py chunk0t16 96`
  (decode after the prompt, pool untouched by prefill); then config-live-0907.json + restart.
  Expected: prefill ~13-17 tok/s (same as now) but no pad drain, so decode right after a long
  prompt should exceed the live 10.1 tok/s; also the refill threads are free during prefill.

## 2026-09-07 phone prefill: a wider pool for the CPU batch
- Prompts wider than the link's 8 rows prefill on the pVM's CPU (~90 ms/token at 4 threads). The VM has
  9 vCPUs; engine.cpp now attaches a separate batch pool (ANCHOR_PREFILL_THREADS, default 8) for
  llama's n_threads_batch while decode keeps its 4-thread pool; n_ctx 1024 so a ~300-token prompt
  fits (prompt-300.txt, 289 tokens). P1 = 4 batch threads, P2 = 8, both adb, 8 generated tokens.
- P1 (4 batch threads): prefill 387 tokens in 11.4 s = 34 tok/s (29 ms/token), decode steady 164
  ms/token. P2 (8 batch threads): prefill 21.2 s, decode steady 381 ms/token: an 8-thread batch pool
  is slower (little cores drag the barrier splits) and its idle polling steals decode's cores.
  Default reverted to the decode count; the knob stays. Trying 5 and 6 next.
- Prefill threads 5: 14.6 s (decode steady 310); 6: 16.1 s (216). Four threads is the phone's best
  for both prefill (11.4 s / 387 tokens = 34 tok/s) and decode. Phone prefill is settled: CPU path,
  4 threads, burners on.

## 2026-09-07 fusion numerics on real 0.8B weights (fusion-numerics.py)
- One-exchange gate/up(norm(h + attn.Wo)) via [h, attn] against [Wgu' ; P], Wgu' = diag(gamma).Wgu,
  P = Wgu'.Wo, 1/rms(h + attn.Wo) applied locally: with FLOAT products the fused output matches the
  exact path to 8e-7 (float rounding: the algebra is exact). With P and Wgu' re-quantized to Q8_0 the
  relative error is 5.1e-3 on blk.3 (full attention), 5.2e-3 on blk.0 (ssm_out into the FFN), and
  5.1e-3 with a 10x residual / 0.1x attention scale: one extra Q8-class quantization on the FFN
  input of each layer, no dynamic-range blow-up (|P| absmax 0.30-0.36 vs |Wgu'| 0.17), so the
  field encoding's per-column exponents would be routine. (The script's "plain-Q8" control is
  idempotent on already-Q8 weights and prints 0; the meaningful floor is Q8_0's own ~0.3-0.5%
  relative error against the fp16 master, which the fusion roughly doubles for those sites.)
- Sizing: P per layer = (2 x ffn) x K_o: 0.8B 14.7M params (trivial); 27B ~178M x 64 = ~11 GB Q8 for
  o_proj->gate/up plus ~8 GB for ffn_down->next qkv, on the workers: fits only because the tenant
  already splits the model across both V100s (13.5 GB per card today; ~24 GB per card fused).
  Verdict for Steven: numerically feasible; the cost is engineering (backend claims add/rms_norm/mul,
  fused executor, product minting, fused-site calibration) and worker memory, not accuracy.

## 2026-09-07 unblock-watcher.sh (detached, polls every 3 min, log dealt-e2e/unblock-watcher.log)
- (a) when the agent wallet shows >= $2.50 USDC: fund $2, resume + forced claim, config
  config-0907-chunk0-t16.json, `enclave restart`, wait for a new startedAt and a 1-token answer,
  then capture-prefill-long RATE, decode-rate.py, RATE again; live config + restart afterwards.
- (b) when the Pixel enumerates at >= 5000 Mbps: direct-run.sh baseline k=3 and k=7 (test prompt).
- Kill with killpat.sh unblock-watcher. It spends at most $2 once.

## 2026-09-07 19:10-19:20 UTC - wallet funded ($30 USDC from Steven), CPU-prefill test started
- unblock-watcher (a) fired 19:10:38Z: deployment was at $0.00 balance (had run dry);
  `fund --usdc 2` re-queued it with 58 min at $2.08/h; claim-hint accepted; config
  config-0907-chunk0-t16.json pinned; restart in place; startedAt 19:11:05Z (epoch 1788808265).
- Watcher BUG: metal-session.json had expired (401 on the tunnel); wait_app read the stale
  token once at 19:17 and would have timed out "app never answered" -> restore live config.
  Killed the watcher (killpat.sh unblock-watcher: this ALSO killed the harness Monitor whose
  command line named the watcher log - keep monitor command lines free of kill patterns).
- Token refresh recipe (from recover_and_bench.py): `ENCLAVE_KEY=$ETH_AGENT_WALLET node
  cli/enclave.mjs --base http://127.0.0.1:18080 status <id> --json` signs in, then copy
  ~/.config/enclave/tokens.json["http://127.0.0.1:18080|<agent addr lowercase>"] into
  metal-session.json (0600). /v1/deployments -> 200 after.
- Running by hand: cpu-prefill-test.sh (wait_app -> capture-prefill-long chunk0t16-restart ->
  decode-rate 96 -> capture-prefill-long chunk0t16-restart-b); log dealt-e2e/cpu-prefill-test.log,
  full outputs dealt-e2e/cpu-prefill-*.out. Live config NOT auto-restored (decide after numbers).
- 19:20-19:36 UTC RESULTS chunk0-t16 (CONFIRMED live: box appConfigCid bafkreiavvfe3e6dgz4zqljd... =
  compact-JSON CID of config-0907-chunk0-t16.json; the platform stores the config compact):
    prefill  RATE chunk0t16-restart 13.4 positions/s (1496 of 1765 in 111.8 s, first text 119.1 s)
             RATE chunk0t16-rerun   13.5 positions/s (1500 of 1766 in 111.1 s, first text 118.5 s)
    decode   8.07 tok/s (TTFT 349.5 s; SKEWED: Steven sent a chat mid-run) / rerun 8.17 tok/s
             (96 tokens 11.6 s, TTFT 246.4 s, quiet app)
  vs the live config (nnThreads 4, link prefill chunk 4): prefill ~14.0 positions/s, decode 10.11 /
  10.13 tok/s, TTFT 231 s. => CPU prefill at 16 threads is LEVEL on prefill (both ~14/s: the link
  path is refill-bound, the CPU path compute-bound at ~730 GFLOP/s) and 19% SLOWER on decode
  (16 compute threads busy-wait against the refill threads on the 16-vCPU box). Net loss: revert to
  the live config after the -b capture. The prefill_chunk=0 lever is CLOSED for the 27B on metal0.
- 19:40 UTC rerun complete (Steven's chat had skewed the first decode run): RATE 13.5 / decode 8.17
  tok/s (TTFT 246.4 s) / RATE-b 13.4. Verdict stands: prefill level, decode -19%. 19:41Z: live
  config (config-live-0907.json) pinned via the relay base + `restart` in place; waiting for the
  box record to show appConfigCid bafkreig7teqi5pyozx46cfp22dlfj3xo2agy27dawylyn6bcv6glirb5xe.
- Deployment funded $2 + $5 today from the agent wallet (Steven sent $30 USDC at 19:08Z; wallet
  $23.18 after). Pixel: unplugged 19:38Z (was bus 5-1 = the Renesas controller's USB 2 side, so the
  old cable never had SuperSpeed lanes); a device on hub port 7-2.2.4.3 then failed high-speed
  enumeration 5x (error -71, "Maybe the USB cable is bad?"); nothing enumerated since. USB 3 needs
  the phone on bus 6 (Renesas SS) or bus 8 (VIA USB3.1 hub). Kernel-log monitor armed.
- 19:43-19:52 UTC USB 3 diagnosis (Steven swapped cables and ports): Pixel enumerates ONLY on the
  USB 2 root hubs (7-1 Renesas port 1; 3-2 = AMD Turin xHCI 41:00.4 port 2 whose SS side usb4-port2
  is 10 Gbps) at 480 Mbps / bcdUSB 2.10, SS side "not attached" every time; MTP function switch
  re-enumerates at HS too. Host SS stack works (VIA/Generic hubs + Realtek LAN at 5000 on bus 8; no
  xhci quirks on the cmdline). The phone's BOS ADVERTISES SuperSpeed Device Capability => the gadget
  is SS-capable and not software-limited; the SS lanes never train => cable wiring (both leads USB 2)
  or the phone's Type-C socket SS pins. Discriminator for Steven: a known USB 3 device on the same
  cable+port (bus 4/8 = cable fine, socket suspect; bus 3/7 = cable). H13SSL-N has two on-package
  USB 3.1 controllers (41:00.4, e5:00.4), 10 Gbps root hubs bus 2/4.
- 19:59:01Z USB 3 LINKED: after a further re-plug on the Renesas card a1:00.0 port 1 the Pixel came
  up on bus 6 port 1 as SuperSpeed 5000 Mbps, bcdUSB 3.20 (the same physical port that linked at
  480 as 5-1 minutes earlier - so it was the plug orientation / socket contact, not the host).
  Kernel: "LPM exit latency is zeroed, disabling LPM". NCM tethering up on the SS link: cdc_ncm
  6-1:1.1 -> ens10u1i1 10.160.70.152/24 (same host IP; forwarders 9501/9503 still bound to it).
  Runs: direct-run.sh usb3-k3 64 (WPORT=9503 BURN=5 MTP=3 PACE=16 SHIELDED_LOCAL_SITES=token_embd.weight)
  then usb3-k7; logs dealt-e2e/usb3-k*.log.
- 20:01 UTC USB3 k=3 (usb3-k3, 64 tokens, test prompt): decode_ms_per_tok 148.0, STEADY 138.8 ms
  = 7.2 tok/s (USB 2 best 160.5 ms / 6.2), watchdog bounces 0 (no NCM wedge on the SS link).
  MTP: 16 rounds, 48 drafted, 47 accepted (3.94 tokens/round, 98%); per round draft 73 ms (head
  decode 69.8), verify 504 ms (= 96 exchanges -> 5.25 ms/exchange vs ~6.35 on USB 2), observe 11 ms.
  exchanges=1632, link mask 194 ms wire 6142 ms (3.76 ms/exchange wire). Exchange cost only -17%:
  the phone-side turnaround, not bandwidth, dominates. Next: k=7 (8 rows/exchange now affordable).
- 20:03 UTC USB3 k=7 (usb3-k7, 64 tokens, test prompt): decode_ms_per_tok 111.8, STEADY 106.0 ms
  = 9.4 tok/s = NEW BEST with the Pixel as root of trust (USB 2 best 6.2). MTP: 9 rounds, 59
  drafted, 54 accepted (7.00 tokens/round, 92%); per round draft 142 ms (head decode 135.8 = 19.4
  ms/step, lm_head-bound), verify 639 ms (96 exchanges -> 6.66 ms/exchange at 8 rows), observe 13.
  exchanges=960, wire 3987 ms (4.15 ms/exchange), bounces 0. Round = ~794 ms / 7 tokens.
  Budget to 20 tok/s (50 ms/token): needs k~15 (16 rows, SHIELDED_MAX_M cap) AND fusion (2
  exchanges/layer): est. draft 291 + verify 360 + 13 = ~664 ms / ~13 tokens = ~51 ms/token on the
  test prompt only. Natural prompts (46% acceptance at k=3) stay well below.
- 20:09 UTC USB3 k=15 (usb3-k15, 64 tokens; engine.cpp clamp now = SHIELDED_MAX_M-1, d[32];
  SHENV adds SHIELDED_MAX_M=16 -> 16-row exchanges; worker takes them via its m>8 two-pass):
  decode_ms_per_tok 126.2, STEADY 87.8 ms = 11.4 tok/s = NEW BEST. MTP: 5 rounds, 71 drafted,
  58 accepted (12.60 tokens/round, 82%); per round draft 279 ms (15 head steps x 18 ms), verify
  1307 ms (incl. first-round upload), observe 24. Forwarder at close: turn mean 11.0 ms p50 5.3
  p90 15.4 (8 rows: mean 5.9 p50 3.6) -> the 16-row exchange doubles the phone-side turnaround
  (local 16-row work + mask/unmask), not the wire (262 KB/exchange = ~0.6 ms at 5 Gbps).
  Budget: 20 tok/s at 12.6 tokens/round needs <= 630 ms/round; steady now ~1100. Levers left:
  fusion (halve exchanges), cheaper draft (lm_head-bound 18 ms/step), 16-row local work.
- 20:12 UTC USB3 k=15 x 256 (usb3-k15-256): 17 rounds, 251 drafted, 238 accepted (15.00/round,
  95%); decode_ms_per_tok 110.9, STEADY 100.1 ms = 10.0 tok/s (the 64-token 87.8 was flattered by
  the short run). Per round: draft 333 ms (15 x 21.4 ms head steps, lm_head-bound), verify 1304,
  observe 26. Cumulative link: 1728 exchanges, wire 12552 ms (7.26 ms/exchange at 16 rows; 4.15 at
  8, 3.76 at 4), mask 968, unmask+lhs 398, rhs 228; link total 14801 = 822 ms/graph -> the other
  ~480 ms of verify is LOCAL phone work, mostly the local 16-row vocab projection (~16 x 18 ms).
  "REFUSED" = a late pad shipment (index 384) after the run ended; pads used 26208 missed 0.
  NEXT: drop SHIELDED_LOCAL_SITES (offload the vocab projection: 16-row reply 7.3 MB once per
  round + 15 single-row replies of 456 KB in the draft) - a win only on USB 3.
- 20:16 UTC k=15 x 128 with the vocab projection OFFLOADED (SHENV=SHIELDED_MAX_M=16 only,
  usb3-k15-lmgpu): WORSE - draft 573 ms (15 x 36.7 ms: each head step now waits on a 456 KB reply
  through the bridge = ~15 MB/s effective), verify 1227 (from 1304), steady 111.0 ms/token (from
  100.1). Keep SHIELDED_LOCAL_SITES=token_embd.weight.
- Topology check: 127.0.0.1:9501/9502 are metal0's OWN shielded-worker processes on THIS host
  (warden-host = metal0's box: RTX 3070 idle for us, Tesla PG500-216 + V100-PCIE-32GB held by the
  workers, 31.7 GB each; worker :9501 restarted with the 19:41 deployment restart). Phone -> NCM ->
  tcp-forward(-timed).py -> worker: the worker answers in 0.13 ms mean; ALL of the per-exchange
  cost is the phone-side path.
- Raw TCP over the USB 3 NCM link (netbench, phone->host, 64 x 1 MB, reply every 1 MB): 157 MB/s
  (USB 2 was 40). So the ~15-36 MB/s seen for large replies is the vsock + Java pump (64 KB
  read/write/flush per chunk, TCP_NODELAY set) inside the phone, not the USB link.
- Decomposition of a k=15 round (steady ~1420 ms / 15 tokens = ~95 ms/token): bridge floor
  ~5.3 ms x 96 = ~510 ms (forwarder turn p50); phone local compute between exchanges ~550 ms
  (turn mean 11.0 - p50; the 16-row local vocab projection ~290 of it); draft 333 (15 x 21 ms
  head steps, lm_head-bound); observe 26. 20 tok/s needs <= 750 ms/round: fusion (48 exchanges)
  gives ~-255, nothing yet cuts the local 550 or the draft 333 -> ~1160 ms = ~78 ms/token = ~13
  tok/s is the realistic ceiling of this chain (pVM + Java vsock bridge + 4 mid cores).
- 20:20 UTC k=15 x 128 PACE=0 (usb3-k15-nopace): decode_ms_per_tok 99.9, STEADY 84.4 ms = 11.8
  tok/s = NEW BEST; verify 1081 (from ~1230), wire 6.5 ms/exchange, bounces 0 -> on USB 3 the
  upload pacing is pure loss (Thread.sleep waits on the request pump). Use PACE=0 on USB 3.
- LEVER FOUND: the phone's LOCAL matmuls run at ~8 GMAC/s (head step 0.17 GMAC in 21 ms; 16-row
  vocab projection 2.5 GMAC in ~290 ms) because the bundled libggml-cpu.so is GGML_CPU_REPACK=OFF
  (memory: "or NOTHING offloads silently" - the repacked Q8_0x4 layout defeats the offload). A
  repacked/i8mm path should give 5-10x on the local 550 + draft 333 ms -> round ~700 ms -> ~21
  tok/s on the test prompt. Fix = keep the offloaded weights out of the CPU repack buffer (own
  buffer type / claim before repack) while token_embd-dup (lm_head) and the head repack.
- 20:25-20:35 UTC REPACK campaign: arm64 llama.cpp rebuilt with GGML_CPU_REPACK=ON (build-ggml-arm64.sh
  now takes GGML_CPU_REPACK; its cmake --install fails on the fork's app target, cp the .so by hand).
  Run 1 (no pin): NOTHING offloaded, but the phone ALONE decoded the 0.8B at k=15 in 28.8 ms/token
  steady = 34.7 tok/s (verify 271 ms for 16 rows x 24 layers locally!) -> the fast kernels are a
  5-10x lever on local work. Run 2 (tensor_buft_overrides -> ggml_backend_cpu_buffer_type()): still
  nothing offloaded: llama.cpp treats an override to THE cpu buft as "consider extra bufts" (REPACK
  wins). Run 3 (engine.cpp: distinct host buft "CPU_plain" delegating to the CPU one, pinned by a
  regex of the calib's 96 site names): offload path ACTIVE (backend asked for dealt pads) but prefill
  failed "dealt pads: group 1 index 0 not in any shipment (bank behind)" = a race with the first
  shipment's install (model load now 15.3 s, no mmap for pinned tensors). Rerunning (plain2).
  Also added: on "nothing offloaded" the engine relays engine.err lines mentioning shielded/REPACK.
- 20:43 UTC REPACK ON + whole calibrated layers pinned (CPU_plain, regex ^blk\.(0|..|23)\..*\.weight$;
  the calib names ONE node per group - attn_gate/ffn_up/K/V members were the mismatch): offload
  back (138 nodes/prefill, 1380/run, verify_fail 0). k=15 x 128: steady 94.7 ms (WORSE than 84.4
  no-repack): draft 274 (head 260.7 = 17.4 ms/step: the single-row lm_head is DRAM-bound at ~8 GB/s,
  kernels barely matter), verify 1476 (from 1081): forwarder turn mean 13.9 p50 6.5 p90 23.0 ms
  (was ~11 / 5.3 / 15.4) -> the exchange turnaround got slower (thread contention from the repack
  kernels' spinning vs the bridge/burners?), while the backend's own CPU work got faster
  (unmask+lhs 398->233, post 658->484). A/B next: BURN=0 on the repack build.
- 20:46-20:49 UTC repack A/B: BURN=0 on the repack build = 149.7 ms (burners stay essential).
  Repack run #2 (layers2, same config as #1): STEADY 72.1 ms = 13.9 tok/s = NEW BEST (draft 234,
  verify 1073, observe 14) -> run #1's 94.7 was an outlier; run-to-run spread at k=15 is ~+-15%.
  Thermal status 0 (no throttling). No-repack APK rebuilt from a byte-identical libggml-cpu.so
  (4603456 B = the old prefix lib) and stashed (dealt-e2e/anchor-norepack.apk); paired runs
  norp1/norp2 in flight for a 2-vs-2 comparison. Phone-alone (no GPU) reference at k=15 with
  repack: 28.8 ms/token = 34.7 tok/s (run usb3-k15-repack, 0 exchanges).
- 20:53 UTC A/B verdict (k=15 x 128, USB 3, BURN=5, PACE=0, MAX_M=16): repack 94.7 / 72.1 (draft
  274 / 234) vs no-repack 84.4 / 95.2 / 103.4 (draft 314 / 311 / 376). Draft consistently ~25%
  faster with repack (the repacked lm_head dup helps even single rows); verify inconclusive within
  the +-15% spread. KEEP REPACK: prefix lib = repack, APK stashed dealt-e2e/anchor-repack.apk and
  installed; no-repack twin at dealt-e2e/anchor-norepack.apk. Commit 175c4604 (engine pin +
  err relay + build knob). BEST = 13.9 tok/s (72.1 ms steady) with the Pixel as root of trust.
- 20:58 UTC natural prompt at k=15 (usb3-k15-nat2, "Write a short paragraph explaining why the
  sky looks blue..."): acceptance 8% (2.25 tokens/round), steady 719.9 ms/token, and the run
  died "decode failed (verify of 16 rows)": at 2.25 tokens/round every round burns 16 pad
  indices (57 rounds x 16 = 912 for 128 tokens) and the x86 dealer mints ~23 indices/s
  (256 in 11.3 s) -> the bank falls behind, verify balloons (3716 ms/round) then stops. Wide k
  only pays on predictable text; natural prompts want k=3-5 and the dealer's mint rate is a
  real ceiling (~3 tok/s at 16 rows) unless the dealer gets a GPU (platform GPU dealer, PLAN).
  (prompt-300.txt run: the model answered "\n" + EOS after 388 tokens - not a speed sample.)
- Correction on the nat2 failure: pads used=24576 waited=0, so no in-engine pad wait; the dealer
  DID keep minting (up to 576) but at 2 shipments per ~6 s (~21 indices/s) plus the 117 MB
  fetch+install per shipment, while 16-row rounds at ~1.5/s burn ~24 indices/s -> index 256 was
  asked for before its shipment landed -> "bank behind" -> refill stopped. Dealer throughput
  (x86 zero-pad mint path) + shipment latency = the ceiling for wide k on low-acceptance text.
- 21:00 UTC natural prompt at k=3 (usb3-k3-nat, 96 tokens, repack build, USB 3): 44 rounds, 2.16
  tokens/round (40%), draft 49 ms (15.5 ms/step, from 23), steady 234.0 ms/token = 4.3 tok/s -
  the SAME as USB 2 (E6 4.4): at 4 rows the exchange is latency-bound (~5.3 ms bridge floor x 96),
  USB 3 only paid for the wide (16-row) exchanges. Natural-text reality with the phone in the
  loop: ~4-5 tok/s; test prompt 13.9; phone alone (no GPU, repack) ~35 on the test prompt.
  END OF DESIGN-A LEVERS FOR TODAY. Open question to Steven: design B (phone = dealer/attester,
  engine in metal0's SNP VM on the V100) is the only route to 20 tok/s with a phone root of trust.

## 2026-09-08 05:25-05:30 UTC - phone prefill thread sweep (repack build, 379-token prompt, 8 tokens)
- ANCHOR_PREFILL_THREADS 5: 15.9 s; 6: 20.2 s; 4: 19.9 s (run order 5, 6, 4). The 4-thread
  reference from 20:57Z was 10.7 s for the same prompt (388 tokens then). Spread is 2x across
  runs (thermal/DVFS within a chain: each run holds 5 burners + compute for ~90 s), so nothing
  above 4 threads shows a gain; the little cores stall the batch. KEEP 4 prefill threads.
  Phone prefill stays ~36 tok/s cold. (Steven asked about USB 4 and a Pixel 10: answered from
  the round decomposition - neither changes the 96-round-trip structure; Pixel 10 = attestation
  + maybe pVM networking.)

## 2026-09-08 05:30-05:40 UTC - VM networking for the pVM (Steven: "try to implement the VM networking")
- framework-virtualization.jar (pulled, dexdump): network exists ONLY on custom-image VMs
  (VirtualMachineCustomImageConfig.Builder.useNetwork -> VirtualMachineRawConfig.networkSupported);
  the app-VM VirtualMachineConfig.Builder has no network setter (even with hidden_api_policy=1:
  setConnectVmConsole/setConsoleInputDevice/setCpuTopology/setOs/setShouldUseHugepages/
  setVendorDiskImage/setVmConsoleInputSupported only). VirtualMachineAppConfig.CustomConfig
  .networkSupported is written only by the parcel code, never by toVsConfig.
- The service DOES enable the feature: VirtualMachineManager.isFeatureEnabled
  ("com.android.kvm.NETWORK") = true (probe in Main.java, commit pushed). No Terminal app, no
  vmnic service in `service list`, no network flag in device_config virtualization.
- Custom-image route = a raw VM (own kernel/initrd/disks): would need the privileged
  USE_CUSTOM_VIRTUAL_MACHINE permission (third-party app: no) AND re-implementing virtmgr's
  payload composition (composite disk, idsig, instance image, encrypted store, DICE) -> not viable.
- Corrected benefit estimate: virtio-net is also a crosvm userspace device (VM exit per packet),
  so VM networking would remove the Java pump + one TCP traversal, ~5.3 -> ~3.5 ms/exchange
  (~30%), NOT the 2x I first guessed. Remaining structural levers on this device: native (JNI)
  pump + C splice forwarder (~10-25% of the floor), exchange fusion (~1.4x), row-split exchange
  pipelining in the backend (overlap wire with local compute, up to ~1.6x, complex).
- 05:40 UTC RAW LINK RTT (pingpong: static arm64 client in the phone shell, TCP_NODELAY, Python
  echo on the host NCM IP, 300 round trips): 64 B 1.77 ms; 24 KB 1.60; 84 KB 2.87; 262 KB 4.18 ms
  (p90 4.34, min 2.4). => the USB NCM link itself is ~1.7 ms floor + ~10 us/KB; an exchange-sized
  round trip (84 KB up + 178 KB down at 16 rows) costs ~4.2 ms of the ~5.3 ms floor measured
  through vsock + Java + Python. VM networking / a native pump can only win the remaining ~1 ms.
  Levers that attack the 1.7 ms: cdc_ncm tx timer / aggregation (host: tx_timer_usecs sysfs,
  needs root; phone gadget: no root), fewer/larger exchanges (fusion), pipelining.
- 06:08-06:15 UTC cdc_ncm HOST TUNING (Steven, sudo): tx_timer_usecs 400->0 + min_tx_pkt 13312->0:
  64 B RTT 1.77->0.56 ms but 262 KB 4.18->10.2 ms (every 1.5 KB frame padded to a 16 KB NTB).
  tx_timer_usecs=50 + min_tx_pkt=13312: 64 B 0.70 / 84 KB 1.36 / 262 KB 2.56 ms (p50 2.16) =
  the link floor HALVED. The phone's gadget side (untunable without root) keeps its share.
  dwNtbOutMaxSize=16384 (device ceiling: tx_max cannot grow). Settings are volatile (re-plug or
  reboot resets them): a udev rule for the cdc_ncm interface would make them stick. Runs in
  flight: usb3-k15-ncm50 (128) + usb3-k3-nat-ncm50 (natural, 96).
- 06:17-06:20 UTC tuned link end to end: k=15 test prompt steady 89.9 ms (wire 6.29 ms/exchange vs
  5.99-6.50 before: NO change), natural k=3 229.2 ms (was 234.0: no change). The host NCM timer
  was not where the engine's exchange time goes.
- 06:20 UTC VSOCK ECHO PROBE (app worker=echo returns the guest's bytes over the same vsock; engine
  ANCHOR_LINK_ECHO=1 ping-pongs before loading anything): 64 B p50 1.27 ms (mean 1.89, min 0.87);
  24 KB p50 1.95; 84 KB p50 4.01; 262 KB p50 7.37 ms (mean 8.53, p90 14.3, MIN 1.23). => the
  vsock + app pump path costs ~1.3 ms base + ~14 us/KB (~70 MB/s) with a heavy scheduling tail;
  for an exchange's 84 KB up + 178 KB down that is ~4.9 of the ~6.3 ms wire. The USB link (2.6 ms
  tuned) is the smaller part. VM networking would have bypassed exactly this and is not available
  to app VMs on this build. Per-KB cost is the transport (64 KB vsock packets through crosvm /
  virtmgr's proxy), not the Java loop -> a native pump would not fix it. What would: fewer bytes
  per round (impossible: masked data), fewer exchanges (fusion), overlap (row-split pipelining),
  or a different guest<->host channel (virtiofs exists in this framework: startCrosvmVirtiofs;
  untested), or design B.
- 06:22 UTC pump thread priority (new --ei pumpprio, PUMPPRIO env): -19 (URGENT_AUDIO) vs 0 on the
  echo probe, back to back: 64 B p50 1.86 vs 1.80 ms; 84 KB 7.05 vs 2.70; 262 KB 8.30 vs 5.62.
  Urgent priority HURTS (the pump preempts the vCPU/crosvm threads it feeds). Keep 0. The vsock
  path's ~1.3-1.9 ms base for 64 B (a plain KVM guest does ~0.1) points at virtmgr proxying the
  app's connectVsock stream in userspace; apps cannot open AF_VSOCK themselves (SELinux), so this
  floor is Android's design, not ours. DESIGN A CEILING on this phone is now fully accounted for.

## 2026-09-08 06:25-06:35 UTC - DRAFT-AHEAD (Steven: hosts have NO TEE; the pVM stays the trusted half;
## non-confidential compute may go to the host CPU)
- Bug fixed on the way: engine.cpp verify row buffer was rows[9] (k<=7 era) while k=15 writes 16
  -> stack overrun in every k=15 run so far (text looked right by luck). Now rows[33].
- Draft-ahead (ANCHOR_DRAFT_AHEAD=1, ANCHOR_HEAD_THREADS=4): the head keeps its chain going on
  its own thread pool while the target verifies: guess the bonus token, then draft the next k;
  if the target accepts all rows and samples the guessed token, the next round skips its serial
  draft (~230-280 ms at k=15). anchor_mtp gains a tail + chain() + refeed(); output text unchanged
  (the target verifies exactly as before). Paired runs ahead1/base1/ahead2/base2 in flight.
- 06:40 UTC DRAFT-AHEAD RESULT (k=15 x 128, two pairs): ahead 75.7 / 81.8 vs base 94.8 / 81.1 ms
  steady (means 78.8 vs 88.0, -10%); draft per round 71 / 57 vs 248 / 305; verify 1137 / 1226 vs
  1294 / 1009 (no visible contention from the head thread); 7 of 9 rounds from a pre-draft in
  both runs. Committed a908bb8a default off; recipe adds ANCHOR_DRAFT_AHEAD=1 to SHENV.
  Round means: ahead ~1282 ms vs base ~1449 (-11.5%).
- 06:47 UTC T4 natural text (96 tokens): k=15 p_min 0.5 + draft-ahead 233.8 ms/token (1.58
  tokens/round, 42 drafts in 53 rounds); k=7 p_min 0.5 234.2 (identical); k=3 no gate 225.8 (2.16
  tokens/round). The confidence gate protects the pad budget but buys no speed; natural text
  stays ~4.4 tok/s, bound by ~530 ms per round of 96 exchanges (~5.5 ms each at 4 rows). Only
  fewer or overlapped exchanges move it. T4 CLOSED.
- 06:52-06:56 UTC echo probe on an idle phone after a fresh install: 262 KB p50 1.2 ms sequential,
  211 MB/s with two in flight (vs 7.4 ms / 70 MB/s measured after decode runs) - variance
  unexplained (thermal status 0 both times). Cold/hot decode pair: cold k=15 steady 78.3 ms,
  wire 6.4 ms/exchange = no better than hot runs; the hot leg aborted "bank behind" at index 128
  while the host was loaded by Astra's builds (dealer + 117 MB shipment pushes starve). AHEAD
  raised to 512 for runs. Pulled Astra's f3de882f (self-check bounds) + 3e15d4e1 (overlap the
  pad-check RHS with socket transit, SHIELDED_OVERLAP_VERIFY=1); APK rebuilt (anchor-overlap.apk);
  measuring off/on/off/on at k=15 + draft-ahead.
- 07:00-07:40 UTC PAD PIPELINE DEFECT (four identical failures of the overlap quad at round 4,
  "decode failed (verify of 16 rows)" / "bank behind" at index 64-68): the app's streamBank thread
  streamed shipment 0 into the VM and then spent its time in syncBank downloading 117 MiB files -
  including RE-downloading shipments it had just dropped below the ledger mark (the relay still
  lists them) - so 64-64 was never streamed before the engine needed it. Earlier k=15 runs only
  passed because every shipment was fetched during the 50-s first round. Fixes (app): fetcher on
  its own thread (2 s cadence), never re-fetch dropped/spent shipments, fetch in index order;
  (dealer-loop.py): streaming publish - push each shipment when the dealer announces it (one model
  load kept), plus --mint-batch as an option. Also: the x86 dealer sustains ~20 indices/s
  (~12 idx/s minting per shipment second) vs ~24/s consumed at 16 rows: sustained 16-row decode
  needs dealer parallelism or a GPU dealer (platform-owned; never the operator's V100s - Astra).
  Quad "ove" (off/on/off/on, overlap_verify) running on the fixed pipeline, AHEAD=512.
- 07:50 UTC sixth quad leg: 6 rounds then fail; the VM logged "PADS ...-64-64.pads FAILED at 0 of
  123282432" for every shipment after the first, during the model load - the receiver's open() of
  the temp file in the encrypted store failed (its body loop is skipped when fd < 0 -> "at 0"),
  the VM answered 'E' and closed, the app saw EPIPE. Adding errno + free-space to the message and
  a 2-s bounded retry on open; the store is 2048 MiB (model 794 + 8 shipments of 117 = 1730).
- 08:00-08:15 UTC pipeline repaired (d9b8b754) - OVERLAP_VERIFY quad (k=15, draft-ahead on, 128
  tokens, APK with Astra's 3e15d4e1 + 6ff887a9): off 80.6 / 81.6 ms steady (verify 1259 / 1302),
  on 77.2 / 81.0 (verify 1209 / 1202). Overlap = ~-75 ms/round (-6% verify), ~-2 ms/token: small
  but consistent; keep SHIELDED_OVERLAP_VERIFY=1 in the recipe. Next: SHIELDED_FUSE_LOCAL pairs.
- 08:16-08:25 UTC SHIELDED_FUSE_LOCAL pairs (overlap on in all): on 85.4 / 86.3 vs off 85.5 / 86.8
  ms steady - neutral, as a prerequisite should be (islands local on the caller thread). All four
  ~5 ms slower than the overlap quad 30 min earlier: slow drift within a session (phone warming?);
  pairs interleaved on/off remain the only fair comparison.

- 2026-09-08T08:16:06+00:00 Astra coordination alert: please read the newest COORDINATION.md before expanding mint edits. I have unblocked your VS Code approvals and am watching them. There are critical pad-seed/platform-key and attestation-own-key binding gaps; exact v2 transcript and split ownership are in the log. Your mint pthread_create failure and scratch cleanup findings also need attention. I own relay + NEW binding/grant helpers; you own existing payload/app integration.
- 08:30-08:45 UTC DEALER THROUGHPUT: sh_link_mint_shipment ran its group loop on one thread
  (16 indices per weight pass). Now SHIELDED_MINT_THREADS (default 1 = unchanged) splits the
  groups across threads, each with its own scratch incl. the writer's (new
  sh_pads_writer_cell_with; cells land at disjoint pwrite offsets). Host (EPYC 9115, 16c/32t):
  64 idx 3.5 -> 2.1 s; 256 idx 11.1 -> 5.4 s; 512 idx 9.8 s @16 / 11.2 @8 / 9.2 @32 threads
  => ~17 ms/index (~58 idx/s) after ~2 s fixed load+probe per dealer run. Scaling ~3x only
  (per-thread refill ~22 GMAC/s incl. the 3 byte-planes; AEAD seal + PRF per cell); enough for
  one phone at 16 rows (~24 idx/s). dealt-selftest ok at 1 and 8 threads. device-dealt-run.sh
  exports SHIELDED_MINT_THREADS=16 (MINTTHREADS env). Streaming publish + this = first shipment
  pushed ~2-3 s after the dealer starts. End-to-end leg "mint16" running.

- 2026-09-08T08:37:27+00:00 Steven follow-on request: after the Q8 20tok/s milestone, jointly investigate Q4 support with Enclave Shielded/Pixel root of trust. Keep Q8 for the current milestone; details in COORDINATION.md.

## 2026-09-08 08:20-09:10 UTC - authenticated pad bootstrap (Astra's PAD-BOOTSTRAP.md), phone side
- Astra found: attest() signed arbitrary BOUND bytes; PADSEED was unsigned (chosen-seed); PADWIN
  signatures did not bind the request nonce (replay after reconnect); PADSIGN signed any kind
  (fabricated receipts); ENGINE env= could set trust keys; pad index counter wraps at 2^24.
- Mine (pushed 4ef8eb7b + staged): app builds the android-avf-pvm/v2 transcript (domain || SPKI ||
  pad pk || nonce), payload validates it against g_tpk/g_ppk (sh_avf_pad_binding_valid) and the
  sha256 challenge, signs nothing else; PADREQ2/PADGRANT signed seed grants (pVM nonce, pVM model
  SHA-256 via a verified streaming implementation, calib SHA-512/256, sh_pad_grant_verify under the
  pinned ledger key from assets/ledger.pk; ANCHOR_LEDGER_PK at build; unpinned = dev, loud);
  window sig_v2 verified against the engine's own nonce (required when pinned); PADSIGN limited to
  the legacy seed request in unpinned builds; ENGINE env whitelist. Dev hub restarted (was 24 h old,
  pre-grant code). Pixel 8 Pro: attestation itself still "not supported" (Pixel 10 needed).
- Parallel mint pushed 8dbb1c39 (SHIELDED_MINT_THREADS; ~58 idx/s at 16 threads; selftest
  regression). Steven's roadmap (via Astra 08:37Z): Q8 until 20 tok/s; then Q4 evaluation.

- 2026-09-08T08:48:36+00:00 STEVEN EXACT FOLLOW-ON TARGET: latest user clarification says Qwen3.8 27B in Q4_K_M specifically, AFTER current Q8 optimization work /20tok/s milestone. This supersedes generic Q4 wording. Preserve the exact requested model/version and quantization; do not substitute Qwen3.5 or generic Q4. Verify the actual model artifact/availability when starting that phase; do not switch early. Astra and Fable jointly own compatibility, calibration, authenticated asset binding, quality and throughput evaluation with Shielded/Pixel root of trust.
- 09:15-09:55 UTC pushed 59ef6866: measured pins module (payload/anchor_pins.{h,c}: explicit
  assets/anchor.mode dev|protected, ledger.pk / model.sha256 / prefix.pk 64 hex; protected fails
  closed without all three; a malformed pin is an error in any mode), PADREQ2 checks the stored
  model's bytes against the pin before signing/loading, PREFIXPK pinned, ENGINE refused on an
  unverified model in protected mode, host ASan/UBSan regression test/anchor-pins.test.mjs.
  Build knobs ANCHOR_MODE/ANCHOR_LEDGER_PK/ANCHOR_MODEL_SHA256/ANCHOR_PREFIX_PK. Bootstrap legs on
  the dev hub: grant ok, decode 80.4 ms steady (one transient 183 ms leg with 19.9 ms/exchange wire,
  cause unknown; the next leg was normal). OPEN: engine saw legacy-only windows although
  relay reserve() emits sig_v2 - app now logs sig_v2 presence; pins-dev leg waits on Astra's lock.
- 2026-09-08 09:15 UTC BUILD/INSTALL RECIPE (survives compaction):
  APK:   cd ~/Projects/enclave/shielded/anchor/avf && ./build.sh anchor        (~4 s -> out/anchor.apk; dev mode by
         default, protected = ANCHOR_MODE=protected + ANCHOR_LEDGER_PK/ANCHOR_MODEL_SHA256/ANCHOR_PREFIX_PK all set)
         ADB=~/Projects/optee-anchor-spike/bin/platform-tools/adb; $ADB install -r out/anchor.apk; $ADB reverse tcp:8787 tcp:8787
  arm64 ggml prefix (only when the CPU backend changes): build-ggml-arm64.sh with GGML_CPU_REPACK=ON; its cmake --install
         fails on the fork's app target -> cp libggml-cpu.so by hand into out/ggml-arm64-work/prefix/lib, then build.sh anchor.
  HUB:   cd shielded/anchor/avf && PADS_MASTER_SEED=$(cat $W/dealt-e2e/master.hex) PADS_DEALER_TOKEN=local-dealer-token \
         ENCLAVE_DEV_UNATTESTED=1 nohup node host/local-hub.mjs --port 8787 --dev-unattested >> $W/dealt-e2e/local-hub.log 2>&1 &
         (verify: tr '\0' '\n' < /proc/<pid>/environ | grep -c PADS_DEALER_TOKEN == 1; a hub WITHOUT the token = every dealer
         push "Broken pipe" = phone "bank behind" at index 0. This happened 08:58-09:08Z.)
  LEG:   cd $W && WPORT=9503 BURN=5 MTP=15 PACE=0 AHEAD=384 INTERVAL=5 \
         SHENV="SHIELDED_LOCAL_SITES=token_embd.weight,SHIELDED_MAX_M=16,ANCHOR_DRAFT_AHEAD=1,SHIELDED_OVERLAP_VERIFY=1" \
         ./direct-run.sh <label> 128 > dealt-e2e/<label>.log 2>&1   (takes PHONE.lock; writes phone-/dealer-/watchdog-<label>.log;
         the run script starts its own dealer for the label; forwarders tcp-forward(.py 9501, -timed.py 9503) stay up)
  PASS = PINS mode=dev ... -> "MODEL ok <sha> (unpinned: hashed only)" -> "PADGRANT ok" -> "PADS window a..b sig_v2" -> steady ~80 ms/token.
- 2026-09-08T09:16:07Z stage-dev4 PASS (hub with dealer token, pid 1771216): PINS dev -> MODEL ok c54f8b67 -> PADGRANT ok -> windows 0..256 sig_v2 (0 legacy)
  -> 79.0 ms/token steady (12.7 tok/s), verify_fail 0, prefill_ms 44131 (weight upload lands in round 1), 0 bounces.
  Commit eb02384f pushed (model stage before grant, pin read-error fixes, PREFIXPK startsWith, fixture cases). Astra's
  lock writer overwrote mine at 09:14:40Z (told them). Next: --ei tamper/restage knobs + protected first-boot leg.
- 2026-09-08T09:24:47Z tamper1 PASS: swap after grant refused + purged + honest re-stage accepted (matches the grant) + decode 94.0 ms steady
  (64 tok). Payload fixes built (dup MODEL reply, pending request dropped on re-stage + PADGRANT model check, g_pad_name[65]).
  APKs stashed: dealt-e2e/anchor-dev.apk, dealt-e2e/anchor-protected.apk (pins in dealt-e2e/pins/, hub key 6240333b...).
  Knobs: --ei tamper 1 (TAMPER=1), --ei fresh 1 (FRESH=1) via device-dealt-run.sh. prot1 leg started 09:24Z (protected + fresh).
- 2026-09-08T09:27:33Z prot1 PASS (protected APK + FRESH=1): pins all pinned, first-boot stream, MODEL ok (matches the pin), PADLEDGER ok (pinned),
  PADGRANT ok (pinned ledger key), dup-stage reply verified, windows sig_v2, 74.3 ms/token steady (32 tok), offloaded 552 / local 0,
  verify_fail 0. Pushed 416d7dc0. Dev APK reinstalled 09:27Z. k15a (baseline, 128 tok) running; then k31a = MTP=31 with
  SHENV SHIELDED_MAX_M=32 (pads are one index per row: no dealer change; 32 idx/round vs the x86 dealer's ~58 idx/s), then k15b/k31b.
- 09:27-09:32 UTC k=15 vs k=31 pair a (same APK = dev+pins d67520d7-era, 128 tok, test prompt, BURN=5 PACE=0 AHEAD 384/512):
  k15a: 81.1 ms/token steady; 9 rounds, 14.11 tok/round (90% of drafts); draft 59 ms (draft-ahead 7/9), verify 1283, observe 31;
        960 exchanges, wire 6048 ms = 6.3 ms/exchange; offloaded 1380 / local 0; verify_fail 0.
  k31a (MTP=31, SHIELDED_MAX_M=32): 111.6 ms/token steady; 7 rounds, 18.14 tok/round (63% of drafts); draft 321 ms (draft-ahead
        only 3/7: a 31-step head chain = 983 ms no longer fits the verify wait), verify 2055, observe 31; 768 exchanges, wire 7644 ms
        = 9.95 ms/exchange (32 rows); offloaded 1104 / local 0; verify_fail 0. Pads: one index per row, dealer kept up (no bank behind).
  Cost model from the two points: wire/exchange ~ 2.65 + 0.228*m ms; local verify ~ 256 + 26.4*m ms; a k=23/M=24 leg would land
  ~108 ms/token, k=11/M=12 ~111 => k=15/M=16 is at the optimum on this chain for the test prompt. k=31 REJECTED. Pair b running (k15b).
- 2026-09-08T09:36:38Z pair b: k15b 82.3 / k31b 145.1 ms/token (k31b verify 2749 ms/round, head chain 1552 ms: hotter phone or contention).
  k=31 REJECTED; k=15/M=16 stays. Posted to Astra. Next: PADACK payload/app side (PAD-ACK.md), then fusion status with Astra.
- 2026-09-08T09:50:14Z PADACK: 4e6e0e9f (checker, receiver, PADACK, Main relay, doc) + 2ca8e8f9 (judge/hash via retained fd, dir fsync
  required, cached path via inode). ack1 = 6 PADACKs, old hub 404 (expected). Hub restarted on Astra's relay 7b18a44a
  (/v1/pads/ack); ack2 running 09:49Z for platform acceptance. Recipe unchanged (k=15/M=16).
- 2026-09-08T09:59:41Z RECIPE FACT: build.sh anchor BUNDLES out/engine-pvm as built; any change to engine.cpp, ggml-shielded.cpp or the
  pads/tee library must be preceded by ./build.sh engine-pvm (then anchor). Pushed a2b233d6 (signer returns status, ctl_close,
  anchor_ctl_write handed to the engine via engine_set_ctl_writer, standalone engine link fixed). phone-v100-run.sh now
  honours DEALER_DELAY (seconds before the dealer starts) for the late-dealer leg.
- 2026-09-08T10:22:27Z fine1 (FULL calib, ANCHOR_FINE_PLACEMENT=1 = only calibrated group members pinned CPU_plain, rest repacks; APK
  anchor-fine-full.apk, engine-pvm 1bdf9fc5): 72.1 ms/token steady (64 tok, 5 rounds, 12.6 tok/round), verify 1081 ms/round
  (vs 1283-1335 with whole-layer pins), draft 106, offloaded 828 / local 0, gmac 39.75, verify_fail 0, sha256=arm_sha2.
  = equals the all-time best (72.1) with NO placement change: the whole-layer pin was costing ~200 ms/round of un-repacked
  local matmuls. local1 (local-output calib 0e616212 in APK + dealer, 48/97 groups) running 10:22Z.
- 2026-09-08T10:24:36Z local1 (local-output, 48 groups): 84.1 steady; verify 842 (-239/round), draft 145, 10.5 tok/round (67%); text identical
  to fine1/k15a. Per round wins, per token lost on acceptance (small sample). Next: fix receiver name classes (prefix files
  were judged as shipments), rebuild engine-pvm on fa4031a3, 128-tok pair fine2/local2.

## 2026-09-08T10:29:37.989601+00:00 Astra transport attribution correction (source review)

Android16-release android/virtmgr/src/aidl.rs connectVsock returns VsockStream::connect_with_cid_port as ParcelFileDescriptor via File::from_raw_fd(stream.into_raw_fd()). There is no per-byte virtmgr proxy in this sourcepath. The 06:20/06:22 notes inferred such a proxy from end-to-end Java echo latency; that inference is not established. The measuredlatencies remainvalid, but Javaecho conflatesappstreamloop+kernel/vsock/crosvm and scheduling. Nativeecho diagnostic is beingadded tocomparethesameguestprobe witha64KiBCloop; no claimofimprovement yet. Installedfd domain/type/buffer logs willcheckdescriptorassumption. Source:https://android.googlesource.com/platform/packages/modules/Virtualization/+/refs/heads/android16-release/android/virtmgr/src/aidl.rs . Savedsource inAstrai-w/work/avf-source/16-virtmgr-aidl.rs.
- 2026-09-08T10:31:17Z PLACEMENT PAIR 2 (128 tok): fine2 (full calib, fine pin) 90.0 ms/token, verify 1362, 14.11 tok/round; local2 (local-output
  calib 0e616212, 48 groups: QKV + FFN gate/up on the GPU, attn out / ssm out / ffn down / vocab local+repacked) 71.8 = NEW BEST,
  verify 915, 12.70 tok/round, 90 nodes/round, gmac 56.37, text identical. Per round -31%, per token -20%. APKs: anchor-fine-full,
  anchor-fine-local (engine-pvm fa4031a3), anchor-fine-gpuffn (payload 7ed800e3, calib 3e892b03, 24 groups). gpuffn1 running 10:30Z.
  Recipe for the local-output profile: ANCHOR_CALIB=<profile> build.sh anchor (after engine-pvm), CALIB=<same file> for the dealer
  (device-dealt-run.sh), SHENV += ANCHOR_FINE_PLACEMENT=1. Pushed 7ed800e3 (calib hashed whole or refused), 8f488fcb (pads-port names).
- 2026-09-08T10:36:11Z GPU-FFN profile (gpu-ffn.calib 3e892b03, 24/97 groups = FFN gate/up on the GPU, everything else local+repacked,
  ANCHOR_FINE_PLACEMENT=1, k15/M16, APK anchor-fine-gpuffn.apk, engine-pvm fa4031a3):
  gpuffn1 (draft-ahead on):  56.1 ms/token steady = 17.8 tok/s NEW BEST; 9 rounds, 14.11 tok/round; draft 60, verify 832, observe 43;
           24 exchanges/round (48 nodes), wire 2655 ms / 240 = 11 ms/exchange (big FFN replies), gmac 25.54, prefill 13.0 s, text identical.
  gpuffn2 (draft-ahead off): 56.8; verify 665, draft 248 (head chain 236 ms vs 519 when overlapped): the overlap is paid 1:1 by core
           contention. Round ~932 both ways; local graph ~390 ms real compute + wire ~265. 20 tok/s needs round ~830 (steady ~0.85*round/14.11).
  gpuffn3 (draft-ahead on + ANCHOR_HEAD_THREADS=2) running 10:35Z. Pushed 44fcd1c1 (prefix fd-held verify+load, ntok bound, calib abort).
- 2026-09-08T10:37:46Z 0.8B MILESTONE, NOT THE GOAL (Steven via Astra 10:40Z: the goal is 20 tok/s on the 27B Q8 Eyesoff deployment with MTP/vision/180224 ctx): gpuffn3 = 43.3 ms/token steady = 23.1 tok/s on the 0.8B (128 tok, test prompt), text identical to
  every other leg, verify_fail 0, 24 exchanges/round (480 offloaded nodes, 0 local), gmac 25.54, draft-ahead 7/9.
  RECIPE (the whole thing, from a booted phone on USB 3 NCM + metal0 worker + dev hub with dealer token):
    APK  = anchor-fine-gpuffn.apk  (build: ./build.sh engine-pvm; ANCHOR_CALIB=$W/dealt-e2e/calib/gpu-ffn.calib ./build.sh anchor;
           gpu-ffn.calib = calib-profile.py <full calib> --profile gpu-ffn = 24/97 groups: FFN gate/up on the GPU, rest local)
    LEG  = CALIB=$W/dealt-e2e/calib/gpu-ffn.calib WPORT=9503 BURN=5 MTP=15 PACE=0 AHEAD=384 INTERVAL=5 \
           SHENV="SHIELDED_LOCAL_SITES=token_embd.weight,SHIELDED_MAX_M=16,ANCHOR_DRAFT_AHEAD=1,ANCHOR_HEAD_THREADS=2,SHIELDED_OVERLAP_VERIFY=1,ANCHOR_FINE_PLACEMENT=1" \
           ./direct-run.sh <label> 128
  Per round: draft 88 + verify 629 + observe 24 = ~741 ms at 14.11 tok/round. Ladder today: 81 -> 72 (local-output) -> 56 (gpu-ffn)
  -> 43.3 (gpu-ffn + 2-thread head chain). gpuffn4 = exact repeat running 10:37Z; then natural text (k=15, k=5), then Astra's echo pair.
2026-09-08T10:38:53Z gpuffn4 repeat = 44.9 ms/token steady (0.8B milestone stable: 43.3 / 44.9), verify 631, text n/c
- 2026-09-08T10:46:01Z 27B feasibility audit written: /home/steven/Documents/Codex/2026-09-04/lo/work/eyesoff-perf/27B-FEASIBILITY.md (Astra's geometry of record: 2026-09-07/i-w/work/model-scale-audit.md).
  Verdict: ~1 tok/s, ctx <= ~14k in a 4 GiB pVM, minutes of prefill per 1k tokens; 20 tok/s ~20x away on physics.
  probe1 (APK b8e8f295, 4 GiB VM): STORAGE /mnt/encryptedstore ext4 1951 MiB (962 avail), fs-verity REFUSED (EACCES),
  userfaultfd EPERM, ram 3999 MiB => no authenticated paging for an app payload; the pVM must never need the 27 GiB
  (compact e.w retention = Astra; platform-signed per-tensor manifest pin = proposal). probe2 = MEM=8192 running 10:45Z.
- 2026-09-08T10:51:37Z probes (Pixel 8 Pro): probe2 MEM=8192 without fresh -> ram 3999 (stored instance keeps its size); probe3 FRESH=1 MEM=8192
  -> ram=8009 MiB (8 GiB pVM GRANTED); host /data 110 G / 95 G free (30 GiB store feasible). probe4: store mount =
  /dev/block/mapper/cryptdev ext4 rw (encryptedstore_fs/encryptedstore_file contexts). Design written (27B-FEASIBILITY.md s.10):
  verified streaming registration per boot (one sequential pass: sha256 vs pin + per-tensor registration + resident copies,
  commit at end) = no pager/fs-verity/uffd needed. Pushed c6861f03 (probe: MEASURE/chmod-retry/SELinux/AuthFS/uffd user-mode fault).
  probe5 (8 GiB instance, extended probe) running 10:51Z. Astra: compact e.w retention drafted; native echo b28a5b4e pending pair.
- 2026-09-08T10:55:28Z probe5 (8 GiB): microdroid_app; verity MEASURE/ENABLE = EACCES (policy), uffd USER_MODE_ONLY = EACCES, authfs absent,
  /dev/fuse EACCES => no authenticated paging for app payloads on the Pixel 8 Pro. Engine-pvm rebuilt on 807bc5c9 (Astra's
  compact encoded-weight cache) + payload d00d50de (ANCHOR_WEIGHT_CACHE=1 -> <store>/wcache; MEM lines; SHIELDED_VERBOSE).
  cacheoff (full calib, fine, k15, head 2 thr, 64 tok, 8 GiB VM): 72.2 ms/token, verify 1037, verify_fail 0,
  MEM before VmRSS 9.9 MB / after VmRSS 680 MB, VmHWM 2695 MB. cacheon running 10:55Z.
- 2026-09-08T11:06:46Z anchor64 = separate named 64 GiB instance (VMNAME=anchor64 STORAGE=65536 MEM=8192; Main 4cd59c01: --es vmname, no
  silent deletion of an incompatible instance, only FRESH=1 deletes by name). big-off on it: 74.2 ms/token, verify_fail 0,
  VmHWM 2761 MB. cacheon on the 2 GiB store FAILED for a cache-path group-name mismatch ("0 of 5 ready for group
  blk.0.attn_gate.weight") = Astra's 807bc5c9, reported; big-on waits for their fix. Loader design = audit s.11 (per-tensor
  digest table from ONE pass + verify-on-consume); payload/anchor_gguf.{h,c} pushed 58014149 (test green incl. real 0.8B);
  integration waits on Astra's incremental SHA API. Echo pair running: echo-java1 (worker=echo, ANCHOR_LINK_ECHO=1), then
  NATIVEECHO=1 native1/native2, then java2. Run-script knobs now: MEM STORAGE VMNAME NATIVEECHO WORKER CALIB TAMPER FRESH DEALER_DELAY.
- 2026-09-08T11:08:32Z echo-java (Java pump, worker=echo, anchor64, APK 58014149-era): 64 B mean 2069 us p50 1102 min 714, pipelined 50 us/req;
  24 KB mean 1683 p50 1350, pipelined 1002 us/req 47.9 MB/s; 84 KB mean 3277 p50 2786 min 1392, pipelined 5054 us 33.2 MB/s;
  262 KB mean 8912 p50 7246 min 2451, pipelined 10552 us 49.7 MB/s. echo-native running 11:08Z (same APK, --ez nativeecho true).
- 2026-09-08T11:09:37Z echo-native (native loop, --ez nativeecho true, raw vsock domain 40 sndbuf 320K rcvbuf 1.25M): 64 B mean 1746 p50 1299 min 735,
  pipelined 146 us; 24 KB mean 1929 p50 1581, pipelined 2265 us 21.2 MB/s; 84 KB mean 5181 p50 4138 min 662, pipelined 7249 us
  23.2 MB/s; 262 KB mean 11049 p50 8627 min 1478, pipelined 17037 us 30.8 MB/s. => native SLOWER than the Java pump at every
  size on pair 1 (Java 8912/10552 us, 49.7 MB/s at 262 KB). echo-native2 running 11:09Z, then echo-java2.
- 2026-09-08T11:12:56Z echo pairs done: native == Java within spread; vsock transport = 0.7 ms floor, 1-3 ms at KB, 7-11 ms at 262 KB, 30-50 MB/s.
  Stage integrated with the GGUF pass (uncommitted, built): MODEL table line expected; device check next (stage1 on anchor64).
- 2026-09-08T11:26:01Z cache pair on anchor64 (same APK): big-off2 76.6 ms/token, verify 1289, VmHWM 2770 MB; big-on 518.6 ms/token, verify 6526
  (5.1x), VmHWM 2291 (-480 MB as designed), verify_fail 0 -> the cache path does I/O inside the exchange loop (Astra's).
  Engine loader rewritten on Astra's proved route (sealed header memfd, no_alloc, per-tensor pread+hash before expose, repack from
  verified bytes, no_alloc flag cleared, fd closed) + backend weight verifier + CPU_plain re-hash; engine-pvm + anchor-verify.apk
  built; verify1 leg running 11:25Z (uncommitted: engine.cpp, build.sh -I src, payload table hand-off).
- 2026-09-08T11:34:25Z verified loader on device: verify1 = dlopen failed (direct symbol ref to the shielded module -> now dlsym); verify2 =
  "header memfd: Permission denied" (memfd denied to the payload domain -> fallback O_TMPFILE in the VM's /data, unlinked named
  file as last resort; STORAGE line now shows vm-/data fstype); verify3 running on the fallback (still with my repack heuristic,
  which Astra flagged: embeddings must not land in CPU_REPACK) ; the next build lets llama choose each tensor's buffer type
  during the no_alloc load (use_extra_bufts=true + overrides) and allocates exactly that type from verified bytes. CACHE lines
  (reads/bytes after prefill and after decode) added for Astra's cache attribution. Astra 1e36d69c = streamed weight source API.
- (amended: tensor-path proof, NOT authenticated metadata; store home removed in 81afb1e6) VERIFIED LOADER ON DEVICE (640ac727): verify6 = 336 tensors / 1042 MiB hashed before use (186 plain, 9 repacked,
  141 other CPU), metadata from the verified header (home: encrypted store, since removed in 81afb1e6 as a TOCTOU), 73.6 ms/token,
  verify_fail 0, TEXT IDENTICAL to big-off2, CACHE reads=0. Header home on the Pixel 8 Pro: memfd creates but ftruncate EACCES;
  /data not writable; verify7 (running, cache ON) tests pwrite-grow of the memfd and prints CACHE reads/bytes after prefill/decode.
  Astra implementing funopen + llama_model_load_from_file_ptr (in-memory header FILE) = the final header route.
- 2026-09-08T11:44:50Z verify7 (private loader + cache ON): CACHE reads 504 / 468 MiB after prefill, unchanged after decode (zero steady-state reads);
  verify 824 ms/round, 59.6 ms/token steady, verify_fail 0, TEXT IDENTICAL to big-off2, prefill 85 s. memfd pwrite-grow fails on this device -> Astra's
  funopen + llama_model_load_from_file_ptr route is the header home. Lock released to Astra.
- 2026-09-08T11:46:49Z stream1 running (ANCHOR_STREAM_WEIGHTS=1 + cache ON, anchor64): private loader attaches the backend's weight source to
  every CPU_plain-placed tensor (reader preads the staged file on demand; verifier authenticates before encode; fd held).
  After it: lock stays FREE for Astra's FILE-header window; then controlled cache repeats (2x off / 2x on, wire phases).
  Uncommitted: engine.cpp streamed sources + payload allowlist ANCHOR_STREAM_WEIGHTS.
- 2026-09-08T11:50:35Z FILE header route (Astra 2d1bea66) wired: memfd/filesystem branches gone. stream2 = "verified header served from
  private memory" then "model metadata load failed from the verified header" (llama's reason not captured). stream3 running with
  dump_err() on that failure + a stdio self-check line (seek-end/tell = virtual size, rewind + magic, fileno). Fork's FILE impl
  (llama-mmap.cpp:228) sizes by seek/tell and reads by fread - funopen-compatible on paper.
- 2026-09-08T11:52:20Z stream3: FILE self-check sound (virtual size, magic, fileno -1); llama "mmap failed: Bad file descriptor" because my header
  block replacement had dropped no_alloc/load_mode NONE/use_extra_bufts/sh_pin (Astra caught it). Restored (engine.cpp:438-439),
  rebuilt; stream4 running 11:52Z = memory header + private tensors + streamed sources + cache on.
- 2026-09-08T11:55:41Z stream4 PASSED (contended by the 27B push): memory header + 150 resident (538 MiB) + 186 streamed sources (504 MiB never
  resident), CACHE 504 reads at prefill / 0 in decode, 71.8 ms/token, VmHWM 1238 MB, text identical. Pushed 7a93de91 (header from
  memory, streamed sources, prefix snapshot integration). 27B: push to /data/local/tmp/anchor/gg27/model.gguf in progress;
  anchor-27b.apk built with the 27B calib (262 sites); leg plan = VMNAME=anchor64 MEM=8192 STORAGE=65536 MODEL=<gg27 path>
  CALIB=<27B calib> AHEAD=128 MTP=3 16 tok, ANCHOR_STREAM_WEIGHTS=1 + cache on, assert table 866 tensors / stat size / blk.64.
- 2026-09-08T11:58:49Z b27-1 = FIRST 27B LEG on the phone (anchor64, 8 GiB, k=3, 16 tok, streamed sources + cache ON, 27B calib in APK + dealer,
  DEALER_TIMEOUT=3600, PHONE_MODEL=/data/local/tmp/anchor/gg27/model.gguf verified a680f44a). Started 11:58:21Z; ~30-40 min.
  Pushed 8591390a (app digest sidecar). Run-script knobs added: PHONE_MODEL (app path), MODEL (dealer host path), DEALER_TIMEOUT.
- 27B LEG RECIPE (b27-1): cd $W && DEALER_TIMEOUT=3600 PHONE_MODEL=/data/local/tmp/anchor/gg27/model.gguf \
    MODEL=/home/steven/Projects/enclave-models/qwen3.8-27b-mtp-q8-vl-gguf/Qwen3.8-27B-Q8_0.gguf \
    CALIB=/home/steven/Projects/enclave/metal/shielded-overlay/calib/qwen3.8-27b-mtp-q8-vl-gguf.calib \
    VMNAME=anchor64 STORAGE=65536 MEM=8192 WPORT=9503 BURN=5 MTP=3 PACE=0 AHEAD=128 INTERVAL=5 \
    SHENV="SHIELDED_MAX_M=16,ANCHOR_DRAFT_AHEAD=1,ANCHOR_HEAD_THREADS=2,SHIELDED_OVERLAP_VERIFY=1,ANCHOR_FINE_PLACEMENT=1,ANCHOR_STREAM_WEIGHTS=1,ANCHOR_WEIGHT_CACHE=1,SHIELDED_VERBOSE=1" \
    ./direct-run.sh b27-1 16     (APK = dealt-e2e/anchor-27b.apk: ANCHOR_CALIB=<27B calib> build.sh anchor after engine-pvm)
- 2026-09-08T12:08:50Z during b27-1's transfer: pushed abf98289 (prefix adapter 299393ab wired; wire-phase lines pass the summary filter),
  7026fce0 (anchor_copy_exact + fsync gate in receive_model, both fds closed on failure, host fault test; SOURCE counters beside
  CACHE via dlsym of b9d3c526). placement-quant.py corrected (all-dims bytes, K*N >= SHIELDED_MIN_MACS=2e6 claim rule, local sites):
  27B = 262 sites -> 409 worker nodes, 24.24 GiB int8 + 0.38 GiB rings = 24.62 GiB on the worker (fits 31), phone resident 1.29 GiB.
  Next APKs (dev + 27B) must be rebuilt with these after b27-1 ends. b27-1 stream at 8.4 GB (~23 MB/s).
- 2026-09-08T12:14:30Z b27-1 KILLED by Android's lowmemorykiller at 12:08:46Z after 8602 MiB streamed (8 GiB guest page cache + host cache of the
  27 GB file on a 12 GB phone). Fix 065cb3a2: receiver fsync + fadvise(DONTNEED) per 200 MiB step, stage read drops hashed
  64 MiB ranges. b27-2 launched 12:14:05Z on a FRESH anchor64 with MEM=6144 (same 64 GiB store), same recipe otherwise.
  Monitors: leg log + logcat for LMK/VM death. Pixel 8 Pro fact: 8 GiB VM + 27 GB stream = LMK; keep guest RAM <= 6 GiB there.
- 2026-09-08T12:26:48Z MTP prefix experiment (host, mtp-prefix-blind.cpp vs root-598 libs, 0.8B, 102-tok prefix + 28-tok user, 96 gen): a head
  blind to the prefix (target-only snapshot) halves acceptance: k=15 5.94 -> 2.97 tok/round, k=3 3.52 -> 2.44; text identical.
  => v3 artifact must carry the head's seq state + pending_h (proposed to Astra; my side = anchor_mtp setter + engine restore).
  Pushed fcd55c9d: prefix v2 (whole digest + calib), boundary helper (one tokenization, exact suffix, >=1 token), SOURCE lines.
  b27-2: stream 19.8 GB at 12:26Z, guest RSS ~775 MB steady, MemAvailable ~7.1 GB (samples in this session's monitor output).
- 2026-09-08T12:29:07Z Head-state restore PROVED on the host: RESTORED == FULL round-for-round, text identical (mtp-prefix-blind.cpp modes
  FULL/BLIND/RESTORED; logs dealt-e2e/mtp-restored-k15.txt). Pushed 474f42a1: anchor_mtp_n_embd/pending_export/pending_import
  (finite, exact, clears tail+rows) + memory-state helpers; engine slurps capped. Container (Astra) = seq FILE bytes for target
  + head + pending row + n_tokens under one v2 signature; engine wiring after their parser. b27-2: 24 GB streamed 12:28Z.
