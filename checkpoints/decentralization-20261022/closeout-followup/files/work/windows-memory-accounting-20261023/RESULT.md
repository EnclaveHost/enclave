# Windows Hyper-V app-RAM accounting and the 96 GiB installer mismatch — RESULT (2026-10-23)

Status: **source committed and tested on local fixtures. Not deployed, not activated, not composed.** Root must review
this before F composes it and before any native activation. No SSH, production write, restart, VM, wallet or contract
action was taken. No PowerShell or Windows run was performed.

## Provenance

| What | Value |
| --- | --- |
| Isolated clone | `work/windows-memory-accounting-20261023/repo`, branch `windows-memory-accounting` |
| Baseline | `6f6d22f5da31bb40b3131deb1f719291602682d0` (cloned from `nucbox-tls-recovery-20261023/candidate`) |
| Commit | `9f19b7c66c156dc3f1052ece121de89e4c741912`, author/committer SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com>, repo pre-commit crypto scan enabled, run inside the queue |
| Patch for F | `windows-memory-accounting.patch`, sha256 `eeab54d2292a49341125f249a1124ff7bc2a042aa6bec90800c5af681491cb92` |

F's committed `14d1e4954` and `6f6d22f5` share the parent `4106c3114`. Neither touches the changed files, so the memory
code is byte-identical on both. `git apply --check` passed in two places:

- clean onto `14d1e4954`;
- onto copies of F's **uncommitted** working-tree files at 11:15Z. F edits host.mjs, agent.mjs and chain.mjs, so those
  hunks apply at offsets of 1–61 lines.

No file in F's tree, or in any other worker's tree, was edited.

## What was wrong (confirmed in source)

The node's `Host.capacity()` subtracted each isolated deployment's catalog floor (`memMb`) from the app pool. The
manager, however, reserves `floor(pool × dialed cpuShare)` (`memory-share.mjs`). That is at least the floor and fixed at
spawn. The node never read what the manager held.

The original negative control below reproduces root's numbers on the untouched baseline:

- **64 GiB pool:** the node advertised 65024 MiB free; the manager had 49152 left.
- **96 GiB pool:** the node advertised 97792 MiB; the manager had 73728.

Other cases the node also miscounted:

- Partitions that failed or that the node gave up on, but that the manager still lists. The manager keeps their RAM
  until a confirmed DELETE, while the node freed their share.
- A recovered VM, whose allocation nobody knows.

## The fix (one authority, explicit layers)

**Manager (`windows/vbslike/manager/server.mjs`).**

- `memoryView()` is now the single statement of the app pool. The spawn gate uses it, replacing its own inline sum, and
  `/health.memory` publishes it with these fields:
  - `rule`, `poolMiB`, `reservedMiB`, `known` and `freeMiB`;
  - per-record `reservations` (`id`, `name`, `status`, `appMiB`, `vmMiB`);
  - `vmOverheadMiB`, the started VMs' size beyond their app share;
  - `physical: "not measured by this manager"`.
- **Which records reserve:** every record still in `domains` holds its share. That covers starting, running, failed but
  still listed, mid-stop and stop-failed records. Only a confirmed remove frees it.
- **Reservation size:** it is the `appMiB` fixed at spawn, never recomputed from a changed pool.
- **Recovered or unattributed VM:** while one exists, `known` is false and `freeMiB` is null. This is exactly when
  spawn already answers 503.
- **Existing refusals:** the 503 (recovered VM) and 507 (pool full) refusals are unchanged.

**Node (`windows/node/host.mjs`, `agent.mjs`, `chain.mjs`).**

- **Reading the statement:** `Host.noteManagerMemory(health)` validates the manager's statement. Reserved must equal
  the sum of reservations, and free must equal pool minus reserved. Two paths call it:
  - the agent's existing 15 s `/health` refresh, which also records null when the read fails;
  - `isolationVerdict()`'s `/health` read, before a claim and at spawn.
