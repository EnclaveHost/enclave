Root activation update (2026-10-23): the node-only patch below is now active. Public api.enclave.host/enclaves confirms 17% CPU and 16.3 GB RAM availability at 17:22:15 UTC; all nine prior apps are running and have passed TLS/HTTP checks. See root-validation/node-rollout-result.json and public-fleet.json. CPU manager/guest rollout remains pending. The source-worker report below records its pre-activation handoff.

# Coupled resource shares: node-side source fix (R)

Status: the source fix is final and tested. It has **not** been activated, and nothing in production was touched.

The user's request is **not complete**. Actual CPU enforcement belongs to the parallel worker Q (`work/coupled-cpu-enforcement-20261023`). Until Q's manager change and guest image land, a partition still runs on 1 vCPU with no cap, whatever its share. See "Gaps".

## Commits
Repo: `work/coupled-resource-shares-20261023/repo`, branch `coupled-shares`. Its parent clone is the frozen candidate; there is no remote.

| commit | what |
|---|---|
| `0f1ef848b21e03f6fd6c4852d7cccff6f18ba2b2` | **Baseline = installed source.** It is d281007c2 plus root's installed manager overlay. All 14 files in root's installed snapshot are byte-equal, including isolation-client `8d07cb4e` and isolation-lifecycle `5ae5f457`. |
| `14b2459262415ae93a970fc79ac224ab158fffdf` | The fix: one share, both pools. |
| `a5e155ecfd9b71faa8f1e853d65bcc08efea7b5a` | **Final HEAD.** Owner resizes are relaunched up and down; test fixtures read a pooled manager. The worktree is clean. |

## Installed delta (node only; the manager is unchanged)
Files are in `delivery/`:
- `files/` holds the new files and `rollback/` holds the installed ones.
- `installed-to-fix.patch` has sha256 `7165865a…acb5`.
- `MANIFEST.json` is included.
- `release-proposal.json` uses the format of root's `activate-node.py`, with `reviewed:false`.

| target (`C:\Program Files\Enclave\control\…`) | before (installed) | after |
|---|---|---|
| `windows\node\host.mjs` | `ea0f6b8ab9562e95cc20e82ea0d6cc6c7a242445d0a8608195f50ebb711c00de` | `e537f7277a69b5d809ba9994ee97744f3e9038a175efa156425aba611d157234` |
| `windows\node\chain.mjs` | `3e9fae0392497841f5c4e084c9d11f6c01243d339b0bdf3395b569f921a12938` | `b257fcf64e7e0f44738b84a35f32237a03e62034b74b0dc0c9ff276a49ab9225` |
| `windows\node\isolation-client.mjs` | `8d07cb4ea105819c8f769e942c58063d20cf1289544c2afac0b9aeda0d963b7b` | `d2222100a2a8fc09765fd4bf38eebcea061be77401cf6e0b39ddbaf098a41a04` |

Only the Node agent process loads these three files, so only the Node wrapper needs a restart. The Shield manager and the partitions keep running.

## What changed (sharesCoupled = partition manager configured, no in-enclave apps)
- **One free fraction for both pools.** `cpuShareFree = min(ledger free [reserve 25% and owner cap], RAM room / pool)` and `ramMbFree = floor(pool × cpuShareFree)`.
  - Each deployment holds the larger of `floor(pool × share)` and what the manager's `/vms` says its partitions hold.
  - Partitions that name no deployment are counted against the manager's own pool. Today that is only the readiness witness, counted by its policy `memMiB`.
- **Unknown is not room.** The node refuses new claims and publishes 0 free when the manager view is any of these:
  - not read yet, or the read failed;
  - malformed (a `/vms` answer with no list, or `/health` that is not an object);
  - stale (more than 10 min old);
  - holding recovered or unattributed VMs;
  - pool-less, or using a rule other than cpu-share;
  - sized from a different pool than the node's;
  - listing a non-witness VM that states no share reservation.

  Work already on the box is never refused or given back for this; uncapped capacity ignores it. A resize up waits instead of giving up the lease. The node reads the manager once per pass (10 s timeout) and again before any claim older than 30 s.
- **The RAM floor is a share requirement.** `effectiveCpuShare(…, sharePoolMiB)` rounds `memMb/pool` up to whole percent, the same as the site's `minPctsOf`. A RAM floor raises the share or the claim is refused; it never buys discounted RAM. The ledger dial and billing are unchanged.
- **Spawns use the share the node counts** (`body.cpuShare = cpuShareOf`). This was c13's root cause: node-bridge sent the 1% dial while the node counted 2%.
- **A partition sized for another share is relaunched in place.** This covers an owner resize up or down, and a dial-sized spawn like c13.
  - It happens only when the new size fits (a shrink always fits), and at most once per 10 min.
  - The old partition is retired and confirmed gone before the new one starts.
  - Otherwise the partition keeps serving and is shown as pending on every pass, via `allocatedShare` and a reason. It is counted at the larger size meanwhile.
- **Rounding.** `cpuShareFree` is rounded down to millionths, so 0.16999999999999993 is published as 0.17 and the fleet row shows 17%, not 16%.
- **isolation-client.** A `GET /vms` answer with no `vms` list is now a protocol error, never an empty inventory. Views carry `policy`.

