# Windows host integration r11 — root review

**NOT DEPLOYABLE.** The frozen 225-file candidate remains unchanged by root review. No production, remote Windows, application, financial or configuration action occurred. This is part of the decentralization goal; automatic funding and fenced migration remain unfinished.

## Provenance

The same required-Max Claude invocation `dd6abf47a1394ae2a3b8247cb301b17c` terminated with rc0, session `df9140f7-c0e4-4bd3-941e-12fb4f5b4517`, duration843028ms. Exact recorded PIDs and executable/cwd were clear before collection. Delivery has225 files,9 changes,0 removals; manifest `1eeb9a4f5ccf3dadb83350f463a59bf7de64244c6a28ce2723dd600ef17a6e62`. All6217 readonly input pins matched. Read26/Grep27/Edit34/Write3, no unexpected tools, outside mutations or replay differences. Raw91 user rows and51 distinct assistant message IDs differ from the55 agentic-turn counter. Author inner303MiB/outer369MiB, minimum available32922MiB. Author ran no tests/builds.

## Executed results

| Run | Pass | Fail | Skip/cancel | Scope |
| --- | ---: | ---: | ---: | --- |
| Initial shared-process focused89 | 57 | 32 | 0/0 | Retained harness failure: new sponsored tests leave global fetch mocked until file after-hooks, contaminating later real HTTP tests |
| Separate-process focused90 | 88 | 2 | 0/0 | Same candidate, sequential isolated test processes; includes independent restart reconstruction regression |
| External r8 policy-fixture correction4 | 4 | 0 | 0/0 | Same assertions and product; direct supervisor fixture now installs a real pinned TEST enrollment file/hash |

Runs overlap and must not be summed as unique coverage. The second run changes only test isolation and adds the root regression; it does not repair product code. The third addresses the r8 constructor fixture's missing newly required policy, without overriding the real policy gate. Original failed source and TAP remain. All tests used the shared512MiB lane/hard limit, inner450MiB, floor27648MiB, one CPU/no swap, owned loopback-only namespace and short private test directories. Source pins matched before/after; units MainPID0 and temporary directories absent. Isolated run peak246MiB inner/306MiB outer, minimum33278MiB available. Fixture run inner156MiB. See guards and cleanup evidence for measurements.

Prior r10 root failures now pass: valid-policy corruption/removal, claim/release gate forwarding, permission changes during simulation, and another route's Stop while one route's new-work plan is held. Existing actual two-manager/router TCP composite and owner-loss regressions also pass within their labeled TEST chain/OS/preactivated-handoff scopes. These do not substitute for the missing actual Host-to-owned-runtime positive integration.

## New reproduced blocker

`root-restart-unknown.test.mjs` uses the actual serialized direct sender with inert TEST account/RPC/wallet modules, no real signing/network/payment. An attempted write throws an ambiguous response; the same loaded module correctly refuses another send. A fresh module instance using the same TEST identity and unchanged RPC nonce then reaches a second inert write. The expected refusal fails. This demonstrates loss of the module-memory quarantine; it is a restart reconstruction test, not an OS crash or production transaction demonstration. Pending nonce equality cannot replace a durable attempted-write record. Preserve unknown obligations before effects and recover them before new sends; no automatic replacement, cancellation or nonce jump is authorized.

## Source findings still requiring consuming tests

The frozen peer report `frozen-send-admission-review.md` is source evidence, not additional executed failures:

1. Direct ambiguous writes and claim/renew withheld signatures live only in module memory. Sponsored tests use a TEST lease-client emulator, not the shipped bundle. A gate denied during signing is not latched, so a later restored predicate may permit POST. Release journaling alone does not close all paths.
2. Supervisor policy checks precede further awaited admission, plan, inventory and runtime operations; lower start/serve effects need current authority checks.
3. A Host launch body can be cached before the supervisor's newer authority read. Comparing the newer snapshot with another fresh snapshot does not bind the earlier plan body to it. The actual plan reader does not establish that binding.
4. `settleStart` reads the owned journal before awaiting manager inventory. After the await it checks only admission token and inventory before clearing commitment; it does not re-read newly pending commitments/raw unknown work.
5. Shared unknown-operation reconciliation can hold per-route authority lanes. Caller timeouts retain raw ownership but do not by themselves let a later authenticated Stop bypass that unresolved read/cleanup.

The author explicitly did not deliver real-dispatch fresh-plan/terminal-outcome tests, the mandatory actual Host + real factory/journals/dispatch/runtime/client/manager/router queued → readiness → Running → TCP → off-chain permit refresh → Stop/Offline/owner-loss test, or native protected roles/useful workload integration. Those remain incomplete. Native/Base/Windows/production authority and full release closure are unqualified.

## Dependency and documentation status

Readonly comparison finds all411 recorded npm input hashes in the separate debbfb377 sponsored reference match the installed local dependency files (esbuild0.28.1, viem2.53.1, ws8.21.1). This is neither full dependency/lock acceptance nor a regenerated or tested sponsored bundle. Candidate bundle remains unchanged; no minified patch or authority rollback occurred.

The existing scheduled follow-up prompt was refreshed through the app tool because it repeatedly described obsolete morning jobs. Schedule, identity, status, thread and notification preference were preserved; local before/after evidence is in `automation-context-refresh-20261029`. This is bookkeeping, not implementation progress.

Next author preparation is source-only and not launch authorization. Prioritize the real positive consumer and close the above boundaries using that path; retain durable sender/reconciliation work, actual sponsored-source closure and native/workload requirements. Production payments, finite grants, owner controls, resource floors, pads and storage remain unchanged. No new deposit or wallet request is needed for source work.

Published `source/` contains only the nine changed/new candidate files. The full candidate is described by the delivery manifest and retained locally; this package is not a standalone deployable tree.
