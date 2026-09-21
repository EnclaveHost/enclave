# LPN-structured pads: measured against the handoff

Status: reference implementation, selector and benchmarks DONE (2026-09-20); nothing
in the engine changed. Every number below is measured on this box unless it says
"derived" or "handoff". Companion: [README.md](README.md) for what each file is,
[lpnpad.py](lpnpad.py) for the construction, [lpn_select.py](lpn_select.py) for
the parameter choice, `results/` for the raw data.

## 0. The answer in five lines

1. The construction works: `u = (W.A).s + W.e` unblinds exactly, bit for bit, across a
   full forward pass in `Z_2^32`, `Z_2^24` and the tier's own `Z_M`, with fresh `(s, e)`
   per pad and Freivalds over the integers (103 assertions, `test_lpnpad.py`).
2. Against an UNBATCHED uniform refill at decode (`B = 1`) it delivers what the byte
   model predicts: **1.4-1.6x at n = 4096, 1.5-3.3x on the 27B's layers, 3.6x at n = 16384**,
   both paths pinned at the same 60-75 GB/s (8 threads, one CCD, W.A evicted between pads).
3. Against the refill the engine actually runs, which mints **4 pads per pass over W**,
   the advantage mostly disappears: the uniform path's bytes per pad fall as `1/B`, the
   LPN gather's do not. Measured per 27B token, 8 threads: uniform 357 -> 126 ms going
   from B = 1 to B = 4; LPN 172 -> 114. Per token that is 2.1x at B = 1, 1.1x at B = 4,
   1.2x at B = 8: within noise on the attention-width layers, 1.25-1.4x on gate|up,
   down and lm_head.
4. LPN's real advantage is a FLOP advantage, and it shows only where refill is
   compute-bound: 1.6x per 27B token at a 16-deep refill, 3.1x on one layer at B = 64,
   between kernels of the same instruction class. The engine's uniform refill is int8
   VNNI, which the LPN gather cannot be, so in the engine's arithmetic that advantage
   shrinks again (section 5.7).
5. Three things in the handoff were wrong or missing, and each changes the numbers:
   the cost of computing `r = A.s` itself (omitted; a dense ring-width A costs as many
   bytes as W.A and cut the 16384 speedup from 3.6x to 2.4x), the byte-optimal split
   (a spurious square root; the true optimum equalises the two byte terms), and the
   claim that batching helps LPN "twice" (it helps the uniform baseline more).
   Two it had right that this work first mis-read: W.A resident in L3 really is 3-5x
   cheaper to read, and a 16-bit ring really is a large win (6.0x vs 3.7x at the best
   k) -- but the first is reachable only by batching, which already amortises W.A,
   and the second is unusable for this tier's numerics (section 8).

Recommendation: do NOT integrate this into the engine for the CVM tier as it stands.
The measured payoff against the batch-4 VNNI refill is ~1.0-1.3x on the 27B's mix of
layers, for a second copy of the weights in the enclave (or a layout change to the
refill path), a new pad derivation on the dealer, and an unreviewed hardness
assumption over a ring. Where it WOULD pay is stated in section 7.

## 1. What was built

| file | what |
|---|---|
| `lpnpad.py` | `Ring` (Z_2^b wrapping; Z_M for the tier), `UniformPads`, `LPNPads` (random or regular noise; dense / dense8 / Toeplitz public matrix), `Freivalds` over the integers mod 2^31-1, `Host`, `MaskedLinear`, `ToyTransformer` |
| `lpn_select.py` | `select(n, m, ring_bits, weight_bits, batch, sec, ...)` -> `(k, t)` or `mode="plain"`; byte objective at B = 1, time = max(bytes/bw, flops/rate) otherwise; Prange bits reported; `--table` for this tier's shapes |
| `test_lpnpad.py` | 103 assertions: exactness across generation in three rings x three pad sources x three A layouts, exactness at n = m = 4096 with the selector's own (k, t) at B = 1 and 16, Freivalds catches a +1 lie, a +2^(b-1) lie and a ring wrap, pads distinct and F_2-independent, noise structure, transcript uniformity, selector properties |
| `bench_pads.c` | AVX-512 kernels: `plain` (u = W.r), `wa` (W.A).s, `gather` (W.e, per-pad and union strategies), `a_s` (dense/dense8/toeplitz), `lpn` (all four as one region); threads split output columns; `--layers L` cycles L weight copies to defeat the cache; LPN checked against plain bit for bit before timing |
| `bench_pads.py` | the sweep and the per-token roll-up; writes `results/*.json` and Markdown |

Two details the handoff left implicit, both implemented and both load-bearing:

- **Noise values are units.** Reducing `r = A.s + e` mod 2 gives an F_2-LPN instance
  whose noise is `e mod 2`. With arbitrary noise values half of `e` vanishes mod 2 and
  the F_2 instance has weight ~t/2: the parameters buy half the security they were
  chosen for. Odd values (units of Z_M for the tier) keep the weight at t. The reverse
  direction is the one that matters for sizing: once the F_2 instance is solved the
  support is known and every higher bit is linear algebra on the noise-free
  coordinates, so the Z_2^b instance is AT MOST as hard as F_2-LPN(n, k, t).
