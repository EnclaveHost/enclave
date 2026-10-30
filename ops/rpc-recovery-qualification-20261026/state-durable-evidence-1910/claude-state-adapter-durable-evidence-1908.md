# 1908: state-production-validation-stage/r4 = r3 + the test-04 stub fix + durable actual extractor evidence (SOURCE ONLY; NOT run)

**Scope of MY activity:**
- **Created** the new stage `state-production-validation-stage/r4` only.
- **Read:** the r3 failure; and I hashed root's committed raw evidence.
- **The only checks I ran:** `ast.parse` and `sha256sum -c`.
- **Not done:** tests, builds, mounts, network, data, queue jobs, or commits.
- **Untouched and re-verified clean:** r1, r2, r3, extractor r3. r12, capture, acceptance, resource/memory/lifecycle are not changed.
- **Still `None`:** `PRODUCTION_INPUTS` and `EXTRACTOR_E2E_RAW`.
- **No canonical/reset/acceptance claim.**

## The actual r3 result (preserved, frozen r3 `5d24dd4b…`)
**`runs/tests-20261027T120233Z-3173349`:**
- `ran ["25"]`, rc 1, `pass: false`; 24 passed, **1 FAIL**.
- The failure: `test_04_extractor_last_e2e_block_explicit_no_dead_end`, with `AssertionError: 'BLOCKED extractorE2E' not found in 'extractorSums: README.md changed'`.

**The cause (a test bug, mine):** the test's `stubbed()` replaced `m.sha_file` for **every** path with the helper's all-`a` hash. The real `verify_extractor_stage` → `verify_sums(EX3)` therefore saw a wrong hash for the extractor's `README.md`.

**The extractor r3 is unchanged** (`sha256sum -c` OK), and the other real-qualification tests (21, 22, 25) passed.

## r4 changes
**1. Test 04.**
- The stub answers `("a"*64, None)` **only** for `good["helperDir"] + "/base-state-readonly"` and delegates every other path to the original `sha_file`.
- The real extractor-stage qualification stays in the test: SUMS, the actual unit 25 raw outputs, then `BLOCKED extractorE2E`.

**2. Durable actual evidence.**
- **The paths:** `EXTRACTOR_UNIT_RAW` now points at root's committed copy `source/ops/rpc-recovery-qualification-20261026/extractor-guard-1904/actual-tests/`.
- **Hashes verified before binding;** the pins are unchanged:

| key | durable path | sha256 (== r3 pin) |
|---|---|---|
| out | `che-r3-unit.out` | `d00104275c5584fd49e1385816ffbd97d79d62940913a9914f42c0ba82feee7a` |
| rc | `che-r3-unit.rc` | `9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa` |
| guard | `che-r3-unit.guard` | `3fa1f405044ac908af579c12338c9bffc5dede6e3d062693daeb0065ade3f1a0` |
| stderr | `extractor/stderr` | `e090ee4b45b29b18552b1fed88051659611d973463d9c1916e82779300bcec5a` |
| stdout | `extractor/stdout` | `60c3cb56a286182eb1f22ec905e6d3d66e2f2be8174db02a6b2440565ae85659` |

- **The original dir:** `EXTRACTOR_UNIT_ORIGIN_DIR = "/tmp/che1881-unit-GnvMSyRq"` is the original `tests.sh` output dir, named by the preserved log's own `## outputs` line. **It is kept as metadata, not as a new run.**
- **`read_raw_test(pins, n, out_dir_re, e2e=False, origin_dir=None)`:**
  - **Physically:** stderr/stdout must still be `<one parent>/stderr` and `<one parent>/stdout`, regular, `O_NOFOLLOW`, sha == pin, like every other file.
  - **`origin_dir`** must be an absolute, normalized str. When given, the **unchanged** `raw_test_errors` checks `## outputs <origin_dir>` and `out_dir_re` against it. The physical archive location may differ.
  - **The default `None`** (used for the live e2e when pinned): the physical parent IS the output dir, as in r3.
- **The call:** `verify_extractor_stage` calls it with `origin_dir=EXTRACTOR_UNIT_ORIGIN_DIR`.
- **No count/rc/guard/tail/marker check is weakened.**
- **This preserves earlier actual evidence** (the queue log and the hashes bind the original dir). It is not a rerun and not an invented PASS.

**3. Labels.** `OWN_TESTS = ("state-production-test-receipt/r4", 26)`; `jobs/tests.sh` requires exactly `Ran 26 tests`; the job and stop scripts point to r4.

**Diff vs r3** (`state_gate.py`): only the docstring, `OWN_TESTS`, the `EXTRACTOR_UNIT_RAW` block (+ `EVID`, `EXTRACTOR_UNIT_ORIGIN_DIR`), `read_raw_test`'s signature/parent check/origin, and the two `verify_extractor_stage` calls.

## Files (frozen, a-w)
| file | sha256 |
|---|---|
| **`SHA256SUMS`** | **`5b543e00e4684b5a5c5a915cdd672bf38ff3d1ea6712fa99f9514d6a1fa0499b`** |
| `state_gate.py` | `8a883f93fea1ea890bf095b324d1a039c42226af603a3c69ab7713006ecb27b7` |
| `composite_session.py` (unchanged since r1) | `52099d9f70a69d80fb96862a23c6316439a619ca7f2c9f92a88c0b8fe9856e9a` |
| `tests/test_state.py` (**26**) | `b135203d2b1f5d77bd3ac9e21ecafbd4373da4eabade571b0f67e2b69926cb92` |
| `jobs/tests.sh` | `70bf47bac6edc6635cdd3b0ad82f0f3a0f7b2242a06cf06047221dc2b5173753` |
| `jobs/root-state-validate.sh` | `ef27b60267c576805bb5c7efa3ad484acb4bf6d083ac5a8742c204c47c062e2e` |
| `jobs/stop-session.sh` | `a763e24ad6709f8736f775e375c9370c1d154667ce7d95ab42797fcb1a0297d2` |
| `README.md` | `d035560e35eb29daea9329dfb60af4d6250c396fbeef6afa949f3d5ec7ae2a7b` |

## Tests (26; NOT run)
**1–25:** r3's, with:
- **04:** the narrowed stub;
- **21:** the actual durable evidence passes **with** the origin dir and is **refused without it** (the archive's physical dir is not the run's output dir); its 14 mutations now use the origin as `outDir`.

**26 (new):**
- **Accepted:** copied ACTUAL unchanged raw files (a new archive layout, same shas), read with the original origin.
- **Refused:**
  - a mismatched or malformed origin (`/tmp/che1881-unit-AAAAAAAA`, a subdir, None, relative, int, unnormalized);
  - the unit evidence as the e2e;
  - each of the 5 files modified with the pin unchanged (sha);
  - stderr + out modified **and re-pinned** (the unweakened parser refuses `Ran 26`);
  - stderr and stdout in different physical parents.

**Root's command:**
```
bash jobs/q-exit-status.sh spv-r4-tests 256 unshare -Urn bash state-production-validation-stage/r4/jobs/tests.sh   # expect "Ran 26 tests", OK, receipt pass
```

## Still blocked (unchanged)
- **`PRODUCTION_INPUTS = None`:** no actual build, captures, structural CLEAN, production extraction or view yet.
- **`EXTRACTOR_E2E_RAW = None`:** no actual che-r3-e2e 8 PASS, and it is not runnable before all 265 + no driver. Its live reading keeps the default (physical dir = output dir).

A 35 remains PARTIAL v2 self-consistency only.
