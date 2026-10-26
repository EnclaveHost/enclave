# Composition r9 (IN PROGRESS, already has failures) and standalone-MCP r1/r2 (PREPARED, NOT RUN): bounded source preservation, 2026-10-26

**What this is:** a bounded text-only record, for root to inspect, commit and push normally.

**Not done:** no tests, builds, queue use, network, SSH, live change, commit or push. Nothing in the frozen stages or the
active runs was touched; everything here is a copy.

**NOTHING HERE IS A PASS:**
- **r9** (`root-composition-r9-0237`) is **IN PROGRESS and already has failures**. Root expects r9 to FAIL overall
  (`r9-root-build-triage.txt`).
- **The MCP r2 job** (`root-mcp-authority-r2-0241`) is **QUEUED** behind it: no output yet.

## Pins (`PINS.txt`, full hashes)

| What | Pin |
| --- | --- |
| Consumer, current head | `relay-consumer-source` `12b41d459…` |
| r9 candidate | `refs/r9/candidate` **`82ec7d455cc6e9957c1500f6e58ffde557093392`** (in the frozen r9 `src.git`) |
| r8 partial | `refs/r8/candidate-partial` `8fdf00d001c593602c3639dca79d3ec4bcf2e559` |
| MCP r1/r2 base | `b6ac5d657…` (the 3 MCP source files are byte-identical at `12b41d459`) |

`PINS.txt` lists every ref of the r9 `src.git`.

## Contents

**`r9/stage/`:** `rpc-runtime-composition-stage/r9` **without** `src.git`, `wt`, `run`, `node_modules` and
`__pycache__`. It holds the README, `REFS`, `DEPS`, `DEPGRAPH`, `GENERATED`, `GENERATORS`, `INTENTIONAL-CHANGES`,
`LINK-*`, `R3-PINS`, `R9-RESOLUTIONS`, `REGRESSIONS`, `jobs/`, `stack-tests/` and `tools/`.

**`r9/source/`:**
- **`r8-candidate-partial..r9-candidate.diff`:** the exact `git diff --full-index --binary` (12 files, +833/−127).
- **`RAW-MODES.txt`:** `git diff --raw`. All 12 files are mode `100644`: 9 modified, 3 added
  (`test/windows-chain-authority-runtime.test.mjs`, `test/windows-owner-cli.test.mjs`,
  `windows/node/chain-selection.mjs`).
- **`files/`:** the 12 full files at `refs/r9/candidate`, via `git archive` (modes preserved).
- **`FILES-r9-candidate.sha256`:** each was checked equal to its git blob.

**`r9/evidence-in-progress/` (snapshot `SNAPSHOT-UTC.txt` = 20261026T023919Z; raw bytes, never edited):**
- `r9-root-build-triage.txt`: root's early D-phase triage, **6 open failures**:
  1. the custody vendor bundle differs;
  2. the host-service-packages allowlist is missing 4 generated files;
  3. the staleness auditor hashes symlink text;
  4. the sidecar/runtimeFiles mapping;
  5. the `git add -A` guard;
  6. the test summaries ignore cancelled counts.
- `root-composition-r9-0237.out`: the queue log **so far**.
- `run-r4-20261026T023428Z/`: the run's top-level text results (`RESULTS.tsv`, test lists, `regenerated.paths`,
  `link-after.json`, `staleness-after.json`, `gen-pass-2.ignored.sha256`) and `logs/*.out`. All are under 2 MB.
- **Already visible at the snapshot:**
  - `dns-relay-chain-authority.smoke`: 0 pass / 4 fail;
  - `native-relay-chain-authority`: 7 pass / 1 fail;
  - `storage-front-binding-release`: 0 pass / 5 fail;
  - `lease-relay-host-policy`: 3 skipped (`BASELINE-NOT-CLEAN`).
- **Not included:** the composed images and trees (3.4 GB).

**`mcp/r1/` and `mcp/r2/`:** `standalone-mcp-authority-stage` (r1, without its `r2/` sub-directory) and its `r2/`:
base and candidate files, patches, manifests, `EXPECTED-TAP.txt` and jobs. Neither ever had a `run/`.
- **r1:** 70 expected; superseded by r2.
- **r2:** **73 expected, queue cap 1408. NOT RUN.**

**`reports/`:**
- `claude-standalone-mcp-authority-result.md` and `claude-standalone-mcp-r2-result.md`;
- `claude-composition-r9-result.md`;
- `root-mcp-authority-r2-0241.out.QUEUED-SNAPSHOT` (0 bytes at copy time: queued, nothing ran).

## Manifests

- **Outer:** `SHA256SUMS` covers **every** file here (`sha256sum -c SHA256SUMS`).
- **Inner manifests are kept as written:**
  - **`r9/stage/SHA256SUMS`:** it also lists a `tools/__pycache__/*.pyc`, deliberately omitted here. Its
    `src.git`/`wt`/`run` references (for example `R3-PINS.sha256` and `REFS.txt`) refer to checkout artifacts **not
    included**. Every other entry verifies in place.
  - **`mcp/r1/SHA256SUMS` and `mcp/r2/SHA256SUMS`:** verify fully in place.
  - **`base`/`candidate` manifests:** they name files in a `git archive` of the base or a candidate clone. They are
    applied by the jobs, not verified here.

## Limits

- **r9:** no pass is claimed. The run continues, and root will publish its final result separately.
- **MCP:** proof and SNP are not qualified. Custody v2 stays REFUSED. The guest MCP activation gate is unchanged (a
  rebuilt bundle, a new measured release, an in-guest loopback verifier, a bound config).
