# Recovery/capture r2 (PREPARED, NOT RUN) + the current production-cutover plan: bounded source preservation, 2026-10-26

**What this is:** a bounded text-only record, for root to commit normally.

**Not done:** no tests, builds, queue use, network, SSH, live change or commit. Nothing in the frozen stages was touched.

**Excluded:**
- the stages' `logs/`, `tmp`, runs, clones (`scratch.git`), `node_modules` (except the test stub below), binaries and
  caches;
- **anything of the active r3 or r10 work.**

## Status (nothing here is a pass)

| Stage | Status |
| --- | --- |
| **`a1-capture-r2/`** (`a1-capture-binding-stage/r2`) | **QUEUED, NOT RUN.** The root job `root-a1-capture-r2-0243` had 0 bytes of output at the snapshot (`queue/SNAPSHOT-UTC.txt`; the empty log is kept as `queue/…QUEUED-SNAPSHOT`) |
| **`base-reanchor-recovery-r2/`** (`base-reanchor-recovery-stage/r2`) | **NOT RUN.** The known r1 failure (the old bounds fixture) is still open; **it needs the r3 fix** |
| **`production-cutover-current-plan/`** | the current plan and its canary scripts (static scan, Linux and Windows egress observation). Prepared; nothing run or deployed |

**Activation flags: unchanged.** As found in these r2 sources:
- `LAUNCH_PRODUCER_REVIEWED = False` (`wrapper/chain_service.py:477`);
- `FINALITY_PROOF_REVIEWED = False` (`producer/base_launch.py:43`);
- `A1_CAPTURE_VERIFIER = None` (`harness/a2a4.py:118`).

The tests set the verifier only inside their own fixtures, and reset it in `tearDown`. **Nothing reads the A1 captures
yet.**

## Original failures and r1: referenced, not duplicated

These are already published and committed in **`../rpc-recovery-credit-progress-20261026/`** (commit `6c124268e`, its
`SHA256SUMS` `6c3c2ed5…`):
- the frozen **r1** stages: `a1-capture-binding-stage/` and `base-reanchor-recovery-stage/`;
- **the actual original failed runs:** `actual/root-a1-capture-0232.{out,rc,guard}`,
  `actual/root-reanchor-recovery-0232.{out,rc,guard}`, and their run outputs under
  `actual/a1-capture-binding-stage/root-capture-tests-20261026T023019Z-595581/` and
  `actual/base-reanchor-recovery-stage/root-reanchor-tests-20261026T023020Z/`.

## Contents

| Path | What |
| --- | --- |
| `a1-capture-r2/` | `R2-CHANGES.md`, README, `src/a1_capture.py`, `a1gate/` (gate, anchor, recheck), `tests/` (including the stub below), `jobs/root-capture-tests.sh`, `SHA256SUMS` |
| `base-reanchor-recovery-r2/` | README, `harness/`, `wrapper/`, `producer/`, `tests/`, `base/` (the r1/r3/orig bases), `inputs/`, the `r1-to-r2-*.patch` and `*-vs-*.patch` patches, `jobs/root-reanchor-r2-tests.sh`, `MANIFEST.sha256` |
| `production-cutover-current-plan/` | README, `canaries/*.sh`, `*.ps1`, `SHA256SUMS` (without `scratch.git`) |
| `review/` | **root's exact review inputs** for these r2s: `a1-capture-r2-root-review-task.txt`, `reanchor-integrated-review-task.txt`, `production-cutover-current-plan-task.txt` |
| `reports/` | `claude-a1-capture-r2-result.md`, `claude-reanchor-r2-result.md`, `claude-production-cutover-current-plan-result.md` |
| `queue/` | the 0-byte queued snapshot and its UTC time |

**Modes:** preserved as in the sources (tar `-p`).
- **Executable:** `base-reanchor-recovery-r2/jobs/root-reanchor-r2-tests.sh` and the two canary `.sh` scripts.
- **Not executable:** `a1-capture-r2/jobs/root-capture-tests.sh` is 0644 in the source too, unchanged.

**Size:** every file is far below 2 MB. No secrets were found.

## Manifests

- **Outer:** `SHA256SUMS` covers **every** file here.
- **Inner, all verifying fully in place:**
  - `a1-capture-r2/SHA256SUMS`;
  - `base-reanchor-recovery-r2/MANIFEST.sha256`;
  - `production-cutover-current-plan/SHA256SUMS`.

  `base-reanchor-recovery-r2/README` also names the frozen r1 `../MANIFEST.sha256` (`02abf9be…`), which is in the
  referenced publication, not here.
- **Force-add needed:** `a1-capture-r2/tests/stubs/deps/node_modules/fakehash/{index.mjs,package.json}` (37 and 59
  bytes) are a **test fixture stub** listed in its `SHA256SUMS`. They match `.gitignore:4 node_modules/`, so root must
  `git add -f` them, or the inner manifest will not verify after a checkout.

**Unchanged:** Custody v2 stays refused, and lease consumers stay on HOLD.