- **Computing r costs n.k multiplies.** `A.s` is not in the handoff's accounting. Three
  layouts were built so it could be measured instead of argued: dense A at ring width
  (the handoff's A, `n.k.b/8` bytes), dense A with byte entries, and Toeplitz A
  (`n + k - 1` ring elements; the product is a correlation, no bandwidth). All three
  reduce mod 2 to a uniform F_2 matrix; Toeplitz-LPN is a studied variant (HB#,
  Jain-Krenn-Pietrzak-Tentes) but a distinct assumption and is flagged in section 8.

## 2. Test hardware, and what "consumer" means here

EPYC 9115, 16 cores / 32 threads, Zen 5, AVX-512 VNNI, two CCDs of 8 cores with
**32 MB L3 each**; 124 GB DDR5. Measured DRAM read bandwidth: 33 GB/s on one thread,
**68 GB/s on 8 threads of one CCD, 119 GB/s on 16**. All pad benchmarks pin 8 threads
to one CCD (`OMP_PLACES=cores OMP_PROC_BIND=close`), which is the shape of a consumer
part (8 cores, ~70 GB/s, 32 MB L3) and of a CVM slice. RTX 3070 for the engine
loopback. The box was idle; every figure is a median of 7 runs after a warm-up.

## 3. Correctness (deliverable 1)

`python3 test_lpnpad.py`: 103 assertions in ~25 s. The forward-pass test generates
four tokens greedily from a three-token prompt through a two-layer integer
transformer whose five linears per layer (qkv, o, gate|up, down, lm_head) are
`MaskedLinear`s; the batch grows every step, so B = 3..6 pads are drawn per layer per
step and the B = 1 and B > 1 paths both run. The 36 recovered products and the token
stream must equal the plain in-TEE run exactly, and they do, for every ring in
{Z_2^32, Z_2^24, Z_14457349} x {uniform, lpn, regular-lpn} x {dense, dense8, toeplitz}.
At n = m = 4096 with the selector's own (k, t) the recovered W.x is exact at B = 1 and
B = 16 in both rings. Freivalds over the integers catches a one-entry lie, a
half-ring lie (which a mod-ring check misses half the time) and a product that
wrapped the ring; 30 pads of one layer are distinct and have full rank over F_2. The C
kernels re-check `u_lpn == W.(A.s + e)` on every invocation before timing.

## 4. The selector (deliverable 2), and two corrections to the handoff

`python3 lpn_select.py --n 16384 --m 16384 --ring 32 --wbits 4` returns k = 423,
t = 3486, ratio 0.42 -- not the handoff's k ~ 720, t ~ 2040, ratio ~0.48. The
handoff's section 3.3 minimises `k.(b/8) + t.(w/8)` subject to `k.t = C` and states
the optimum as `k/t = sqrt(0.5/(b/8))`. There is no square root: the Lagrangian gives
`k/t = (w/8)/(b/8) = w/b`, i.e. **the two byte terms are equal at the optimum**. The
consequences are small but real: the 32-bit/4-bit example is 2.4x, not 2.1x, and the
16-bit one 3.4x, not 3.2x. `test_lpnpad.py` asserts the equal-terms property.

Section 3.2's "FLOP-optimal split is symmetric, k = t" is also not right once `A.s`
is counted: on a square layer the multiplies are `(2k + t).m`, so `t = 2k`. The
selector's `--objective flops` returns k = 846, t = 1743 at n = 16384.

Section 3.4's fallback is implemented and it bites earlier than the handoff says:
with 8-bit weights (this tier reads its int8 field encoding, not 4-bit) and a dense
A, n = 896 is plain (ratio 2.1), n = 4096 is 0.84, and only from n ~ 5000 up does the
LPN path win at B = 1. `--table` prints every layer of the 27B / 9B / 0.5B.

The time model `max(bytes/68 GB/s, flops/250 GMAC/s)` uses this box's measured
8-thread constants; only their ratio matters (where bytes stop binding: B ~ 4 here)
and another box should pass its own. The batched gather cost follows the kernel that
wins (per pad, `B.t` rows) rather than the union kernel that reads fewer bytes but
lost at every B measured.

## 5. Benchmarks (deliverable 3)

### 5.1 Every layer of the models this tier serves, cold, 8 threads

Cold: the driver allocates enough copies of (W, W.A, A) to exceed 4x the box's L3 and
cycles them, so a pad of layer i never finds layer i's W.A in cache. That is the
per-token truth (a token visits every layer once). (k, t) are the selector's for each
B; 32-bit ring, Toeplitz A, regular noise, `sec = 90`.

| layer | n | m | B | k | t | plain us/pad | lpn us/pad | speedup | bytes ratio | plain GB/s | lpn GB/s |
|---|---|---|---|---|---|---|---|---|---|---|---|
| spec-4096 | 4096 | 4096 | 1 | 299 | 1233 | 256 | 159 | 1.61x | 0.59 | 66 | 63 |
| spec-4096 | 4096 | 4096 | 4 | 588 | 627 | 74 | 79 | 0.94x | 1.19 | 56 | 63 |
| spec-4096 | 4096 | 4096 | 8 | 836 | 441 | 61 | 59 | 1.03x | 1.68 | 34 | 60 |
| spec-16384 | 16384 | 16384 | 1 | 597 | 2470 | 3774 | 1045 | 3.61x | 0.30 | 71 | 76 |
| spec-16384 | 16384 | 16384 | 4 | 1194 | 1235 | 969 | 628 | 1.54x | 0.59 | 69 | 63 |
| spec-16384 | 16384 | 16384 | 8 | 1693 | 871 | 955 | 527 | 1.81x | 0.84 | 35 | 53 |
| qwen3.8-27b/attn_qkv | 5120 | 10240 | 1 | 332 | 1388 | 587 | 390 | 1.50x | 0.53 | 89 | 71 |
| qwen3.8-27b/attn_qkv | 5120 | 10240 | 4 | 664 | 694 | 208 | 201 | 1.04x | 1.06 | 63 | 69 |
| qwen3.8-27b/attn_qkv | 5120 | 10240 | 8 | 960 | 480 | 153 | 152 | 1.01x | 1.50 | 43 | 65 |
| qwen3.8-27b/attn_gate | 5120 | 6144 | 1 | 332 | 1388 | 499 | 269 | 1.85x | 0.53 | 63 | 62 |
| qwen3.8-27b/attn_gate | 5120 | 6144 | 4 | 664 | 694 | 134 | 125 | 1.07x | 1.06 | 59 | 67 |
| qwen3.8-27b/attn_gate | 5120 | 6144 | 8 | 960 | 480 | 83 | 103 | 0.81x | 1.50 | 48 | 57 |
| qwen3.8-27b/ssm_out | 6144 | 5120 | 1 | 365 | 1515 | 520 | 269 | 1.93x | 0.49 | 60 | 57 |
| qwen3.8-27b/ssm_out | 6144 | 5120 | 4 | 720 | 768 | 144 | 127 | 1.14x | 0.97 | 54 | 60 |
| qwen3.8-27b/ssm_out | 6144 | 5120 | 8 | 1024 | 540 | 99 | 95 | 1.05x | 1.37 | 40 | 57 |
| qwen3.8-27b/ffn_gate|up | 5120 | 34816 | 1 | 332 | 1388 | 2408 | 1245 | 1.94x | 0.53 | 74 | 76 |
| qwen3.8-27b/ffn_gate|up | 5120 | 34816 | 4 | 664 | 694 | 962 | 712 | 1.35x | 0.96 | 46 | 60 |
| qwen3.8-27b/ffn_gate|up | 5120 | 34816 | 8 | 960 | 480 | 654 | 522 | 1.25x | 1.50 | 34 | 64 |
| qwen3.8-27b/ffn_down | 17408 | 5120 | 1 | 620 | 2527 | 1306 | 402 | 3.25x | 0.29 | 68 | 64 |
| qwen3.8-27b/ffn_down | 17408 | 5120 | 4 | 1224 | 1280 | 421 | 260 | 1.62x | 0.58 | 53 | 49 |
| qwen3.8-27b/ffn_down | 17408 | 5120 | 8 | 1343 | 1167 | 288 | 210 | 1.37x | 0.85 | 39 | 45 |
| qwen3.8-27b/lm_head | 5120 | 248320 | 1 | 332 | 1388 | 20992 | 10362 | 2.03x | 0.53 | 61 | 65 |
| qwen3.8-27b/lm_head | 5120 | 248320 | 4 | 664 | 694 | 6732 | 5148 | 1.31x | 0.96 | 47 | 59 |
| qwen3.8-27b/lm_head | 5120 | 248320 | 8 | 960 | 480 | 4681 | 3686 | 1.27x | 1.29 | 34 | 56 |
| qwen3.5-9b/attn_qkv | 4096 | 8192 | 1 | 299 | 1233 | 497 | 307 | 1.62x | 0.59 | 67 | 65 |
| qwen3.5-9b/attn_qkv | 4096 | 8192 | 4 | 588 | 627 | 134 | 140 | 0.96x | 1.19 | 63 | 71 |
| qwen3.5-9b/attn_qkv | 4096 | 8192 | 8 | 836 | 441 | 80 | 103 | 0.78x | 1.68 | 53 | 69 |
| qwen3.5-9b/attn_gate | 4096 | 4096 | 1 | 299 | 1233 | 259 | 160 | 1.62x | 0.59 | 65 | 62 |
| qwen3.5-9b/attn_gate | 4096 | 4096 | 4 | 588 | 627 | 75 | 79 | 0.95x | 1.19 | 56 | 63 |
| qwen3.5-9b/attn_gate | 4096 | 4096 | 8 | 836 | 441 | 61 | 59 | 1.05x | 1.68 | 34 | 60 |
| qwen3.5-9b/ssm_out | 4096 | 4096 | 1 | 299 | 1233 | 265 | 157 | 1.69x | 0.59 | 63 | 63 |
| qwen3.5-9b/ssm_out | 4096 | 4096 | 4 | 588 | 627 | 78 | 78 | 0.99x | 1.19 | 54 | 64 |
| qwen3.5-9b/ssm_out | 4096 | 4096 | 8 | 836 | 441 | 61 | 59 | 1.03x | 1.68 | 34 | 59 |
| qwen3.5-9b/ffn_gate|up | 4096 | 24576 | 1 | 299 | 1233 | 1386 | 832 | 1.67x | 0.59 | 73 | 72 |
| qwen3.5-9b/ffn_gate|up | 4096 | 24576 | 4 | 588 | 627 | 550 | 416 | 1.32x | 1.19 | 46 | 72 |
| qwen3.5-9b/ffn_gate|up | 4096 | 24576 | 8 | 836 | 441 | 346 | 315 | 1.10x | 1.68 | 36 | 67 |
| qwen3.5-9b/ffn_down | 12288 | 4096 | 1 | 518 | 2135 | 626 | 276 | 2.27x | 0.34 | 80 | 63 |
| qwen3.5-9b/ffn_down | 12288 | 4096 | 4 | 1024 | 1080 | 212 | 164 | 1.29x | 0.69 | 59 | 53 |
| qwen3.5-9b/ffn_down | 12288 | 4096 | 8 | 1233 | 897 | 184 | 136 | 1.35x | 0.99 | 34 | 45 |
| qwen3.5-9b/lm_head | 4096 | 248320 | 1 | 299 | 1233 | 16788 | 9283 | 1.81x | 0.59 | 61 | 65 |
| qwen3.5-9b/lm_head | 4096 | 248320 | 4 | 588 | 627 | 5306 | 4618 | 1.15x | 1.06 | 48 | 58 |
| qwen3.5-9b/lm_head | 4096 | 248320 | 8 | 836 | 441 | 3635 | 3285 | 1.11x | 1.41 | 35 | 55 |
| qwen2.5-0.5b/attn_q | 896 | 896 | 1 | 180 | 448 | 12 | 11 | 1.04x | 1.31 | 70 | 95 |
| qwen2.5-0.5b/attn_q | 896 | 896 | 4 | 280 | 288 | 3 | 4 | 0.65x | 2.54 | 73 | 120 |
| qwen2.5-0.5b/attn_q | 896 | 896 | 8 | 384 | 210 | 3 | 4 | 0.79x | 3.60 | 35 | 98 |
| qwen2.5-0.5b/attn_kv | 896 | 256 | 1 | 180 | 448 | 6 | 7 | 0.90x | 1.32 | 37 | 44 |
| qwen2.5-0.5b/attn_kv | 896 | 256 | 4 | 280 | 288 | 2 | 3 | 0.60x | 2.56 | 32 | 49 |
| qwen2.5-0.5b/attn_kv | 896 | 256 | 8 | 300 | 269 | 1 | 2 | 0.54x | 3.76 | 24 | 49 |
| qwen2.5-0.5b/attn_o | 896 | 896 | 1 | 180 | 448 | 12 | 11 | 1.05x | 1.31 | 69 | 95 |
| qwen2.5-0.5b/attn_o | 896 | 896 | 4 | 280 | 288 | 3 | 5 | 0.57x | 2.54 | 74 | 108 |
| qwen2.5-0.5b/attn_o | 896 | 896 | 8 | 384 | 210 | 2 | 4 | 0.52x | 3.60 | 49 | 93 |
| qwen2.5-0.5b/ffn_gate|up | 896 | 9728 | 1 | 180 | 448 | 121 | 137 | 0.88x | 1.30 | 72 | 83 |
| qwen2.5-0.5b/ffn_gate|up | 896 | 9728 | 4 | 280 | 288 | 38 | 61 | 0.61x | 2.54 | 58 | 90 |
| qwen2.5-0.5b/ffn_gate|up | 896 | 9728 | 8 | 384 | 210 | 25 | 45 | 0.55x | 3.59 | 44 | 87 |
| qwen2.5-0.5b/ffn_down | 4864 | 896 | 1 | 325 | 1347 | 82 | 39 | 2.08x | 0.55 | 53 | 61 |
| qwen2.5-0.5b/ffn_down | 4864 | 896 | 4 | 640 | 684 | 25 | 26 | 0.95x | 1.09 | 44 | 46 |
| qwen2.5-0.5b/ffn_down | 4864 | 896 | 8 | 527 | 831 | 16 | 18 | 0.88x | 1.81 | 35 | 55 |
| qwen2.5-0.5b/lm_head | 896 | 151936 | 1 | 180 | 448 | 2114 | 2564 | 0.82x | 1.30 | 64 | 69 |
| qwen2.5-0.5b/lm_head | 896 | 151936 | 4 | 280 | 288 | 669 | 1131 | 0.59x | 2.03 | 51 | 61 |
| qwen2.5-0.5b/lm_head | 896 | 151936 | 8 | 384 | 210 | 374 | 799 | 0.47x | 2.59 | 46 | 55 |

Reading it: at B = 1 both columns run at 55-75 GB/s, so the speedup IS the byte ratio
(1.5-1.9x on the 27B's 5120-wide layers, 3.25x on its 17408-wide `ffn_down`, 3.6x at
16384); the model is right where it is bandwidth-bound. At B = 4 and 8 the uniform
kernel reads W once per batch and the LPN gather still reads `t` rows per pad: the
byte ratio crosses 1 on every 4096-6144-wide layer (0.8-1.1x measured) and LPN keeps
1.25-1.6x only on gate|up, down and lm_head. The 0.5B is plain almost everywhere, as
the selector says, and where the table still shows an LPN run at n = 896 it is the
selector's best LPN point being run anyway, to show what it would have cost.

### 5.2 Per token (deliverable 3's tokens/sec, as a refill-bound ceiling)

Sum over the model's layers of the measured per-pad cost, times the block count. The
ceiling is what tokens/sec would be if pad generation were the ONLY cost, on 8
threads; it is the number to set against the engine's measured token time.

| model | B | uniform ms/token | lpn ms/token | speedup | uniform ceiling tok/s | lpn ceiling tok/s | lpn layers on plain |
|---|---|---|---|---|---|---|---|
| qwen3.8-27b | 1 | 360.0 | 172.4 | 2.09x | 2.8 | 5.8 | 0 |
| qwen3.8-27b | 4 | 126.5 | 114.1 | 1.11x | 7.9 | 8.8 | 4 |
| qwen3.8-27b | 8 | 87.5 | 72.8 | 1.20x | 11.4 | 13.7 | 0 |
| qwen3.8-27b | 16 | 92.5 | 58.5 | 1.58x | 10.8 | 17.1 | 0 |
| qwen3.5-9b | 1 | 111.9 | 64.5 | 1.73x | 8.9 | 15.5 | 0 |
| qwen3.5-9b | 4 | 38.5 | 37.0 | 1.04x | 26.0 | 27.0 | 5 |
| qwen3.5-9b | 8 | 27.5 | 24.8 | 1.11x | 36.4 | 40.3 | 0 |
| qwen3.5-9b | 16 | 29.1 | 20.2 | 1.44x | 34.4 | 49.4 | 0 |
| qwen2.5-0.5b | 1 | 7.9 | 6.6 | 1.19x | 126.5 | 150.4 | 5 |
| qwen2.5-0.5b | 4 | 2.4 | 2.4 | 1.00x | 420.4 | 420.4 | 6 |
| qwen2.5-0.5b | 8 | 1.5 | 1.6 | 0.98x | 645.7 | 631.2 | 5 |
| qwen2.5-0.5b | 16 | 1.2 | 1.2 | 0.97x | 856.9 | 832.2 | 5 |

Set against the engine (section 6): a 27B token on the production tier is ~250 ms
(4 tok/s), of which refill is none of the critical path -- it runs on background
threads. So single-stream tokens/sec does not move with the pad scheme at all; what
moves is the CPU the refill burns per token, 8 threads times the ms above: 1.01
core-seconds per token with the batch-4 uniform refill against 0.91 with LPN at B = 4
(1.1x); 0.70 against 0.58 at B = 8 (1.2x); 0.74 against 0.47 at B = 16 (1.6x, with the
VNNI caveat of 5.7). At 4 tok/s that is four cores busy on pads either way. The
memory-bandwidth floor for the uniform refill's bytes at B = 4 on one CCD is 77 ms per
token; this bench's u32 kernel reaches 126, the engine's VNNI refill sits between.

### 5.3 The k sweep (handoff section 4.3), n = m = 16384

Fixed `k.t = 90n`. "wa us hot" is W.A read back to back with nothing else touching
the cache: the L3-resident case the handoff hypothesises, and the only way to see
it, since one pass over W between two pads evicts a 33 MB W.A.

| ring | k | t | WA MB | plain us | lpn us (cold) | speedup (cold) | wa us cold | wa us hot (L3) | lpn us if W.A hot | speedup if hot | gather us | a_s us |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 32 | 128 | 11520 | 8.4 | 3739 | 2783 | 1.34x | 116 | 24 | 2691 | 1.39x | 2650 | 8 |
| 32 | 192 | 7680 | 12.6 | 3759 | 1984 | 1.90x | 174 | 39 | 1849 | 2.03x | 1795 | 11 |
| 32 | 256 | 5760 | 16.8 | 3767 | 1599 | 2.35x | 230 | 55 | 1424 | 2.65x | 1366 | 14 |
| 32 | 384 | 3840 | 25.2 | 3718 | 1244 | 2.99x | 336 | 79 | 987 | 3.77x | 911 | 20 |
| 32 | 512 | 2880 | 33.6 | 3742 | 1048 | 3.57x | 447 | 127 | 728 | 5.14x | 668 | 26 |
| 32 | 768 | 1920 | 50.3 | 3761 | 1024 | 3.67x | 657 | 318 | 686 | 5.48x | 457 | 38 |
| 32 | 1024 | 1440 | 67.1 | 3754 | 1187 | 3.16x | 893 | 588 | 883 | 4.25x | 351 | 50 |
| 32 | 1536 | 960 | 100.7 | 3739 | 1571 | 2.38x | 1316 | 1096 | 1351 | 2.77x | 240 | 73 |
| 32 | 2048 | 720 | 134.2 | 3721 | 2018 | 1.84x | 1797 | 1609 | 1830 | 2.03x | 186 | 97 |
| 16 | 128 | 11520 | 4.2 | 3725 | 2689 | 1.39x | 64 | 9 | 2634 | 1.41x | 2612 | 5 |
| 16 | 192 | 7680 | 6.3 | 3716 | 1861 | 2.00x | 93 | 17 | 1785 | 2.08x | 1767 | 7 |
| 16 | 256 | 5760 | 8.4 | 3722 | 1447 | 2.57x | 121 | 22 | 1348 | 2.76x | 1322 | 8 |
| 16 | 384 | 3840 | 12.6 | 3718 | 960 | 3.87x | 177 | 34 | 817 | 4.55x | 867 | 11 |
| 16 | 512 | 2880 | 16.8 | 3711 | 744 | 4.99x | 234 | 56 | 566 | 6.56x | 647 | 14 |
| 16 | 768 | 1920 | 25.2 | 3700 | 619 | 5.98x | 348 | 80 | 350 | 10.56x | 449 | 20 |
| 16 | 1024 | 1440 | 33.6 | 3723 | 672 | 5.54x | 465 | 108 | 315 | 11.80x | 342 | 25 |
| 16 | 1536 | 960 | 50.3 | 3703 | 849 | 4.36x | 692 | 334 | 491 | 7.54x | 231 | 37 |
| 16 | 2048 | 720 | 67.1 | 3700 | 1043 | 3.55x | 922 | 616 | 738 | 5.02x | 180 | 50 |

Three findings. The cold optimum is broad (k = 512-1024 within 15% of the best, 3.7x)
and sits where the selector puts it (k = 597). L3 residency is real: with W.A hot the
dense term is 3-5x cheaper up to the 33 MB that fits one CCD's L3 (k = 512 at 32 bits:
127 us against 447), and the whole pad would be 5.1-5.5x rather than 3.6x -- the
handoff's section 4.3 mechanism, confirmed. What it does not confirm is the reach: a
token visits 64 layers, whose W.A total gigabytes, so at B = 1 W.A is cold every time;
the only way to read it hot is to mint several pads of one layer back to back, and
that is batching, where the W.A read is already divided by B. Trading k for t to fit
L3 at B = 1 (k = 256) loses outright because the gather then dominates. And the 16-bit
rows are a genuine 1.65x over 32-bit at the best k (619 vs 1024 us; 6.0x over plain):
the W.A term halves AND the optimum moves to a larger k where the gather is smaller.
That is the "single largest bandwidth win" of section 4.2, measured -- and section 8
says why this tier cannot take it. The tier's 24-bit width was not measured (no
3-byte kernel here); it sits between.

