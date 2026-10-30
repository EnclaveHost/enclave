# Diagnosis: bounded-retirement canary 1da34434 (guest gd6d5c8224), app status 139 during GPU warmup

Date: 2026-10-28. **Read-only source diagnosis.** I did not compile, execute, mutate, touch production or use the network. I did not try to retrieve app stderr or core dumps. **The root cause is not established.** Nothing below says it was OOM, pad or auth.

Path abbreviations:
- `C` = `shield-memory-20261028/steady-memory-r1/candidate/`, the candidate copies. Line numbers refer to these copies.
- `PG` = `/home/steven/Projects/enclave/.consolidation/2026-10-24/worktrees/enclave-padgov/wasm/`, the original shim and Shielded backend.
- `FE` = `steady-memory-r1/failure-evidence/`
- `IRP` = `steady-memory-r1/init-release-prep/`

Note: the retained `engine-src` tree (`enclave-bench/shield-original-reclaim-20260929/build/`) has an **older** backend. It has no `sh_release_consumed_sources`; its only source read is `backend-src/ggml-shielded.cpp:1038`. So I traced callbacks against `PG/ggml-shielded/`, which matches the shim's ABI (`set_source_release`). I have not proven that `PG` is the deployed backend's exact source.

## 0. Evidence used

- `FE/RESULT.md`: attestation, image, whole-model authentication and TLS all succeeded. The app then exited with status 139 during warmup. 87 bytes of output were withheld.
- `FE/gd6d5c8224.serial`: `:22` "DOM warmup: started", `:43` "DOM ERROR app exited status=139", `:45` "warmup: response failed". `:6` shows the dynamic RAM budget was 58093 MiB, enforced.
- `FE/memory-summary.json`: `memory.peak` 50,819,276,800 B (47.33 GiB). All memory.events counters are 0 (oom, oom_kill, max). The baseline peak recorded in candidate REVIEW §1 was 58.69 GiB, so **the intended load-peak reduction appears to have happened.**
- `FE/unit-journal.txt:2`: wall clock 7 min 8.7 s, 47.3G memory peak.
- `IRP/shield-retire-marker.h:12-13`: the marker turns into exactly `ENCLAVE_SHIELD_SOURCE_RETIRE_BUDGET_MIB=1024`, so the production budget was 1 GiB.

## 1. Every way the engine or backend reaches the candidate's source callbacks

The loader binds three callbacks. All of them are in `C/enclave_shield_loader.cpp`:

| Callback | Bound at | Who calls it | When |
|---|---|---|---|
| `verify` | `:102` | `PG/ggml-shielded/ggml-shielded.cpp:1067`; `shielded-weight-source.h:81` | At registration, and on every `get_tensor` |
| `release_consumed` | `:105` | `ggml-shielded.cpp:361-369`, called at `:1401` (split) and `:1440` (non-split) | At the end of each `sh_plan` batch, **including late batches** |
| `read` | `:124` (one per GPU-candidate tensor) | `shielded-weight-source.h:36`. It is reached from (a) `sh_source_read_for_registration` `:42-50` → `ggml-shielded.cpp:1062`; (b) `sh_source_get` `:65-90`, i.e. any `ggml_backend_tensor_get` on a source weight; (c) the prefetch thread `shielded-source-prefetch.h:37`, which production does not enable | (a) registration; (b) any time, including during inference |

Facts about tensor data pointers:
- For a GPU-candidate tensor, `t->data` is the buffer's `guard`. The guard is an anonymous **`PROT_NONE`** mapping (`shielded-weight-source.h:121`, set at `:131`), not file memory.
- The buffer is non-host (`:94`), so ggml reaches the bytes only through `get_tensor`. The Shielded device also accepts this buffer type (`ggml-shielded.cpp:3091-3092`).
- CPU tensors point into the `MAP_SHARED PROT_READ` private mapping (`C/enclave_shield_loader.cpp:94-97,131-134`).
- `retire()` punches only whole pages inside consumed GPU-candidate extents (`C/shield-original-source.hpp:76-86`).
- **No pointer into a punched range exists anywhere in the traced code.**

Readback after registration:
- The private copy is freed at `ggml-shielded.cpp:1101`. Later compute uses encoded rows (`sh_local_products` `:2063`) or the link.
- The only routes back to the original bytes are `sh_source_get`, which reads and verifies the whole tensor and otherwise calls `GGML_ABORT` (`:85-88`), and `sh_plain_mul_mat` (§3).

## 2. What the candidate actually changes at runtime

`defer_retirement` is set once (`loader.cpp:103`) and **never cleared**. So the new branch (`hpp:148-152,158`) runs on **every** first private read of an entry, not only during registration batches.

1. **During a registration batch.** Entries leave private storage earlier, oldest first, keeping 1 GiB plus the tensor just read.
   - Split mode reads the same weight once per card, back to back (`ggml-shielded.cpp:1374-1381`), and `keep` protects it (`hpp:93`). So no reread is expected.
   - In both versions, `release_consumed` (`hpp:118-129`) leaves the file in the same state after the batch: every consumed entry retired, deque cleared.
