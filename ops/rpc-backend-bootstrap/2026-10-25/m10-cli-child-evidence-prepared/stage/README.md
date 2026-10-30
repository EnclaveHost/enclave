# M10 CLI child evidence: SUPPLEMENTAL offline guest runner (PREPARED; NOT run; no compile/queue/SSH/commit by Claude)

**Why it exists:** root's guest run 2 ended with `## aggregate rc=0`, but its STRICT receipt correctly says **pass:false**
(`ignoredTotal 1`).
- The only ignored test is `node::tests::validates_sequencer_key_from_env_child`, annotated in the original Base CLI
  `node.rs` (line 958): `#[ignore = "spawned by validates_sequencer_key_from_env with isolated process env"]`.
- The three wrapper cases passed in run 2. Each spawns the same binary with `--exact <child> --ignored`, after removing
  the four signer variables and setting the case's env, then asserts the exit status.
- The original receipt, the ignore annotation and the source are **unchanged**. `aggregate rc=0` does **not** prove an
  overall PASS.

## What it runs (guest, root, foreground; only the already compiled run-2 CLI test binary)
- **Binary:** `/srv/m10-guest-validation/runs/run-1/build/target/debug/deps/base_consensus_cli-d6ae36328af6d7bb`, sha256
  `5575a2c2e3735cd6251583259256db305cbefa56c30c1c2047810b9b5d74fa4a`.
  - Run 2 reused run-1's `CARGO_TARGET_DIR` (`m10-guest-import-recovery/bundle/runner/guest-env-2.sh:13`). Because
    that cache is mutable, the launcher hashes the binary, copies it root-owned 0555, executes ONLY the copy, and
    re-hashes both afterwards.
- **Cases:**
  - the 45 non-ignored cases of run 2's `node::` filter (derived from the pinned `cli.test.out`; 10 `bootnode::` + 35
    `node::`), each alone: `--exact <name>`;
  - the child three times, exactly as the wrapper does it (`--exact <child> --ignored`), with the raw_key, key_path and
    remote_endpoint case env;
  - the no-env **negative control**, which must fail by the child's own assertion.
- **Environment:** clean (PATH, LANG, HOME) plus the case variables. That is stricter than the wrapper (which removes only
  the signer variables). The raw_key value is an upstream PUBLIC test fixture from `node.rs`; it is stored only as
  16-char chunks plus a sha256 pin and never logged.
- **Bounded unit:**
  - user m10build; MemoryMax 256M; no swap; CPUQuota 100%;
  - PrivateNetwork, PrivateTmp, ProtectSystem=strict, ProtectHome, NoNewPrivileges;
  - writable ONLY in `/srv/m10-guest-validation/supplement/cli-child-<N>/work`;
  - RuntimeMaxSec 15 min; 60 s per case;
  - no build, cargo, DB or live config.
- **Output:** stdout and stderr saved byte-exact per run, plus `results.json`.

## Pins (`pins/pins.json`, sha256 `4e7c14f1969c5f5af3e648a82033c1f7cfee718c20f3cb1d4d49ff3d90151750`; derived by `tools/derive_pins.py`)
- **Binary:** as above.
- **CLI test source:** `node.rs` `f73fe422634f548f4338995ba4d87c62aede2ae6eb417d2c4fa11a833ac3fe0a`.
  - Reconstructed by Claude: `git show 5476069f:crates/consensus/cli/src/node.rs` + M7 `e9dfb8c6…` + fixed M10
    `d97c31b5…` (its node.rs hunks) equals the `m10-bootstrap/build/tree` copy. The fixed-M10 delta touches only an
    engine file.
  - On the guest it is checked at `/srv/m10-guest-validation/runs/run-2/build/tree/crates/consensus/cli/src/node.rs`
    (refused if that file is absent or different).
- **Run-2 files:** `run-2.out` (`6f22c072…`), `.rc` and `.receipt.json` (`b4162de1…`), and all 8 phase logs, from
  root's collected `outputs/rpc-production-final-20261025/m10-guest-native-2`.

## Compound acceptance (`checker/check_compound.py`, fail-closed; a SEPARATE receipt, never a rewrite of run 2's)
Accepted ONLY if every condition holds:
- **(A) Run 2 pinned:** every run-2 file is byte-pinned. Its receipt fields are exactly as recorded (including
  **pass:false** and ignoredTotal 1). All 8 phase verdict lines and `## aggregate rc=0` are present, and the pinned CLI
  binary is named.
- **(B) The single ignored test is the annotated child:** the ignored total of 1 is exactly that child; every other phase
  log reports 0 ignored.
- **(C) The pinned binary and source were executed:** the binary and its copy hash to the pin before and after, the
  source is the pinned one, and the unit exit is 0.
- **(D) The 45 cases ran alone:** each shows exactly 1 test, `1 passed; 0 failed; 0 ignored`, 141 filtered out, rc 0.
  Zero-test or multi-test output is refused.
- **(E) The child passed three times** with each original case's env keys and value hashes and the wrapper's argv.
- **(F) The control was killed by its own assertion:** rc 101, `0 passed; 1 failed`, and
  `assertion failed: args.validate_sequencer_key().is_ok()` panicking in `node.rs`. Any other failure is INVALID.
- **(G) All 49 runs present:** in order, with output hashes matching.

This is not a blanket rule that ignored tests are acceptable.

## Root commands (prepared; NOT run)
1. **Checker tests** (synthetic, queue 256, foreground):
   `python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 256 --log <stage>/logs/check-tests.guard -- python3 -I <stage>/tests/test_check_compound.py`
2. **Guest:** copy this stage read-only to `/srv/m10-guest-validation/stage-cli-child` (root-owned, outside /home), then:
   `bash /srv/m10-guest-validation/stage-cli-child/runner/run-cli-child-supplement.sh 1 4e7c14f1969c5f5af3e648a82033c1f7cfee718c20f3cb1d4d49ff3d90151750`

   Outputs land in `/srv/m10-guest-validation/receipts/cli-child-1.{out,launcher.json,compound.json}` plus
   `/srv/m10-guest-validation/supplement/cli-child-1/work/out/`. Collect them with the rest of the guest log under
   `outputs/rpc-production-final-20261025/m10-guest-native-2`.
