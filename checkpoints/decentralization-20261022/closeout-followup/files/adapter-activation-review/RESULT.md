# One-file host.mjs activation on minipc: smallest bounded plan from EXISTING helpers (read-only source review, 2026-10-22)

No live call, SSH, RPC, test, build, wallet or mutation was made. Root re-reads everything live before any step.

## 0. What changes, and what is NOT claimed

**The change:** `C:\Program Files\Enclave\control\windows\node\host.mjs`, live `9634cb40` → the reviewed candidate.

- **Today's candidate.** `637fbdf6` (adapter-admission-review `ad4a72a`). It is a host.mjs-only diff and adds no import
  (patch `422f144d`). host.mjs is no generated bundle's input.
- **The final candidate may change.** The renewal-retry worker may edit the same file. Pin the FINAL reviewed bytes.
- **Not claimed tested.** Any renewal change is not claimed tested here.
- **Not a one-file change if it grows.** If the final host.mjs imports a new module, it is no longer a one-file
  change: re-review.

**Unchanged:**
- wallet-admission `0fa7678f`, agent `76cac355`, host-admission bundle `6bef372d`, privacy agent `cfb69370`;
- run-node.cmd `0fdc3699`, node-config.local.cmd, privacy-config.json;
- the book, contracts, policy, credentials and ExecutionPolicy.

## 1. Live state this plan starts from (root's read-only evidence)

| | value | source |
|---|---|---|
| host.mjs | `9634cb40` | adapter-preflight.json 21:44:25Z |
| node agent / run-node cmd | 33032 (start 03:37:27.6506510Z) / 32204 (03:37:27.5955170Z), parent chain 3292→32204→33032 | same |
| manager (8091) | 35464, start 2026-10-21T12:13:07.5552110Z | same |
| privacy agent | 13932, start 03:37:14.0971470Z | same |
| Hyper-V | 4 VMs Running (ids in the preflight) | same |
| `\Enclave\Update` next run | **22:13:36Z** | same (`nextUpdate`) |
| adapter `0x7ae476a3…ce33` | lease expired 21:39:43Z; renew failed at 21:37:50 (lease-gas RPC quorum); retired at 21:44:42 (correct); reclaimed at 21:45:19 (tx `0xf3a2cd04…`); **new leaseUntil 1792707319 = 22:15:19Z**; status `claiming` at 21:45:37 | host-renewal-diagnostic.json |
| others | 10 deployments failed/queued/refused: underfunded or not admitted | adapter-preflight.json |

## 2. Reusable existing pieces, and what each one does NOT cover