2. **Between batches** (a `get_tensor` on a never-consumed source weight, through `sh_source_get`):
   - Baseline marks the entry consumed and keeps it private until the next batch release, which may never happen.
   - The candidate queues it, and once more than 1 GiB is queued it punches older out-of-batch entries. Later `get_tensor` calls on those entries go to backing fd 199 and run a full-tensor SHA-256 (`hpp:142-146`, `weight-source.h:79-82`).
   - This changes speed, not bytes.
3. **New failure points inside `read()`:**
   - a `fallocate` failure while retiring an *older* entry (`hpp:95`, reached from `:158`);
   - the overflow check (`:149`);
   - `std::bad_alloc` from `deque::push_back` (`:151`).

   Any of these makes `read()` fail **for the tensor being read**:
   - At registration this latches `failed` on that tensor's source (`weight-source.h:48`) and aborts the batch. In split mode this happens at `ggml-shielded.cpp:1380`, which returns before `sh_release_consumed_sources`.
   - In `sh_source_get` it calls `GGML_ABORT` (`:87`). That gives SIGABRT, i.e. **status 134, not 139.**

Implication: every fail-closed path the candidate adds ends in either a clean load refusal or `abort()`. **None of them is itself a SIGSEGV.**

## 3. A concrete SIGSEGV-capable path in the code that exists today (not added by the candidate)

`sh_plain_mul_mat` (`ggml-shielded.cpp:1968`) dereferences `w->data` directly (`:1989` and `:2004`). For a weight-source tensor, `w->data` is the `PROT_NONE` guard, so this faults with SIGSEGV, i.e. status 139.

Its callers:
- `:2402`: "claimed but not registered; computing it in the enclave"
- `:2767`: split exchange unavailable. Only reached when there is no verifier, so not production.
- `:2867`: "offload and local path both failed"
- `:2981`: I did not read its guarding context.

Weights that are claimed but not yet registered can be queued during compute (`:1488-1490`, `:2951-2958`). The backend also expects late registration during warmup or MTP drafting (`:1207-1214`).

**Whether the candidate makes this path reachable is unproven.** The candidate cannot change what a successful `read()` returns, since bytes are either private or authenticated backing bytes. It can only change registration outcomes through the §2.3 failure points, or through timing. I have not traced the code between a latched `source_verification_failed` or refused weight and `:2402`/`:2981` (limitation L3).

## 4. Undefined behaviour and lifetime review of the new code

I found no UB.
- **`std::deque<entry *>`** (`hpp:36`):
  - Elements point to `std::map` values. These are stable: the map is never erased, insertion does not invalidate them, and every `add()` (`loader.cpp:122`) finishes before `ell_shield_load_model` returns.
  - `erase(it)` returns a valid iterator, and the `keep` branch advances it (`hpp:91-100`).
  - `unretired_bytes` cannot underflow. An entry is pushed only when `!consumed`, and `consumed` is set straight afterwards (`:148-153`), so each size is added exactly once.
  - `release_consumed` clears the deque and the byte count together (`:127`).
- **Locking:**
  - `read`, `retire_over_budget` and `release_consumed` all run under `s.mu` (`:120,139`).
  - `verify` (`:130-136`) does not lock. It only reads fields that never change after load (`type/ne/size/digest`), through `find` on a map whose structure no longer changes. It never touches `retired` or `consumed`. No data race.
- **Layout and ABI:**
  - `shield_original_source` is a member of `loader_state` (`loader.cpp:15-16`), which is created with `new` and value-initialised (`:63`).
  - The backend receives only an opaque `void *ctx` and passes it back to the shim's own static functions.
  - `enclave_llama.c` uses only the `ell_*` externs (`PG/llama-shim/enclave_llama.c:190-235`). No other translation unit includes the header (grep across `PG/wasm`), so the added members cannot cause an ODR or layout mismatch.
  - No `memset` is applied to this struct. `entry e{}` is aggregate value-initialisation (`hpp:64`).
  - **There is no `Region` type in the candidate, loader or `shielded-weight-source.h`.** If the brief means a type from another file, I could not find it, so I did not assess it.
- **Static and global lifetime:**
  - The global `std::unique_ptr<loader_state> state` (`loader.cpp:27`) is destroyed at exit. That frees the source buffers (`:20-23`, then `weight-source.h:23,51`).
  - Destroying the deque at that point is trivial.
  - The ordering hazard where exit happens while backend threads are still live existed before and is unchanged.
- **Weak spot, not UB:** if `push_back` throws after `unretired_bytes += e.size` (`hpp:150-151`), the counter overstates by `e.size`.
  - Later reads would then retire everything except `keep`, causing more rereads.
  - The failing read itself fails closed through `catch(...)` (`weight-source.h:47`, `:83`).
  - The same throw inside `sh_source_get` would call `GGML_ABORT`, giving status 134, not 139.
- **The env parser** (`hpp:105-117`) is bounded: at most 5 digits, ≤ 65536 is checked before `<< 20`, leading zeros are rejected.

## 5. Candidate explanations, ranked (none proven)