### 5.4 The public matrix: the term the handoff did not count

| shape | A | k | t | a_s us | a_s bytes MB | lpn us | plain us | speedup | selector ratio |
|---|---|---|---|---|---|---|---|---|---|
| spec-4096 | dense | 212 | 1739 | 60 | 3.5 | 231 | 263 | 1.14x | 0.84 |
| spec-4096 | dense8 | 266 | 1386 | 21 | 1.1 | 177 | 260 | 1.47x | 0.66 |
| spec-4096 | toeplitz | 299 | 1233 | 5 | 0.0 | 162 | 263 | 1.63x | 0.59 |
| spec-16384 | dense | 423 | 3486 | 436 | 27.7 | 1594 | 3750 | 2.35x | 0.42 |
| spec-16384 | dense8 | 537 | 2746 | 143 | 8.8 | 1102 | 3669 | 3.33x | 0.33 |
| spec-16384 | toeplitz | 597 | 2470 | 32 | 0.1 | 1047 | 3749 | 3.58x | 0.30 |
| 27b-gate|up | dense | 320 | 1440 | 104 | 6.6 | 1361 | 2409 | 1.77x | 0.57 |
| 27b-gate|up | dense8 | 332 | 1388 | 30 | 1.7 | 1284 | 2407 | 1.88x | 0.54 |
| 27b-gate|up | toeplitz | 332 | 1388 | 7 | 0.0 | 1244 | 2418 | 1.94x | 0.53 |

