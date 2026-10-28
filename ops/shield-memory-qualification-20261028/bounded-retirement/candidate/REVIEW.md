# Candidate: opt-in bounded deferred retirement of private originals

Date: 2026-10-28. **Source only.** Read/Grep/Glob/Write only.
- Nothing was compiled or run. **No test result exists.**
- No commands, network, GPU, VM, service, production, config or finance actions were taken.
- I made no edits to the padgov worktrees or production.
- I read no credentials, keys, session configs, prompts or app logs.

Labels:
- **[src]** comes from source I read.
- **[obs]** comes from `steady-memory-r1/host-memory.json` or `allocator-lines.txt`.
- **[doc]** is an older repo document, not current production evidence.
- **[est]** is my inference.

`PG` = `/home/steven/Projects/enclave/.consolidation/2026-10-24/worktrees/enclave-padgov`. It is assumed, not proven, to be the source of the deployed shim. The deployed `libenclave_llama.so` has not been shown to be reproducible from it.

## Verdict

The candidate is defensible as an opt-in, with its default left exactly as it is today. It is implemented here as isolated copies:

| File | What it is |
|---|---|
| `shield-original-source.hpp` | Patched copy of `PG/wasm/llama-shim/shield-original-source.hpp` |
| `enclave_shield_loader.cpp` | Patched copy of `PG/wasm/llama-shim/enclave_shield_loader.cpp` |
| `bounded-retirement.patch` | Hand-written unified diff of the two files above. The copies are authoritative. Check the patch with the command in §7 |
| `test_bounded_retirement.cpp` | C++ tests on real tmpfs files (memfd), with real hole punching and real SHA-256 |

What it changes and doesn't change:
- It does not change steady-state RAM or inference. It can only lower the **load-time high-water mark**, and on this host the high-water mark *is* the host footprint.
- I wired no env to a marker, init or release. Without `ENCLAVE_SHIELD_SOURCE_RETIRE_BUDGET_MIB`, behaviour is the current deferred behaviour.

## 1. Why the high-water mark is the target [obs]

`host-memory.json` (guest gdc03538eb, 2026-10-28T08:55Z) after warmup:

| Field | Bytes | GiB |
|---|---|---|
| `memory.current` | 63,019,995,136 | 58.69 |
| `memory.peak` | 63,020,384,256 | 58.69 |
| `file` | 62,574,919,680 | — |
| `unevictable` | 62,278,172,672 | 58.00 |
| `anon` | 163 MB | — |

