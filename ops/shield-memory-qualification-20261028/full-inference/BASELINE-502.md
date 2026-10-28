# BASELINE-502: why baseline A (56 GiB / 16 vCPU) gave HTTP 502 on the graph query

Status: source-only diagnosis, 2026-10-28, 8-turn budget. No commands, builds, VM, GPU, network or wallet use. No production logs, keys or sessions read. Only canary artifacts in `full-smoke-fw-r3/` and `full-smoke-fw-r4/` were read.

**Bottom line.** The 502 comes from the guest's own front proxy, not from the client, the tunnel or the host. The front's request to the app's local HTTP listener failed with a non-timeout error (refused, reset or closed before any response). The installed-equivalent init source prints a serial line whenever the app is OOM-restarted or exits. Neither line appears in r3 or r4. That makes it **less likely** that the app was group-OOM-killed or died on a signal, but it does **not rule it out** (see caveats C1–C3). The best-supported source hypothesis is that the request failed inside a still-running wasmtime (a Wasm trap or a host-call/backend error during the lazy model load), whose stderr goes to `/dev/null`. **OOM is not proven, and neither is any other cause.**

---

## 1. Evidence (artifacts actually read)

| # | Fact | Source |
|---|---|---|
| E1 | Client got `app_status=502`, `app_body="the app could not be reached"`, 1 request sent, pinned key, attestation/runtime/seccomp/minTCB/replay all passed | `full-smoke-fw-r4/client-0-1-fixture-0.out:1-45` |
| E2 | Guest serial's last line: `2026/10/28 07:23:31 DOM proxy: GET unreachable` | `full-smoke-fw-r4/serial-0-A.log:22` |
| E3 | Same signature in r3: `07:09:36 DOM proxy: GET unreachable`, also the last line | `full-smoke-fw-r3/serial-0-A.log:22` |
| E4 | No `DOM app restarted without model after bounded load failure` and no `DOM ERROR app exited status=` in either serial | both serial logs (23 lines each) |
| E5 | Budget `DOM Shield dynamic RAM budget: 51784 MiB, controller=enforced` (r3: 51662). Guest `memMiB=56159` | r4 serial `:2,:6` |
| E6 | `MODEL verified bytes=17559178144 … copy_verify_ms=28598`. The private tmpfs copy completed before app start | r4 serial `:10` |
| E7 | App started at 35.8 s, front serving at 35.9 s. No engine/llama/`[shielded]` load lines on serial (expected, because app stdio is `/dev/null`) | r4 serial `:20-21` |
| E8 | `HOST_DATA names no deployment`, `release: none`, `app config: none` | r4 serial `:15-17`; client `:24-25` |
| E9 | Forwarder stderr is empty | `full-smoke-fw-r4/fwd-0-A.out.err` (0 bytes) |
| E10 | (From the task, not re-read) 502 after 113.52 s; client stderr empty, exit 0; sampled guest RSS 59,906,166,784 B (55.79 GiB); host available 28.83 GB at the end; neither the 840 s client idle limit nor the 180 s front header limit was hit; workers held only CUDA contexts (~300 MB/card), with no bulk model VRAM before the failure | task statement |

E10 vs E5: 55.79 GiB host-accounted against a 54.84 GiB (56159 MiB) guest means the guest had **touched essentially all of its RAM** (the remainder is QEMU/OVMF overhead). That is a high-water mark of touched pages. It is not proof of cgroup pressure.

## 2. Source map (what produced each line)

**Version caveat.** The source read is `test-scratch/base-9fa02e1bc/isolation/m2/` (`dominit.c`, `front/`). The installed image is iso-sdshield-1c3cdbb8 with REL 5cab66e4 binaries and padgov 4c716378a. I did **not** diff this tree against 1c3cdbb8. Every serial string in E2–E7 does match this tree, but line numbers and behaviour must be re-checked against 1c3cdbb8 before anyone relies on them.

### 2.1 How the 502 is produced (front)
- `front/ready_test.go:156-158` pins the proxy's classification: a wedged upstream gives `DOM proxy: GET timeout` → **504**. A gone or closed upstream gives `DOM proxy: <METHOD> unreachable` → **502**.
- So E2 means the front's transport to the app returned an error that was **not** a timeout: connection refused, connection reset, or EOF before the response headers. Hitting the 180 s header limit would have produced `timeout`/504, which matches the task's "front 180 s limit not hit".
- 113.52 s is well under 180 s. The upstream therefore **actively failed** at about 113 s. It did not hang.

