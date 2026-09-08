# GPU observation capture

These opt-in tools measure driver-reported utilization and host observation
times. They neither configure GPUs nor establish phone decode throughput.
All selectors require full GPU UUIDs; explicitly choose the intended cards.

`gpu-util-sample.py` starts a read-only `nvidia-smi` query, writes bounded CSV
records and produces a final `.summary.json` binding the byte count and SHA-256.
The CSV output must be new. Its environment requires `OUT` and `GPUS`; optional
`INTERVAL_MS` and `MAX_SECS` bound sampling. An invalid row, early query exit,
write failure or unreaped query process fails the capture.

`gpu-capture-run.py` owns the sampler and a supplied command. For example:

```sh
python3 gpu-capture-run.py --prefix /tmp/new-gpu-capture \
  --gpus "$GPU_UUID_1,$GPU_UUID_2" --sampler ./gpu-util-sample.py \
  --interval-ms 250 --max-secs 600 -- ./benchmark-command
```

It waits for at least two fresh readings from every selected device before
starting the command, records start/end on this host's monotonic clock, then
keeps sampling through a post-roll. It stops and reaps its own processes and
checks the final capture hash, status, bracketing and observation gaps. Each
command runs in its own process session: it must not launch a persistent shared
service, because cleanup also stops descendants of that command.

The exclusive `.capture.json` preserves the command exit and sampler exit
separately. PASS requires both success and a usable observation window. A query
failure during a command retains the command's eventual result, while marking
the combined capture failed. A deadline or cancellation stops owned processes.
Command-lifetime timing includes startup, waiting and teardown; it is never an
exact remote decode interval. There is no VM-to-host clock synchronization here.

`gpu-util-window.py` can summarize another explicitly established interval from
the same host clock. It requires the clean sampler sidecar bound to those exact
CSV bytes. Every selected device must bracket the whole interval, have at least
two readings inside it, and have no observation gap above `--max-gap`.

The mean, percentiles and fractions of zero or high readings summarize the
driver's samples. They are not exact fractions of wall time idle or proof that
a particular process used the GPU. Missing observations remain incomplete.
Choose a post-roll long enough for another reading at the selected interval;
the default 250 ms interval uses a 1 s gap threshold and 1 s post-roll.

Framed request/reply observations are described in `FRAMED_FORWARD.md`.
They can identify a worker-exchange window on the same GPU host; they still
exclude phone work before the first request and after the final reply.
