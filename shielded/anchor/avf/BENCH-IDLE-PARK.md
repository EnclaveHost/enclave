# Paired target-pool parking experiment

`ANCHOR_BENCH_IDLE_PARK=off-on` runs the first benchmark trial with the ordinary
CPU pool behavior and the second with the existing target/batch parking hook.
`on-off` reverses that order. It requires `ANCHOR_BENCH_TRIALS=2`,
`ANCHOR_HEAD_OWN_POOL=1`, and `ANCHOR_CPU_IDLE_PARK=0`. An absent option preserves
the existing behavior; malformed values and conflicting settings refuse the run.

The hook stays disarmed throughout model registration, prefill, prompt observation
and the prompt-state snapshot. Each trial selects its mode after any state restore
and before the timing and counter boundary. Turning the hook off also resumes the
target/batch pools before timing. Only the engine owner can park those pools; the
independent MTP draft caller cannot park an executing target pool. The unchanged
ggml CPU backend resumes a parked pool when its next CPU graph starts.

Explicit trial mode and call-count lines accompany the normal benchmark records.
A control trial must have zero park calls, an enabled trial must have positive
calls, and all existing output, MTP, verification, and pad-lifecycle checks still
apply. The snapshot never restores pads or spent indices. Trial differences are
limited to this hook; the ordinary benchmark settings record does not encode it,
so a comparison must require the explicit experiment and trial lines as well.

This permits an A/B comparison after one registration within the existing
600-second test budget. Reverse the order in a second run if a gain is observed:
thermal history, live pad delivery and trial order can still affect the result.
The experiment does not change CPU_POLL, production defaults or trust boundaries.
It does not claim that polling samples measure time wasted or that parking is
faster. Earlier all-pool poll-zero and always-on parking runs are different tests.