1. **A latent backend or engine fault, exposed by the different memory or timing profile.** The peak was 47.33 GiB against a 58.69 GiB baseline: pages from tmpfs are recycled into encoded weights and other allocations, and punches happen in the middle of the batch.
   - This is consistent with status 139, zero OOM counters, and the crash happening late (about 1700/4339 warmup tokens, about 402 s), long after registration.
   - It has the weakest source-specific support. I have not read any engine code that depends on page placement.
2. **The `sh_plain_mul_mat` guard dereference** (§3). It is the only concrete SIGSEGV mechanism I found on a source-weight path. For it to explain this failure, some weight has to end up claimed but unregistered, or both its offload and local paths have to fail, during warmup.
   - The candidate would have to cause that, through a §2.3 failure in a **late** registration batch or a timing change. I have no evidence of either.
3. **Out-of-batch `get_tensor` rereads** (§2.2). These are now slower and run a full SHA each time. They would change warmup timing, which could expose a race such as link quiesce or reconnect at `:1213-1214`.
   - Any direct failure here aborts with status 134, not 139, so this can only be an indirect cause.
4. **A crash that has nothing to do with the candidate,** for example a nondeterministic warmup fault in the baseline. I have no count of baseline warmups at this RAM budget to rule it out.
5. **UB in the candidate's own code.** I found none (§4). Lowest rank.

## 6. Minimal CPU reproduction proposal (not run, no patch written)

The goal is to tell 1–3 apart without a GPU. Use an existing native fixture style (`PG/../test/fixtures/shielded-weight-verifier.cpp:128`, `shielded-source-prefetch.cpp:79,101`).

1. **Callback-level, ASan/UBSan, with the header unchanged:**
   - Drive `read`/`verify`/`release_consumed` the way the backend does: per-card back-to-back split reads, then `release_consumed`, then a **second late batch**, then interleaved `get_tensor`-style whole-tensor reads of entries that were never consumed.
   - Use budget = 64 and 1024 MiB.
   - Assert: bytes always verify; `reread_bytes` is 0 inside batches; the deque is empty after each release.
   - This extends §8 of the candidate REVIEW to the out-of-batch path, which it did not cover.
2. **Guard-dereference probe (hypothesis 2):**
   - Build a minimal CPU-only graph on the `PG` Shielded backend with one weight-source Q8_0 tensor that the device claims (`sh_claimable`) but whose registration is refused. Refuse it by making its `read()` fail on a late batch, e.g. a read-only private fd so `fallocate` fails (as `test_retire_failure_fails_closed` already does).
   - Compute once. If it SIGSEGVs at `ggml-shielded.cpp:1989`/`:2004` instead of refusing or aborting, the mechanism exists. Run it with the candidate and with the original header.
3. **Small-model end to end on CPU:**
   - Arm A: env unset. Arm B: `RETIRE_BUDGET_MIB=64`.
   - Use the loader plus the Shielded backend under ASan with a small public GGUF (the 0.5B referred to at `ggml-shielded.cpp:1090`), the dealer/loopback link if a CPU worker exists, and `SHIELDED_SPLIT_COLS=1` with two loopback cards.
   - Run a warmup longer than 4339 tokens with mixed ubatch widths, plus MTP drafting if the model has it.
   - Log `ggml_backend_shielded_weight_source_stats` (`weight-source.h:9`), `released_bytes` and `reread_bytes`.
   - If only B crashes or shows ASan reports, the candidate's runtime differences (§2.2/2.3) are implicated. If neither does, hypothesis 1 (GPU or page placement) remains and needs the bench host, which is not proposed here.

## 7. Limitations

- **L1.** No execution. Native ASan/UBSan results are the root's (9 groups). Nothing here exercised the candidate with GPU inference.
- **L2.** App stderr (87 B) and core dumps were withheld and not sought. So I cannot tell which of `:2402`, `:2867`, `:2981` or `GGML_ABORT` ran, if any.
  - If policy allows, the root could check a **sanitised** indicator (message class only) for "claimed but not registered", "offload and local path both failed" and "authenticated weight source read failed".
- **L3.** I did not read the contexts around `ggml-shielded.cpp:2380-2402`, `:2960-2981`, the latch handling after a failed late batch, the llama.cpp scheduler's weight-copy path, or the pad and dynamic-RAM controller.
- **L4.** The backend was traced in `PG`, not in the retained `engine-src` (older backend). The byte-reproduction of the installed shim is the root's claim; I did not verify it. I compared the candidate with `PG` only through the hunks and line offsets in `C/bounded-retirement.patch`, not with a byte diff.
- **L5.** I could not compare against baseline af50d526 warmup repeat counts or timing at this RAM budget.
- **Security properties preserved by the candidate source (unchanged):**
  - exact name, type, ne and size lookup (`hpp:54-60`);
  - SHA-256 digest built only from private bytes before any punch;
  - a full verify on every reread;
  - the backend latches.
  - I found no path that reads a retired source without verifying it, or rebuilds one unsafely. One-use pad handling is in the backend and link and is not touched by this change.
