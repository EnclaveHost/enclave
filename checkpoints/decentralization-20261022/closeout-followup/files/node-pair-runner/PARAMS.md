# Params for node-pair-restart.ps1 through root-node-pair.py

Root writes ONE immutable params file per run, takes its sha256, and passes both: `--params FILE --params-sha SHA`.
- The runner checks the sha and the schema below BEFORE any remote call.
- It uploads the file to `<stage>\params-<mode>-<runId>.json` and verifies the uploaded sha.
- The task's loader passes the same sha to the helper as `-ParamsSha`, and the helper refuses other bytes.

Templates: `params.identify.example.json` and `params.apply.example.json`. Every FINAL live identity in them is
intentionally `null` or a `<…>` placeholder, and the runner REFUSES them for apply and rollback. This runner picks no
lease budget, no expectedIds and no identity.

| key | identify | apply / rollback | rule enforced by the runner (the helper re-checks everything at its pins) |
|---|---|---|---|
| `stage` | required | required | exactly the stage of `--stage-receipt` (`C:\ProgramData\Enclave\staging\nodepair-<12 hex>`) |
| `runId` | required | required | `^[a-z0-9][a-z0-9-]{5,40}$`, new per run. It names the task `\EnclaveOps\node-pair-<runId>`, the journal `<stage>\pair-<runId>.jsonl` and the attempt record. The 41-character cap keeps LAUNCH under the transport's 7900 encoded characters |
| `boundSec` | required | required | integer 1..1140 (the helper's MAX_BOUND, inside the task's 20-minute limit); the helper also checks its minimum |
| `nodeExe` | required | required | exactly `C:\Program Files\Enclave\runtime\node\node.exe` |
| `nodeSha` | optional | required | 64 hex: root's verified sha of that node.exe. In identify, a wrong or unset value is only reported (`params`) |
| `bundleSwap` | required | required | `{ "path": "<stage>\\bundle-swap.ps1", "sha": "21d85c69…" }` |
| `files` | required | required | exactly `chain.mjs` and `host.mjs`, see below |
| `unchangedFiles` | list (sha may be null) | non-empty, each sha 64 hex | absolute `C:\` paths only: no `..`, no quote or `$` characters, not inside the stage, not the two targets |
| `runner` | — | required | `0x` + 64 hex (the helper's readiness compares it) |
| `task` | — | required | the identified `\Enclave\Node` action: `{ execute, arguments }` |
| `node` | — | required | `{ cmdPid, cmdStart, agentPid, agentStart }`: positive PIDs, ISO start times from identify |
| `scheduler` | — | required | `{ pid, start, name, commandLike }` (the parent of run-node's cmd.exe) |
| `manager`, `vms`, `hyperv` | — | required | the identified strings (never `unavailable`) |
| `privacy` | — | required | `{ pid, start }` |
| `expectedIds` | — | required | root's EXACT running set: unique `0x…` ids. The helper refuses any other set, at the pins and again before the stop |
| `lease` | — | required | root's explicit budget `{ reserve, marginSec, revertSec, forwardMinSec, startNodeSec, returnPinsSec }`. The runner only requires the four integers; the helper's gate judges the values and the reserve kind (full-return / recovery-start / terminal-return, rollback only) |
| `test*` | refused | refused | the mock harness keys never go to minipc |
| any other key | refused | refused | |

Each entry of `files`:

```json
{ "name": "chain.mjs",
  "target": "C:\\Program Files\\Enclave\\control\\windows\\node\\chain.mjs",
  "oldSha": "<the live sha from identify (apply) / the sha the apply replaced (rollback)>",
  "newSha": "<the staged candidate's sha: stage receipt inputs.chain.mjs.sha>",
  "newFile": "<stage>\\files\\chain.mjs",
  "workDir": "<stage>\\swap-chain.mjs" }
```

`host.mjs` is the same with its own name. For identify, `oldSha` may be null.

A rollback uses the same stage as its apply (bundle-swap's backups live in those work directories) and a NEW `runId`.