A dense A at ring width is a quarter of the LPN time at n = 16384 (436 of 1594 us)
and takes the speedup from 3.6x to 2.4x; byte entries recover most of it; Toeplitz
recovers all of it (32 us, compute only). The reference implements all three; the
selector charges each its bytes.

### 5.5 Regular vs random noise (handoff section 4.4)

| shape | B | noise | rows read | gather us | lpn us | speedup |
|---|---|---|---|---|---|---|
| spec-16384 | 1 | regular | 2470 / 16384 | 580 | 1042 | 3.58x |
| spec-16384 | 1 | random | 2470 / 16384 | 631 | 1046 | 3.58x |
| spec-16384 | 8 | regular | 6968 / 16384 | 1661 | 4245 | 1.86x |
| spec-16384 | 8 | random | 6968 / 16384 | 1693 | 4189 | 1.85x |
| 27b-down | 1 | regular | 2527 / 17408 | 203 | 407 | 3.38x |
| 27b-down | 1 | random | 2527 / 17408 | 240 | 403 | 3.35x |
| 27b-down | 8 | regular | 9336 / 17408 | 739 | 1709 | 1.36x |
| 27b-down | 8 | random | 9336 / 17408 | 742 | 1711 | 1.38x |

No measurable difference. The handoff expected regular positions to matter
"substantially for cache behavior"; they would in the GGUF (output-major) layout,
where a column of W is a strided byte per row, but the TEE copy here is input-major
so every gathered column is one contiguous 16-35 KB row, and where in the row order
it sits is irrelevant. Regular LPN is kept as the default for its security literature,
not for speed.

