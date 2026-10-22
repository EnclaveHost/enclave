# Independent host onboarding: integration patches (NOT applied)

These patches finish the source glue for `cli/host-independent-lifecycle.mjs`
(docs/network/independent-host-onboarding.md). They touch files this workstream
does not own, so they are written here for the coordinator to apply once the
owners release those files.

Apply from the repository root with `patch -p1 < FILE`. On 2026-10-19 each
patch passed `patch -p1 --dry-run` against the base hashes below.

| Patch | Files | Owner | Base sha256 |
|---|---|---|---|
| `01-cli-enclave-cmdHost-delegation.patch` | `cli/enclave.mjs` | CLI / move worker | `5c21db40f393806f9da44392c35174d626e580356a7b206c0f30a361e599125d` |
| `02-supervisor-key-file-and-explicit-rpcs.patch` | `supervisor.js` | supervisor / direct-runtime worker | `2b7dd8b8bd455aa6556a472dd86093b84c7bb410ef7906cc79698c9d54b88cdc` |
| `03-lifecycle-companion-for-02.patch` | `cli/host-independent-lifecycle.mjs`, `test/cli-host-independent-lifecycle.test.mjs` | this workstream | `886ef152…f5570` and `2ff02e0c…181e4` (the full hashes are in the result report) |

**02 and 03 must be applied together.** If 03 lands alone, the env file gets
`REGISTRY_PRIVATE_KEY_FILE`, which today's supervisor ignores; that host would
silently never register. If 02 lands alone, nothing changes: the env file still
carries `REGISTRY_PRIVATE_KEY`.

## 01: `enclave --independent host init|build|install|run|check|referral`

- **Before the fix:** `cmdHost` refuses these commands in independent mode.
- **The fix:** the command now delegates to `hostLifecycle` from
  `cli/host-independent-lifecycle.mjs`, before `flags()` parses the arguments
  (the lifecycle has its own flags, such as `--dir`).
- **init:** it forwards this invocation's authorities to the plan:
  - `--profile` and `--profile-digest`, or the `--contract-pins` file;
  - the RPCs, quorum, confirmations and maximum block age that
    `configureIndependent` already validated.
- **Later commands** read the authorities from the plan.
- **Exit codes** pass through: `check` exits 3 (not ready) or 4 (unknown).
- **Unchanged:** `status`, `fund`, `declare-payout` and `clear-payout` keep
  their existing independent paths.
- **Refusal message:** it now lists the lifecycle commands.

Verified in a scratch tree with the patch applied, running `node cli/enclave.mjs`
with an isolated HOME and `--independent --profile … --profile-digest … --rpc
https://127.0.0.2:1,https://127.0.0.3:1`:

- `host init` exits 0, and the plan records the global authorities;
- `host build --dry-run` reads the plan;
- `host check` exits 3, with chain rows UNKNOWN;
- `host referral` without a code prints the optional message;
- `host frobnicate` gets the new refusal message.

Follow-up for the CLI owner (not in the patch): `docs/network/independent-cli.md`
and the HELP text can now link to independent-host-onboarding.md instead of
saying host setup is refused.

## 02: the supervisor reads only the operator's RPCs, and can read the key from a file

- **`BASE_RPCS`:** a comma-separated list. When set, `RPC_POOL` is exactly that
  list. Today `RPC_POOL` is always `BASE_RPC` plus publicnode, drpc, 1rpc and
  mainnet.base.org, as a first-answer fallback, so a direct-only host still
  reads through RPCs its operator never chose. This patch does not change the
  supervisor's read semantics: the pool is still viem `fallback`, not a quorum.
  That remains a residual for the supervisor owner.
- **`REGISTRY_PRIVATE_KEY_FILE`:** the operator key is read from a regular file
  owned by this user, mode 0600/0400. Setting both forms is refused. Every
  problem is `FATAL` + `process.exit(1)`, the same as `need()`. A plain throw
  would be swallowed by the supervisor's `uncaughtException` guard, and the
  host would run without ever registering; that was found and fixed while
  testing this patch.

Verified by the patched test in 03 against the real patched `supervisor.js`:

- it starts in direct-only mode with the key file;
- with the key file at mode 0644, it exits 1 with
  `FATAL: REGISTRY_PRIVATE_KEY_FILE must be this user's regular 0600 file`.

## 03: the lifecycle uses 02

- `supervisorEnv` emits `REGISTRY_PRIVATE_KEY_FILE=HOST_DIR/operator.key` and
  `BASE_RPCS=<the plan's quorum RPCs>`. The env file then holds only `SECRET`.
- The tests are updated to match.

Verified: the full lifecycle suite passes 8/8 with 01 + 02 + 03 applied in a
scratch tree.

## Verifying after applying

```sh
node --test --test-concurrency=1 test/cli-host-independent-lifecycle.test.mjs
```