### 2.2 App lifecycle and what init would have printed (dominit.c, base-9fa02e1bc)
- The app's stdin, stdout and stderr are `/dev/null` (`dominit.c:13`, `:265-267`, `:603-604`; a failed open gives `_exit(126)`). **All wasmtime and engine stderr is suppressed by design**, including trap messages, wasi-nn backend errors, llama load lines and `[shielded]` lines. This is the "suppressed stderr" path.
- The shield cgroup has `memory.oom.group=1` (`:305`). An OOM kill therefore kills **every** member: the model loader and the dropped runtime that joined it.
- The supervisor loop records `app_oom_before = shield_oom_events()` (`:1107`). It reads the `oom` line of `memory.events` (`:308-313`).
  - If the app exits **and** `oom` increased: wait for or kill the shield pid, call `shield_disable_model()`, restart the app, and print `DOM app restarted without model after bounded load failure` (`:1123-1142`).
  - Any other app or front exit prints `DOM ERROR app|front exited status=<code or 128+sig>` (`:1146-1147`).
- The earlier load step (`:927-930`) handles a non-zero loader exit the same way, with an oom check followed by decline.

**Inference from E4 plus this source (conditional on C1–C3):** at least until the serial was captured, the app process had not exited, through OOM or otherwise. A memory-cgroup OOM kill with `oom.group=1` would have killed the runtime and triggered one of those two lines.

### 2.3 Caveats that keep OOM open
- **C1. Capture timing.** The front's line (E2) is the last serial line. If the harness tore down the VM within about 1 s of the 502, a restart line could have been lost. The shield-pid wait alone allows up to 1 s (`:1128-1129`). Check the r4 receipt and plan for the gap between the 502 and the serial close or teardown. I did not read the receipt in this pass.
- **C2. Partial OOM without a kill.** `memory.events oom` counts failures to reclaim under `memory.max`. A kernel-side charge (for example tmpfs or socket buffers) can fail with ENOMEM back to the caller **without** an OOM kill. A wasi-nn host call that receives ENOMEM, or a socket write that hits `sock_throttled`, would surface as a host error or trap inside a live wasmtime, which matches E2 and E4. Init only checks `oom` **when the app exits**, so this case leaves no trace on serial.
- **C3. Source equivalence** with 1c3cdbb8 (above).