### 5.6 Threads, 27B gate|up (5120 x 34816), B = 1

| threads | k | t | plain us | plain GB/s | lpn us | lpn GB/s | speedup | wa us | gather us | a_s us |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 332 | 1388 | 5809 | 31 | 2449 | 39 | 2.37x | 1047 | 1391 | 41 |
| 2 | 332 | 1388 | 3443 | 52 | 1568 | 60 | 2.20x | 731 | 814 | 21 |
| 4 | 332 | 1388 | 2641 | 67 | 1302 | 73 | 2.03x | 671 | 660 | 11 |
| 8 | 332 | 1388 | 2413 | 74 | 1236 | 77 | 1.95x | 642 | 699 | 7 |
| 16 | 332 | 1388 | 1637 | 109 | 695 | 136 | 2.36x | 412 | 398 | 7 |

Bandwidth-bound at every count (plain 31 -> 109 GB/s from 1 to 16 threads). The
speedup is 2.4x on one thread and 2.0-2.4x on eight or sixteen.

### 5.7 Batch, 27B gate|up, batch-aware (k, t)

| B | objective | k | t | plain us/pad | lpn us/pad | speedup | rows read (gather) | plain GMAC/s | lpn GMAC/s |
|---|---|---|---|---|---|---|---|---|---|
| 1 | bytes | 332 | 1388 | 2389 | 1243 | 1.92x | 1388 (perpad) | 75 | 50 |
| 4 | time | 664 | 694 | 958 | 699 | 1.37x | 2258 (union) | 186 | 73 |
| 8 | time | 960 | 480 | 675 | 525 | 1.28x | 3840 (perpad) | 264 | 105 |
| 16 | time | 1328 | 347 | 642 | 389 | 1.65x | 3442 (union) | 278 | 167 |
| 64 | time | 1204 | 383 | 787 | 257 | 3.06x | 5081 (union) | 227 | 239 |

