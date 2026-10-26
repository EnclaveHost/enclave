# 1602: writer-integrated-stage/r3 — root 1600 fix + witness placement r2 + history r4 (FINAL: frozen, NOT run)

**Status:** source frozen; not run, so no pass is claimed; not production-ready.
- **Stage:** `writer-integrated-stage/r3/`, `SHA256SUMS` sha256 **`24636147a5e66d948750c52843252600116ce461357714396143de4e1dd6f271`** (17 files, all read-only).
  - patch `c603a252…`;
  - job `45f92f34…`;
  - `PROVENANCE.md`;
  - `release.git`;
  - inputs 1600/1596/1593/history-r4.
- **Source tree:** **`8a616194b085df620bc882eed87d682dad4e6b9f`**, reproduced in a fresh clone from `e903c224` through history r3, history r4 and driver r1.
- **`release.git`:** branch `integrated-r3-source` = commit `a560f978…` with the same tree. The job cross-checks it.
- **Preserved:** integrated r1 and r2, placement r2 and history r4 still pass their SUMS checks.
- **Scratch:** `/tmp/w9` (new). `/tmp/w7` was only cloned from; `/tmp/w8` (da) and others were untouched.
- **Executed by me:** sha256, scratch git, Python text edits and `bash -n` on the job. **No `node`, tests, builds, network, live or USB.**

## Inputs consumed
- **History r4 is FROZEN** (`9fa22972…`, tree `571b5c84`), so r3 is composed on r4 rather than r3.
  - r4 changes only the history transport, its budget and its suite (backward-history **16**).
  - The integration never builds a history transport itself; the provider does, through r4's `historyTransport`.
- **Witness placement r2 is FROZEN** (`07084e7a…`). Its patch was applied 3-way.
  - **It merged cleanly** into the v2 policy in `measured-control.mjs` (optional HOST_DATA `witnessUrl`), the role (compose plus tamper check), the wiring (own-backend URL rule and `bindWitnessUrl`) and the writer (it strips `witnessUrl` before the provider, so the binding bytes are unchanged).
  - **The one test conflict** (`f.start`) was resolved by combining the v2 sha and `boundWitnessUrl`.
  - **Moved to v2:** its fixture `test/fixtures/witness-placement-policy.json` (v2 format + `rollupConfigTemplateSha256`), and its start test now pins the template sha.
- **Producer r3** (`816417f4…`, the output bound) is a **separate service stage** with its own tests (10). It is not part of this tree.

## Fixes
### Root 1600 (the actual 1594 failure)
1. **`createWitnessTransport` returns `Buffer.concat(chunks, size)`,** a Buffer within the cap, instead of a `new Uint8Array(…)` copy.
   - **The native validator is unchanged** (`invokeDerivation`: `Buffer.isBuffer`, non-empty, ≤ max).
   - **Exact regression, test 2:** the transport result is `Buffer.isBuffer`. The **real** `invokeDerivation` refuses `new Uint8Array(got)` with "native witness size refused". The transport's Buffer passes that check and stops at the deliberately invalid `timeoutMs: 0` ("invalid native execution bounds"), so nothing is spawned or written.
2. **Test 5:** `t.after(() => d.stop())` is registered **immediately after start, before polling**. The `until` timeout reports `d.status()`.
3. **`wired()`:**
   - the replacement provider is wrapped in a frozen facade whose `close` (memoized) **stops the driver first, then closes the provider exactly once**, whichever cleanup runs first: `readerFixture`'s `t.after` or the new one;
   - `f.start` records the driver;
   - the frozen provider object is not mutated.
4. **Test 3:** asserts the step result (`error === undefined`, with the result in the message) before dereferencing the floor, and asserts the floor exists before using `.base`. The provisional step is checked the same way.

### Review 1596 (low-risk, tested)
- **L1:** `createDerivedWriterAuthority` is constructed and validated **before** `startReaderDriver`.
  - An authority error closes the API and the reader, then rethrows.
  - A driver start failure closes the API and the reader (as before).
  - **New case in the relay-startup test:** a two-anchor service without `recordStateFact` is refused with `/recordStateFact/`, **no `driver.start`**, and the reader closed.
