# lease-consumer-seams r4: result (PREPARED ONLY; no test, queue, build, network, live action or commit by Claude)

## Actual r3 result (FAIL; r4 has NOT run)

**Run:** root job 61747, lease `root-lease-consumer-seams-r3-0119`, run `r3/runs/20261026T012004Z-358345`. Its `verdict.json` reads `ok: False`:
- **Base:** 66 tests, 56 pass, 10 fail (the 9 expected + the loader test).
- **Candidate:** 66 tests, 65 pass, 1 fail. The only failure was "the shared loader: pinned relays may be the ONLY route; partial or invalid refuses; absent keeps the exact configuration": `plain.authority` was expected `null` (my r3 fixture, wrong), but the actual value is `'rpc-quorum'`.
- **What passed in the candidate:** all 3 Windows routing tests, the conduit/runtime seam tests, the gsup assertion and the measured-control snapshot.
- r3, its run, its logs and its code are untouched; `r3/SHA256SUMS` still verifies. r1, r2 and the stage are unchanged. Product `seams.patch` is unchanged at `26393ac5…`.

## Trace

`lease-executor-authority.mjs:50` (default `"rpc-quorum"`) → `:99` → `lease-gas-runtime.mjs:99`. This is the legacy RPCS quorum, the intended legacy behaviour (details in `r4/README.md`). Only the expected value changes; no behaviour, no other assertion and no expected-failure entry is changed.

## r4: `lease-consumer-seams-stage/r4/`

- **Pins:** `SHA256SUMS` lists 17 files; its own sha256 is `12e7ebf8618964b2a03f3eeb418f0c8cfe80e305dbb83da7e73f65bc10233925`.
  - The runner `jobs/root-seams-test-r4.sh` is `8a63c1ae16280e02c8a77ff0661ab07980911a6409efdab5736270be9b47553d`, the source root reviewed, unchanged.
  - `fixtures.patch` is `cd498eef7e726628e5524683d9623c26f920afc24a962bed64cbcb7a99c18f0e`.
  - `candidate-tests.patch` (`548e44811237`) and the Windows test (`b9f76ec28573`) are the same as r3.
- **Required outcome (enforced by the runner):**
  - base rc 1, 66 tests, 57 pass and exactly the 9 expected failures;
  - candidate rc 0 and 66/66, with 0 skip, todo or cancelled;
  - the dependency closure the same before and after;
  - the 11 integration files equal their pins.
- **Prediction (not a result):** only the loader test deviated in r3, so r4 should meet this. Only the root run decides.
- **Root command:**
  ```
  R4=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/lease-consumer-seams-stage/r4
  python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1024 --log $R4/root-seams-test-r4.guard -- unshare -rn bash $R4/jobs/root-seams-test-r4.sh > $R4/root-seams-test-r4.out 2>&1; echo $? > $R4/root-seams-test-r4.rc
  ```

**Source head drift:** `relay-consumer-source` has moved to `920a5911d`, and a mode fix is pending; it includes an independent 3-file deep-CLI patch. r4 does **not** follow it.
- The runner clones `$SRC` and checks out `81ba668531d17151db810e14562c77a672d742e4` explicitly; it asserts HEAD equals that commit.
- The 15 before-pins, the patches and the expected failures are all against `81ba`. No r4 input was changed for the drift.
- Moving onto `920a5911d` (or later) is a separate step after r4 passes: re-derive the before-pins at the new head and confirm the deep-CLI files are disjoint from the 15 paths (and from the platform-api inputs).

## Integration manifest (`r4/INTEGRATION-MANIFEST.md`): transplant ONLY after r4 passes

- **15 paths:** 6 product, 5 test and 4 generated (Windows lease runtime bundle + manifest, metal conduit bundle + manifest).
- **Hashes:**
  - `integration/rev-before.sha256` (15) holds the REV hashes; I re-derived them from git at `81ba` while writing, unchanged.
  - `integration/source-and-tests.sha256` (11) holds the tested non-generated hashes; the runner checks them.
  - The generated hashes come from the passing run's `integration-bundles.sha256`. `integration/r3-build-bundles.reference.sha256` is a reference only.
- **Static completeness check:** the patch file lists, the builder outputs and the REV-wide hash pins were cross-checked.
- **Separate pending artifact:** `r4/PENDING-platform-api-bundle.md`. `metal/guest/platform-api.bundle.mjs` (+ manifest) bundles `metal/guest/lease-gas-conduit.bundle.mjs`, `metal/guest/measured-control.mjs`.
  - Its REV manifest has 2221 inputs: 115 tracked and compared, and 2106 untracked and skipped (2105 under `node_modules/` plus the gitignored `relay/network-runtime.bundle.mjs`).
  - Already stale at REV, before the seams: `custody/v2/quorum.mjs`, `metal/guest/measured-control.mjs`, `metal/guest/platform-api-role.mjs`, `relay/api-relay.js`, `relay/custody-state.mjs`, `relay/fleet.mjs`, `relay/host-sponsor.mjs`, `relay/lease-generation.mjs`, `relay/mcp.js`, `relay/net-guard.mjs`, `relay/sessions.mjs`, `relay/shield-derive.mjs`, `relay/store.js`, `relay/vbs-runtime.mjs`.
  - It is not rebuilt or tested in r4, and the runner was not expanded. Before any integration it needs a separate root decision and job.

## Fix made in this pass

My previous writers failed before writing anything:
- The first looked up untracked `node_modules/` manifest inputs with `git show`.
- The second asserted that every untracked input sat under top-level `node_modules/`; `relay/node_modules/` and the gitignored `relay/network-runtime.bundle.mjs` broke that.

The writer now compares only inputs tracked at REV and classifies the untracked ones. Nothing else changed: the r4 runner, the patches, the tests and the 15 before-pins are as root reviewed them.

## Not done

No execution of tests, the queue, builds, network access, live access or commits. Static checks only: `git show`/`ls-tree` at `81ba`, sha256 and `sha256sum -c`.