This is the row the handoff's section 4.1 is about, and the sign is the other way. The
uniform kernel goes from 75 GB/s bandwidth-bound at B = 1 to 230-280 GMAC/s
compute-bound at B >= 8; its cost per pad falls 3.5x from B = 1 to B = 8. The LPN pad's
falls 2.4x, because the gather is per pad. LPN wins again only once both are
compute-bound (B = 16-64), where its FLOP ratio (~0.3) is what counts and it reaches
1.65-3.1x. Two caveats on that regime. In the engine, B here is the pool's refill batch
per group, not the rows per exchange, so a 16-deep refill is a memory question (pads
are `(K + u_len) x 4` bytes each; 16 per group on the 27B is ~0.7 GB). And the
comparison is between kernels of the same instruction class (`vpmulld`, 16 int32
multiplies per instruction). The engine's uniform refill runs on residue planes with
`vpdpbusd` (64 int8 multiplies per instruction, 3 per field multiply) at a measured
~250 G field-MAC/s per core; the LPN dense term can take the same form in Z_M, but the
gather multiplies a 24-bit scalar into int8 weights and cannot. So in the engine's
arithmetic the compute-bound LPN pad keeps its 0.3x multiply count but pays ~4x per
multiply on the gather half, which is roughly a wash at B = 16 and a modest win at 64.

