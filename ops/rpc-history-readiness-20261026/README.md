# historical-blob-readiness-stage (evidence only)

- **Probes:** `jobs/probe.py` (3 requests) and `jobs/probe2.py` (1 request) are the ONLY 4 read-only requests made to our own L1 (EL 28645 / CL 25052 host forwards), through the shared 512 MiB queue.
- **Raw outputs:** `logs/probe-1.out`, `logs/probe-2.out`.
- **Not done:** no payload or bulk download, no prefetch, no mutation.
- **Report:** `../logs/claude-historical-blob-readiness.md`.
