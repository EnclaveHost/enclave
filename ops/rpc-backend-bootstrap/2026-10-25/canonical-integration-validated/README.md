# Canonical Helios pin integration: offline regressions PASSED (root run 0104). NOT an image, NOT live, NOT production

**What changed:** the attested-verifier source's chain-verifier pin moves from the old Helios `cc962e2b` to the
canonical Helios artifact **`8250f08a`**. That artifact was built from `eeffcc9` + `canonical-block.patch` `41667ec9`;
see `../native-artifacts-validated/`.

**The candidate:** 5 files changed against source commit `77d6cc859` (`stage/CHANGED-FILES.txt`):
- `docs/network/local-chain-verifier.md`
- `metal/chain-verifier-image.json`
- `network/rpc-runtime.mjs`
- `scripts/rpc-runtime/closure.json`
- `test/chain-verifier-guest.e2e.test.mjs`

## Actual result: `root-canonical-integration-0104`, rc 0, `[queue] EXIT 0`

**Run:** cap 2560 MiB; peak 654 MiB; minimum host available 22418 MiB. Run dir
`canonical-integration-actual/run/regress-20261026T005955Z`.

**Setup checks:** offline; stage == `SHA256SUMS`; `jobs/INPUT-PINS.sha256` unchanged; `77d6cc859` present; the
candidate's "before" blobs as recorded.

**B (new chain-verifier-inputs):** 7 pinned files, `PINS.sha256` `d68833a7…`.
- **The 6 old inputs are reused unchanged:** `enclave-base-head-listener` `9ca75047…`, `witness-check` `4fe0cd3b…`
  (NOT AFFECTED per the witness impact audit), and the glibc runtime (`ld-linux` `f5e11cc6…`, `libc` `02c8c3d0…`,
  `libgcc_s` `e618cb9c…`, `libm` `96510670…`).
- **One new input:** `helios` **`8250f08a…`**.

**C:** the candidate tree differs from base in exactly `CHANGED-FILES`.

**D (regressions, offline):** **154 positive checks passed, 0 skipped** (no failures, cancellations or todos).

| Phase | What | Result |
| --- | --- | --- |
| D1 | provenance (Python) | 4 |
| D2 | source updater (Python) | 10 |
| D3 | pin candidate (Node) | 6 |
| D4 | existing suite on the candidate (Node) | 48 |
| D5 | existing suite on the base, control (Node) | 48 |
| D6 | overlay: candidate + new inputs | 19 |
| D7 | overlay: base + old inputs, control | 19 |
| **D8** | **negative control:** candidate + OLD inputs | **rc 1, as required.** The pin check refused the old Helios: `has sha256 cc962e2b…, not the pinned` digest. |

**E (optional real guest E2E):** **NOT RUN**, because `GUEST_ROOTFS` / `RIG_CHAIN_NODE` were not provided.

**Root's own line:** "candidate pin replacement regressions passed offline; E: NOT RUN; NOT committed, NOT an image,
NOT measured, NOT SNP-qualified".

**Failure kept:** **`root-canonical-integration-0103`, rc 2**, was rejected by the queue **before any test**. The
`--mib 2048` value is not an allowed choice. Its receipt is kept in `actual/`, and no test ran.

**Runner:** root tightened the original runner **before the first execution**.
- **Original:** `stage/prior-root-review/integration-regression.sh` (`3a7640d1…`) and its `SHA256SUMS`.
- **Executed:** `stage/jobs/integration-regression.sh` (`c4b88db1…`).
- **Why:** `stage/ROOT-REVIEW.md`.

**After the run (root-reported):** root applied the 5 tested files to the attested-verifier source in commit
**`c61dbe5fd`**. The GitHub push is **pending**. No image was built and nothing went live. This record does not
verify that commit.

## Limitations (explicit)

- **No real guest E2E:** the optional E phase was **NOT RUN**.
- **Not built, measured or live:** no image build, measured release, SNP qualification, deployment or production.
- **Unsafe head, not finality:** `requireCanonical:true` in the pinned Helios means **on the current verified head
  chain** (fresh ≤ 60 s, exact parent-hash ancestry, ≤ 256 deep). That head can reorg, so it is **not** a safe or
  finalized guarantee.
- **Custody v2 stays REFUSED.**
- **Lease consumers stay on HOLD.**
- **Rebuild recipe follow-up still active:** the legacy `build-binaries.sh` is still **unpatched**. It would rebuild
  the old unpatched Helios, so the integration currently relies on the separately built and verified `8250f08a`
  artifact.
- **No independent native reproduction:** neither of the Helios artifact nor of this regression.
- **Reused artifacts:** the 6 old artifacts are reused from the verified stage inputs, not rebuilt.

## Contents (bounded text; no private clone trees `base/` or `cand/`, no binaries, no `node_modules`, no keys)

| Path | Contents |
| --- | --- |
| `stage/` | `canonical-integration-actual/` without `run/` |
| `actual/` | `root-canonical-integration-0104.{out,rc,guard}`, `root-canonical-integration-0103.{out,rc}` |
| `actual/run-regress-20261026T005955Z/` | `logs/` (D1–D8 `.out` and `.rc`), `RECEIPTS.sha256`, `chain-verifier-inputs/PINS.sha256` (pins only; the 7 binaries are not included) |

**`stage/`** holds:
- the candidate files, `candidate.diff` (`b1a358f7…`) and `update.diff` (`f28f7f4b…`);
- `UPDATE.json`, `SOURCE-FILES.sha256`, the tests (`test-provenance.py`, `test-source-updater.py`,
  `canonical-helios-pin.test.mjs`) and `tools/`;
- `jobs/` (`INPUT-PINS.sha256` `4d9b6c77…`), `prior-root-review/`, `ROOT-REVIEW.md`, and its `SHA256SUMS` (`b5d7a1c8…`).

**Verify:** `sha256sum -c SHA256SUMS` covers every file. `stage/SHA256SUMS` and `actual/run-*/RECEIPTS.sha256` also
verify in place.

Root confirmation: the exact five tested files are committed as c61dbe5fd and pushed to GitHub branch fix/rpc-attested-verifier-20261025. The apply/push exit-zero receipts are in actual/. This changed source only, not production.