| piece | sha | reuse | limits |
|---|---|---|---|
| `cron-startup-20261021/respawn-activation/bundle-swap.ps1` | `21d85c69` | **yes, unchanged**: `-Target` takes any node file. CAS (`-OldSha`, `-NewSha`); `node --check` on the exact bytes to be installed; private SY+BA backup; destination ACL restored and SDDL-checked; hash-only journal (apply refuses while a mutation is "started"); `-Mode rollback -ExpectCurrent` | inert for the running agent: the module is loaded at start |
| `…/respawn-activation/node-restart.ps1` | `beac40d9` | **`-Mode identify` only (read-only)**. Its `-Mode restart` (pins: run-node sha, agent PID+start, cmd PID+start, manager PID+start), re-verified before the task stop and before any Stop-Process; new agent must be a child of the new cmd; pause bound `-MaxPauseSec` 30..180; manager, other `\Enclave\` tasks and VM set compared after | readiness is only "9600 answers"; it does **not** check listener ownership, lease readiness, the updater or the lease. Its task Stop/Start are **unbounded** `Stop-/Start-ScheduledTask` cmdlets: an outer SSH observation timeout does not bound them. So `-Mode restart` is **NOT a bounded restart** and is not proposed. Root's own earlier run recorded `vmSetUnchanged=FALSE` (unattributed; enclavedns retry review B1) |
| launcher expression `run_script` (`activate.py:47-53`) | — | **the expression only**: read the staged file, compare its sha to the pin, run the bytes as a ScriptBlock with splatted params. No `-File`, no ExecutionPolicy change of any scope. This is the same pattern root already uses in production via `root-node-hold.py`'s one-shot SYSTEM task | `activate.py` as a whole is **NOT reusable**: it pins stale live code (host `2500c650`, run-node `3366a005`, bundle `7ce23a55`) and would refuse |
| `root-node-hold.py` IDN text + `node-hold-cutover.ps1` functions (`BeforeStop`, `UpdateDecision`, `Invoke-TaskCommand`, `StopNode`, `StartNode`, `AgentUp`, `LeaseReady`) | `1d1b995c` / `df2e58f2` | **reference only**. They hold the stronger root-accepted guards: bounded task commands; updater window; lease forward/revert budget; 9600 owned by the NEW agent PID before and after; leaseReadiness pass started after the new agent and completed | reachable only through `-Mode cutover` / `rollback`, which edit configs. Cutover would refuse (pins expect old config shas). **`-Mode rollback` would undo the wallet hold: never use it for this** |
| `public-health/adapter-preflight.py` (+ host-renewal / admission readers) | `f65021de` | **yes, read-only**: PIDs, apps, live `9600/v1/host/state` leaseReadiness, VMs, `nextUpdate` | adds nothing by itself; pair it with a listener-owner query |

**Correction (supersedes RESULT.v1.md).** No existing helper offers a BOUNDED node-only restart.
- The bounded task commands (`Invoke-TaskCommand` with a confirmed response and no automatic retry, `NodeTask`,
  `StopNode`, `StartNode`, `AgentUp`, `LeaseReady`, `BeforeStop`, `UpdateDecision`) exist only inside
  `node-hold-cutover.ps1` `df2e58f2`, behind its config-editing modes.

**Smallest bounded choice.**
- `bundle-swap.ps1` unchanged, for the file, plus root's read-only probes.
- A **restart-only extract** of exactly those cutover functions, copied verbatim: pins → `BeforeStop` → `StopNode` →
  `StartNode`/`AgentUp`/`LeaseReady`, plus the cutover's own POST comparisons. It has no config phase and no privacy
  step.
- The extract needs root's review and the existing mock harness (`tools/cutover-mock.ps1`) before any use. It is not
  written here.
- Until it exists, there is no bounded restart, and S5 must not run.

## 3. Steps (root; each mutating step after a fresh read; attempt records O_EXCL, never blindly retried)

**S0. Window.**
- Do nothing in the current lease cycle.
  - The adapter lease ends 22:15:19Z. Its app-funded renewal starts **285 s** earlier, at about 22:10:34Z:
    `host.mjs:2220` asks `chain.renewLeadMs(id, RENEW_LEAD_MS)`, and the lease sender answers from minipc's sponsored
    renewWindow of 300 s. `RENEW_LEAD_MS` (15 min) is only the fallback, and it only arms the check. (RESULT.v1 wrongly
    said 15 min.) Renewal quorum failed at 21:37.
  - The updater is due at 22:13:36Z.
- Start only when all of these hold:
  - the 22:13:36 updater run has finished, `Ready`, with its next run ≥ 60 min away;
  - the adapter is `running` with a **freshly renewed** lease, and remaining ≥ **1500 s**. That covers forward (stop
    ≤ 60 s + first full pass ≤ 600 s) + rollback (swap back + the same restart ≤ 660 s) + margin 180 s;
  - forward + rollback (≤ 1320 s) end before the next sponsored renewal lead. After a fresh renewal (~1800 s left),
    renewal starts at 285 s left, leaving ~1515 s; forward and rollback fit, with ~195 s to spare.
- If not, wait for the next renewal.
- **Budget note.** The cutover budget's `startNodeSec 150` is too short here. A completed readiness pass took ~7-8 min
  under 429s (`isolation adopted` 6m47s-7m56s apart).

**S1. Pins (read-only).**
- Run `node-restart.ps1 -Mode identify`. Record the task action, run-node sha `0fdc3699`, cmd/agent PID+start, manager
  PID+start, the other tasks' processes and the VM ids.
- Run `adapter-preflight.py` for host.mjs `9634cb40`, apps, privacy PID+start and `nextUpdate`.
- Also record:
  - the agent's child processes (names, PIDs, starts: review B2);
  - "control-tree files changed after agent start = 0";
  - the node-config.local.cmd sha (must predate the agent start).

**S2. Stage.**
- Copy ONE file (final host.mjs) with the pinned transport (`scp -3`/SFTP) into a new private
  `C:\ProgramData\Enclave\staging\hostmjs-<uuid12>` (SYSTEM + Administrators only).
- Then copy `bundle-swap.ps1`, `node-restart.ps1` (identify only) and, once reviewed, the restart-only extract there. All must be sha-verified remotely.

**S3. Inspect (read-only).**
- `bundle-swap.ps1 -Mode inspect -Target 'C:\Program Files\Enclave\control\windows\node\host.mjs' -WorkDir <stage>
  -OldSha 9634cb40c60b74f92eff8497f687dcaa1ec04a33c21cbd22dc745d773b1da396 -NewFile <stage>\host.mjs -NewSha <final>
  -Node <the agent's own node.exe>`.
- `-Node` must be pinned from identify. The default `C:\Program Files\Enclave\runtime\node\node.exe` may not be the
  agent's runtime.

**S4. Swap, immediately before S5.**
- Run S3's line with `-Mode apply`, then re-read the target = `<final>`.
- It is inert for the running agent. Do it inside the same window as S5, so an uncoordinated crash-restart cannot load
  it alone.

**S5. Bounded restart (node only). BLOCKED until the reviewed restart-only extract (section 2) exists.**
- Run it from hash-verified bytes through the existing one-shot SYSTEM ScriptBlock launcher. Its params:
  - pins from S1 (cmd/agent/manager/privacy PID+start, run-node `0fdc3699`, VM ids);
  - `expectedIds = [0x7ae476a3…]`, `runner`;
  - lease `{revertSec 660, marginSec 180, forwardMinSec 660, startNodeSec 600}`.
