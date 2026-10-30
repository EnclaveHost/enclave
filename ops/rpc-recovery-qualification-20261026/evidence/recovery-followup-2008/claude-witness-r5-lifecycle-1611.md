# Witness r5: deterministic test lifecycle and joined shutdown (root 1610). Source only; nothing run, built or installed - 2026-10-26

## Stage: `witness-producer-service-stage/r5`, FROZEN
**`SHA256SUMS` = `a3bcefedf44fe11512b957b83f27208e33af175c3788cc579a6122b16a5ce801`** (hashed with `sha256sum`; files `a-w`).

| file | sha256 |
|---|---|
| `producer/witness_producer.py` | `bb8ac12e7b5e5ffc0595a7bf3a51cd5b12f8156821d74ee8e40a317993643e5d` |
| `tests/test_witness_producer_r5.py` (11 tests) | `aa05e84c003c0548e61ee9d9bd8aaafee1d91e6ca812d192e05e8d800d2a8a89` |
| `tests/test_forward_chain_r5.py` (7 tests) | `62ee60268583617393134d4d16bc95fe5998eab30b0a381b4868a10fd2bbfc08` |
| `jobs/tests.sh` | `b3fdfed811e2eb59d5f1c2e8475e836ade86c005257af15b2f8270fb68800b70` |
| `README.md` | `65e0f5152678bc57f5f65dedada66d43574231d70febc4aef527db80124af87e` |

**Unchanged (re-verified):** r1 `1efa5c85…`, r2 `07084e7a…`, r3 `816417f4…`, r4 `eef30b11…`.

## Root 1610 findings → cause → r5 change
Every failure was one lifecycle race:
- **The client side:** `post()` returns once it has the Content-Length bytes.
- **The server side:** the producer handler still runs its `finally` after that (`clean_run`, log, `c.close()`, the single-flight release).
- **The consequences:**
  - logs and the work dir were inspected too early: `IndexError` ×3, a `configs/` dir still present, a leftover `w-*`;
  - the next request hit the still-held slot (503 instead of 502/200/400);
  - the forward readiness check could see `active == 0` **before** the probe's upstream was even admitted, so the idle regression raced the probe, got "busy", and never saw `active == 1`.

**Producer (r3 plus two changes only):**
1. **Observable completion.** One `Condition` guards `active`, `stats["admitted"]` and a new `completed` counter. The handler's `finally` increments `completed` **as its last step**. `wait_quiescent()` waits for `completed == admitted and active == 0`; `wait_admitted(n)` waits for actual admission.
   - The production behaviour is unchanged: the single slot is still released after cleanup, which keeps the disk bound. The driver is single-flight and runs the native between requests.
2. **Shutdown (a real defect in r1/r3, fixed here with a regression).** `shutdown()` only closed the listener, so handler threads **and the fetch child** were orphaned; the child runs `start_new_session` and is not reached by the parent's signals. r5:
   - sets `closing` (admission and `run_fetch` refuse new work);
   - SIGKILLs every registered fetch process group (pids are unregistered as soon as they are reaped);
   - joins the workers with a bound, and returns the names still alive.
   - Under systemd the default control-group kill on stop also reaps children; the defect was the in-process API and the fixture teardown.

**Tests: the same 17 checks plus 1 genuine regression = 18.** No sleeps, retries or relaxations on any tested assertion.
- **Producer suite (11):**
  - r3's 10, unchanged in assertions;
  - each `post()` asserts `wait_quiescent(60)` after reading the response;
  - every teardown asserts `shutdown() == []` (no orphaned handler);
  - **new `Shutdown`:** a real fetch child (sleep) is started; `shutdown()` returns `[]` in < 15 s; the child's `/proc` entry is gone (not a zombie); the client got **502**; `wait_quiescent`; the work dir is empty; new connections are refused.
- **Forward suite (7):**
  - **Readiness** is one complete bounded exchange through the real `systemd-socket-proxyd` from 10.0.2.2: a malformed `{}` → **400** read to EOF, then the producer handler's observed completion. Only `ConnectionRefusedError` (the listener not yet bound) is retried, bounded at 20 s; any other answer fails.
  - **The idle regression:**
    - opens the idle client and waits for its **actual admission** (`wait_admitted(base + 1)`);
    - asserts the concurrent request gets **503 "busy"** in < 2 s, through the producer's own `busy` counter (refused by admission, never read);
    - closes the idle client and observes **its handler's completion**;
    - only then expects **200**.
  - Every other request is followed by `wait_quiescent`. Teardown kills the proxy before asserting `shutdown() == []`.
- **Job extras:** `jobs/tests.sh` also fails if any process whose command line contains the run's temp dir is still alive after the suites.

**Not claimed:** the single-flight behaviour and the shutdown fix are **not** shown to pass until root runs this job.

## Exact root job
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh witness-producer-r5 512 unshare -Urn bash witness-producer-service-stage/r5/jobs/tests.sh
```
**PASS requires all of:**
- `## test_witness_producer_r5 PASS (11)`;
- `## test_forward_chain_r5 PASS (7)`;
- no skips, no orphaned fixture processes, and `## witness-producer-r5 rc=0`.

Exit 9 (PRETEST) names the failing input: a stage sum, the bridge source pin, a tool, or the manifest.

**Still unqualified / measured remaining:**
- real witness sizes and durations vs the caps/`--fsize`;
- the real Rust fetcher under `--fsize`;
- bridge method coverage;
- the QEMU path SNP guest → 10.0.2.2:28747 → host → RPC VM;
- systemd `IPAddressAllow` enforcement;
- native acceptance of a served witness;
- the release build / image pin;
- the transport patch's node tests (5 + 8) in the merged composition.
