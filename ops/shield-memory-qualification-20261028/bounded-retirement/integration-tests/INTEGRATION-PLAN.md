# Integration plan: bounded deferred retirement × exact backend (CPU, synthetic)

Date: 2026-10-28. **Source only.** I compiled nothing and ran nothing. **No test results exist.** The fixture has never been compiled, so expect to fix a few compile or assert issues the first time it is built (see §6).

Constraints I kept to:
- I wrote files only in this directory.
- I made no production, config, memory or app changes.
- I did not read any keys, model files or app/model memory.
- Nothing here asserts a cause for status 139.

## 1. What was written

| File | Purpose |
|---|---|
| `test/fixtures/bounded-retirement-integration.cpp` | New fixture. It includes the exact backend `ggml-shielded.cpp` and the **unchanged** `../candidate/shield-original-source.hpp`, and drives them together. |
| `test/bounded-retirement-integration.test.mjs` | Runner. Builds with ASan/UBSan, `-O0 -g0`, `-DGGML_MAX_NAME=128`, and runs 11 scenarios. |
| `INTEGRATION-PLAN.md` | This file. |

**Source changes:**
- None to production, the backend, the candidate header, the loader or the parser.
- The fixture includes the backend source as is. It does not copy or patch it.

**Callbacks.** The backend receives thin observer callbacks: `observe_read`, `observe_verify` and `observe_release`.
- Each one calls the candidate's `shield_original_source::read`, `::verify` or `::release_consumed` and returns that result unchanged.
- They only record events and add assertions.
- Verification is not weakened, and no return code is altered.

## 2. Exact inputs

**Backend source.** Read in place from `../backend-rebuild-r1/src` (no staging copy).
- The runner first checks sha256 of **every** file listed in `RESULT.json.sourceHashes` and fails on any mismatch.
- It also checks that `byteIdentical == true`.
- Include resolution: `-I ../backend-rebuild-r1/src` comes first, so `#include "ggml-shielded.cpp"` gets the exact source, and its own quoted headers resolve next to it.
- The fixture does **not** include `../backend-verifier-tests-r1/wasm/...`. That tree was not re-hashed here.

**Candidate.** `-I ../candidate`, `#include "shield-original-source.hpp"`.
- The file is unchanged. The runner prints its sha256 for the record. I have no reference hash for it.
- It needs OpenSSL headers and `-lcrypto`. `-Wno-deprecated-declarations` is added because of `SHA256_Init`.

**Engine paths.** Taken from `RESULT.json.argv` unless overridden by env:

| Variable | Default (from RESULT.json) |
|---|---|
| `GGML_SRC` | `/home/steven/enclave-bench/shield-original-reclaim-20260929/build/engine-src` (needs `ggml/include`, `ggml/src`) |
| `GGML_LIB` | `/home/steven/enclave-bench/shield-original-reclaim-20260929/build/engine-build/bin` (`libggml{,-cpu,-base}.so`) |
| compact root | `/home/steven/enclave-bench/shield-compact-production-20260930/onednn-wx/install` |

The compact root can be overridden with `SHIELDED_COMPACT_TEST_ROOT`. Setting it to empty skips the compact scenarios.

**Objects and flags.**
- The C object list and compact object flags are the same as the passing verifier runner.
- The fixture is compiled the same way that runner compiled its fixture. That means **without** `-DGGML_BACKEND_DL -DGGML_BACKEND_SHARED`, so it is not the `.so` build line.
- `-DSHIELDED_COMPACT` is added only when the compact root exists.
- The runner removes `SHIELDED_*` and `ENCLAVE_*` from the child environment.
- Sanitizer options: `ASAN_OPTIONS=detect_leaks=1:abort_on_error=1`, `UBSAN_OPTIONS=halt_on_error=1`.
- Build products go in a temporary directory that is deleted at the end.

**Synthetic data.** Page `P` is from `sysconf`; `T = 69632` bytes = Q8_0 256×256 = 17 × 4 KiB pages.

Private file layout (`Tp` = `T` rounded up to a page):