- What it does:
  - `BeforeStop` re-reads the updater and the lease;
  - `StopNode`, using the bounded task command, with no automatic retry when the task outcome is unconfirmed;
  - `StartNode`, which returns only with new identities plus `AgentUp`/`LeaseReady` of the NEW process.
- Accept only an unchanged manager, privacy agent, other tasks' processes and VM set.
- Not touched: the manager, privacy agent, Network/Relay/Card tasks and VMs.
- `node-restart.ps1 -Mode restart` (unbounded task cmdlets) is NOT a substitute.

**S6. Readiness from the ACTUAL new process.** It runs read-only, inside forward budget ≤ 600 s.
- Persisted "running" status does not count.
- The new agent PID ≠ 33032, and its parent is the new run-node cmd.
- `Get-NetTCPConnection -LocalPort 9600 -State Listen` owner = the new agent PID, before AND after the state read.
- `9600/v1/host/state` `leaseReadiness`:
  - `inFlight=false`, `startedAt ≥` the new agent's start, `completedAt` within 5 s;
  - the adapter's check `ready`, row `running`, leaseUntil beyond 180 s.
  - These are the same rules as the cutover's `LeaseReady`.
- On disk host.mjs = `<final>`.
- The privacy agent is still 13932 with the same start; walletAdmission is fresh, with the NEW process generation.

**S7. Validation window** (read-only sampling every 10 s, ≥ 20 min).
- Must cover at least two full slow passes AND one renewal attempt of the adapter.
- `walletUntil > now` and the adapter's egress route are present in every sample.
  - The base shows ~73-85 s up per ~7 min, so any gap > 0 is a FAIL.
  - Accept only continuous routing > 90 s beyond each grant's own deadline across passes.
- node.log NEW-line counts: refresh refusals/unknowns; `retired`/`stopped` lines (expect 0 for the adapter while the
  lease is live).
- The manager PID, privacy PID and VM ids are unchanged at the end.

**Rollback** (any S5-S7 failure, or a VM-set/manager/privacy change):
- `bundle-swap.ps1 -Mode rollback -WorkDir <stage> -OldSha 9634cb40… -ExpectCurrent <final>`. This restores the private
  backup, with ACL kept and CAS-checked.
- Then S1 identify (new pins) and the same S5 restart. Any extra allow from the new code expires ≤ 90 s.
- If S5 itself reports FAILED (old agent still alive, or no answering new agent), do NOT retry blindly. The task WAS
  started or stopped; read the state and decide.

## 4. Expected cost and residual risk

**Outage.**
- The adapter's egress stops within ≤ 90 s of the stop: the writer heartbeat dies with the old process.
- It returns only after the new process's first pass re-grants it, which can take up to a full slow pass (~7-8 min).
  The refresher keeps grants alive only after that.

**Startup re-evaluation (B2).**
- A fresh agent decides every deployment at once behind one 429-limited egress IP.
- With the wallet hold active, an UNKNOWN keeps the domain (its key and certificate) ONLY if the network agent
  acknowledges the withdrawal within `WALLET_HOLD_ACK_MS` = 15 s (host.mjs:66-73). Otherwise the domain is retired as
  before. Either way the app is offline until a fresh decision. Count `retired` lines in S7.
- The B1 precedent: a node-only restart changed the VM set once (unattributed). Treat `vmSetUnchanged=FALSE` as a
  rollback trigger, and diagnose it from node.log counts.

**Renewal is not fixed by this change.**
- 21:37:50 `renew failed: lease-gas RPC quorum cannot read the configured chain`. If that recurs, the adapter's lease
  lapses again and it is retired and reclaimed, as at 21:44/21:45.
- Each reclaim means a new partition and a new certificate order, against Let's Encrypt limits.
- Retry scheduling belongs to the other worker. Do not combine it untested.

**The other 10 apps will not recover from this change.** They are failed/queued/refused because they are underfunded
(app-funded lease-gas reserves) or refused by policy.
- The refresher only re-decides allows this process already published, for routed apps.
- It never claims, renews or funds.
- Recovering them needs funding (a financial decision still pending) or policy action, not a restart.

**Restrictions kept.**
- The pending process-only RemoteSigned question for the bootstrap harness is untouched. Nothing here changes Machine or
  User ExecutionPolicy.
- The scripts run only through the existing hash-verified ScriptBlock launcher root already uses in production.
- No book, contract, policy, config or credential is edited.

## 5. Unrelated open item (not repeated)

- In the front change (native-front-abort `d9459aae`), `platform-api-hosted` needs the gitignored runtime bundle, and it
  was guard-stopped at 266 MiB > 256.
- That suite is left for root's 512 MiB run. The unchanged suites that passed were not repeated.
