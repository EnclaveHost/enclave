# Retention selection fix r4: base-retention-stage/selection-r4 (PREPARED; NOT run by Claude, 2026-10-26)

**Status:**
- Source only. I ran no tests, builds, network, queue, live actions or commits.
- My only checks were `ast` parse, `bash -n` and `sha256sum -c`.
- **Untouched:** active root job 1394 (PID 110490), its unit, the installed guard and preflight, the controller, the guest, `activation-r2`, and **frozen selection-r3**. The r2 and r3 `SHA256SUMS` were re-verified.
- **Inputs read:** `logs/retention-selection-fix-root-note.txt` (root 1404) and `logs/claude-retention-state-redownload.md`.

## Stage
`base-retention-stage/selection-r4/`, `SHA256SUMS` = **`7bb30de21427cb865664dfe12336754ba1c31f717583a9a460e416064ebe17ab`**

| file | sha256 |
|---|---|
| `retention_preflight.py` | `2143f6cadee2fc2ffd0a60c4bbf60432f02b5922a6d9b52b09eeedcb2dc659a1` |
| `verify_retention_completion.py` | `5667476bc2edd4cc90682461a113f1d7a8ffe57a51b2efea2ba6be833b542d47` |
| `test_selection_r4.py` | `a6c024140aca4c0c09bba1d1094e2696fa778efb079141fb8a91fdf2915bdfc8` |
| `README.md` | `633d9de83b7d899be16b81d3d870be57f79502704f30abe716584e2ec9dcab11` |
| `jobs/root-selection-r4-tests.sh` | `335a3eb7ff21c8ced791172166ce7fb82952b81657dd3928d420f72bdc6edd17` |

## Corrections to my r3 (and r2's docs)
- **The r3 audit missed mandatory `state`.** reth 7134be3 plans `state` and headers as All whenever the manifest declares them (`mod.rs:753-756, 886-888`).
  - It reuses an archive only on exact size + full blake3 (`verify.rs`).
  - Every pending archive starts with `cleanup_outputs()`, which **deletes** its declared outputs (`archive.rs:150-152`).
  - `finalize` rewrites the DB (`mod.rs:647-674`), so a second run over a finalized datadir deletes `db/*` and re-downloads the state.
- **"Only --force/--prune-unlisted delete data" was FALSE.** I had repeated it in r3 and in earlier reports. The r4 docs say so explicitly, and a test asserts it.
- **r3's size-presence check cannot prevent this.** r3 stays frozen as a boundary-formula artefact, and is not a full preflight.

## `retention_preflight.py` (read-only; exit 0 admitted, 3 refused)
- **Boundary formula:** kept byte-for-byte in logic. The tests compare `first_chunk` with frozen r3 on 8 starts.
- **Manifest gate:** anything but the pinned `1f0c4e6c` is REFUSED, and so is a manifest with no state component.
  - A state-less or derived manifest needs separately reviewed provenance: derived from the pinned manifest, exact same block, checkpoint and readiness review.
  - This is documented, **not implemented**, and no command is proposed for it.
- **Destructive-reuse gate:** if the manifest declares state and **any** declared state output, anything under `db/`, or a `.download-cache/state.tar.zst*` exists, it is REFUSED.
  - This holds even at exact manifest sizes. A size match is not integrity, and reth would delete the DB.
  - Nothing is silently reused or retried.
- **Needs** (size presence only, labelled as such):
  - mandatory state (always pending on a finalized datadir);
  - all 107 headers;
  - the 30 history archives (the 4 below-floor archives listed separately).
  - `cliWouldPlanPending` reproduces the live **23** (22 history + state; 1,017,378,416,526 compressed and 1,628,200,462,623 extracted, all computed from the manifest).
  - `ifPresentOutputsFailIntegrity` gives the upper bound if every present output re-fetched.
- **Reserves:** unchanged (index ESTIMATE max(2×, 150 GB); 30-day growth). `declaredFloor` is 48,000,000 / 52,500,000. `readiness` says NOT readiness.
- **Command:** emitted only when admitted, i.e. for a datadir with no DB, as one-pass full retention from the start. It is scoped "re-run this preflight immediately before any start". The current guest would be **refused** once a DB exists.