## 6. Engine baselines (deliverable 3's two baselines)

Qwen2.5-0.5B q8_0, host loopback, RTX 3070 worker, 8 threads, 64 tokens, medians of 3:

| backend | decode tok/s (3 runs) | ms/token | exchanges / 64 tok | pads used / missed / waited | verify fail |
|---|---|---|---|---|---|
| shielded, uniform pads, RTX 3070 loopback | 200.8 / 188.2 / 192.2 | 5.2 | 3139 (4676 nodes) | 3139 / 0 / 0, refill on path 0.0 ms, 5 refill threads | 0 |
| the same engine, CPU in the enclave | 128.5 / 120.2 / 116.0 | 8.3 | - | - | - |

Shielded is 1.6x the same engine's CPU decode on this model, with refill entirely
off the request path (pads never waited). Plain llama.cpp (a CPU-only build from July,
not the ELL engine) for scale, 8 threads: 0.5B q8_0 decodes at 120 tok/s; the 27B
UD-Q4_K_XL at 3.7 tok/s, and 5.6 on 16 threads (`results/llama-bench-*.json`).
Batched: `bench-batch`'s binary is skewed against the current CPU backend (it aborts
on an unknown op), so the batched engine baseline is the tier's measured
rows-per-exchange sweep of 2026-09-14 (0.5B, RTX 3070, 8 threads): m = 1: 8.8 ms/step
(114 tok/s), m = 4: 14.0 (285), m = 8: 25.1 (319), m = 16: 42.7 (375), m = 64: 163.5
(391 tok/s-equivalent), exchange count flat across the sweep. Production reference
for the 27B on the shielded tier (2026-09-14, two V100s, in the CVM): ~4 tok/s at
250 ms/token, 43% wire, 7% card, 50% enclave CPU, pads waited 0.

The LPN variant was not run in the engine (section 7 says what that takes), so its
single-stream tokens/sec is the same as the uniform row by construction -- refill is
off the critical path in both -- and its batched behaviour is section 5.7's, which is
per-pad CPU cost, not step time.

## 7. What integrating it would take, and when it would pay

Where it plugs in: `shielded-tee.c`'s `generate()` (pad r from the bank, `u = r.W`
through the VNNI refill), per node at registration, behind a `SHIELDED_PAD_LPN=1`
default-off switch with the selector deciding per node.

1. **Layout.** The refill reads `W` output-major (N rows of K, GGUF order) and dots
   each row with r. The gather needs input-major (K rows of N) so a column of W is
   contiguous; the uniform fallback and the outlier term keep the old layout. Either
   two copies (+1 byte per weight in the enclave: +27 GB on the 27B q8) or the
   uniform refill rewritten in axpy form on the new layout.
