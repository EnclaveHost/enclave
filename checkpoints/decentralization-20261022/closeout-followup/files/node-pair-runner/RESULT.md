# Root-only runner for node-pair-restart.ps1 (RESULT, 2026-10-22)

**Status: source prepared and tested offline with a stub transport and a stub scp.**
- NEVER run against minipc: no ssh, scp, native PowerShell, wallet, VM, chain or funds.
- The `node-restart-final` files were read only: not changed, its tests not run.
- Root freezes the final pins and owns review and activation.

## Files (`work/resume-after-checkpoint-20261022/node-pair-runner/`)

| file | sha256 | role |
|---|---|---|
| `root-node-pair.py` | `a1c950f246826bd9204e0b6a60115a2631196ae81f60c58810ca64bd3cfbf2fa` | the runner (267 lines) |
| `PARAMS.md` | `435a382a943cdd021de6a6d8d98f93c351207e301b67ac1a29cceaa4f32b42d7` | params schema |
| `params.identify.example.json` | `71ddf2477cdbcc498d7af245e95f3a0130d9873a5c8e58b644e10eebcffa6476` | template; live identities unset |
| `params.apply.example.json` | `487fd9305ab335aa0116d20e81ae88c12277cb4338a2f644559fbf673108b701` | template; every FINAL identity null (refused as is) |
| `test_root_node_pair.py` | `9b4183bfe006dae43aeadbb18d391877990ad3cc1771bac6dce4a04952abdca4` | 31 stubbed tests |
| `run-tests.sh` | `38b7caaf97b28edc2461b3954954349e3f33c5851a5c24759145109107afe44f` | the tests in a private network namespace, `timeout 300` |
| `mutants.py` / `run-mutants.sh` | `b08f600d…` / `c36deb06…` | 5 one-line safety mutants |

## Pins

**In the runner (reviewed, final):**
- transport `work/nucbox-tls-20261021/root-activate-reviewed.py` **c50aac8e…**. It is loaded only by a remote command, and
  only if its bytes are that pin. `ps()` is used unchanged.
- `bundle-swap.ps1` **21d85c69…** (`work/cron-startup-20261021/respawn-activation/`), unchanged.
- `U`, `LOADER`, `LAUNCH`, `JOURNAL`: **verbatim** from `root-control-rpc-final-20261022/control-package/helper/root-node-hold.py`
  (`1d1b995c…`). A test evaluates those four assignments from that file's AST and asserts byte equality.

Nothing else of that runner is inherited: no manifest, network/control file sets, cutover, budget, `NODE_EXE` or source pins.

**Supplied by root at run time** (nothing WIP is hard-coded):
- the helper path and sha;
- the two candidate modules (path and sha each);
- per run, a params file and its sha.

The fixed node binary path is `C:\Program Files\Enclave\runtime\node\node.exe`. Root supplies and verifies its sha
(`nodeSha`).

## What it does (and only this)

The help text and an import are inert: the transport is loaded lazily, and a test patches `subprocess.run` before the
import and records nothing.

1. **`--stage`**
   - **Local first:** helper, chain and host each exist and equal root's sha; chain ≠ host; bundle-swap is the pin.
   - **Then one NEW stage** `C:\ProgramData\Enclave\staging\nodepair-<uuid12>`:
     - it is created WITH a protected DACL granting SYSTEM and Administrators FullControl, and no other entry;
     - a pre-existing path refuses;
     - the protection and the DACL SIDs are read back, and anything else uploads nothing.
   - **Uploads ONLY** `node-pair-restart.ps1`, `bundle-swap.ps1`, `files\chain.mjs` and `files\host.mjs`, using
     `timeout 300 scp … minipc:/C:/…`.
   - **Then reads** every uploaded sha and the stage ACL again. The receipt is `ok` only if everything matches.