## `verify_retention_completion.py` (read-only; exit 0 complete, 1 not, 2 refused while running)
`jobComplete` requires four separate sections:
1. **terminal:**
   - `ActiveState=inactive`, `SubState=dead`, `Result=success`, `ExecMainStatus=0`, `MainPID=0`;
   - the **exact InvocationID** root recorded (e.g. 1394's `c67c9c6b…`);
   - ExecStart `argv[]` equal to the reviewed live command.
   - A failed, signalled, other-invocation or different-argv unit is **never** complete, even with every size present (tested).
2. **marker:** the unchanged r2 `retention-complete` file must be:
   - a regular file, owned by the expected uid, mode 0444;
   - format v1, pinned manifest, reviewed argv and floors, `archives == 26`;
   - with a timezone-aware `completedAt` at or after `ExecMainStartTimestamp`.
   - It is labelled a 26-archive r2 **subset** record: not the full selection, not state verification, not readiness.
3. **history:** size presence of all 30 archives plus 107 headers, with at-or-above-floor separate from below-floor.
4. **state:** presence only. `db/mdbx.dat` is a non-empty regular file. The original `mdbx.dat`/`lock`/`mdbx.lck` sizes and blake3 are **not** required after `finalize`; they are reported as informational (expected to differ).

Size coverage is **NOT integrity or chain readiness**.

## Tests (13; `test_selection_r4.py`)
1. **Pinned manifest and boundary:** the formula equals r3; 30 selected; the 4 below-floor archives; invalid starts refused.
2. **Same-size changed DB:** every output at its exact manifest size is still REFUSED, with no command.
3. **Partial traces refused:** a `db/lock` only, an unknown `db/` file, a `db/` subdirectory, or a state `.part` cache.
4. **The live situation:** 22 history + state = 23 pending, with exact bytes, and refused.
5. **Empty datadir:** admitted, with state, 107 headers and 30 history counted; reserves; command; floors; capacity refusal at `need − 1`.
6. **Unreviewed or state-less manifest:** refused with the provenance message; an invalid manifest exits 3.
7. **Docs:** the false deletion claim is corrected.
8. **Completion, success:** a successful exact invocation with a valid marker, a finalized (different-size) DB and full sizes is complete, and the tree is unchanged.
9. **Completion, failures:** failed, signal, wrong expected id, other recorded id, or `--force` argv are never complete, although every size is present.
10. **Running:** refused (2).
11. **Marker variants:** wrong manifest, argv, archives, floor, early or naive `completedAt`, format, missing marker, or mode 0644 each make it not complete.
12. **Separate requirements:** a missing `mdbx.dat` (history ok) is not complete; a missing below-floor archive (state ok) is not complete.
13. **Frozen files:** r2 and r3 are unchanged.

## Root command (not run)
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh base-retention-selection-r4 256 unshare -Urn bash base-retention-stage/selection-r4/jobs/root-selection-r4-tests.sh
```
- **Checks:** the r4, r3 and r2 sums before and after the run; `Ran 13 tests` plus `OK`.
- **Files:** sparse only, under the run directory, removed afterwards. `TMPDIR` is set only for the test command. **HOME is not assigned.** No `__pycache__` is written.
- **Memory bound NOT demonstrated:** I estimate about 3 parsed copies of the 4 MB manifest at peak. If the guard stops it at 256 MiB, rerun the same job at 512.

## Using the verifier after 1394 exits (root, read-only)
Copy `verify_retention_completion.py`, `retention_preflight.py` and `SHA256SUMS` into a root-owned temp dir in the guest, sha-check the two files, then run:
```
/usr/bin/python3 -I verify_retention_completion.py --invocation c67c9c6b227a4a4fbc5feddf9d91a2c7
```
The defaults are the live manifest and root paths. Nothing is installed.

## Limits / unknowns
- **No integrity:** neither tool hashes. reth's blake3 checks ran during the job, and only a successful terminal state of the exact invocation attests to them.
- **Timestamp parsing:** the verifier parses `ExecMainStartTimestamp` only in the `Day YYYY-MM-DD HH:MM:SS UTC` form. Any other guest timezone format fails closed (not complete).
- **systemd retention:** whether systemd still reports 1394's InvocationID/Result after a later unit run or a reboot is not checked. Run the verifier before anything else starts the unit.
- **Pruning:** whether reth's first node start prunes the below-floor blocks (`PruneMode::Before`) is not traced. Readiness must use the declared floor only.
- **No future backfill command exists.** A state-less derived manifest needs its own reviewed provenance, exact-block and checkpoint/readiness review before any proposal.
- **r4 is not installed.** Replacing the live guard is a separate root decision after 1394.