### 2.4 Memory arithmetic for the ~51 GiB model cgroup (hypothesis only)
| Charge to the shield cgroup | Size | Basis |
|---|---|---|
| Private tmpfs verified copy (shmem, charged to the writer's cgroup, kept for the whole registration batch) | 16.35 GiB | `AUDIT.md` §1.2/§3; `LOADER.md:13` |
| Native process peak for the same compact unit-64 profile | 33.99 GiB | `AUDIT.md` §3 (native, not measured in-guest) |
| **Sum** | **≈50.34 GiB** | vs budget **50.57 GiB** (51784 MiB) |
| Page cache from reading `/dev/vda` (copy_verify, then authenticated retired-source reads on fd 199) | up to ~16 GiB, **reclaimable** | charged to the reading cgroup if buffered. I did not verify whether the loader uses O_DIRECT |

- The ~0.23 GiB margin makes cgroup pressure **plausible**. Reclaimable page cache will not cause an OOM by itself, but it would raise the `memory.events max` counter and slow the load through reclaim, which fits a long 113 s request. This is arithmetic, not evidence. Note also that the native peak already contains whatever buffers the engine uses for reading the model.
- No bulk VRAM before the failure (E10) puts the failure **before or at the first weight upload** to the workers. That is the CPU-side phase (read, verify, compact-encode), which is also the phase with the highest RAM use.

## 3. Ranked hypotheses (all source-derived; none proven)
1. **H1: request-path failure inside a live wasmtime** (Wasm trap, wasi-nn `load` error, or backend/RPC error propagated as a trap). The wasi:http server closes the connection without a response, so the front reports `unreachable`/502 (§2.1) while the process stays up (E4) and the message goes to `/dev/null`. The underlying cause could be C2-style ENOMEM, a worker/shm-ring/transport error, or an engine assertion that becomes a trap. *Fits every observation.*
2. **H2: group OOM kill whose serial line was lost** (C1). This fits the RAM arithmetic and the full-touch RSS. It is contradicted only by the missing line, and only if the serial was captured late enough.
3. **H3: native abort/signal** (an engine `abort()`, a SIGSEGV/SIGBUS in the runtime, or the shield helper killed). This would print `DOM ERROR app exited status=13x` unless C1 applies. It is no better supported than H2.
4. **H4: front or transport defect between the front and the app** (local listener or port mismatch). This is unlikely: the readiness path passed and the same front served attestation. It is also not timing-consistent, because a refused connection would fail immediately, not after 113 s.

## 4. Existing safe, attested diagnostic you can use without any source change
**Post-502 re-attestation (attestation only, no app request).** Proof:
- The client's runtime self-test is "measured at this attestation" and enumerates **every process with an address space**: `evidence: the scan covered every process … (4: runtime=1, root=3)` and `RESULT runtime_selftest="… maps=4 runtime=1 root=3 … scope=all-processes"` (`client-0-1-fixture-0.out:6-8,31`). The client describes it as "the measured front's own word, relayed over this attested connection" (`:9`). It is a front statement, not a hardware claim.
- Run a **second attestation-only pass** against the same canary guest after the 502 (the same client with no app request, if its flags allow that; I did not check). Read the result as follows:
  - `runtime=1` plus no restart or exit line on serial → the app is alive and was not group-OOM-killed (`oom.group=1` would have removed it). That excludes H2 and H3 and points to H1.
  - `runtime=0`, a changed count, or a new serial line → the app died (H2/H3). Serial then separates them: an OOM restart line versus `exited status=128+sig`.
- It exposes no tenant content, needs no image change, and leaves every security check unchanged. Its limit: it cannot separate H1's sub-causes (trap vs ENOMEM vs backend).

Second free signal: **host-side canary worker journals** (non-production canary workers only) for the same 113 s window. A worker-side RPC, ring or shm error would point to H1-backend. Clean workers with no upload attempt would point to a CPU-side failure (H1-ENOMEM/trap, or H2).

## 5. Smallest canary-only diagnostic that separates all three (needs a canary image; nothing here is authorized yet)
This needs a **canary-only** init build. It changes the canary's measurement only. Production images, the allowlist, seccomp, minTCB and the attestation checks stay untouched, and it must never be promoted. In `dominit.c`'s supervisor loop:
1. **Watch the cgroup without reading tenant data.** Every 5 s after app start, and once on any app exit, print one line with **numbers only**: `DOM canary cg current=<memory.current> peak=<memory.peak> ev=<low,high,max,oom,oom_kill,oom_group_kill,sock_throttled> app_alive=<0|1>`. This is the same field set the bench init already emits and parses (`bench-harness/init/main.go:396-400`; format in `bench-run-r1/serial-B.log:15,17`), so the parser and tests already exist. This separates **OOM** (`oom_kill`>0), **pressure without a kill** (`max`>0 or `oom`>0 with `oom_kill`=0, i.e. C2), and **no pressure**.
2. **Count stderr instead of discarding it.** Replace the `/dev/null` dup on fd 2 (`:603-604`) with a pipe that init drains and **discards**, emitting only `DOM canary app-stderr bytes=<n> lines=<n>` on each tick. No content is printed, so tenant text cannot leak. `bytes>0` at the moment of the 502, with the app alive, separates **trap/host-error (H1)** from a silent transport close (H4).
3. **Report the exit form.** The existing `exited status=128+sig` line already covers **abort/signal (H3)**. Additionally flush serial before any shutdown so C1 cannot hide the line.

Decision table for one canary run:
| oom_kill | max/oom w/o kill | app_alive after 502 | stderr bytes at 502 | Verdict |
|---|---|---|---|---|
| >0 | – | 0 then restarted | – | memory-cgroup OOM (H2) |
| 0 | >0 | 1 | >0 | allocation failure surfaced as a host error/trap (H1-ENOMEM) |
| 0 | 0 | 1 | >0 | trap or backend error, not memory (H1); then check worker journals |
| 0 | 0 | 0, status 128+sig | – | native abort/signal (H3) |
| 0 | 0 | 1 | 0 | front↔app transport (H4) |

If a canary image is not acceptable, run §4 (re-attestation plus worker journals). It answers H2/H3 versus H1 at zero source cost.

## 6. Not covered in this pass (turn budget), and not re-proposed
- I did **not** read the harness unit, model, ring or shim profile (in-place vsock-only, private worker shm rings, worker context sharing). Those configuration-defect checks are still open and are the next read for H1-backend. Workers showing only CUDA contexts is consistent with a failure before the upload. It neither confirms nor excludes a ring or shm misconfiguration.
- I did not open the wasmtime wasi:http serve source to confirm "trap → connection closed without response". §3 H1 relies on the front's classification test and general wasmtime behaviour, not on reading the 49.0.0 source.
- I did not verify the loader's O_DIRECT use (page-cache charge in §2.4).
- Already done and not revisited: the graph fix (68 tests), startup, the client timeout (13+75), and the 18 GiB floors and admin controls (unchanged by anything here).
- The full B-only r5 was never launched: the production image lease expired, gas was unaffordable, and the normal controller claimed Qwen 65049 MiB pending at 80% GPU. Everything above is gated on a dedicated canary slot with no local GPU contention.