2. **`--run identify|apply|rollback`**, in this order:
   1. **Local checks, before any remote call:**
      - a passing stage receipt with a well-formed stage path;
      - the params file equals `--params-sha`;
      - the schema of `PARAMS.md`.
      - For apply and rollback, every FINAL identity must be explicit: node, scheduler, privacy, manager, vms, hyperv,
        task, nodeSha, runner, oldShas, the exact `expectedIds` and root's `lease` budget.
      - Paths are exact: targets are exactly `…\control\windows\node\{chain,host}.mjs`; newFile and workDir sit inside
        the stage.
      - No `test*` keys and no unknown keys. `runId` is restricted to `[a-z0-9-]`, at most 41 characters.
   2. **The attempt record** `runs/attempt-<mode>-<runId>.json`, opened O_EXCL BEFORE the first mutation. An existing
      record refuses: nothing is ever retried.
   3. **The params upload**, then a remote sha read. Any mismatch or scp failure launches nothing.
   4. **ONE `LAUNCH`** (verbatim): the unique one-shot SYSTEM task `\EnclaveOps\node-pair-<runId>`, with a 20-minute
      ExecutionTimeLimit and `IgnoreNew`.
      - Its action is `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand <LOADER>`.
      - The verbatim ScriptBlock loader runs the helper only from bytes hashing to the helper pin, with
        `-Mode <mode> -ParamsFile … -ParamsSha …`.
      - No `-File`, no ExecutionPolicy change, no Bypass; the tests assert this on every remote text.
      - Any answer other than `decision: started` is **LAUNCH NOT CONFIRMED**: it is recorded, not retried, and root
        reads `--status`.
   5. **Polling** with the verbatim `JOURNAL` read of `<stage>\pair-<runId>.jsonl`, for at most 1260 s. `JOURNAL`
      unregisters the task only after a final line, and only when the task is not Running.
      - The result receipt holds the journal lines and the classified final.
      - Success means `IDENTIFIED` (identify), `DONE:` (apply) or `ROLLED_BACK:` (rollback).
      - Every other final is reported as recovery, refused, check, crashed, pair-unchanged-restarted or unknown, with
        exit 3. Nothing automatic follows.
3. **`--status --stage-receipt R --run-id ID`**: read-only `TASKINFO` (LastTaskResult and LastRunTime) plus `JOURNAL`.

The runner never writes live files, configs or other tasks. Receipts hold shas, paths, task names and the helper's
journal lines; the helper's journal is hash, PID and count only. They never hold config or wallet values or file
content (a test checks the stage receipt for a content marker). The runner never reads configs.

## Tests (`work/claude-test-queue.py --mib 256`, private network namespace via `run-tests.sh`, `timeout 300`)

| run | result |
|---|---|
| t-1 | 10 ok / 21 bad: 20 were my stub's MKSTAGE matcher; **1 was a REAL runner bug** (below) |
| t-8 | 25 errors: my comment edit had swallowed the `HEX` / `ID` definitions |
| t-9 | 30 / 1: my test's no-attempt assertion did not allow an earlier test's attempt record |
| t-10 | 31 / 31 OK |
| **final-1** | **31 / 31 OK** on the final bytes |

**The real runner bug, fixed.** With a 63-character runId, the `LAUNCH` text (the runId appears in the task name and,
encoded twice, in the loader) encoded to **8036** characters. The transport refuses anything over 7900, so `ps` would
have refused the launch locally. The runId is now capped at 41 characters, and the test checks the longest accepted
runId and the rollback mode against the REAL transport `HEAD`.

What the 31 tests cover:
- **Inert:** the import makes no subprocess call; usage and `--help` load no transport and make no call.
- **Local pins first:** a mismatched or missing helper or module sha, a malformed sha, identical modules, a params sha
  mismatch and a tampered transport file each refuse with zero remote texts and zero scp calls.
- **Stage:** the creation text is protected and SY+BA only, Test-Path comes before CreateDirectory, and exactly 4 uploads
  land in the stage. A pre-existing stage or an open DACL uploads nothing. A remote hash mismatch makes the stage not
  ok. A failing or traversal stage receipt is refused.
- **Params gate:** the apply example (identities null) is refused with every missing item named. Each final identity
  removed, in turn, refuses. Empty, duplicate or bad `expectedIds`, a partial lease and an `unavailable` VM set refuse.
  None of these makes a remote call or writes an attempt.
- **Quoting and path bounds:** a runId containing a quote, a space, upper case, `..` or more than 41 characters refuses.
  So do a target traversal, a newFile outside the stage, a shared workDir, a wrong newSha, a single file, another stage,
  a wrong bundle-swap sha, another node.exe, boundSec 1200 or `true`, unchangedFiles with `..` or a path in the stage or
  on D: or containing `'$(…)` or naming a target, `test*` keys and unknown keys. `q()` doubles quotes.
- **Uncertain launch:** an `ssh rc 255` answer gives exit 3 with one launch only. The second invocation exits 4 (attempt
  exists) with zero further remote texts or scp calls.
