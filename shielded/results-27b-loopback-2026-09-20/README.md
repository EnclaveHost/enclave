# 27B host-loopback lever runs, 2026-09-20/21

Raw data behind `shielded/REPORT.md` section 14. One JSON per run (bench-spec's
line), `results.txt` (one summary line per run with the load the box carried,
`load=` and `others=`), `table.md` (all runs in one table), `run.sh` (the
harness: two V100 workers on 9601/9602, the engine drop's libraries, the q4 vl
calibration), and `bench-spec2.cpp` (bench-spec plus `WARM=1` / `PREFILL_REPS=n`
so the link is open and the graphs captured before anything is timed).

Run prefixes: `mx64-*` first pass (pool depth 256, superseded), `base2`/`ov1`/
`spin*`/`gomp*`/`rf*`/`pin8*`/`long-*` the config levers (quiet box), `c-*` the
re-runs after the game stopped, `rows*` the row-pool build, `g-*`/`i-*` old-vs-new
interleaved pairs (i-* with the refill-unit rule and a 25 GB reservation),
`f-*`/`lw-*`/`h-*`/`ab-*` runs invalidated by a dead worker or a refused link and
kept only for the record, `j-*` the final repo build. Every claim in the report
says which prefix it rests on.
