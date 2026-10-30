# Canary r3 guest A1 call timeout: cause not yet proven; a bounded read-only diagnostic is ready (plus recovery fixture r2)

**Status:** finalization stays **blocked**. Canary r3 failed terminally at the initial capture, and no capture/verify/recheck has passed on the guest.

**What I did:** read existing artifacts, wrote two new stages, and ran static checks only (`bash -n`, `node --check`, `ast.parse`).

**What I did not do:** no SSH, tests, queue jobs, guest writes, restarts or commits. No timeout, binary or RPC-source change was made.

## 1. What the actual run shows (`guest-capture-canary-stage/r3/logs/run-20261026T071038Z-0aa8a393`)

**Worked:**
- **EL port fix confirmed:** `a1-config` `elUrl` is `http://127.0.0.1:18645`.
- **Helios forward finality PASS:** finalized block 26275226, whose hash equals our own EL's hash at that number. The checkpoint payload was 26271752.
- Production PIDs were unchanged, cleanup completed, and the host minimum was 18515 MiB (per root).

**Failed:**
- `evidence.json`: `{"verdict":"refused","code":"helios_call_failed","message":"anchorStateRegistry() on 0x49048044d57e1c92a77f79988d21fa8faf74e97e: The operation was aborted due to timeout"}`.
- `result.json`: `a1Exit 3`, `a1.stderr` empty (sha e3b0c442…), capture took 142 s, finished 07:13:02Z.
- `helios.out` has only 4 info lines and no error:
  - checkpoint saved at 07:12:39;
  - latest block 26275290 at 07:12:39 (age 16 s);
  - latest block 26275291 at 07:12:51 (age 16 s).

  Helios was alive and following the head while the call was outstanding.

**The actual call flow** (`a1-anchor.mjs` lines 205-232 and `a1-read.mjs:19-24`):
1. `io.helios("eth_chainId")`, then `eth_getBlockByNumber("finalized")`.
2. The EL header is fetched by hash, and its hash is recomputed and checked.
3. The first verified read is `eth_call [{to: portal, data: anchorStateRegistry()}, {blockHash: <finalized hash>}]` (`pinBy: "hash"`), sent to Helios with `AbortSignal.timeout(20000)`. This is the reader's fixed `rpc()` default.

**What Helios does for that call:** it executes the call locally and pulls the state it needs from its `executionRpc` (our reth on :18645): an access list or account/storage proofs (`eth_createAccessList` / `eth_getProof`) **at the finalized block**. It verifies them against that block's state root.

The finalized block was **786 s old, about 65 blocks behind the head**. So reth must build **historical** proofs, which means reverting changesets from the tip. That is far more expensive than proofs at the tip.

**Same getter, previous success:** host run `outputs/…/a1-capture-live-0252` succeeded at 02:53Z (a1Exit 0, about 70 s total). It used the same getter, `pinBy hash`, and the **same reth** through the 28645 forward. So neither the code nor the EL configuration is the obvious cause. What differs on the guest:

