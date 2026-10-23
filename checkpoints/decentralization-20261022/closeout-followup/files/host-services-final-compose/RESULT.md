# host-services-final-compose: RESULT (2026-10-23 ~07:30Z)

**Verdicts:**
- **Source and artifacts: READY for root review and staging.**
- **Phase A** (code only, host services stay off): **CONDITIONALLY READY.** Preflight gates A1–A4 must pass (§7).
- **Phase B** (host services opted in on a Windows node): **NOT READY.** The open gates are in §8.

**Ownership and scope:**
- Nothing was deployed, pushed, signed, imaged or activated.
- No SSH, wallet, production, Wine or live network was used.
- C's tree was only read. D owns checkpoint publication; `main-repo` was not touched. Root owns every live action.
- Every build, test and scan ran through `work/claude-test-queue.py` (16 GiB floor; caps 256, 768 and 1024; peak 604 MiB).
  None counted on exit 98 or 99.

## 1. Composition (exact)

| item | value |
|---|---|
| tree | `work/resume-after-checkpoint-20261022/host-services-final-compose/candidate`, branch `final/host-services-compose`, origin removed |
| first parent | **C `0757085e5b78ed38efc11920fb3cf4a25d7dfc4d`** (policy carriers), from `windows-host-services-compose/candidate` |
| second parent | **F `6c38c0489d769db12e5037e7c20f7372e56d5620`**: F's COMPLETE series on `427780bbc` (`24fb993c` → `862f6549` → `6c38c048`), fetched from `host-service-lifecycle/candidate` |
| **final commit** | **`4106c3114dd13f39692195c182d3152efa5e212c`** (merge, `--no-ff`), **tree `1a679ef307a70acf440584a7e991ebf6834d9030`** |
| author / committer | SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com> |
| conflict resolution | **none needed.** The only file both sides touch is `network/privacy-agent.mjs`, and git auto-merged it (disjoint hunks). This equals F's earlier trial `merge-tree` (same tree `1a679ef3`) |
| source edits beyond the merge | **none** |

**Semantic check of the merged seam** (`network/privacy-agent.mjs`):
- C's gate construction is `hostPolicyCarrierGate` when `hostServicesPolicy` is present, `createHostServiceGate` otherwise.
  Both return the unchanged `createHostServiceGate` object.
- F's `hostServiceLifecycle` reads only `hostGate.serviceRefusal()`.
- Admin anchors, bans, allowlist, sticky refusal, explicit fresh admit and the exits' own `admitHost` are unchanged.