- **Advertised free RAM:** on the isolated backend (no in-enclave runtime, manager configured, manager states the
  `cpu-share` rule), `capacity().ramMbFree` is computed as:
  - start from `min(node pool, manager pool)`;
  - subtract the manager's reservations;
  - subtract, for each unit claimed here that the manager does not hold yet, `max(floor, floor(pool × record cpuShare))`.
    That estimate is conservative: the record's share is at least the dialed share.
  - `exclude` adds a unit's own reservation back.
  - `ramMbPool` keeps the configured pool, so the price guide is unchanged. New local fields: `ramSource`,
    `ramMbManagerPool`, `ramMbReserved`, `ramMbPending` and `ramMbPerShare`.
- **Unknown view:** a manager view that is unread, stale (over 60 s), malformed or `known:false` gives:
  - `ramMbFree` 0, with `ramMeasured:false` and a `ramUnknown` reason;
  - a claim-gate refusal that says why.

  A unit that already occupies the box, sized with `exclude`, is not refused because of an unknown view. It is judged on
  the floors, as before.
- **Claim gate:** `claimPolicy` also refuses a dialed share whose partition, `floor(managerPool × dial)`, would not fit,
  just as the manager would refuse it with 507. Before, that case was claimed, refused by the manager, and given up.
- **Unchanged:** in-enclave (legacy) accounting, a manager with no pool rule (floor accounting), signed policy floors,
  charging and pricing.

**Installer (`windows/installer/install-host.ps1`).**

- **Reading:** the owner's `NODE_APP_RAM_GB` in `node-config.local.cmd` is read as cmd applies it: the last `set` line
  wins, the quoted form is accepted, and `rem` lines are ignored.
- **Validation:** it is checked in the machine checks, before any task or process is stopped. The value must be a whole
  number of GiB from 4 to `floor(TotalPhysicalMemory/1GiB)`. Anything else stops setup with the reason.
- **Writing:** the value is carried **unchanged** into both `node-config.cmd` and `shield-config.cmd`.
- **Removed clamp:** the silent `min(physical − 16, value)` clamp, applied to the manager only, is gone. On the NucBox
  it turned the owner's 96 into 95 for the manager while the node used 96.

### The reserve tradeoff (explicit)

On the NucBox, `floor(111.82) = 111`, so 96 is accepted and leaves 15 GiB outside the pool. That is below the 16 GiB the
old clamp kept. The 16 GiB rule is therefore reported, not enforced: the checks line turns "warn" and says so.

**This tradeoff is unavoidable.** Honouring the user's explicit 96 consistently, without inventing capacity, cannot keep
16 GiB outside the pool. Clamping one consumer was the bug.

## Tests (all through `work/claude-test-queue.py`, unchanged floor; logs in `logs/`)

| Job | Cap | Peak MiB | What | Result |
| --- | --- | --- | --- | --- |
| j1-new | 256 | 162 | the 2 new files | 12/12 pass |
| j2-negctl | 256 | 166 | candidate, then the same files on the untouched baseline 6f6d22f5 | candidate 12/12; **baseline 0/12**: 65024≠49152, 97792≠73728, the 50% claim admitted, the clamp present |
| j3-coupled | 512 | 270 | 41 existing coupled files (30 windows-node files on capacity/isolation/claims; installer-independence; isolation-memory; hosting; manager server, restart, regressions, memory-share, main, liveness and wmi-launcher; isolation-manager-restart) | 434/447. The 13 failures are explained in the two rows below. |
| j4-fixtures | 512 | 295 | the 3 files that failed in j3 | 22/22 pass |

How j3's 13 failures were resolved:

- **9 failures, preclaim and scan-slot: intended.** Those fixtures call `consider()` on an isolated host that never read
  its manager, so "unknown is not free" refuses. The fixtures now state the manager view that the agent reads before any
  scan:
  - preclaim reads the real fake manager's `/health`;
  - scan-slot states a manager with no pool rule.
- **4 failures, hv-attach-relay: environment.** The fresh clone lacked the gitignored build output
  `relay/network-runtime.bundle.mjs`. It was copied byte-identical (sha256 `dced8384…`) from the 6f6d22f5 candidate
  tree, not rebuilt.

