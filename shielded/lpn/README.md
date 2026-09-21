# shielded/lpn -- LPN-structured pads for masked offload

The tier's trusted half pays one full pass over the public weights for every
pad it mints (`u = r.W`, `shielded-tee.c`'s refill). This directory replaces the
uniform pad with an LPN-structured one, `r = A.s + e`, so that `u` costs a
`k x m` dense term plus `t` gathered columns instead of `n x m`, and measures
what that buys on this box. Everything here is standalone: numpy and one C
file. Nothing in the engine changes.

```
lpnpad.py        the reference: rings (Z_2^b, and the tier's Z_M), uniform /
                 LPN / regular-LPN pad sources, three public-matrix layouts,
                 Freivalds over the integers, a toy integer transformer whose
                 masked forward pass must equal the in-TEE one bit for bit
lpn_select.py    the parameter selector: (k, t) for (n, m, ring, weight bits,
                 batch, security target), or "plain matvec" when that is cheaper
test_lpnpad.py   103 assertions (python3 test_lpnpad.py; ~25 s)
bench_pads.c     the fast path: AVX-512 kernels over Z_2^32 / Z_2^16, threads
                 split the output columns, self-checked against the plain path
bench_pads.py    drives bench_pads over the real layer shapes of the models this
                 tier serves, the k sweep, hot vs cold, A layouts, threads,
                 batch, and rolls the numbers up per token
results/         the measured data (JSON + the Markdown the driver printed)
REPORT.md        what was measured, what the handoff predicted, what was wrong,
                 and the three questions that need a cryptographer
```

```
python3 test_lpnpad.py
python3 lpn_select.py --n 16384 --m 16384 --ring 32 --wbits 4        # one layer
python3 lpn_select.py --table --ring 32 --wbits 8                    # this tier's shapes
gcc -O3 -march=native -fopenmp bench_pads.c -o bench_pads
OMP_PROC_BIND=close OMP_PLACES=cores ./bench_pads --n 17408 --m 5120 --k 620 --t 2527 --threads 8 --layers 6
python3 bench_pads.py --threads 8                                    # the whole sweep, ~10 min
```

Conventions follow the handoff (W is m x n, x a column, y = W.x), not the
engine's row-vector form; the C kernels keep the weights input-major
(n rows of m int8) so a gathered column of W is a contiguous row. The
engine's own layout is output-major, and an integration would transpose at
registration (REPORT.md, "What integrating it would take").

`results/sweep8.md` is the first full sweep; its B > 1 rows were chosen by a
selector that modelled the union gather, which loses to the per-pad gather, so
`results/sweep8b.md` (same kernels, corrected selector, plus the back-to-back
W.A column in the k sweep) supersedes it for everything but the A-layout and
thread sections, which are B = 1 and identical in both. The engine loopback
log and the llama-bench JSON are beside them.