2. **`A.W` precompute** (k x N per node, 3 bytes per entry in Z_M): exactly k pads'
   worth of the existing refill, `k/4` batches of the VNNI kernel per node, ~1 s on 16
   cores for the 27B; cacheable next to the calibration file since it is a public
   function of public data.
3. **The Z_M kernels.** `A.W` is output-major (N rows of k) so the dense term IS the
   existing dot-product refill on residue planes, 3 int8 MACs per field MAC. The gather
   is an axpy with a 24-bit scalar times int8 weights: no VNNI form; a 12-bit split of
   `e` into two `vpmulld` passes costs ~2x the Z_2^32 kernel measured here, still
   bandwidth-bound on 8 threads at B <= 4.
4. **Pad derivation.** `(s, e)` from the same ChaCha stream the bank uses today; `r`
   materialised through the Toeplitz product, which also gives the dealer a cheaper
   mint and changes the `.pads` shipment nothing (u is u).
5. **Freivalds, pad check, PADACK, windows: unchanged.** `u.s == r.(W.s) mod M`
   holds for any u = r.W.

When it pays: (a) a refill that is compute-bound rather than bandwidth-bound --
16-deep pools, or a wide-memory box with few cores per GB/s -- where the 0.3 FLOP
ratio delivers 1.7-3x; (b) a TEE that cannot batch pads at all (a per-token dealer
mint, a phone anchor filling one pad at a time), where the 2-3.6x byte figure is
real. The CVM tier today is neither: bandwidth-bound at batch 4 on 8-16 vCPUs, with
refill already off the critical path.

## 8. The three open questions (handoff section 8), not resolved here

1. **Ring hardness.** What this work adds: with unit noise the Z_2^b (and Z_M)
   instance reduces mod 2 (mod each prime) to F_2-LPN(n, k, t) with the same support,
   and the F_2 solution lifts, so the ring instance is at most that hard; with
   non-unit noise it is at most F_2-LPN(n, k, ~t/2). The noise-free coordinates give
   exact linear equations over the ring, which is what ISD exploits and what a
   lattice attack would need to exploit differently; the error is sparse but its
   entries are uniform units, not short, so Euclidean lattice reduction has no
   obvious handle. That is an observation, not a proof, and the parameter table must
   not be treated as final until a cryptographer has looked at LPN over Z_2^b / Z_M
   with sparse unit noise, at the Toeplitz variant if it is used, and at regular noise
   (Esser-Santini 2023, Carozza-Couteau-Joux 2023 find regular instances easier in
   some regimes).
2. **ISD margin.** `sec = 90` is the linear proxy; the selector also reports the Prange
   figure it corresponds to (130-155 bits across this tier's shapes, 137 at the
   handoff's n = 4096, k = t = 600). BJMM-class algorithms and dual attacks shave a
   fraction of that exponent at these rates (k/n = 0.03-0.3, t/n = 0.05-0.3). The knob
   exists: `--sec 120` costs the 16384 layer 0.42 -> 0.54 of plain, `--sec 150` more.
   Nothing here confirms the margin against current best attacks.
3. **Ring width.** Answered by the tier's own calibration data rather than by
   analysis: every site in `metal/shielded-overlay/calib/*.calib` is calibrated to
   the 2^23.8 field with two bits of headroom, i.e. peak products of ~2^20-2^21 at
   activation exponents of 7-14 bits. A 16-bit ring needs peaks below ~2^13, which
   means 7-8 fewer fractional bits on the activations: below what the quantisation
   tolerates. 24 bits is the width, and it is what the tier has. The bench's 16-bit
   rows quantify what is forgone: 1.65x per pad at the best k (section 5.3), the
   largest single lever in the handoff and the one this tier cannot pull without a
   different activation encoding.

## 9. Where the handoff's estimates stood against measurement

| handoff | measured | note |
|---|---|---|
| ~2.1x at n = 16384, 32-bit, 4-bit weights, B = 1 | 3.6x at 8-bit weights (Toeplitz), 2.4x with the handoff's dense A | byte model right; A omitted; 4-bit weights would widen it |
| ~3.3x at n = 4096 (FLOP view) | 1.4-1.6x (bytes, B = 1); 0.9-1.0x at B = 4-8 | FLOPs are the wrong objective at B <= 4 |
| batching: ~7x at 16384, "helps twice" | 1.8x at B = 8, 3.1x at B = 64 (same instruction class); helps the uniform baseline more at B <= 8 | uniform bytes/pad ~ 1/B; VNNI caveat |
| 16-bit ring "single largest bandwidth win" | confirmed: 1.65x per pad over 32-bit (6.0x vs 3.7x); not usable for this tier's numerics | the optimum also moves to a larger k |
| size W.A to L3 | mechanism confirmed (W.A term 3-5x cheaper hot); reach denied: hot only via back-to-back pads of one layer, i.e. batching | cutting k to fit at B = 1 loses |
| regular LPN "matters substantially for cache" | no difference | input-major layout |
| `k/t = sqrt(w/b)` | `k/t = w/b` | equal byte terms |
| FLOP-optimal `k = t` | `t = 2k` on square layers | A.s counted |
| refill is the dominant cost | true of an unbatched refill; the engine's batch-4 VNNI refill is off the critical path at 4 tok/s | section 6 |
