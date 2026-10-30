# M10 CLI child evidence: root supplement ACTUAL PASS; compoundAccepted true; run-2 receipt STILL pass:false

## Current status (actual, root run 2026-10-25 ~23:39 UTC)
- **Run-2 receipt (unchanged and preserved):** `run2-evidence/run-2.receipt.json` (`b4162de1…`) still says
  **`pass:false`, `ignoredTotal 1`**.
  - Run 2's `## aggregate rc=0` alone never proved an overall PASS. That receipt is not rewritten, not loosened and not
    replaced.
- **Root job `actual/root-2339/`** (`root-m10-child-2339.sh`, `.out`, `.rc` = 0, `.guard`):
  - **Local checker tests:** `tests/test_check_compound.py` ran **7/7 OK**.
  - **Guest run:** the read-only stage copy was verified against `MANIFEST.sha256` `f3d45ccb…`, then the launcher ran
    attempt 1. `launch.rc` is 0.
  - **Memory guard:** peak 47 MiB, minimum host available 23090 MiB.
- **Guest supplement `actual/supplement-1/`:**
  - **Launcher receipt** `cli-child-1.launcher.json` (`09621f4e…`):
    - unit `Result=success`, exit 0;
    - the binary at its pinned path and the executed root-owned copy were both
      `5575a2c2e3735cd6251583259256db305cbefa56c30c1c2047810b9b5d74fa4a`, **before and after**;
    - CLI test source `f73fe422…` (`node.rs`, the reviewed reconstruction).
  - **The 49 runs, recorded byte-exact** (`out/`: 49 stdout, 49 stderr, `results.json` `551406ea…`). Every file was
    re-hashed against `results.json` during this publication: 0 mismatches.
    - **45 non-ignored cases, each alone** (`--exact <name>`): 45/45 show `running 1 test`, the expected name `... ok`,
      `1 passed; 0 failed; 0 ignored; 0 measured; 141 filtered out`, rc 0.
    - **Child ×3**, exactly as the original wrapper spawns it (`--exact <child> --ignored`), with the raw_key, key_path
      and remote_endpoint case env (clean env plus case variables; the raw_key slot is the upstream public test fixture,
      recorded only as a hash): 3/3 pass the same way, with 0 ignored.
    - **No-env negative control:** rc 101, `0 passed; 1 failed; 0 ignored`, killed by the child's own assertion:
      `panicked at crates/consensus/cli/src/node.rs:969:9: assertion failed: args.validate_sequencer_key().is_ok()`.
  - **Compound receipt** `cli-child-1.compound.json` (`79a0beb9…`): **`compoundAccepted: true`**,
    `originalReceiptPass: false`, `failures: []`, summary 45 / 3 / control killed by its assertion.
  - **`stop.out`:** `Unit … not loaded`. This is root's cleanup after the unit had already ended; benign.
  - **`TAR-INDEX.txt`:** the guest `supplement-out.tar` (sha256 `d3452372…`, 112640 B, 99 regular files + `out/`) is
    **not published**. Its members were extracted with a filter (regular files under `out/` only; no links or paths) and
    are all in `out/`.

## What the compound acceptance does and does not establish
- **Established:** the A–G conditions in `stage/README.md`.
  - The pinned run 2 has all 8 phase verdicts + aggregate (all 8 phase logs are in `run2-evidence/`, matching the pins).
  - Its single ignored test is exactly the annotated child.
  - The supplement ran the same compiled binary.
  - The previously ignored child test, `node::tests::validates_sequencer_key_from_env_child`, has now run **explicitly
    three times** with the original cases' env and passed.
  - The control proves that the child really asserts.
- **Scope of the targeted run:** run 2's CLI phase was the targeted `node::` filter, which matched **46** tests:
  - 45 run, made up of **10 `bootnode::` + 35 `node::`**;
  - 1 ignored (the child).

  **No claim is made about the full 142-test CLI suite.** The other 96 tests were filtered out in run 2 and are not
  covered here.
- **Unchanged:** there is no source fix, the `#[ignore]` annotation stays, and there is no ignored-test whitelist.
  Consumers must integrate `cli-child-1.compound.json` together with run 2's pinned evidence, never by requiring
  `run2.pass:true`.
- **Not deployed:** the production combined build must still wait for its own reviewed gate and test pass.

## Contents
- **`stage/`:** the prepared supplement, **unchanged** (`MANIFEST.sha256` `f3d45ccb…` verifies; the combined release
  worker consumes it).
- **`run2-evidence/`:**
  - run 2's `run-2.receipt.json`, `run-2.out`, `run-2.rc`;
  - **all 8 phase logs:** cli, engine, node, node-seq, node-safedb, node-derivation, control-engine, control-node;
  - `result.json`, `remote.out`, `precheck.out` (empty).

  Collected by root in `outputs/rpc-production-final-20261025/m10-guest-native-2`.
- **`actual/root-2339/`, `actual/supplement-1/`:** as above.
- **`SHA256SUMS`.**
- **Excluded:** no binary and no tar archive.