## Evidence (all through `work/claude-test-queue.py`; logs in `logs/`)
- **Counterexample, `test/windows-node-coupled-shares-defect.test.mjs`.** It uses only installed APIs and is the same file on both trees (`logs/focused3-baseline.out`, `logs/focused3-fix.out`).
  - **Baseline (installed): 0/6.**
    - The live box floors to 16, not 17.
    - A 20 GiB app dialed at 1% is admitted.
    - Recovered VMs are sold (0.1699…).
    - c13: **983 ≠ 1966**.
    - The manager refuses the spawn: "983 MiB < 4096".
    - A resize leaves the app in "provisioning" ("different RAM share").
  - **Fix: 6/6.**
- **Focused suites on the fix (256 lane, peak 177 MiB):**

  | suite | passed |
  |---|---|
  | coupled-shares | 14/14 |
  | defect | 6/6 |
  | isolation-client | 27/27 |
  | isolation-memory | 1/1 |
  | hosting-caps | 25/25 |
  | isolation-host | 15/15 |
  | preclaim | 5/5 |
  | scan-slot | 13/13 (`logs/scanslot-fix.out`) |

  The coupled-shares suite covers:
  - the live 9-app state (17% CPU, 16711 MiB, 16.3 GB);
  - 1% of both pools;
  - reserve and cap;
  - RAM floor to share;
  - manager-held sizes larger than the share;
  - every unknown and malformed case, including a real-HTTP bad-200 manager;
  - a non-coupled box keeping its old figures;
  - c13 auto-repair, and c13 explicitly pending when the repair does not fit;
  - owner resize up and down with the 10-min bound;
  - an unknown manager making a resize wait (pinned in source).
- **Regression, 63 existing non-Anvil files touching the changed modules, run on both trees** (`logs/reg-baseline-part{1,2}.out`, `logs/reg-fix.out`).
  - **Seven fail on baseline and fix alike, with identical failing subtests (compared on the 14b245926 run).** These were already failing in the installed source:
    - catalog-platform-enforcement
    - registry-reconcile
    - hv-attach-relay
    - lease-readiness
    - wallet-grant-refresh
    - wallet-network-hold
    - shield-startup (newer pin-interface failures)
  - **Four failed only on the fix:** hosting-caps, isolation-host, preclaim and scan-slot. Each failure was a fixture with a pool-less or unreachable manager, which the node now correctly refuses, or an exact-float expectation. I adapted those fixtures in `a5e155ecf` and they now pass. Only these 4 plus the new and client suites were rerun on `a5e155ecf`, per root's instruction not to repeat broad runs. The unknown and malformed rejection tests are kept.
  - The batch first ran at 256. The guard stopped it at 257 MiB on hv-attach-relay, so I resumed the remaining files at 512.
  - **Not run:** the 9 Anvil/contract suites (lease-*, offchain-heartbeat, session-api-auth, windows-current-runtime, windows-host-app-funded, windows-release-journal). They need Anvil or foundry `out`, and they cover lease and gas paths that this change does not touch.

## Expected live effect when root activates (from the 15:58Z state)
- Availability will show **CPU 17% with RAM 16.3 GB** (16711 MiB = floor(98304 × 0.17)) and `nodeRamGb` 96. Today it shows 79.8 GB.
- **On the first pass, c13d4b6a is relaunched once in place at 2% (983 → 1966 MiB).** It fits: excluding c13, 19% is free. The app is down for one partition boot plus readiness. Root controls the timing. The other 8 apps already match their share and are untouched.
- Physical RAM grows by +558 MiB: c13's VM goes from 2048 to 2606 MiB (align2(max(2048, 1966 + 640))). Today 74.9 GiB of VMs are assigned on a 111.8 GiB machine.

## Rollback
Stop Node, restore the three files from `delivery/rollback/` (or root's `.pre-coupled-<sha12>` backups), then start Node. The manager is untouched.

**Caveat:** if c13 or any resized app was already relaunched at its effective share, the old node spawns at the dial. Its lifecycle then **holds** that partition ("different RAM share") and stops serving it. After a rollback, run a forced relaunch for c13 (0xc13d4b6a); it respawns at the 1% dial.

## Gaps (reported, not hidden)
1. **CPU is not enforced (owner: Q).**
   - All 9 app VMs have 1 vCPU, Maximum 100 and Reserve 0, whatever their share (`cpu-live.json`). The 25% and 21% apps are capped at 6.25% of the box, and 1% apps can burst to 6.25%.
   - The guest monitor's cgroup `cpu.max` is fixed by the catalog `cpuPercent`.
   - My node already sends the one effective share Q's manager will size CPU from (wire unchanged, per `CPU-WORKER-INTERFACE.txt`).
2. **Nothing measures physical free RAM** (reserved availability is kept distinct from OS usage, as asked). On paper:
   - The remaining 16.3 GiB of app RAM plus at most 7 new VMs × ≤1065 MiB of guest overhead is about 23.6 GiB, against about 25.5 GiB physically free.
   - At a full 75% sale with all 16 slots, worst-case overhead could exceed physical RAM.
   - Not changed (no pool growth).
3. **Site and Linux:** no change needed.
   - The fleet row prefers `ramGbFree` and floors `cpuShareFree`; both are now correct at the source.
   - The Linux supervisor already publishes `ramGbFree = cpuFree × ramGb` (root audit).
