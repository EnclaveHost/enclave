# Streamed-source floor experiment

`ANCHOR_STREAM_MIN_BYTES` sets a size floor for streamed weight sources.
With `ANCHOR_STREAM_WEIGHTS=1`, every calibrated member the placement pins
to plain rows becomes a streamed source: never resident, read from the
staged file and verified against the staged digest table on demand. A
member whose byte size is below the floor takes the existing resident path
instead: read once, digest-checked against the same table, then set. The
value is a canonical decimal integer in `[0, 2^40]`; unset or `0` preserves
today's behaviour (every member streams); a malformed value refuses the run
before anything is allocated. The engine reports the requested floor and
the resulting streamed-source count in its verified-loader line.

Why: a streamed source that a CPU operator consumes is re-read and
re-hashed as a whole on every tensor read. On the 27B (ping-3, 2026-09-09)
the engine's SOURCE counters grew by exactly 576 reads / 150,405,120 bytes
between prefill and decode: the 96 `ssm_alpha`/`ssm_beta` members
(5120x48 Q8_0, 261,120 bytes each) read once per MTP round. The cost of
those reads on decode time is unmeasured; a floor of `4194304` (4 MiB) keeps
those members resident (+25 MB of guest RAM) and leaves every member of 26 MB
or more streamed. Expected observable: the SOURCE counter delta between the
prefill and decode snapshots becomes 0 and the streamed-source count drops by
96. Integrity is unchanged: the resident path is the verified loader the
other resident tensors use, and the backend encodes such a member from RAM
exactly as it encodes a streamed one.