**Preserved (byte-identical to C's 0757085e):**
- the reviewed live Windows runtime: `windows/node/host.mjs` **`ea0f6b8a…00de`** and `chain.mjs` **`3e9fae03…2938`**. These
  are exactly the hashes root's 05:20Z updater postcheck observed;
- every serving-first fix, the carriers and gate, the packages, the lock check and the bundle guard;
- `agent.mjs` `e530ff3b…`, `network-enroll.mjs` `a51e9de8…`.

**Final source hashes** of the merged seam:
- `privacy-agent.mjs` `5e56973d…f705`;
- `host-service-transport.mjs` `43e7c115…6c45d` and `wg-circuit-runtime.mjs` `77b842e8…045efd` (= F's final);
- `host-policy-carrier-gate.mjs` `7d24a332…` and `host-policy-gate-config.mjs` `acc321cb…` (= C's).

## 2. Composed tests (real control flow, offline fixtures; logs in `logs/`)

**t1-composed** (768, peak 528 MiB, `STRICT=1`: any skip or cancel fails the job): **48/48, 0 skipped, 0 cancelled.**

| suite | tests | what it exercises on the composed tree |
|---|---|---|
| `host-service-lifecycle` (F) | **10/10** | real `WgCircuitRuntime`, `WgGrants` and 2 `WgProvider`s behind their control servers, the real ingress worker, and the agent's ACTUAL host-service block sliced from the merged `privacy-agent.mjs`. Cases: **admin ban DURING startup** (stopped at once, late grant withdrawn, no circuit up); **re-admit** (a fresh transport serves through the worker); a ban during a background reconcile; **an app circuit on the same runtime unaffected** (keeps traffic and its exit peer); delayed failures; no timer or child after a stop |
| `host-services-carriers` (C) | **9/9** | the REAL daemon (`node network/privacy-agent.mjs --config`) behind a preload that **refuses every connection to the 4 DO fronts** and every `*.enclave.host` lookup. **The first admit comes from the IMPORTED carrier**; unanchored, substituted or wrongly signed data never admits; **admin ban and allow arrive through the carrier**; rollback is refused; the policy-mirror store and an HTTP peer act as carriers; the verifier seam |
| `host-services-cold-start` (C) | **12/12** | the real daemon and the real gate: zero apps, admin ban, unban; unknown policy held; the first app added or last removed never touches host services; malformed configs refused before binding; the shipped bundle runs app-less |
| `host-service-transport` | 14/14 | transport, enrollment, profile and sandbox policies |
| `privacy-agent-lifecycle` | 3/3 | agent start and stop |

**t2-packaged** (1024, anvil 1.x from `~/.foundry/bin`, C's REAL forge-subset outputs):
- The outputs are copied from C's tree, and **all 12 match `carriers/forge-subset-artifacts.sha256`**.
- No test was skipped for a missing build dependency.

| run | result |
|---|---|
| t2 (all 3 files: `hosted-policy-cold-start`, `credit-vault-submitter-runner`, `hosted-service-placement`) | **14/16.** The 2 failures were in `hosted-policy-cold-start`: "admin bans host B" (timed out) and the next case (knock-on: `docs[1]` undefined) |
| t2b (`hosted-policy-cold-start` alone, unchanged bytes) | **5/5** |

**The packaged-role failure is a REAL race in C's `policy-mirror` package, not in the composition.**
- The policy-mirror package `0cec04fa` and the runner are byte-identical to C's (§3).
- **Where:** `network/host-services/policy-mirror.mjs` `sync()`, lines 52–55.
  1. It snapshots `stored`.
  2. It awaits `verify(stored)`.
  3. It then drops every key of the CURRENT store that the verified set lacks.
- **The effect:** a document an admin POSTs during that await is dropped as "not signed by the address book's current
  owner at block N".
- **The log proves it:** `stored published policy #2 0xef2428eb… (not anchored yet)` at 07:01:54.084Z, then `dropped
  0xef2428eb…: not signed … at block 56` 46 ms later. The owner is the constant deployer.
- **Impact:**
  - a ban published only to that mirror is lost from it;
  - hosts relying on it keep serving within the gate's grace (status "behind"), then fail closed;
  - **ban enforcement is delayed, not bypassed.**
- **Fix (for C, 1 line):** iterate the digests of `stored`, not `store.keys()`. It is not applied here (not a composition
  bug). It **gates the policy-mirror role's activation** (§8 B7), not the agent.

**Scans** (`c1-scan`, 256) over `427780bbc..4106c311`: C's `0757085e`, F's 3 commits and the merge.
- `scan-crypto-keys --range`: 0 findings.
- gitleaks with HEAD `.gitleaks.toml`: "no leaks found" (`gitleaks-range.json` = `[]`).

**Not re-run** (unchanged by the composition, already terminal at C or F):
- F's 104-test regression, its control (0/10 on 427780bbc) and its 6/6 mutants;
- C's batch-A regression, its `control-427` and its 25/25 at 0757085e;
- `hosted-services-stage`'s two `STAGE_TAR` archive tests (separate activation build).

## 3. Final artifacts: one build from 4106c311, C's proven recipe

**`build-final.sh`, logs b2** (1024, peak 594 MiB). It follows C's `cold/repro.sh`:
- built in this tree AND in an independent `--local --no-hardlinks` clone at another path;
- offline (`unshare -rn`), `GOPROXY=off GOFLAGS=-mod=readonly GOTOOLCHAIN=local`;
- packages built and `--check`ed under the lockfile check (`package-lock.json` `9ada1611…`, `relay/package-lock.json`
  `e5d896ba…`, verified current).

**Result: `REPRODUCIBLE: 25 artifacts byte-identical`.**

**Clean Go stamps:** `go1.27.2-X:nodwarf5`, `vcs.revision=4106c311…`, `vcs.time=2026-10-23T05:38:14Z`,
**`vcs.modified=false`**.
- The first build (b1, also 25/25) had `vcs.modified=true`, because C's order generates the untracked `packages/` before
  Go runs.
- b2 applies C's own RESULT-COLD §7.3 advice: Go on a clean tree first.
- The 22 JS artifacts are identical across b1 and b2; only the 3 Go stamps differ.

**Staged copy:** `release/` (26 files including `consumers/build-manifest.json`), listed in `release.sha256` (sha256
`1a93c065…be22`). The full list is `artifacts-final.sha256` (`cb5da1f8…`).

| artifact | sha256 | vs C 0757085e |
|---|---|---|
| `dist/privacy-agent.mjs` (Windows agent) | `6480ca9bb76d22e6e9653aaac6a2c0b4202c6c0f541d3f1da3a9cbbdc701ec77` | CHANGED (F's lifecycle; was `e16cb651`) |
| `consumers/privacy-agent.mjs` | `4124c4cacd7bdba370de5a3e8b1ee16845a094573e99a84a1f183c2676ceac27` | CHANGED (was `9c162ddb`) |
| `dist/enclave-wg.exe` | `4e686c5ddab77337aa18b013f80721e85cd890c0884848953850b5ff557b785e` | stamp only (Go source = C's) |
| `dist/enclave-wg` | `14944bd95f181f2384e687bd126358adea88dd6eaf3910b6bf4c1adbc057993d` | stamp only |
| `dist/enclave-circuit-firewall.exe` | `243a371c069612538e7dcabeb8b6595545c8b711240c3c614e4697ab20d2cf50` | stamp only |
| `dist/host-service-ingress.mjs` | `c952dce4…62d3` | same |
| `dist/windows-circuit-worker.mjs` | `dcac53cb…c2332` | same |
| `dist/wg-provider.mjs`, `wg-qualify.mjs`, `enclave-directory.mjs`, `reconcile-apps.mjs` | `594e421b…`, `b996a8c2…`, `f65da9e7…`, `57943e45…` | same |
| `network-runtime.bundle.mjs` | `dced8384…f656` | same |
| packages: `policy-mirror` manifest **`0cec04fa…cf80`** (bundle `117bdd23…`); `directory-replica` `4aa032fa…`; `bootstrap-replica` `7732950b…`; `route-dns` `d60eb763…`; `credit-vault-submitter` `45b98921…` | | same (C's pins hold) |
| consumers: `provider` `ad1871a0…`, `dns` `2efb1417…`, `checker` `9bd7c85a…` | | same |

**Recipe caveat:** the installer's `windows/installer/stage-bundle.sh` builds `network/build.mjs` inside a `git archive`
export (no `.git`).
- Its Go binaries therefore carry NO VCS stamp and will not byte-match the ones above. Its JS should match for the same
  lockfiles.
- It also needs `npm ci` (network), which was not run here.
- Root must pin the hashes of the recipe it ships.

**Windows node deploy closure** (`windows/node/deploy-files.mjs`, derived from `agent.mjs`): **87 files**, each hashed in
`node-deploy-files.sha256` (`5580acb7…`). Relative to the serving-first base `d281007c`:
- **new:** `control/network/host-service-transport.mjs` `43e7c115…`, `control/network/host-service-names.mjs`
  `a46123cb…`, `control/network/host-policy-gate-config.mjs` `acc321cb…`;
- **changed:** `control/windows/node/agent.mjs` (`76cac355` → `e530ff3b`) and `control/windows/node/network-enroll.mjs`
  (`bdc6019c` → `a51e9de8`);
- **also in the closure, unchanged since d281007c and possibly absent on an old box:** `control/network/rpc-identity.mjs`
  `74cb965e…` and `control/network/platform-host-policy-config.mjs` `6422d065…`;
- `windows/node/package.json` and its lockfile are unchanged, so no npm change on the node.

## 4. Installed layout this maps to

From `windows/installer/stage-bundle.sh` and root's reviewed nucbox reads:
- **`C:\Program Files\Enclave\network\`:** `privacy-agent.mjs`, `windows-circuit-worker.mjs`, `host-service-ingress.mjs`,
  `enclave-wg.exe`, `enclave-circuit-firewall.exe`.
- **`C:\Program Files\Enclave\control\`:** the node closure in repository layout. That includes `windows\node\host.mjs`
  and `chain.mjs`, which root's postcheck hashes.
- **Updater (root's `node-updater-readonly`):**
  - installed and published are both `2026.10.12.47` (manifest `5b966e81`, legacy unsigned channel), updater `36f9e0d6`;
  - the scheduled run at :13 each hour is a **same-version no-op**: it exits when latest ≤ installed, and the task has no
    `-Force`;
  - the 05:13Z run kept host `ea0f6b8a` and chain `3e9fae03`, with 9 apps running.

## 5. Staged activation plan (root-owned)

The plan keeps the reviewed serving-first runtime (host/chain pair) untouched and runs no release or installer. Every
file is staged OUTSIDE the installed runtime first.

**Phase S (staging, no effect on the running node).**
1. On the workstation, verify the release (§9 R1).
2. Copy the files below to `C:\ProgramData\Enclave\staged\hs-final-4106c311\` with root's reviewed transport (scp -3 SFTP),
   then hash them on the box (§9 R3):
   - `network\` set: `privacy-agent.mjs` `6480ca9b…`, `windows-circuit-worker.mjs` `dcac53cb…`, `host-service-ingress.mjs`
     `c952dce4…`, `enclave-wg.exe` `4e686c5d…`, `enclave-circuit-firewall.exe` `243a371c…`;
   - control set: `windows\node\agent.mjs`, `windows\node\network-enroll.mjs`, `network\host-service-transport.mjs`,
     `network\host-service-names.mjs`, `network\host-policy-gate-config.mjs`, plus `network\rpc-identity.mjs` and
     `network\platform-host-policy-config.mjs` if absent.

**Phase A (code only, host services OFF).** No `ENCLAVE_HOST_SERVICES_FILE`, no `hostServices` block. The new agent then
runs no gate and no host service, exactly as at 427780bb without a block. Steps:
1. **A1 network swap:** the 5 `network\` files, while the Network task's agent is stopped.
2. Then one privacy restart through root's EXISTING reviewed privacy-restart procedure (no new helper).
3. **A2 control swap:** the 5 to 7 control files, then one Node restart inside root's node-restart window rules. A node
   restart withholds apps for about 48–68 s.

A1 and A2 are independent: the new enroll writes nothing without an opt-in, and the new agent changes nothing without a
block.

**Never during:** the Update task's :13 run (keep at least 5 min away); a newer release on the channel; an in-flight
node-pair or challenge activation.

**Phase A postcheck:**
- root's `check-0513.py` pattern: host `ea0f6b8a`, chain `3e9fae03`, the same 9 running apps, updater result 0;
- each swapped file's hash;
- `latest.json` still `2026.10.12.47`;
- after the next :13 run, the swapped hashes are still present.

**Phase B (host services).** Only after every gate in §8 closes:
1. Write the opt-in (`stage-tool.mjs host-services …` → `agent` object, plus `hostServicesPolicy`, §8 B3/B4) to
   `ENCLAVE_HOST_SERVICES_FILE`, set in **`node-config.local.cmd`**. `node-config.cmd` is regenerated by the updater.
2. Run one enrollment pass, then one privacy restart.

**Rollback** (reverse order; it never touches host/chain):
- **Phase B:** unset `ENCLAVE_HOST_SERVICES_FILE` FIRST, then let enrollment drop the block, or remove `hostServices` from
  `privacy-config.json`.
  - The transport withdraws its own exit grants on stop (revoke, then close; tested).
  - Grants that cannot be withdrawn lapse within ≤ 10 min, routed to a dead key.
  - Never roll back to an OLDER agent while an app-less config exists: the old agent refuses an empty app list, and
    `run-network.cmd` restarts it every 10 s (RESULT-COLD §8).
- **Phase A:** restore the backed-up originals (taken in §9 R3) for the files swapped, with the same restarts.

## 6. What this does NOT change: provider dependency (honest)

- **The 4 DO fronts stay in every public path.** They are the only exits and ingress addresses (raw WireGuard transport
  plus each front's provider), the DNS authority for `app.enclave.host` (NS = the 4 fronts, with dnsdist → route-dns
  there), the default policy mirrors, and the host of the legacy release channel.
- **Moving the role packages onto Enclave hosts does not remove that one-provider failure domain.**
- **What this work does:** a host's own public service roles run on the host and are withdrawn on a ban or stop. The
  policy DOCUMENT can arrive without the fleet (imported carrier, tested with the fronts refused).
- **What it does not do:** chain reads remain public RPC providers. Provider independence needs a non-DO exit and DNS
  path. The authorized hardware is one site, and that is a separate, unstarted step.

## 7. Phase A preflight gates

| gate | requirement | how |
|---|---|---|
| **A1 installed baseline** | identify the installed `network\privacy-agent.mjs` (and the 4 helpers) against a known build. The new bundle carries the whole normal-tree lineage `f58e03ec4` → serving-first → d7f520bf → 427780bb → 0757085e → F; on a box running an older or native-recovery agent this is a full agent upgrade for all 9 apps | §9 R3. Root decides from the recorded hashes. Do not swap blind |
| **A2 updater/channel** | `latest.json` = 2026.10.12.47 / `5b966e81`; installed same; updater `36f9e0d6`; the task's next run is ≥ 5 min away | root's existing `node-updater-readonly` reads |
| **A3 restart window** | no lease due inside the restart (root's node-pair-restart window rules; the observation floor) | root's runner (`node-pair-runner`) |
| **A4 backups** | every file to be replaced is copied (with hash) under the stage dir BEFORE the swap | §9 R3 |

## 8. Phase B gates: NOT READY

| # | gate | precise requirement (compatible with admin rights; no bypass) |
|---|---|---|
| B1 | host registration | the box's registry row is active, and `keccak256(endpoint bytes) == runner` (agent preflight refuses otherwise) |
| B2 | platform host policy state | the agent starts host services only on the gate's authenticated ADMIT for this host. Root must take a FRESH native gate read for nucbox's runner with the production book `0xab2143…0907` and record whether the book is anchored and this host is admitted. A ban or unknown keeps them held. Never answer a refusal by turning the policy off |
| B3 | policy RPC quorum | the default production list still names BlockPI (503 in root's native proof). Use an explicit `hostServicesPolicy: {policy:"production", rpcs:[publicnode, mainnet.base.org, base-rpc.polkachu.com, base.drpc.org]}` = root's natively proven RC set. Majority = **3 of 4**, the same threshold as production (`quorumSnapshot` floor(n/2)+1), NOT reduced. Needs a FRESH proof at activation; the drpc budget is unproven |
| B4 | policy document carrier | the default mirrors are the 4 DO fronts. Add `carriers.importDir` (e.g. `C:\ProgramData\Enclave\policy-import`) holding the admin-signed `{document,signature}` of the anchored digest. **The admin must place every new anchored document there**, otherwise the host fails closed after the grace |
| B5 | exits | every id in `hostServices.exits` must run the hs-transport provider build with `hostServices.zone` and its own platform host policy (`admitHost`). The fronts run `native-recovery-464cad3` via drop-ins without it (only the ca-east canary ran an hs-transport build). A provider rollout on the fronts is a transport-role change, owned by root |
| B6 | name publication | the derived names (base32 of the full registry id in the zone) must be published in the hosted route-dns `appStatic` lists that point at the exits (`stage-tool host-services` output). Today that route-dns runs on the DO fronts |
| B7 | policy-mirror race | fix C's `policy-mirror.mjs` `sync()` drop loop (§2) before relying on any host's policy-mirror as a carrier |
| B8 | native Windows | not executed: the Windows Shield/TPM branch of `runPrivacy`, the circuit sandbox install (`enclave-circuit-firewall`), `enclave-wg.exe` `udpforward` on a real box, the Task Scheduler loop, and a real WireGuard exit. A single canary host with explicit rollback is required |
| B9 | release channel | no newer release may be published on the legacy unsigned channel until a release contains these files (its delta overwrites changed paths). Pin through `required-release-files`/`check-release.py` |
| B10 | G3 / challenge (optional) | without service-tls the endpoints advertise http only. A challengeReplica with carriers needs this new agent, not the minipc `cfb69370` (exit-2 hazard). It follows root's challenge activation recipe (orphan-child handling) |

## 9. Exact bounded root commands

**R1: verify source and artifacts (workstation, offline, read-only):**
```bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/host-services-final-compose
git -C candidate rev-parse HEAD 'HEAD^{tree}' HEAD^1 HEAD^2   # 4106c311… 1a679ef3… 0757085e… 6c38c048…
(cd release && sha256sum -c --quiet ../release.sha256) && echo RELEASE_OK
sha256sum -c --quiet <(sed 's|  |  candidate/|' node-deploy-files.sha256) && echo CLOSURE_OK
```

R1 was executed here exactly as written (`r1-check.sh`, `logs/r1-check.*`): it printed the 4 hashes, `RELEASE_OK` and `CLOSURE_OK`.

**R2: optional independent rebuild** (same recipe, ~6 min, peak ~600 MiB; must print `REPRODUCIBLE: 25` and
`vcs.modified=false`):
```bash
python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1024 --log logs/root-r2.guard.log -- ./build-final.sh > logs/root-r2.out 2>&1
```

**R3: nucbox read-only preflight.** Pass it as the PowerShell text `p` to root's reviewed transport
(`work/nucbox-tls-20261021/root-activate-reviewed.py` `t.ps(p, 25)`, as `node-updater-readonly/current-window.py` does). It
only hashes and reads:
```powershell
[Console]::OutputEncoding=[Text.UTF8Encoding]::new();$r='C:\Program Files\Enclave';$f=@('network\privacy-agent.mjs','network\windows-circuit-worker.mjs','network\host-service-ingress.mjs','network\enclave-wg.exe','network\enclave-circuit-firewall.exe','control\windows\node\agent.mjs','control\windows\node\network-enroll.mjs','control\windows\node\host.mjs','control\windows\node\chain.mjs','control\network\host-service-transport.mjs','control\network\host-service-names.mjs','control\network\host-policy-gate-config.mjs','control\network\rpc-identity.mjs','control\network\platform-host-policy-config.mjs');$u=Get-ScheduledTask -TaskPath '\Enclave\' -TaskName Update|Get-ScheduledTaskInfo;[ordered]@{at=(Get-Date).ToUniversalTime().ToString('o');files=@($f|ForEach-Object{$p2=Join-Path $r $_;[ordered]@{path=$_;present=(Test-Path -LiteralPath $p2);sha=$(if(Test-Path -LiteralPath $p2){(Get-FileHash -LiteralPath $p2).Hash}else{$null})}});optIn=[Environment]::GetEnvironmentVariable('ENCLAVE_HOST_SERVICES_FILE','Machine');updateNext=$u.NextRunTime.ToUniversalTime().ToString('o');updateLast=$u.LastTaskResult}|ConvertTo-Json -Depth 5 -Compress
```

**R3 was NOT executed here** (no SSH): the PowerShell text is reviewed only and has not been run on a Windows host.

**Expected and decision:**
- **Expected:** `host.mjs` = EA0F6B8A…, `chain.mjs` = 3E9FAE03…. Every other recorded hash is root's A1 baseline input.
- **Decision:** proceed to the Phase A swap only if root identifies the installed agent and accepts the upgrade delta.
  The backups for A4 are the files at these paths, copied with their hashes before any swap.

**The swap and restarts** use root's existing reviewed cutover and privacy/node restart procedures (no new helper here,
per root's bounded-integration rule). The file list and hashes are §5.

## 10. Known native and physical gaps

- **Data plane in tests:** the lifecycle tests use a stand-in wg data plane on loopback. The daemon suites run the Linux
  branch.
- **Kernel paths not exercised here:** real WireGuard, the nft DNAT/conntrack paths (this host's kernel lacks the nft nat
  modules) and Windows WFP/AppContainer. They were proven only where root ran them natively earlier (hs-transport G1/G2),
  not for this composition.
- **Fixtures, not production:** the policy chain is a loopback JSON-RPC/anvil fixture with test admin keys. No production
  anchor, exit, DNS or provider was touched.
- **Reproducibility scope:** two paths on one machine, with the same toolchain and lockfile-verified `node_modules`. A
  fresh `npm ci` (network) and the archive-based `stage-bundle.sh` recipe were not run.

## 11. Files here

- **Scripts:** `setup.sh`, `merge-msg.txt`, `job.sh`, `build-final.sh`, `scan.sh`, `q.sh`.
- **Evidence:** `logs/` (s1, b1, b2, t1, t2, t2b, c1), `artifacts-final.sha256`, `artifacts-final-run1-modified.sha256`,
  `release/` and `release.sha256`, `node-deploy-files.{txt,sha256}`, `gitleaks-range.json`.
- **Generated, untracked in `candidate/`:** `network/host-services/packages/`, the relay runtime bundle, and the copied
  `node_modules` and `contracts/foundry/out` (C's forge subset).

**Not claimed:** deployment, activation, provider independence, RPC independence, or completion of the overall goal.
