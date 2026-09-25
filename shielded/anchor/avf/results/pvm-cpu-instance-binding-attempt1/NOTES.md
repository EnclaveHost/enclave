# Instance binding, device attempt 1 (kept as it is)

STOPPED at A (19:55Z): the lab hub crashed at startup -- my edit to cpu/local-hub.mjs put a comment mid-line and dropped its authority pins (hub.err). The VM had derived its instance key and certified Bind3 (vm/stop-A.log: INSTANCE ccd79db1..., ABI2 binding bind3=..., ABI2 instance ...) but, with no relay, never served. Fixed; the run script now checks the hub is alive first.

The passing run and all four attempts are described in ../pvm-cpu-instance-binding/NOTES.md.