- **L2:** `readTemplateFile` (exported) is the driver's **default** template reader. The relay no longer passes its unbounded `readFile`.
  - **What it does:** `lstat` must be a regular file (a symlink, FIFO, device or directory is never opened). Then it opens with `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`; `fstat` must be regular and ≤ 1 MiB; it reads at most 1 MiB + 1.
  - **New test 10:** a regular file is returned as a Buffer; exactly 1 MiB is read; 1 MiB + 1, a symlink, a FIFO with no writer, a directory and a missing file are refused; and `startReaderDriver` without `readFile` refuses a symlinked template.

**Unchanged:** the 120 s on S, finality-first, A2, single native/single flight, the full native/provider proof checks, enrolled-only signed startup, all admin and business controls, and the default-disabled template/record (no `driver`, `history` or `rollupConfig`).

## Root job: `jobs/root-writer-integrated-r3.sh` (derived from r2 by explicit replacements)
- **Verifies:** r3 itself; frozen integrated r1/r2, history r3/r4, placement r2, driver r1, two-anchor r1-r3, cold-recovery r2, r9 (with its check verdict) and the KVM r3 closure; and `release.git` = `a560f978`/`8a616194`.
- **Composes** 8 patches, asserting every tree, ending at `cff4690a` → `8a616194`.
- **`slice` (512 MiB) = 208:**

| suite | tests |
|---|---|
| driver-integration | **10** |
| witness-placement | **5** |
| driver | 10 |
| backward-history | **16** |
| writer-history | 9 |
| two-anchor | 13 / 12 / 12 |
| KVM r3 (six suites) | 65 |
| writer | 23 |
| composition | 6 |
| replica | 8 |
| enrollment | 19 |

  - **Namespace address:** `10.0.2.2/32` is added to the namespace `lo` **only** around the witness-placement suite, then removed. No route is added.
- **`check` (2560 MiB):** the r2 check set. The guest-bundle input check adds `measured-control.mjs` and `network/chain-authority.mjs`, both manifest inputs.
- **Run:**
  - `bash jobs/q-exit-status.sh wint-r3-slice 512 unshare -Urnm bash writer-integrated-stage/r3/jobs/root-writer-integrated-r3.sh slice`
  - then the same with `wint-r3-check 2560 … check`.
- **Environment:** no HOME, CODEX_HOME, TMPDIR or TEST_TMP use.

## Risks for root's run (honest)
- **Untested together:** history r4 (16) and placement r2's node suite (5) have **never run**, and neither has this composition. A failure in r4's suite belongs to da; a placement-only failure belongs to 370. Fixes go into a new stage, never into r3.
- **Placement test transport:** it binds a server on 10.0.2.2 inside the namespace. If `ip addr add` is refused there, the job dies with a clear message rather than skipping.
- **The L1 test** relies on `createDerivedWriterAuthority`'s existing `recordStateFact` refusal text.

## Still pending (activation; nothing enabled)
- **The rest of the witness path:** producer r3 qualification (its own 10 tests), the QEMU guest → host → RPC-VM forward (`hostfwd` plus the forward units; root-coordinated VM restart) and systemd `IPAddressAllow` enforcement are unmeasured.
- **A2–A4 from review 1596:**
  - reviewed Base rollup-config bytes plus `files.rollupConfig`;
  - a template with `driver` v2 + `history` v2;
  - the signed rotation;
  - KVM review;
  - measurements: native time vs 120 s, history F4 loop lag and own-node load.
- **Review 1596 L3** (KVM-side validation of the driver section) and **L4** (the role-only record-path check) remain informational.

## Merge instructions
1. **Root:** run `slice`. If it passes, run `check`.
2. **Future fixes:** a new stage on `8a616194`. **Do not edit r3**, r2, placement r2 or history r4.
3. **A later history r5 or placement r3:** apply 3-way onto `8a616194` and keep policy v2 in every fixture.
