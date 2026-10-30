# Witness r4: root's real failures 1603/1604 analysed and corrected (source only; nothing run, built or installed) - 2026-10-26

## Stage: `witness-producer-service-stage/r4`, FROZEN
**`SHA256SUMS` = `eef30b11368c4a845ed1d3573e4ca5bed9db2cb052a41d96b276182542983088`** (hashed with `sha256sum`; files `a-w`).

| file | sha256 |
|---|---|
| `tests/test_forward_chain_r4.py` (7 tests) | `081597c2437298365b6eb0a6ff768266d3ab996d4eb4ce1ee647cccc0f187422` |
| `jobs/tests.sh` | `aaa5c314c0823621ade10fb6480f77cb10c3fbd2eccff5608751293b46dbf4f9` |
| `README.md` | `fbfdd5d00b412ccf18958be1119911b0032e25b53435004abee3baa20bf292ba` |

**Preserved and unchanged (re-verified):**
- r1 `1efa5c85…`;
- placement r2 `07084e7a…` (its units, proposal and transport patch, tree `58c9b92e`);
- producer r3 `816417f4…`;
- the r14 bridge source `cb976541…`.

r4 copies nothing. It uses the r3 producer and r3's own 10-test file, and r2's units and proposal, **by path with sha pins**.

## 1603 (placement r2: 6 tests, 4 pass, 2 fail): causes
1. **`malformed…` got 503, not 400. This is real single-flight concurrency in the test, not a producer defect and not relaxed:**
   - **The setup probe:** `setUp`'s readiness probe `create_connection(10.0.2.15:fport).close()` goes through `systemd-socket-proxyd`, which opens an **upstream connection to the producer** for it.
   - **The slot:** the producer admits that connection; `max_conn` 1 is the bridge rule reused in r1/r3. It holds the slot until the proxy tears the upstream down and `read_request` sees EOF.
   - **The race:** the test's first request arrived inside that window and was correctly refused 503 before being read. The happy-path test passed only by timing.
   - **r4 fixture:** after the probe, it waits until `prod.active == 0`, and before each sequential request does the same (the driver is single-flight too).
   - **New regression** `test_an_idle_forwarded_connection_holds_the_single_slot_then_releases_it`:
     - an idle connection from 10.0.2.2 through the real proxy is admitted (`active == 1`);
     - a concurrent request gets **503 "busy" in < 2 s, unread, with no fetch**;
     - after the idle one closes, the slot is released and the next request is **200**.
   - **Operational note:** any TCP connect to the forward occupies the producer's single slot until it closes or the 15 s header deadline passes. The SNP driver retries with backoff. Health probes must not target the forward.
2. **The `[Install]` assertion matched my own comment** (`# No [Install]: …`). r4 parses the **real section headers** (socket `[Unit, Socket]`, service `[Unit, Service]`, the producer unit without `Install`), and the bind/peer checks run on non-comment lines only. The unit files themselves are unchanged and correct.
3. **Hygiene:** the ResourceWarnings (files opened without closing) are fixed in r4's harness.

## 1604 (producer r3: exit 9 before tests)
- **The cause:** `source/ops/rpc-witness-r14-20261026/witness-r2/SHA256SUMS` lists `./bridge/__pycache__/witness_rpc_bridge.cpython-314.pyc`, which is absent (incidental bytecode never shipped; see the r14 STATUS). r3's job ran `sha256sum -c` on that whole archive.
- **The fix in r4's job (no bytecode recreated, no archive edited):**
  - the bridge **source** must be a regular file, not a symlink, with sha256 = the reviewed **`cb976541…`**;
  - **and** that exact line must appear in the archive's own `SHA256SUMS` (`grep -qx`);
  - the archive is not verified as a whole.
- **Other inputs pinned:**
  - **Stage sums:** r1/r2/r3 are re-verified by the sha of their `SHA256SUMS` plus `-c`, before and after the run.
  - **Tools:** `prlimit` with `--fsize`, `systemd-socket-proxyd`/`-activate`, and a readable manifest (read only).
  - **Files:** the r3 producer sha (`133eed31…`), r2's unit and proposal shas, and r1's unit sha are checked inside the tests.
  - **Bytecode:** none may exist in any stage, before or after.

## Producer inspection (any bug, fix plus regression)
I re-read r3's `handle`/`run_fetch`/`clean_run`/`send_witness` against both failures and r3's frozen tests.
- **No producer defect was found.** The 503 is the designed admission, now covered by the regression above.
- **Two traces checked:** the exact-cap case (one 64 KiB write served at cap 65536; a short write then EFBIG at cap 65535), and the SIGXFSZ path (rc −25 → 502).
- **The stderr drain** (`deque(maxlen=4096)`) is per byte. A 50 MB flood costs CPU seconds, but memory stays bounded. This was noted, not changed (r3 is frozen).

## Exact root job
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh witness-producer-r4 512 unshare -Urn bash witness-producer-service-stage/r4/jobs/tests.sh
```
**PASS requires all of:**
- `## test_witness_producer_r3 PASS (10)` (r3's frozen file, unchanged);
- `## test_forward_chain_r4 PASS (7)` (the 6 corrected forward tests plus 1 new regression);
- no skips and `## witness-producer-r4 rc=0`.

Exit 9 is a PRETEST refusal and names the input.

**Still unqualified / measured remaining (none claimed):**
- real witness sizes and durations vs the caps and `--fsize`;
- the real Rust fetcher under `--fsize`;
- bridge method coverage;
- the end-to-end QEMU path SNP guest → 10.0.2.2:28747 → host → RPC VM;
- systemd `IPAddressAllow` enforcement;
- native acceptance of a served witness;
- the release build / image pin;
- the transport patch's node tests (5 + 8) in the merged composition.
