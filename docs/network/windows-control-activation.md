# Scoped Windows control-source activation

`windows/installer/activate-control-source.mjs` brings an installed Windows host's node-agent source
(`C:\Program Files\Enclave\control`) to a reviewed closure, such as the app-funded lease release. It does this without
the full installer, which stops every `\Enclave\` task including the Shield/VM manager. The tool:

- writes only the closure paths whose installed hash differs from the reviewed one, each checked against its recorded
  BEFORE hash;
- ends only the node agent: the process running `control\windows\node\agent.mjs`. Its `run-node.cmd` loop starts the
  new code about 10 s later;
- never touches the Shield manager, its VMs, the scheduled tasks, `C:\ProgramData\Enclave` (keys, `node\host.json`,
  `node-config*.cmd`, logs, state) or the npm packages. Its only writes outside the closure paths are its own journal,
  in `C:\ProgramData\Enclave\control-activation\<plan id>`;
- does not configure app-funded leases. The `ENCLAVE_LEASE_GAS_*` settings are a separate, reviewed step. Until they
  exist, the host keeps the operator-paid path, and a configured lease error never falls back to the operator's ETH.

Run it with the host's own runtime:
`"C:\Program Files\Enclave\runtime\node\node.exe" activate-control-source.mjs ...`

## Steps

1. **Inventory (read-only).** `inspect-public-closure.ps1` lists every closure path with its installed sha256, along
   with the agent's listener and the manager's VMs.
2. **Plan (offline).** `node activate-control-source.mjs plan --closure live-closure.json --source <reviewed tree> --id <id>
   --out plan.json`. This records BEFORE and AFTER hashes for every changed path, and the hash of every unchanged one.
   Review the plan. Paths under `windows/vbslike/manager|datapath` are reported as `managerShared`: the running manager
   loads them too.
3. **Apply.** `node activate-control-source.mjs apply --plan plan.json --source <tree> [--accept-manager-shared]`.
   1. A read-only preflight runs first. It refuses, changing nothing, on any of:
      - an unchanged path that drifted;
      - a changed path that is neither its BEFORE nor its AFTER;
      - a source file that is not its AFTER;
      - a path through a link;
      - a manager-shared change without `--accept-manager-shared`.
   2. The journal is opened and verified backups are taken.
   3. Each file is written beside its target, renamed over it, and every hash is verified.
   4. Only the agent process is ended.
   5. Observation: a new agent process answering `http://127.0.0.1:9600/v1/health`, and the manager's VMs (8091
      `/vms`) as they were.
4. **Status.** `node activate-control-source.mjs status --plan plan.json` re-hashes every planned file and observes the
   agent and the VMs again.
5. **Rollback.** `node activate-control-source.mjs rollback --plan plan.json` restores exactly the files the journal
   says were written: verified backups, and new files removed. It never overwrites a file that has changed since
   (reported as `rollback-conflict`). Then it ends the agent again and observes.

**Results.**

| Exit | Meaning |
| --- | --- |
| 0 | Done and observed. |
| 3 | Done but **unobserved**: the agent did not answer within `--observe-sec` (120 s by default), or there was no agent to restart. |
| 2 | Refused; nothing changed. |
| 1 | An error mid-way. The journal says what happened. Rerun `apply` (it resumes) or `rollback`. |

An unobserved result is not a failure and is never rolled back automatically. The files are in place, and `status`
observes again.

## The current host (2026-10-20 read-only inventory)

- 32 of the 80 closure paths differ from the reviewed main closure: 18 are new and 14 changed.
- The lock files are unchanged, so no npm step is needed.
- One readiness VM was running under the manager, and the agent was PID 19996.

Four of the changed paths are in the manager's import graph, so `--accept-manager-shared` is required:

| Path | Status | Why accepting it is safe |
| --- | --- | --- |
| `windows/vbslike/datapath/node-bridge.mjs` | Changed | The installed version is the one at commit c2bc3cc6. The new version only passes an optional `allowedNames` list to `spliceStream`, so the running (older) manager is unaffected, and so is a later restart of it with this file. |
| `windows/vbslike/manager/custody-key-file.mjs`, `custody-transport.mjs`, `bridge-auth.mjs` | New | The running manager predates them and does not load them. The new agent uses them only when `ENCLAVE_CUSTODY_CALLBACK_KEY_FILE` is set, an environment setting this activation does not change. With that setting but an older manager, custody requests are refused and logged, not fatal. |

Updating the manager itself (its own closure, restarting it, and with it the VMs) is a separate decision this tool does
not make.