| Offset | Extent | Owner |
|---|---|---|
| 0 | `token_embd.weight`, F32, P bytes | CPU |
| P | `blk.0.ffn_gate.weight`, T bytes | Shielded source |
| P+Tp | `blk.0.ffn_up.weight` | Shielded source |
| P+2Tp | `blk.0.attn_norm.weight`, F32, P bytes | CPU |
| 2P+2Tp | `blk.1.ffn_gate.weight` | Shielded source |
| 2P+3Tp | `blk.1.ffn_up.weight` | Shielded source |
| 2P+4Tp+64 | `output_norm.weight`, F32, 256 bytes | CPU (partial page) |

- Total is `3P+4Tp` bytes, about 284 KiB at 4 KiB pages.
- Gaps are filled with xorshift bytes.
- Every tensor has distinct contents.
- Storage:
  - The private file is a `memfd`.
  - The public backing is a **separate** `memfd` with the same bytes. The fixture asserts the two inodes differ, which is the same aliasing refusal the loader does.
  - CPU tensors live in a `MAP_SHARED PROT_READ` mapping of the private memfd, through `ggml_backend_cpu_buffer_from_ptr`, mirroring the loader.
- The table is built with `add()` for all 7 extents before any registration.
- `defer_retirement = true`.
- **Test budget.** `retire_budget` is assigned directly: `T` for `bounded_*` and the failure scenarios, `1` for `tiny_*`, `0` for `default_*`. `parse_retire_budget_mib` and its [64, 65536] MiB range are not called or changed. No 64 MiB allocation happens.
- The environment matches the verifier fixture's local-mint scenarios:
  - `SHIELDED_PAD_SOURCE` and `SHIELDED_SOURCE_PREFETCH` are unset.
  - All-zero synthetic seeds and SK strings, as in that fixture.
  - `PAD_CHECK=1`, `NO_SIMD=1`, `MIN_MACS=0`, `MAX_M=16`.
  - `SHIELDED_COMPACT_WEIGHTS=1` for compact scenarios, `SHIELDED_SPLIT_COLS=1` for split scenarios.
- Calibration: `{act_frac 8, no outliers}` for all four weights, on every card.
- **Links.** Every card has `link_failed = true` and `link_retry_at = DBL_MAX`, so no worker connection is ever attempted. Card 0 is also set to contended with a different probe group, as in the verifier fixture.
- **Split.** A second `sh_state` is pushed into `p.cards`, as in the verifier fixture. Unlike that fixture, registration goes through the **real** `sh_plan` column-split branch (`ggml-shielded.cpp:1335-1402`): edges 0/128/256 and two full-tensor reads per weight. It is not hand-wired.

## 3. What is exercised, and the expected results

Each registration round is triggered through the backend's own `ggml_backend_shielded_graph_compute`. That function queues pending weights (`:2949-2960`), calls `sh_plan` (`:2961`), which runs `sh_register` → `sh_source_read_for_registration` → verifier, and then `sh_release_consumed_sources`.

There are two rounds:
- **Round 1:** `blk.0` gate and up.
- **Round 2:** `blk.1` gate and up, in a graph that also contains `blk.0`.