- **Upload failures:** a params upload with a sha mismatch, or a failed scp, launches nothing.
- **Apply:**
  - the attempt record exists BEFORE the params upload;
  - the task name, the `\EnclaveOps\` path, SYSTEM and the 20-minute limit are present;
  - the decoded ENCX equals `LOADER` with exactly the helper sha, params path, params sha and mode;
  - the journal path is correct and a `DONE:` final gives exit 0.
  - A `RECOVERY_REQUIRED` final is not success; an unparsable `"final"` line is ignored.
- **Rollback and identify:** a terminal-return rollback runs `-Mode 'rollback'`, and a rollback without identities
  refuses. Identify runs with identities unset and `IDENTIFIED` gives exit 0. With no final, the run reports
  `NO FINAL YET`, exit 3.
- **Status:** exactly 2 remote reads (TASKINFO, JOURNAL), and a bad runId is refused.
- **Verbatim:** U, LOADER, LAUNCH and JOURNAL equal root-node-hold.py's AST values. Every remote text at its maximum
  length fits 7900 with the real transport `HEAD`. `classify()` is checked on all helper finals.

**Mutants** (mut-9, `--mib 256`, private network namespace): all **5 killed**, each by a named failing test:
- m1: no O_EXCL on records;
- m2: no local sha check;
- m3: stage without a protected DACL;
- m4: no final-identity gate;
- m5: a fresh attempt name per invocation, which would allow a retry.

An earlier m1 that removed the `try:` line was a SyntaxError, not a kill (mut-3). The script now marks a mutant that
does not compile as INVALID.

Logs: `logs/` (t-*, final-1, mut-3, mut-9, each with a `.guard.log`).

## Root commands (`cd work/resume-after-checkpoint-20261022/node-pair-runner`)

```sh
# 0. local, no remote: the tests
python3 -m unittest -v test_root_node_pair.py
# 1. stage (root's FINAL reviewed helper + the two candidate modules, each with its sha)
./root-node-pair.py --stage --helper <final node-pair-restart.ps1> --helper-sha <sha> \
    --chain <candidate chain.mjs> --chain-sha <sha> --host <candidate host.mjs> --host-sha <sha>
#    -> runs/stage-<ts>.json (stage path + verified upload shas)
# 2. FIRST actual step: read-only identify (helper -Mode identify)
#    copy params.identify.example.json -> params-identify.json; fill in stage, runId, boundSec (e.g. 300),
#    newSha = stage receipt inputs.*.sha, unchangedFiles paths; nodeSha optional
sha256sum params-identify.json
./root-node-pair.py --run identify --stage-receipt runs/stage-<ts>.json --params params-identify.json --params-sha <sha>
#    -> runs/identify-result-<runId>.json: the IDENTIFIED line (identities, task action, scheduler, VM sets, leases, file shas)
# 3. apply: params-apply.json from params.apply.example.json, every identity from step 2, oldSha = the identified live
#    shas, expectedIds = the EXACT running set, root's lease budget (node-restart-final table), a NEW runId
sha256sum params-apply.json
./root-node-pair.py --run apply --stage-receipt runs/stage-<ts>.json --params params-apply.json --params-sha <sha>
# status at any time (read-only; unregisters the task only after a final line and only if it is not running)
./root-node-pair.py --status --stage-receipt runs/stage-<ts>.json --run-id <runId>
# 4. explicit return (same stage, NEW runId, fresh identify first; reserve as the helper requires)
./root-node-pair.py --run rollback --stage-receipt runs/stage-<ts>.json --params params-rollback.json --params-sha <sha>
```

After any exit-3 outcome (LAUNCH NOT CONFIRMED, NO FINAL YET, RECOVERY_REQUIRED, a CHECK): read `--status`. Never re-run
the same attempt; a new run needs a new runId and root's decision.

## Limitations (honest)

- **Not run on Windows.** `MKSTAGE`, `SHAS` and `TASKINFO` are NEW PowerShell texts and were never parsed by PowerShell
  5.1. LOADER, LAUNCH, JOURNAL and the transport are the reviewed texts.
  - If MKSTAGE throws, the transport returns an error and nothing is uploaded. An empty private stage may remain.
  - Root may want to parse-check the three new texts first.
- **Elevation.** scp into a protected SY+BA directory needs the SSH session's Administrators token, as with the earlier
  staging. This is not re-verified here.
- **The staging parent.** If `C:\ProgramData\Enclave\staging` does not exist, CreateDirectory also creates it with its
  inherited ACL. Only the stage itself carries the protected DACL.
- **A task that ends without a final line** (the helper's lock refusal, loader exit 3 on helper bytes, params exit 4 or
  5) stays registered by design: JOURNAL only unregisters after a final. Root reads `--status` (LastTaskResult) and
  unregisters it by hand once decided.
- **The helper is not final.** Its sha (656d642a when read) is still being finalized by its owner. The runner accepts any
  path plus sha root supplies; root must supply the frozen, reviewed one. The params schema follows 656d642a's `$PRM`
  use; if the final helper adds a key, the runner refuses it as unknown until `allowed` is extended.
- **Polling** stops after 1260 s; after that, `--status`. The runner does not judge lease budgets or the running set:
  the helper's gate is authoritative.