- Peak ≈ current, so guest pages the host has backed are never given back. The footprint equals the guest's touched-page high-water mark.
- Guest `memMiB=62857`; the footprint is below it. That is consistent with lazily accepted memory [est]. Under lazy acceptance the guest kernel reuses freed pages before it accepts new ones [est]. This is the only reason freeing pages *earlier* can matter.
- `allocator-lines.txt` shows that loader af50d526 already advises DONTNEED on the whole `/dev/vda` copy (`source_dontneed_advised_bytes=17559178144`). So the page-cache residue (AUDIT §2 #3) is already addressed.
- What remains in the load-time peak is the private tmpfs copy being kept through the registration batch.

## 2. Lifetime trace (current source) [src]

1. `shieldmodel` writes the verified 17,559,178,144 B private tmpfs copy (fd 198).
2. Loader `enclave_shield_loader.cpp:104-132`: for **every** tensor, `add()` hashes its private bytes into the table (`shield-original-source.hpp:56-70`). This happens before `llama_model_load_from_file` returns, so the table is complete before any registration.
   - CPU tensors get addresses in one `MAP_SHARED PROT_READ` mapping of the private tmpfs (`:91-97,121-130`).
   - GPU candidates get guarded source buffers (`:117-120`).
   - `defer_retirement = true` (`:100`).
3. Registration runs at context creation (`ggml-shielded.cpp:1087-1090`), batched by `sh_plan`. Per weight and card, `sh_register`:
   - reads the **whole tensor** into a direct-mmap private buffer (`:1055-1063`);
   - verifies its SHA-256 against the table (`:1067-1068`);
   - encodes into `e.w` (K×N int8) and `f_w` (`:1085-1091`);
   - frees the private copy (`:1101`);
   - then builds the long-lived compact/encoded store.
4. `read()` marks the entry `consumed` and, while deferring, returns without punching (`hpp:110-115`).
5. At the end of the batch, `sh_release_consumed_sources` (`ggml-shielded.cpp:361-369`, called at `:1401` and `:1440`) runs `release_consumed`, which punches the interiors of every consumed tensor. A failure latches all cards closed.
6. After that, any read of a retired tensor goes to the public fd 199 with DONTNEED and must pass the same full-tensor SHA-256 (`hpp:105-109`).

So during the batch, all ~16.35 GiB of the private copy is resident at the same time as the encoded weights being built (~22 GiB [doc]). The 14.67 GiB of GPU-source interiors [doc] only become free after the batch.

## 3. Safety analysis: is retirement during the read safe?

**Cross-card reads.**
- Production init sets `SHIELDED_SPLIT_COLS=1` (`PGI/isolation/m2/dominit.c:659`).
- The split planner then calls `sh_register` for card 0, then card 1, … on the **same** weight back to back. Each call reads the full tensor (`ggml-shielded.cpp:1374-1381`). Nothing else reads sources in between.
- The candidate never retires the entry that was just read (`keep`). So the next card's read of the same tensor is still private.
- The tests confirm `reread_bytes == 0` through the batch. Even with no `keep` rule, an early-retired tensor would be reread from fd 199 and authenticated. That is slower, but not a security change.

**Prefetch.**
- `SHIELDED_SOURCE_PREFETCH=1` is not set by production init.
- If it is set, one reader thread reads the *next* tensor while the current one is verified and encoded (`ggml-shielded.cpp:1049-1066`). That read may retire the current tensor's file pages.
- This is safe: the current bytes are already in a private buffer, and `verify` hashes that buffer, never the file.
- `read`, `retire` and `release_consumed` all run under `s.mu`, so a punch never overlaps a private read of the same range.

**Later verification.**
- Retired reads use backing fd 199 and the unchanged full-tensor verifier. The table was built entirely from private bytes before the first punch (§2.2).
- Tests cover repeated rereads (each one reauthenticated), corruption of backing (refused by `verify`) and truncation (`read` fails).

**CPU tensor boundaries.**
- `retire()` is unchanged: it punches only whole interior pages of a consumed GPU-source tensor.
- The tests interleave CPU tensors that share boundary pages, and check their bytes through both `pread` and the `MAP_SHARED` mapping after every retirement.
- Punched interiors read as zero, and nothing maps them as CPU tensors.

**Copy ownership.** Unchanged. The backend owns the private destination. Retirement touches only the tmpfs file.

**Failure paths.**

| Case | Result |
|---|---|
| A punch fails inside `read()` | `read()` returns −1 → `sh_source_read_for_registration` latches `failed` (`shielded-weight-source.h:42-50`) → authentication failure → load aborted (`ggml-shielded.cpp:1076-1080`, `:1380`, `:1431-1435`) |
| Accounting overflow | Returns −1 before the entry is marked consumed |
| Invalid env | The loader throws before opening descriptors, and the load is refused |
| `release_consumed` failure | Handled as today |

**Batch final flush.** Unchanged. It retires whatever is still consumed and clears the accounting.

**Catalog hits** (`g_encoded_source`) never call `read()`, so they are never consumed and never retired. Same as today.

**Split-slice refusal fallback** (the weight goes local, `:1383-1388`). Later CPU fallback reads already go to backing with verification after today's flush. Bounded retirement only moves that earlier inside the batch.

**Pre-existing, not introduced.**
- Neither the default flush nor this candidate checks that tensor extents don't overlap.
- A malformed GGUF with overlapping extents could have an unconsumed tensor's bytes punched. The pinned digest makes this a non-issue for the pinned model.
- A one-line overlap refusal in the loader would be a cheap hardening. It is not included, to keep this patch minimal.

## 4. Design (exact semantics)

- `retire_budget == 0` (default, env unset or empty): identical behaviour. Specifically:
  - the new branch is skipped;
  - `retire_over_budget` loops zero times;
  - `release_consumed` additionally clears an already-empty deque.
- With `retire_budget > 0`, only while `defer_retirement`:
  - The first private read of an entry appends it to a FIFO and adds `e.size` to `unretired_bytes`. Overflow is checked.
  - After each private read, the oldest entries other than the one just read are retired until `unretired_bytes <= retire_budget`.
  - Invariant (tested): `unretired_bytes <= max(budget, size of the tensor just read)`.
- The budget counts logical tensor bytes. Boundary pages are never punched, so slightly fewer bytes are freed than are counted.
- Env `ENCLAVE_SHIELD_SOURCE_RETIRE_BUDGET_MIB`:
  - Accepts plain decimal MiB in [64, 65536], i.e. 64 MiB to 64 GiB.
  - Rejects `0`, leading zeros, signs, whitespace, suffixes, hex, exponents, newlines and more than 5 digits. A rejected value refuses the load.
  - Not wired to any marker or init yet.
- Immediate mode (`defer_retirement=false`) ignores the budget.

## 5. Expected effect [est, unmeasured]

Notation:
- `E` = encoded weights (~22 GiB [doc])
- `T` = per-tensor transients
- `K` = allocations made after the batch (KV ~4.15 GiB plus pads ~4.7 GiB, both [est])
- `B` = budget
- `t` = largest tensor

Current high-water ≈ base + E + max(16.35 + T, 1.68 + K).
Candidate high-water ≈ base + E + max(1.68 + B + t + T, 1.68 + K).

Two cases:
- **K is allocated after registration:** saving ≈ 16.35 − 1.68 − K ≈ **5–6 GiB**, for any B up to about K − t − T. This agrees with the only prior evidence: immediate retirement saved ~13.6 GiB against deferred ~8.0 GiB [doc, 2026-09-29, older release, `shield-original-weight-reclamation.md:119-131`].
- **K is allocated before registration** (still unresolved, AUDIT §7): saving ≈ 14.67 − B − t GiB.

These assume the guest kernel reuses the freed tmpfs pages for the encoded allocations; that reuse is not guaranteed. 256 MiB and 1 GiB should behave about the same in the first case. Prefer 1 GiB for the first bench (fewer punches interleaved with encoding).

Not affected: steady-state RAM, encoded-weight size, KV, pads, tok/s mechanism.

## 6. Performance risks (must be benched)

- **Placement of encoded weights.** They will now land on pages recycled from tmpfs. The doc attributes 14.4–15.1 tok/s in immediate variants to this. The same doc shows the unchanged baseline itself drifting from 16.6 to 14.9, so causality is unproven. Gate on decode tok/s against an adjacent control.
- **Punch timing.** The same ~408 punches happen during the batch instead of in one sweep, under `s.mu`. Load-time cost only.
- **No new device reads are expected** in the split or prefetch paths. The `reread_bytes` counter is not logged anywhere today. A bench build should print it at release time, or the bench cannot prove "0 rereads during the batch". Not added here, to keep the patch minimal.

## 7. Exact bounded commands (not run)

Unit tests (needs g++, libcrypto headers, and memfd with `shmem_enabled=never` or `advise`; huge tmpfs pages would break the block arithmetic and the fixture says so):

```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/shield-memory-20261028/steady-memory-r1/candidate
timeout 180 g++ -std=c++17 -O1 -g -Wall -Wextra -Wno-deprecated-declarations \
  -fsanitize=address,undefined -fno-sanitize-recover=undefined -fno-omit-frame-pointer \
  -I. test_bounded_retirement.cpp -lcrypto -o /tmp/test_bounded_retirement
timeout 60 /tmp/test_bounded_retirement      # expects: "bounded retirement: all checks passed"
```

Patch consistency against the original worktree, in a scratch directory (no worktree edits):

```
tmp=$(mktemp -d) && mkdir -p "$tmp/wasm/llama-shim" && \
cp /home/steven/Projects/enclave/.consolidation/2026-10-24/worktrees/enclave-padgov/wasm/llama-shim/{shield-original-source.hpp,enclave_shield_loader.cpp} "$tmp/wasm/llama-shim/" && \
(cd "$tmp" && timeout 30 patch -p1 --dry-run < "$OLDPWD/bounded-retirement.patch" && timeout 30 patch -p1 < "$OLDPWD/bounded-retirement.patch") && \
diff "$tmp/wasm/llama-shim/shield-original-source.hpp" shield-original-source.hpp && \
diff "$tmp/wasm/llama-shim/enclave_shield_loader.cpp" enclave_shield_loader.cpp && echo patch-consistent
```

The loader `.cpp` needs the pinned llama/ggml/ggml-shielded headers, so I gave no compile command for it. Its change is 6 lines and was reviewed by reading only.

## 8. Test coverage → requirement

| Requirement | Test |
|---|---|
| Default retains until flush; unread sources stay private | `test_default_retains_until_flush` |
| Bounded: expected retirement order; released bytes = sum of page interiors = tmpfs `st_blocks` drop; holes read as zero | `test_bounded_budget_accounting`, `check_state` |
| Neighbouring CPU bytes unchanged (`pread` and `MAP_SHARED`) | `check_state` after every step |
| Adjacent cross-card read without a reread; non-adjacent reread reauthenticates each time | `test_tiny_budget_rereads_authenticate` |
| Corruption detected; corruption under a still-private tensor ignored | same |
| Truncation fails closed | same |
| Punch failure fails closed (read-only private fd) | `test_retire_failure_fails_closed` |
| Accounting overflow rejected | `test_accounting_overflow_refused` |
| Lookup mismatch rejected and not consumed | `test_lookup_mismatch_refused` |
| Immediate mode unchanged | `test_immediate_mode_unchanged` |
| Unreasonable env rejected | `test_budget_parsing` |

## 9. Limitations

- Untested and uncompiled: there was no execution tool. The patch was written by hand, so check it with the command in §7.
- The deployed shim's source and reproducibility from padgov 4c716378a are not established. Port this onto the exact source of the deployed shim before any bench.
- Any rebuilt shim changes the release measurement, even with the env unset. It must be predicted and admitted independently. It is not a hot swap.
- The expected saving is an estimate. Page reuse under lazy acceptance and the timing of KV/pad allocation relative to registration are unverified.
- Production uses `SPLIT_COLS=1`. The `keep` argument for zero rereads relies on the per-weight card loop staying adjacent (`ggml-shielded.cpp:1374-1381`). A future planner that interleaves weights across cards would cause authenticated rereads. That costs speed, not safety.
- The env is read from the runtime environment. If any app-config path can inject env into the runtime, a tenant could choose this memory/performance trade-off. It does not affect authentication. Confirm before wiring.

## 10. Next step (gated; not performed)

Bench on the SNP bench host only. Production stays untouched.
- **A:** af50d526 as-is.
- **B1024:** a shim built from the deployed source plus this patch, with a bench-only init setting `ENCLAVE_SHIELD_SOURCE_RETIRE_BUDGET_MIB=1024`.
- Add a bench-only `reread_bytes` log line.

Measure for each arm:
- host `memory.peak`;
- `released_bytes` and `reread_bytes`;
- cold-start time;
- decode tok/s against an adjacent A, ≥2 boots each.

Pass requires:
- `reread_bytes == 0` during the batch;
- identical token IDs on fixed public prompts;
- tok/s within the owner's bound.

Only after that should env-to-marker wiring be considered.