| # | Candidate | Basis |
|---|---|---|
| H1 | **EL proof latency under concurrent guest load.** The Base snapshot **download** (`enclave-rpc-base-snapshot`; root's actual logs show the download in progress — my earlier "extraction" was wrongly inferred from the unit state `activating` alone) runs on the same VM and competes for disk, network-buffer and CPU. Historical `eth_getProof` is I/O-heavy. The reth L1 flags in our wrapper source include `--rpc.proof-permits 2`, which serialises Helios's parallel proof requests. | I have not verified that the guest's installed wrapper (75c879ec) has these flags. I also don't know the download's load at 02:53. |
| H2 | **CPU quota.** Helios's revm execution plus proof verification plus the node reader all share `CPUQuota=100%`. On the host they were unthrottled. | Plausible but unmeasured. A single getter should not need 20 s of CPU unless throttling is severe. |
| H3 | **Memory pressure.** `MemoryMax=512M` with no swap, holding Helios plus node. | No OOM was seen. `memory.events high/max` was not recorded in r3. |
| H4 | **Helios↔EL request errors or retries.** For example a proof-window error leading to retries until the abort. | `helios.out` at info level shows nothing. Only an EL-side request log can confirm or rule this out. |

I can't tell these apart from the existing artifacts, so I'm not claiming a cause.

## 2. The diagnostic: `guest-call-timeout-diagnostic-stage/` (prepared, not run)

`SHA256SUMS` sha256 **4bff3fcf54de3dc25e5a5949fe4ed234b41fa0fac4810299d2bed847ba9c0439**.

| File | sha256 |
|---|---|
| `guest/diag.sh` | e5f26a0d… |
| `guest/el_probe.mjs` | 6d9b6928… |
| `guest/helios_probe.mjs` | 20e71249… |
| `guest/rpc_log_proxy.py` | f2b22d58… |
| `guest/cleanup.sh` | b6187320… |
| `jobs/root-guest-call-diagnostic.sh` | 61da2c17… |
| `README.md` | 86eaeca8… |

**Bytes it uses:**
- **The frozen canary r3 bundle**, built by r3's own assembler and pins. The job checks r3 `SHA256SUMS` = 9367c877. No new binary is involved.
- The pinned checkpoint 2e8502e6.
- Three small probes.

**Envelope (same as r3):**
- queue `--mib 512`, with a host floor watchdog that stops every diagnostic scope;
- owned cleanup on any exit, removing only `diag-<ID>` and `/run/enclave-diag-<ID>`;
- PIDs-unchanged check, own CL/EL only, no public RPC;
- nothing written to production paths, units or configs, and no restart.

**Phase 0:** a snapshot of guest state before and after every phase: loadavg, nproc, PSI for cpu/io/memory, Base-snapshot (download/extraction) and L1-EL unit state plus CPU usage, and free memory.

**Phase A: direct own-EL timings** (`el_probe.mjs`; scope 256M / `CPUQuota=100%`; sequential; 240 s per request):
- `eth_blockNumber`, and the EL's finalized block (giving the distance from head);
- `eth_call anchorStateRegistry()` at `{blockHash: finalized}` and at `latest`;
- `eth_createAccessList` at finalized and at latest;
- `eth_getProof(portal, [])` at finalized, three times (variance);
- `eth_getProof` with the access-list keys, at finalized and at latest;
- `eth_getProof` for every access-list account at finalized;
- one proof at finalized−300, to record the configured proof-window response.

Each step records ms, bytes, and error. This **directly measures reth's historical-proof latency at the same finalized depth**.

**Phase B: Helios's actual EL call flow** (Q = 100, then Q = 400):
- **Relay.** The r3 bundle's pinned Helios runs through its own `l1_authority.py run` (`check` first), with `executionRpc` = `127.0.0.1:18646`. That is a transparent logging relay (`rpc_log_proxy.py`, its own 128M / 50% scope) to the **same** `127.0.0.1:18645`.
  - Bytes are relayed unchanged and no bodies are logged.
  - Each request logs start offset, duration, **in-flight concurrency**, methods, block parameter, storage-key count, HTTP status, size, and RPC error.
- **Probe.** `helios_probe.mjs` runs inside the Helios scope, as the A1 reader did. It waits up to 900 s for Helios finality, then sends:
  1. **A1's exact call** (`{blockHash}`, 20 s) — does it time out again?
  2. the same call with a **240 s diagnostic bound**, to measure Helios's real latency (this is not a capture and not a timeout change);
  3. the call at the `finalized` tag;
  4. the call at `latest`.
- **Per scope:** `cpu.stat` (`nr_throttled`/`throttled_usec`), `memory.peak`, `memory.events`, and cpu/io/memory pressure are recorded.
- **Q=400** is a controlled comparison only. The canary keeps its quota unless the data justifies a reviewed change.

**Root runs it** from `work/rpc-production-final-20261025` (no other canary running; ports 18550/18646 free; before 2026-11-01 19:22 UTC because of the checkpoint age):
```
(cd guest-call-timeout-diagnostic-stage && sha256sum -c --quiet SHA256SUMS) && \
python3 -u ../claude-test-queue.py --mib 512 --log guest-call-timeout-diagnostic-stage/logs/root-guest-call-diagnostic.guard -- bash guest-call-timeout-diagnostic-stage/jobs/root-guest-call-diagnostic.sh
```
Results land in `guest-call-timeout-diagnostic-stage/logs/run-<ID>/result/out/`.

## 3. How to read the result, and the fix candidate for each case (each one bounded and reviewed; none applied)

| Observation | Cause | Fix candidate |
|---|---|---|
| Phase A `eth_getProof` / `createAccessList` at finalized take many seconds; `io` PSI is high while the Base download is active; the relay shows Helios proof requests queued with in-flight ≤ 2 and long durations | **H1: EL historical-proof latency under extraction load.** | Run the A1 capture (canary, and production launch/reproof) only when the guest is not downloading or extracting. Make that a pre-capture gate: `enclave-rpc-base-snapshot` inactive and io PSI below a bound. Or review raising reth `--rpc.proof-permits` / I/O priority for the L1 EL. Not a timeout increase. |
| Phase A is fast (< 1-2 s per proof), but Helios at Q=100 shows high `throttled_usec` and slow calls, while Q=400 is fast | **H2: CPU quota.** | Re-freeze the canary scope with a measured `CPUQuota` (and the same bound for the production capture unit). The 20 s reader timeout stays. |
| `memory.events` max/high > 0, or `memory.peak` near 512M | **H3: memory pressure.** | A measured `MemoryMax` with the same no-swap rule, re-frozen. |
| The relay shows RPC errors (proof window, method unsupported) or a retry loop | **H4: Helios/EL interaction.** | Review the reth L1 RPC flags. Do not change the binary or the source. |
| The 240 s diagnostic call itself takes more than 20 s even at Q=400 on an idle guest | Cost inherent to Helios plus historical proofs at this depth. | Only then propose a reviewed change to A1's call depth or timeout policy (for example a measured per-call bound in the pinned A1 code). That would require a new reviewed capture stage and re-pins. |

**The canary's 20 s timeout, the binary and the RPC source stay unchanged until this evidence exists.**

## 4. Recovery fixture: r2 ready (separate)

- **The r1 failure:** the actual single-test run `r10-recovery-fixture-fix/logs/run-20261026T071310Z-1119222` errored with `ungated_db_access`. My pre-read `A.head_state` touched the DB before `gate_static`, and the harness correctly refuses that.
- **New stage:** `base-finality-proof-stage/r10-recovery-fixture-fix-r2/`, `SHA256SUMS` sha256 **eb8e255a51ffc9c10ff26010fb71f207b7bdfe9af220d74f0809dba9ba1094e8**. r1 and r10 are untouched.
- **The only change from r1:** `b0 = A.Base(c, [], w); A.gate_static(c, b0); _, st = A.head_state(c, b0)`. The frontier is read **through the normal gate** on the same Base, with no bypass.
- **Assertions are identical to r1:**
  - an exact, anchored `state_below_anchor: the persisted state/trie frontier {st} (Finish.partial_state_trie) is below N: labels are not state`;
  - no mutating or `unwind` `Base.run` during `step_plan`;
  - all other r10 assertions unchanged.
- **The job** (`jobs/root-r10-recovery-fixture-fix-r2.sh`, eafae018…) is r1's job with only the stage name and temp prefix changed: same exact-r10 pins, same private mktemp work, single test, `Ran 1`.

  ```
  FX=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r10-recovery-fixture-fix-r2
  python3 -u $FX/../../../claude-test-queue.py --mib 1536 --log $FX/logs/root-r10-recovery-fixture-fix-r2.guard -- unshare -rn bash $FX/jobs/root-r10-recovery-fixture-fix-r2.sh
  ```
- **Unrun.** A pass here is not an r10 PASS; it still needs integration into a final source stage.

## Root needs to

1. Run the recovery fixture r2 job.
2. Run the guest call diagnostic.
3. Return both raw outputs. I will then name the proven cause, and the matching fix from section 3, with its bounded checks.

**Unchanged:** production is unqualified, Custody v2 is REFUSED, and lease consumers are on HOLD.

## 5. Diagnostic r2: review fixes, FROZEN (supersedes the r1 job; r1 untouched)

**Correction:** the guest Base snapshot unit was **downloading** (root's actual logs), not extracting. I had inferred extraction from the unit state `activating` alone; that was wrong. H1 and the section 3 prose above are corrected.

**Stage:** `guest-call-timeout-diagnostic-stage/r2/`. `SHA256SUMS` sha256 is **5d407984d33ce40bee6154343d40f537c810c856b1cbbd77fb5a9717c378000f**, and the files are read-only. r1 (stage-root files, `SHA256SUMS` 4bff3fcf…) still verifies.

| Path (under `r2/`) | sha256 | Change |
|---|---|---|
| `jobs/root-guest-call-diagnostic-r2.sh` | 482a20c9b1bbd2e3eda3ee6097b77c21f990e09b825209eebeda18c665e9f506 | new host job |
| `guest/diag.sh` | e0e16e881ea54323102ff8fda8faa36d7846c7c56f0560037bfa69edaed3d96f | r1 + fixes |
| `guest/cleanup.sh` | 709b4ab95b022c897998c2b519ab8478239c8ffde41b008e9de1d714d474da63 | two modes: `stop-collect`, `delete` |
| `tools/status.py` | 965db41297343881c197dcd0c5e9d74fd0e99b8159ed7d8a1e40226eaae25418 | new truthful-status writer |
| `README.md` | 41d1e6fe23f40d2e636b5b684475ea6ea6b315fbf70d57c060ac03b98764fdec | |
| `guest/el_probe.mjs` | 6d9b6928… | **byte-identical to r1** |
| `guest/helios_probe.mjs` | 20e71249… | **byte-identical to r1** |
| `guest/rpc_log_proxy.py` | f2b22d58… | **byte-identical to r1** |

**Unchanged pinned bytes:**
- the frozen canary r3 bundle (the job checks r3 `SHA256SUMS` = 9367c877 and runs r3's own assembler and R10 pins);
- checkpoint 2e8502e6;
- helios cc962e2b, via `HELIOS.txt` from the r10 manifest.

No source, binary, RPC-source or timeout-policy change. Only the own EL :18645 and CL :15052 are used.

### Fixes

1. **Memory claim.** The guest aggregate in phase B is Helios scope 512M + relay 128M = **640 MiB** (phase A, 256M, runs alone). The queue claim is now **`--mib 768`**, and the host floor stays 16 GiB.
2. **Q=400 is opt-in.** The default is `DIAG_VARIANTS=100`. Q=400 runs only with `DIAG_VARIANTS="100 400"`, after root coordinates with KVM. Any other value refuses.
3. **Invariants are enforced, not just printed.**
   - Production PIDs that change, either at the end of `diag.sh` or when re-checked during cleanup, are written to `out/invariants.txt`. So is an own listener (18550/18646) left bound, or PIDs that were never re-checked.
   - Any of these gives `status.py` **rc 30**, and the host job reports `verdict: invariant-violation` with **rc 30**.
4. **Truthful incomplete status.**
   - Each phase's real rc goes to `out/phase-rc.txt`: `A`, `B100`, `B400`, or a named failure such as `l1check-refused`, `relay-not-listening`, `aborted-host-floor` or `mkdir-failed`.
   - The Helios scope now exits with the **probe's** rc, instead of the rc from `wait` on the killed Helios.
   - `status.py` marks each phase `complete`, `incomplete: <why>` or `not-requested`, judged from the files that actually exist.
   - Host rc meanings: **0** complete; **10** incomplete (also used when the SSH session times out); **20** setup failure or host-floor stop; **30** invariant violation; **40** cleanup failed.
5. **Partial evidence survives a timeout.** `diag.sh` rewrites `$U/result.tar` atomically (tmp, then `mv`) after setup, after phase A, and after each phase-B variant. The host fetches whatever exists, even if a later phase or the SSH session times out.
6. **Cleanup order.** The host trap runs:
   1. **fetch** the latest snapshot;
   2. `cleanup.sh stop-collect`, which snapshots first, then stops own scopes, the `diag.sh` process (cmdline checked as `bash -s <ID> …`), and any remaining process whose cmdline names our private paths; then re-checks production PIDs and listeners, and snapshots again;
   3. **fetch again**;
   4. `cleanup.sh delete`, which **refuses while any own process remains**. If `stop-collect` cannot confirm all are stopped, nothing is deleted and the job reports `cleanup-failed` (rc 40) with manual instructions.
7. **Diagnostic results are kept separate from assertions.**
   - Probe timings, timeouts and errors are **observations**. They never count as pass/fail.
   - `status.json` and `PUBLIC-STATUS.json` carry `kind: "diagnostic observations only; NOT a capture, readiness or finality verdict"`. Phase completeness and invariants are reported separately.
8. **Host-floor abort.** The watchdog stops all diagnostic scopes and touches `$U/abort`. `diag.sh` checks for it before each phase and records `aborted-host-floor` instead of running on.

### Root queue command (from `work/rpc-production-final-20261025`; not run by Claude)

Run it after the recovery fixture r2 result.

Default, Q=100 only:
```
(cd guest-call-timeout-diagnostic-stage/r2 && sha256sum -c --quiet SHA256SUMS) && \
python3 -u ../claude-test-queue.py --mib 768 --log guest-call-timeout-diagnostic-stage/r2/logs/root-guest-call-diagnostic-r2.guard -- bash guest-call-timeout-diagnostic-stage/r2/jobs/root-guest-call-diagnostic-r2.sh
```

Only after KVM coordination: prefix the same command with `DIAG_VARIANTS="100 400"`. That raises the SSH bound from 3000 to 5000 s.

**Preconditions:**
- no canary or diagnostic currently running on the guest;
- ports 18550/18646 free;
- before 2026-11-01 19:22 UTC (checkpoint age).

**Outputs:** `r2/logs/run-<ID>/PUBLIC-STATUS.json`, `result/out/{el-probe.json, el-requests-*.jsonl, helios-probe-*.json, scope-*.txt, state-*.txt, phase-rc.txt, invariants.txt, status.json}`, plus `stop-collect.out` and `delete.out`.

**What I did:** static checks only (`bash -n`, `node --check`, `ast.parse`). **What I did not do:** no tests, SSH or production writes. Finalization stays blocked.

## 6. Diagnostic r3: repair of the r2 probe bug root found, plus an offline fixture test (FROZEN; r1 and r2 untouched)

**The bug root found:** in r2, `el_probe.mjs` `rpc()` evaluated `JSON.stringify(params.at(-1)).slice(0, 80)` before its `try`. The first request, `eth_blockNumber`, has `params = []`, so `undefined.slice` threw and aborted the whole of phase A. r2 must not be run.

**Stage:** `guest-call-timeout-diagnostic-stage/r3/`. `SHA256SUMS` sha256 is **7e451d7eed2c94a75e1ea1641adc499189842852b6dbc44ed88bcf40168d19a9**, and the files are read-only. r2 (`5d407984…`) still verifies.

| Path (under `r3/`) | sha256 | Change from r2 |
|---|---|---|
| `guest/el_probe.mjs` | 44d5acf3e9d30d35b130573bf7b27da551d7e807e4b687d9e9180effe25c6ecf | fixed (see below) |
| `guest/helios_probe.mjs` | 5fafa9f61648973f16c40e7efadb6a410e8015e5a91bbfb36e49e41b62d8d3c3 | fixed (see below) |
| `tools/status.py` | 1cfb65f3159fd9c5bcf7e5a309a2370585ba1062588069f72e990236b63de5b8 | stricter (see below) |
| `tests/test_probes.py` | 266e245098e33cad49bba6519fa2157422c49215916ac14fabb6f15b3a764de2 | new: 7 offline fixture tests |
| `jobs/root-probe-fixture-tests.sh` | a9e5d00b5d8edaa8ef43dfc84c47acf21fe2be1511183081eb490e6355427ddd | new: queue 256, `unshare -rn` |
| `jobs/root-guest-call-diagnostic-r3.sh` | 542216efdafd7fb858166cd8c6e13f2260c84cb0e20892740f40c5b1e1b78174 | r2's job with r3 paths, plus a fixture-PASS gate |
| `README.md` | 2593bc1eaca13afcbe0530277edfab7d1008a2602e3ceff931ede5c33cf5fa2f | |
| `guest/diag.sh` | e0e16e88… | byte-identical to r2 |
| `guest/cleanup.sh` | 709b4ab9… | byte-identical to r2 |
| `guest/rpc_log_proxy.py` | f2b22d58… | byte-identical to r2 |

### Fixes

- **`el_probe.mjs`:**
  - The block summary is computed inside the guarded path by `blockOf()`: empty params give `null`, never a throw.
  - The output file is rewritten atomically (tmp, then rename) after **every** request, so a kill or timeout keeps every earlier timing.
  - `complete: true` is written only after the last step has run. An aborted probe or a missing finalized block is recorded in `incompleteReason`.
- **`helios_probe.mjs`:**
  - The same incremental flush and `complete` flag.
  - A Helios that never reports finality gets `incompleteReason`.
  - The wait is now configurable through `READY_MS`, which defaults to the same 900 s. `diag.sh` does not set it.
- **`status.py`:** a phase counts as `complete` **only** when all of these hold:
  - the runner rc is 0;
  - the probe file says `complete: true`;
  - the phase content is present: the EL's finalized block and every step timed (A), or Helios's finalized block, all four calls timed and the relay log (B).

  Anything else is reported as `incomplete: <reason>`. Probe errors and timeouts are recorded as observations. Invariant violations give exit 30.

### Fixture tests (`tests/test_probes.py`, exactly 7)

The tests run the **actual** r3 probes with node against an in-process mock JSON-RPC server on 127.0.0.1. No production endpoint is involved, and the job runs under `unshare -rn`. The keccak library is the **pinned `@noble/hashes` `sha3.js` from the frozen canary r3 bundle**, built by r3's own assembler with the R10 pins in a private mktemp dir. The 7 tests:
1. keccak("") known answer from that bundle;
2. empty params: the first `eth_blockNumber` is recorded with block `null` and no error;
3. valid responses: phase A complete with 13 timed steps, the distance, and the window-check block; the run as a whole stays incomplete while B100 is missing;
4. RPC errors are observations: the probe completes; a missing finalized block makes it incomplete;
5. after SIGKILL during a hung `eth_createAccessList`, the four earlier steps survive on disk with no `finishedAt`, and status is incomplete even with runner rc 0;
6. a Helios that never reports finality is incomplete (rc 10), never complete;
7. full success is complete (rc 0) yet still only a diagnostic: no `verdict`, `ready`, `qualified`, `passed` or `readiness` field anywhere; with PIDs never re-checked it gives rc 30.

On a pass the job writes `logs/probe-fixture-<stamp>/RESULT`, which reads `PASS probe-fixture Ran 7 r3-sums <sha of r3 SHA256SUMS>`. **The diagnostic job refuses to start without a PASS RESULT for these exact r3 bytes.**

### Root order (from `work/rpc-production-final-20261025`; nothing run by Claude)

1. The fixture test (queue 256):
   ```
   python3 -u ../claude-test-queue.py --mib 256 --log guest-call-timeout-diagnostic-stage/r3/logs/root-probe-fixture-tests.guard -- unshare -rn bash guest-call-timeout-diagnostic-stage/r3/jobs/root-probe-fixture-tests.sh
   ```
2. If it prints `PASS probe-fixture Ran 7`, run the guest diagnostic (queue 768). KVM has confirmed sequential Q=100 and Q=400 runs are fine, so:
   ```
   DIAG_VARIANTS="100 400" python3 -u ../claude-test-queue.py --mib 768 --log guest-call-timeout-diagnostic-stage/r3/logs/root-guest-call-diagnostic-r3.guard -- bash guest-call-timeout-diagnostic-stage/r3/jobs/root-guest-call-diagnostic-r3.sh
   ```

The main capture's timeouts, binary and RPC source are unchanged. The diagnostic touches only the own EL/CL, read-only. What I did: static checks only (`bash -n`, `node --check`, `ast.parse`). What I did not do: no tests, SSH or live writes. Finalization stays blocked.
