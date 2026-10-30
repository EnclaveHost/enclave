# a1-capture-binding-stage: capture-bound A1 runner revision (PREPARED; source only; NOT run; NOT enabled)

**Purpose:** close the gaps G1–G7 of `base-finality-proof-stage/restart-review/DESIGN.md` §4 for the A1 receipt that the
re-anchor restart R-A would need. Root accepts preparing R-A, with its unmeasured unwind/rebuild downtime acknowledged.
**Nothing here is enabled:** no consumer (harness, producer, prototype) reads these captures yet. The three HOLD flags stay
False.

## Files

| File | Role |
|---|---|
| `src/a1_capture.py` | `capture initial\|recheck OUT` (the runner) and `verify OUT` (the verifier); `admit()` is the consumer replay ledger. |
| `a1gate/` | The pinned A1 gate files, byte-identical to the harness pins (`06cc2961…`, `f591f324…`, `ec92b70f…`). |
| `tests/test_a1_capture.py` | 25 tests. |
| `tests/stubs/` | Stub A1 modules, stub l1-authority and one fake dependency. |
| `jobs/root-capture-tests.sh` | Root's offline job. |
| `SHA256SUMS` | Pins every file. |

## Reused unchanged (no new authority, no new verification)

- **A1 code:** `a1-read.mjs`, `a1-anchor.mjs`, `vendor/anchor-bootstrap.mjs` and `test/deps.mjs` for **initial** captures (`l1-anchor-a1`), and `a1-recheck-read.mjs`, `a1-recheck.mjs`, `a1-read.mjs`, `a1-anchor.mjs`, `vendor/` and `test/deps.mjs` for **recheck** captures (`a1-original-game-prepared`). They are pinned to their published SHA256SUMS. The cryptographic checks (Helios-verified calls, MPT proofs, header-hash recomputation) are theirs.
- **Helios:** `l1_authority.py` (`f4a5160b…`), which already execs the pinned Helios from the hashed file descriptor.
- **Gate:** the pinned A1 gate, used to normalize both receipt kinds.
- **Config derivation:** identical to the reviewed runners, so original-game recheck behaviour is preserved: the same initial pin, original game/N/root, getter, ages and `pinBy`.

## What is bound at capture (G1–G7)

| Gap | Now |
|---|---|
| G1 runner sha | `capture.json` records every executed file. The runner itself is the reviewed source of this stage; it is pinned by `SHA256SUMS` and by consumers' code pins, not by a self-hash. |
| G2 configs | The l1-authority config **and its checkpoint file**, `portal-result.json`, the A1 template (initial) or the pinned initial receipt (recheck), and the **derived** configs are all copied, hashed and re-derived by the verifier. |
| G3 code | The `l1_authority.py` copy, the node binary copy (sha), and the Python interpreter sha and version. |
| G4 dependencies | The `package-lock.json` pin `9ada1611…`, plus the 13-package closure of `@noble/hashes` and `viem`, each pinned by version and full content digest. Unpinned packages are refused. |
| G5 hash-then-exec | Inputs are read once, hashed **in memory**, and written as 0400 `O_EXCL` copies in a 0700 directory. **Only the copies execute.** All copies are re-hashed before exec and after the run. |
| G6 exclusive records | `OUT` is created with an exclusive `mkdir`. `capture.json` is written before anything executes; evidence, stderr, log and `result.json` use `O_EXCL`. The directory is published by a rename to `OUT/capture`. |
| G7 L1 inputs | Helios status (binary sha, `fresh-finalized`) is recorded. The checkpoint file is now bound. The L1 EL endpoint stays untrusted, as in A1. |

## Verifier (`verify`)

`verify` accepts only a clean binding and refuses everything else. It checks:
1. **Layout:** exactly `OUT/capture`; every entry root-owned, no symlinks, not group/other-writable; the exact file set.
2. **Records:** the record format; `result.json` binds `capture.json`; every copy re-hashes to its capture-time sha.
3. **Pins:** code and dependency pins equal the reviewed ones, and there are no extra packages.
4. **The run:** a clean run, with exit 0, Helios stopped, both re-hash checks true, and a pinned, fresh-finalized Helios.
5. **Records match:** the evidence, stderr and log shas equal `result.json`.
6. **Re-derivation:** both configs are recomputed from the bound copies.
7. **Exact execution:** the recorded argv and env executed exactly the copies, in place (a moved capture is refused).
8. **Time window:** the receipt time lies inside the capture window.
9. **Gate:** finally, the **pinned gate** (fresh-initial, or original-game-recheck with the pinned initial receipt).

`verify` is stateless; `admit()` refuses a reused capture id, evidence or record.

## Limits (exact)

- **Trust:** root and the host are trusted to run this runner. Without attestation, the binding cannot defend against a malicious root.
- **Not pinned:** node's shared libraries, the Python interpreter (recorded, not pinned), and the Helios `dataDir`/`homeDir` contents.
- **Copied but not reviewed constants:** configs and data are bound and validated, but they are not constants. A consumer must decide which config hashes it accepts.
- **Installed dependency digests** are observations of the installed tree at `source/node_modules` (→ `work/enclave/node_modules`) on 2026-10-25. They are not a review of upstream package contents.
- **Not integrated:** the harness, the producer and the finality prototype do not consume `verify()` yet. That is the integration owned by 8505 and root.
- **No live run:** no capture has run. **Whether a newer finalized anchor game exists is not asserted.** Root's recheck of 2026-10-25T21:53Z recorded a latest-anchor *observation* only (game `0x27d5…`, N 52,869,960, `accepted: false`).

## Root test command

See `jobs/root-capture-tests.sh` (queue at 1024 MiB, under `unshare -rn`). A pass requires exactly `Ran 25 tests` + `OK`, no skips, rc 0, and `## capture rc=0`.