**Checks inside `observe_release`** (at batch end, before the candidate's flush):
- The batch made exactly 2 reads (split: 4) and the same number of verifies. All are private, none came from backing, and each read is followed by the verify of the same name.
- In split mode, the two reads of each tensor are adjacent.
- With budget > 0:
  - The first tensor of the batch is **already retired**.
  - The snapshot taken right after the second tensor's first read, and its verify, both show the first tensor retired. So retirement happened mid-batch, while real backend callbacks were in flight.
  - In split mode, card 1's read and verify of the first tensor still saw it unretired (the `keep` rule).
  - `unretired` holds exactly the second tensor.
  - `released_bytes` rose by exactly the first tensor's interior.
- With budget 0 (control): nothing is retired before the flush.
- In all cases: `reread_bytes` is unchanged inside the batch, and `check_private` passes.

**`check_private`** (also run after every step):
- Reading the private file with `pread`, and through the `MAP_SHARED` mapping, gives the expected image with zeros **only** in the page interiors of retired originals.
- `released_bytes` equals the sum of those interiors.
- tmpfs `st_blocks` dropped by exactly that sum.
- The three CPU tensors are never consumed or retired, and their bytes read back through the CPU buffer are unchanged.

**After each round:**
- The release callback was called once.
- The backend read stats rose by `reads × T`.
- All originals of the round are retired, and `unretired` is empty.
- Storage:
  - Local: the encoded `w` is kept (K·N, or K·N/2 per card when split) and there is no cache.
  - Compact: `w` is empty and a compact store exists.
  - Split: `part_cards = {0,1}`, `part_col0 = {0,128}`, and card 1 has `col0 = ncols = 128`.
- **Exact arithmetic.** For m=1 and m=19 (wider than `MAX_M`), every output equals `sh_balanced(Σ a·enc) × inv[j]` exactly, with the encoding recomputed by `sh_prepare_weight_rows` from the authentic bytes. This uses the same formula as the verifier fixture. The m=19 compute makes no source reads and no verifies.

**Rereads after retirement** (`reread`):
- `ggml_backend_tensor_get` on a retired source, through the backend's `sh_source_get`, reads from the public backing and reauthenticates the whole tensor.
- The bytes are correct, `reread_bytes` rises by T, and backend stats rise by 1 call and T bytes.
- A 17-byte view read also reads and authenticates the whole T.
- A reread never re-enters the budget or the private file.
- Done for `blk.0` after round 1; for `blk.1` and `blk.0` again after round 2.

**Hostile backing under a still-private tensor.** Before round 2, the fixture corrupts one byte of the backing inside `blk.1.ffn_gate`. Round 2 still succeeds, because unretired originals are read privately. The byte is then restored.

**Pad minting.** After both rounds, `sh_link_mint_shipment(..., 0, 2, ...)` runs once on card 0's local-mint link and succeeds with no source reads. The output file is deleted. There is no pad reuse.

### Scenarios

| Scenario | Budget | Mode | Expected |
|---|---|---|---|
| `bounded_local` | T | local mint, 1 card | Success line |
| `bounded_split_local` | T | local, real split, 2 cards | Success line |
| `tiny_local` | 1 | local, 1 card | Success line (same order as T) |
| `default_local` | 0 | local, 1 card | Success line; no mid-batch retirement |
| `default_split_local` | 0 | split | Success line |
| `bounded_compact` | T | compact, 1 card | Success line (only if compact root) |
| `bounded_compact_split` | T | compact, split | Success line (only if compact root) |
| `private_tamper` | T | local | See (a) |
| `punch_fail` | T | local, private fd reopened read-only | See (b) |
| `backing_tamper_reread` | T | local | See (c) |
| `backing_truncate_reread` | T | local | See (c) |

**(a) `private_tamper`.** A private byte inside `blk.0.ffn_up` is flipped *after* the table is built.
- Registration fails: `source_verification_failed` is set, the release callback is never called, and the graph returns FAILED with outputs left at the sentinel value.
- If gate was read first, gate was already retired mid-batch, and that is checked.
- Afterwards, `blk.0`, `blk.1` and empty graphs all return FAILED with no further reads.
- Prints "failed closed".

**(b) `punch_fail`.**
- The first read succeeds. The second read's retirement of the first fails, so `read` returns −1.
- The backend's per-source `failed` latch is set, and registration aborts.
- `released_bytes` is 0 and `st_blocks` is unchanged.
- Later graphs return FAILED.
- A direct `release_consumed` also returns −1.
- Prints "failed closed".

**(c) The two reread abort scenarios.**
- After round 1, the backing is corrupted (one byte) or truncated.
- An m=1 graph still computes exactly with no source reads.
- Then `pre-abort checks passed` is printed, and the backend's `get_tensor` must end in `GGML_ABORT`: **SIGABRT**, with stderr matching `authenticated weight source read failed`.
- A non-abort exits with code 3.

**Plain fallback is not assumed.**
- All compute uses the authenticated local path (`sh_local_products`).
- The four plain `sh_plain_mul_mat` callsites are each behind a `g_weight_verifier` refusal: guards at `:2391/2749/2859/2977`, calls at `:2402/2767/2867/2981`.
- Every success scenario asserts exact equality with the *encoded* product, so a silent plain fallback, or a crash in one, would fail the test. The fixture still does not claim that plain fallback is unreachable in production.

## 4. How to run (for Root; not run by me)

```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/shield-memory-20261028/steady-memory-r1/integration-test-prep
timeout 1200 node --test test/bounded-retirement-integration.test.mjs
```

Requirements: `cc`/`c++`, OpenSSL dev headers and libcrypto, Node with `node:test`, and AVX-512 hardware for `fast.o` and compact, as in the existing runner. It does not use a GPU, the network or a model.

## 5. Buildability

**Not built.** I expect it to be buildable, with these caveats:
- It uses only internals already used by the passing verifier fixture: `sh_pool_get`, `sh_state` fields, `sh_register` via `sh_plan`, `sh_dev_supports_buft`, `sh_link_mint_shipment`, `sh_prepare_weight_rows`, `sh_balanced`, `crypto_scalarmult_base`.
- It adds two new ones:
  - `sh_weight_source::failed`, from `shielded-weight-source.h:22`.
  - `ggml_backend_cpu_buffer_from_ptr`, which the loader already uses against this engine.
- The OpenSSL `SHA256*` names do not clash with backend symbols. A grep of the backend headers found none.

## 6. Unverified assumptions (review first if anything fails)

1. **Shape.** `sh_layout_fits(256, 256, 16)` and the registration exponent checks accept a 256×256 Q8_0 shape. The verifier fixture only used 32×8. If this is rejected, authenticated registration aborts the load and the assertions will show it. The fallback shape is K=32, N=2048, which is also exactly 17 pages; change `K`/`N` together.
2. **Read order within a batch.** The first-read tensor is taken from the observed log, so the expectations do not depend on order. They do require one layer per round, and each card's reads of a weight to be adjacent (`:1374-1381`).
3. **Real split branch.** `sh_plan`'s split branch plus `sh_card_compute` with `SHIELDED_SPLIT_COLS=1` and two link-down cards has not been exercised before. The verifier fixture hand-wired `part_*` with split columns *off*.
   - It should go: `rc != SH_OK` → `sh_local_products` (`:2749-2751`).
   - The `:2314` block should skip card 1 because `link_failed` is set and the retry time is `DBL_MAX`.
   - If the split diagnostic branch at `:2700-2747` triggers instead, the graph returns FAILED. That would be a finding, not a fixture bug, and should be inspected first.
4. **Links.** `sh_link_open(..., true, ...)` makes no connection; the verifier's compact scenario relies on the same behaviour. `link_failed` set before registration is not reset by `sh_register` or `sh_plan`.
5. **Retirement latch.** `sh_card_integrity_failed` (or `sh_register`'s early return) keeps later graphs FAILED after `source_verification_failed`. The verifier fixture's tamper scenarios observed this.
6. **Huge pages.** memfd must not use huge tmpfs pages. Otherwise the fixture exits with code 2 and a "tmpfs huge pages?" message.
7. **Page size.** With pages that are not 4 KiB, extents are no longer whole-page. A note is printed and the interior arithmetic stays generic.

## 7. Limitations and unfinished parts

- No execution, so no pass/fail evidence. ASan/UBSan, leaks, and the abort paths are all unproven until Root runs it.
- **Not covered:**
  - The dealt or public-cache path (`SHIELDED_PAD_SOURCE` set, `w_cache`).
  - The catalog (`g_encoded_source`).
  - Prefetch (`SHIELDED_SOURCE_PREFETCH=1`; production does not set it).
  - A weight that registers locally after a split slice is refused.
  - A failure in the final `release_consumed` flush (the verifier fixture already covers `source_release_fail`).
  - The patched loader (`enclave_shield_loader.cpp`) is not compiled: the table is built by the fixture rather than from GGUF metadata, and the env parser is not exercised here.
- Synthetic scale: 4 tensors of 68 KiB, not the 17.5 GB model. Nothing here measures load-time peak memory, page reuse, timing, or GPU behaviour.
- It does not reproduce or explain the earlier status 139 and makes no claim about its cause.
- Observer callbacks stand in for directly binding the candidate's function pointers. The behaviour is identical (pure delegation), but the bound address differs from the loader's.
- In the abort scenarios, ASan leak reports are suppressed by the abort, as in the verifier's `source_cpu_tamper` case.