**Fixture scope (honest label).** The new HV test runs the REAL manager over loopback HTTP, with a faked Hyper-V
launcher that creates no VM, and the REAL node `Host`, `ensureApp`, isolation client and `claimPolicy`. It covers:

- the root example at 64 and 96 GiB, through `ensureApp`, the spawn and `/health`;
- reservations held while starting, failed but listed, mid-stop and stop-failed, and freed only by a confirmed remove;
- after a restart with a pool changed to 96: the recovered VM gives "unknown", no claim is made, an occupying unit is
  still not refused, and the view is known again once the VM is reconciled;
- unreadable (500), malformed and stale manager views;
- a node pool of 96 against a manager pool of 64: no resize, and the smaller pool bounds admission;
- legacy and no-pool-rule accounting, unchanged;
- pending units and `exclude`;
- the claim gate's partition-size check.

The installer test is **structural** (there is no PowerShell here). It applies the script's own Select-String and
validation patterns to sample lines and checks where and how the value is written. **A Windows run is still
required.** No native, Hyper-V or production claim is made.

## Remaining gaps (identified, not hidden)

1. **Physical RAM is measured by no admission component.** The pool is an admission budget. The manager admits up to
   `poolMiB` of app RAM plus about 640 MiB per VM, and checks no physical free memory.

   The node's CPU gate keeps the sum of shares at or below `1 − RESERVED_SHARE` (0.75 at the default 0.25; the NucBox's
   actual `RESERVED_SHARE` was not read). At 96 that bounds app RAM admitted through the node at about 72 GiB, plus about
   10 GiB of overhead at 16 slots.

   Against root's 09:45 CIM figures, that worst case fits with roughly 7 GiB to spare:
   - 111.82 GiB visible;
   - minus 12 GiB for the control and storage VMs;
   - minus 10.17 GiB for the host and other use;
   - leaves about 89.6 GiB for app VMs.

   Any new service VM (for example an L1 RPC VM) is outside this accounting and would create a real gap, as in the
   nucbox-rpc-placement plan. A manager spawn that does not come through the node's CPU gate is bounded by the pool
   alone.
2. **Restart at 96 resizes existing apps through the existing recovery path, not through this patch.** A manager
   restart recovers each VM as `recovered`. The node then retires it and respawns ONE fresh partition at
   `96 × share` (host.mjs restart recovery). Existing partitions grow by about 50% on that relaunch. This patch
   advertises no free RAM until those recovered VMs are reconciled.
3. **The dashboard figure is an app-pool figure.** The 47.9 GiB figure was the old floor-based app-pool number. After
   this patch it becomes the manager-reservation figure. It is still not physical free RAM, which CIM measured at
   45.27 GiB at 09:45, and it will not equal it.
4. **Brief zero after startup or a manager outage.** A node with an isolation manager advertises 0 free and claims
   nothing from start until the manager's `/health` has been read. The agent reads it before its first scan. The same
   happens whenever reads fail for 60 s. This is intended ("no false ready").

## Activation (root, after review; not done)

1. F composes `windows-memory-accounting.patch` onto its final package. Rerun j1, j3 and j4 in F's composed tree, since
   F also edits host.mjs, agent.mjs and chain.mjs.
2. The new installer runs on the NucBox at the next update. The current local 96 then passes validation and is written
   to `node-config.cmd` and `shield-config.cmd`. Root already set 96 in all three files, so no value changes on disk.
3. Node and manager restart. **This still needs the pending human answer on interrupting the experiment.** Root decides
   whether existing partitions are relaunched at 96 (gap 2).
4. Read back `/health.memory` against `/v1/local` capacity.

**Rollback:** reinstall the previous bundle, or revert `9f19b7c6`. The config files are unaffected.

No main, checkpoint or GitHub write was made. GitHub main `68b82926`'s three docs-only commits are outside this patch's
files; preserve them at integration. Overall decentralization is not claimed complete.
