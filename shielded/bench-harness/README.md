# 27B shielded bench harness (host loopback, two V100s)

The harness behind `shielded/REPORT.md` sections 18.x. It used to live only in a
session scratchpad under `/tmp`, which is tmpfs; the box stopped uncleanly on
2026-09-23 (journal ends 09:01:45, back at 09:13, cause not identified) and the
whole scratchpad was lost. This copy was rebuilt that day and lives on disk
under `~/enclave-bench/` (the scripts' absolute paths point there).

| file | what it does |
|---|---|
| `run7.sh LABEL K THREADS N` | one run: quiet gate, GPU/thread/CPU samplers, `bench-spec2`, worker log slices, `.meta`, and `VALID`/`INVALID` from `validate.py` |
| `validate.py LABEL [--rc N]` | the ONE complete validity check: every artifact and field required; rc, intruder, every refusal form, local fallback, verify_fail, text identity, observer |
| `pairs.py A B 1 2 ...` | matched pairs, each arm through `validate.py`; any invalid arm drops the whole pair |
| `waitquiet.sh` / `waitfree.sh` / `cpubusy.sh` | gates: no foreign process > 50% CPU / no bench running / foreign busy cores |
| `tsample.py` / `cpusample.py` | passive thread-placement and CPU frequency/power/Tctl samplers |
| `workers-shm2.sh start\|stop` | the two V100 workers on `/dev/shm` rings (`W=` overrides the binary) |
| `abtok.sh` / `abtokprof.sh` | the token-fused GATED_DELTA_NET A/B and its op-profiled pairs (REPORT 18.50) |
| `abrg.sh` / `abrgprof.sh` | the register-row GATED_DELTA_NET A/B and its op-profiled pairs (REPORT 18.51) |
| `bench-spec2.cpp` | `wasm/ggml-shielded/bench-spec.cpp` + WARM/PREFILL_REPS, PLAIN_ONLY, the plain-token dump, the register-max greedy argmax (REPORT 18.52; identical picks) and a per-round phase line on stderr |
| `abam.sh` | the bench argmax A/B (old lg[b]-reload form vs register max, same engine) |
| `phround.py LABEL` | per-round phase budget of the spec decode window from a `SHIELDED_PHASE_TRACE=1` run |
| `phase.py LABEL` | the earlier per-segment phase attribution (recovered) |
| `recover.py` | replays a transcript's Write/Edit/heredoc writes into a directory (how this copy was rebuilt) |

**Provenance of the rebuild.** `validate.py`, `pairs.py`, the gates and samplers
were replayed from the session transcript (heredocs, Edit calls, and the two
Python steps that produced the final `pairs.py`). `run7.sh` is verbatim from two
transcript displays of the full file. `bench-spec2.cpp` is the archived copy in
`shielded/results-27b-loopback-2026-09-20/` plus the one later edit (the
plain-token dump), and builds to the same size as the lost binary.
`workers-shm2.sh` could not be recovered verbatim; it is rewritten from the
running workers' command line captured before the reboot, which it matches.
Before use the rebuilt stack reproduced the pre-reboot plain decode exactly
(token hash `0a1570d184a4`, as in `b-eq-2`, `u16-1`, `cv-on-smoke` and
`cv-off-smoke`) with the same workload (43,118 exchanges, local 0,
verify_fail 0).

Setup after a reboot (`/dev/shm` is tmpfs too):

    mkdir -p /dev/shm/enclave-shielded-shm
    truncate -s 64M /dev/shm/enclave-shielded-shm/card-0 /dev/shm/enclave-shielded-shm/card-1
    ~/enclave-bench/b27/workers-shm2.sh start

**Evidence lost in the reboot.** The raw files are gone: the b-eq-1 worker log
copies, the sterms-1 run, and the twenty 512-token `rep-*` runs (hashes,
divergence) plus the unmasked CPU-only run. `evidence-excerpts-2026-09-23/`
holds every command I ran on those files and its output, verbatim from the
transcript. These are excerpts, not the raw files; the REPORT sections remain
the summaries of record (sterms-1 and b-eq-1: 18.34 and before; the
real-model campaign and the 512-token divergence: 18.47 and 18.49). They contain no activation or product values (the
post-mortem lines are the value-free form).
