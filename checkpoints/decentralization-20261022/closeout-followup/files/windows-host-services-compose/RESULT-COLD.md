# Host-services cold bootstrap and release packaging (RESULT-COLD, 2026-10-23)

**Status.** Source only, in the isolated candidate. Nothing is deployed, staged on a host, pushed or published.

**Commit.** `candidate/` on branch `compose/host-services`: `d7f520bf` (the composition, unchanged) →
**`427780bbc0fc524f8091893614eae8a653518139`**. Author and committer: SteveDeFacto. There is no origin and nothing was pushed.

**Cold-specific patch.** `host-services-cold.patch` (`git diff --binary d7f520bf 427780bb`):
- sha256 `687a164fe7a0270eae08e2e80343866e733b596742b47579f91356fb16f0d3c3`;
- 12 files, +565/−27.

**Provenance.** `PROVENANCE-COLD.json` (sha256 `423ac125…`) records, for each file:
- status, git blob and sha256;
- the sha256 before the change.

Every change was authored in this job. Nothing was imported.

**Scans** on exactly those 12 files:
- `.githooks/scan-crypto-keys.py --files`: exit 0;
- `gitleaks dir --config .gitleaks.toml` on a staged copy: no leaks (`cold/gitleaks-cold.json` = `[]`).

## 1. Root's finding, confirmed, and the whole path audited

**The finding.** Root's probe was right. `runPrivacy` refused `apps: []` before any host-service check. Enrollment wrote
`privacy-config.json` only once it named an app, and `run-network.cmd` waits for that file. So a fresh host could never
run its own services.

**Other gates found while auditing** (each item is fixed or covered below):

| path | gate / defect | disposition |
|---|---|---|
| `network/privacy-agent.mjs` runPrivacy | `!cfg.apps.length` refused before the host-services preflight | **fixed** (§2) |
| `windows/node/network-enroll.mjs` pass | `changed && cfg.apps.length` before any write | **fixed** (§3) |
| fresh box | the only opt-in was a hand edit of `privacy-config.json`, a file a fresh box does not have | **fixed**: `ENCLAVE_HOST_SERVICES_FILE` (§3) |
| `run-network.cmd` launcher (install-host.ps1) | waits for the file, and restarts an exited agent every 10 s | **unchanged**. Enrollment now writes an app-less config only if the agent would accept it, so no 10-s refusal loop (§3) |
| node `restartAgent`, `enrolledIds`, wallet `#walletRouted` (reads `status.apps`), `ENCLAVE_STARTUP_EGRESS_CONFIG` reader | none assumes a non-empty list | unchanged (`[]` is handled) |
| `PrivacyAgent.refreshAuthorization` | a full chain quorum read every 15 s, even with no app | **fixed**: skipped when there are no apps |
| `PrivacyAgent.start` (**existing race**, found by the real-daemon test) | a SIGTERM during start's last status write left 5 intervals running, so the process **never exited** (reproduced 2 of 8; `ACTIVE RESOURCES` showed 5 Timeouts) | **fixed**: re-check after the write. 10/10 after the fix |
| bundled privacy agent (**existing latent defect, also in the INSTALLED minipc agent `cfb69370`**) | `host-services/runner.mjs` is bundled lazily, and its "main module" check fires inside the bundle. A challengeReplica with `hostPolicy.carriers` loads it, and the runner prints its usage and calls **`process.exit(2)`, killing the privacy agent** | **fixed**: guarded bundle entry (§4) |
| consumer `dns.mjs` (scripts/network/build-consumers.mjs) | the bundled `windows/node/host-identity.mjs` CLI ran, so the bundle was unusable (the earlier baseline failure) | **fixed** (§4) |
| Linux `network/reconcile-apps.mjs` | appends apps to an operator-written config; no non-empty gate | unchanged. The agent now accepts that operator's app-less config |
| host-service roles (runner.mjs, lease-relay-host, storage-indexer-host, challenge replica) | each already runs the SAME platform host policy gate | unchanged |
| exits (wg-provider `service()` / `sweepService`) | grant only to an active, operator-signed registry host with an explicit platform admit; removed on a definite ban | unchanged. This is the authoritative half |

## 2. Privacy agent (`network/privacy-agent.mjs`)

**When an empty app list is accepted.** Only when both hold:
- the `hostServices` block passes the existing `hostServicesPreflight` (a valid block, the ingress worker staged, and
  runner = keccak256 of the endpoint);
- the platform host policy is **ON** for this host.

**When it is refused.** Otherwise it is refused before anything binds, in one of two ways:
- with no block at all, with exactly the old message `version 2 app configuration required`;
- with a block that cannot run, with that message plus the reason.

An `"off"` policy admits nothing, so an app-less agent with it is refused.

**One gate for host services, at any app count.** Host services now follow `createHostServiceGate`, the same gate the
node, supervisor.js and the host roles use:
- **Configuration:** this host's registry id, the config's chain address book, `process.env`, and state in
  `<state>/host-services-policy`.
- **Production default:** the production book turns the production policy on with no configuration.
- **Start:** only after an authenticated admit in this process. A fresh or restarted host, or an unreadable policy,
  **holds** them.
- **Explicit refusal** (ban, allowlist miss, deregistration): `HostServiceTransport.close()`, which revokes the exit
  grants. It is sticky until the admin's next admit, which restarts them.
- **Transient outage:** kept within the gate's grace.
- **Apps are never held up:** the first decision is not awaited. A host-service failure still refuses host services only.

**Behaviour change for an existing host WITH apps and a `hostServices` block.** Before, its host services started at
once. Now they wait for the policy's first authenticated admit. With an `"off"`/non-production policy they start at once,
as before (tested). This is deliberate, and it is one rule for all app counts:
- **No mode switch when an app is added or removed.** A switch would drop services at the first app or the last.
- **Root's call:** it adds this policy's quorum read every 60 s, but only on hosts that configure hostServices.

**Rejected alternatives:**
- No dummy app, no forged lease, no default public fallback.
- No allows are carried across restarts: the gate restores only a known refusal, never an admission.

## 3. Enrollment (`windows/node/network-enroll.mjs`, `agent.mjs`, `node-config.example.cmd`)

**The opt-in file.** `ENCLAVE_HOST_SERVICES_FILE` (node-config.local.cmd, an absolute path) names the operator's
explicit opt-in, the JSON `stage-tool.mjs host-services` prints as `agent`: `{hostServices, challengeReplica?}`.
- While configured, it is the source of those blocks.
- A changed block causes one agent restart, as the existing rules already do.
- A missing, unreadable or wrongly shaped file applies nothing: the config's own blocks are kept as they are, and the
  error is reported every pass.
- When it is not configured, nothing changes: the hand-set block is kept byte for byte, as before.

**When an app-less config is written.** Only when every one of these holds:
- a **valid** block;
- the agent would accept it (`appLessRefusal`: worker staged, runner = keccak(endpoint), policy on for the config's book);
- the node's own platform gate (`host.platformPolicy.serviceRefusal()`) does not refuse this host;
- the existing preconditions: the node is registered (`host.registered`) and has an admitted Shield policy.

**The first app** joins the app-less config by the normal reload, with **no restart**, so host services keep running.
Apps are still never removed, as before.

**Deploy closure.** The node's closure gains `network/platform-host-policy-config.mjs` (no dependencies) and `viem`,
which is already declared. `test/windows-node-deploy-files.test.mjs` passes.

## 4. Generated bundles

- **Privacy agent.** It is now bundled from `network/entries/privacy-agent.mjs`, which imports `network/main-guard.mjs`
  first: it renames argv[1], so no bundled library's main check can fire. The entry runs the daemon only when the bundle is
  the main script, and re-exports the library, so consumer imports still work.
  - `network/build.mjs` and `build-consumers.mjs` both use this entry.
- **Consumer dns.mjs.** It now uses the existing `network/host-services/entries/route-dns.mjs`, behind the argv guard,
  plus a banner name that cannot collide.
- **`network/bundle-checks.mjs`.** Every emitted bundle must parse. An unguarded bundle may carry at most one main check;
  a guarded one must contain its guard. Both builders apply it.
  - The real `network/build.mjs` passed it for all 7 JS bundles.
  - The unguarded agent build is refused, with its two checks.
- **Counterexample test.** The same esbuild options run against `runner.mjs`:
  - unguarded: **exit 2 with the runner usage**;
  - guarded: the agent keeps running.

## 5. Pinned, reproducible packages (no unpinned generated packages shipped)

**`scripts/locked-inputs.mjs`.** Every npm input of a host-service package must be exactly the version (and name) pinned
by its governing lockfile (`<prefix>package-lock.json`). An extraneous package, an input outside the tree or a version
drift is refused, with "install with npm ci".

**The network-runtime bundle input.** `relay/network-runtime.bundle.mjs` is gitignored and is an input of route-dns. The
builder **rebuilds it into a scratch directory and requires byte equality**, with that bundle's own npm inputs locked too.

**The drift this pins.** The earlier composition built a runtime bundle `75c8ba75` before `relay/node_modules` existed in
the tree; esbuild then resolved the root copies. With the relay's lockfile-pinned modules present it is `dced8384`. The
package manifests already digest every input file, so those digests plus this lock check are the pin.

**Locked by:**
- `package-lock.json` sha256 `9ada1611…69f20`;
- `relay/package-lock.json` sha256 `e5d896ba…0b56`.

**Reproducibility proof** (`cold/repro.sh`; logs/c16, queue 1024, peak 618 MiB).
- **Method:** an independent `git clone --local --no-hardlinks` at 427780bb in another path, against the candidate. Each
  side builds the runtime bundle, the 5 packages, the 4 consumer bundles and `network/build.mjs` dist.
- **Result: `REPRODUCIBLE: 25 artifacts byte-identical`** (`cold/artifacts.sha256`).
- **Manifest digests to pin:**

| package | manifest sha256 |
|---|---|
| directory-replica | `4aa032fa…82d6` |
| bootstrap-replica | `7732950b…dffc` (bundle unchanged from 32fecf5) |
| route-dns | `d60eb763…27a7` |
| policy-mirror | `56bf5c46…32d6` |
| credit-vault-submitter | `45b98921…e1a3` |

- **Shipped JS:**

| file | sha256 |
|---|---|
| `privacy-agent.mjs` | `e0a6abab…404e` |
| `host-service-ingress.mjs` | `c952dce4…62d3` |
| `windows-circuit-worker.mjs` | `dcac53cb…2c0e` |

Full values for all 25 artifacts are in `cold/artifacts.sha256`.

- **The packages stay uncommitted** (`network/host-services/packages/` untracked). They are reproducible from 427780bb
  and the locked node_modules.

## 6. Tests (all through `claude-test-queue.py`; none exited 98/99)

**New: `test/host-services-cold-start.test.mjs`** (12 tests).
- **Real daemon:** `node network/privacy-agent.mjs --config`, with real enrollment passes.
- **Real gate:** the unchanged gate against the local chain+mirror world (`platform-policy-world.mjs`), or the production
  policy with no network.
- **Isolation:** every `*.enclave.host` lookup is refused and logged; none occurred.

**What it covers:**
- **Zero apps, admin denial:**
  - banned at start: held, the agent runs;
  - unban: started; circuits are really attempted;
  - ban while serving: stopped (grants revoked);
  - an outage after the ban: never resurrected;
  - unban: restarted.
- **Unknown chain policy:**
  - production policy with no network: held for 6 s, never started, agent alive;
  - local policy down from the start: held; once it answers and admits: started.
- **First app added, then last app removed** by live reload (SIGHUP): host services started once and never touched.
  Restart with no app: started again.
  - SIGTERM must exit (0, or 1 "stopped during startup") and never hang: 10/10.
- **Malformed configs** (all exit 1 before anything binds):
  - no block: the exact old message;
  - malformed block;
  - a newer release's field;
  - no worker;
  - runner ≠ keccak(endpoint);
  - policy off (non-production book);
  - `ENCLAVE_PLATFORM_HOST_POLICY=off`.
- **With apps:**
  - off policy: immediate start, as before;
  - banned: held.
- **Bundle guard:** the counterexample (exit 2 vs survives); `checkBundle` refusals; the bundle imports without starting.
- **The shipped bundle** (built from the entry) runs the app-less daemon: admitted, then started.
- **Enrollment:**
  - nothing written without an opt-in;
  - a valid opt-in writes an app-less config, steady across passes, `challengeReplica` carried; the first app joins with
    0 restarts;
  - not written for: a refused host, an invalid block, a missing/bad/wrongly shaped file, an absent worker, an endpoint
    mismatch, a non-production book;
  - existing box: a file change restarts once; an unusable file keeps the running block byte for byte.
- **Lock check:** the governing lockfile per tree (root, relay, nested, scoped); drift, extraneous and outside inputs are
  refused.

**Final regression job (logs/c15, queue 768, peak 650 MiB): 82 tests, 82 pass, 0 fail, 0 skipped.** The 12 files:
- `host-services-cold-start`;
- `host-service-transport`;
- `network-consumer-bundle` (**the previously failing dns.mjs test now passes**);
- `privacy-agent-config`, `privacy-agent-lifecycle`, `privacy-agent-proofs`;
- `windows-node-network-enroll`, `windows-node-wallet-enroll`, `windows-node-wallet-grant-refresh`,
  `windows-node-wallet-network-hold`;
- `windows-node-deploy-files`;
- `challenge-replica-host`.

**Builds:**
- logs/c5: the real `network/build.mjs` (all bundles checked, Go binaries), queue 1024.
- logs/c7/c8: packages build and `--check` under the lock check, queue 768.
- logs/c16: the reproducibility run.

**Not run.**
- 10 tests in `hosted-policy-cold-start`, `credit-vault-submitter-runner` and `hosted-service-placement` (logs/c9) skip
  with "needs the Foundry build". The 6 others there pass.
  - No contract artifacts match these sources: `work/enclave`'s differ in `EnclaveRegistry.sol` and
    `EnclaveProofOfTime.sol`.
  - `forge build` exceeds the 1536 lane.
  - These are the packaged-role end-to-end tests. Root should run them in a larger lane before pinning.

**Process notes.**
- Trivial `node --check` syntax checks and one `node windows/node/deploy-files.mjs` closure listing (both read-only, under
  a second each) ran outside the queue. Their substance was re-run inside queued jobs.
- Superseded or failed runs, kept for the record:
  - c2: two failures, fixed (a test default-parameter bug, and an enrollment compare-after-mutate bug);
  - c4: a B3 static check, fixed by keeping the `bundle('…', 'privacy-agent.mjs')` call shape;
  - c5: B1 failed because that ad-hoc job lacked `lo up`; c6 passes it;
  - c10–c13: the shutdown race above.

## 7. Activation prerequisites (root-owned)

1. **Integrate 427780bb** (after d7f520bf) into the normal Windows release line. Re-diff the touched files against the
   current normal tree first: other workers own nearby files.
2. **Build from a CLEAN checkout** with `npm ci` from the committed lockfiles, then run:
   - `node relay/build-network.mjs`;
   - `node scripts/build-host-service-packages.mjs` and `--check`;
   - `node network/build.mjs`.
3. **Go artifacts:** `enclave-wg(.exe)` and `enclave-circuit-firewall.exe` embed `vcs.revision`, `vcs.time`,
   `vcs.modified` and the toolchain (`go1.27.2-X:nodwarf5` here; go.mod says 1.24). They are byte-reproducible only for
   the same commit, clean/dirty state and toolchain. Build them before generating the untracked packages, or pin the
   toolchain and record `vcs.modified`.
4. **Ship the Windows bundle:**
   - `privacy-agent.mjs` (guarded), `host-service-ingress.mjs`, `windows-circuit-worker.mjs`, `enclave-wg.exe`
     (udpforward), `enclave-circuit-firewall.exe`;
   - the node control files: `network-enroll.mjs`, `agent.mjs`, `network/platform-host-policy-config.mjs`.
5. **Pin the package manifests** above in each host's `host-services.json`.
6. **Per host:**
   - generate the opt-in with `stage-tool.mjs host-services --endpoint … --zone … --exit …` and save its `agent` object;
   - set `ENCLAVE_HOST_SERVICES_FILE` in node-config.local.cmd;
   - the box must be registered and have an admitted Shield policy;
   - the exits must carry `hostServices` with a platform host policy (today only the ca-east A1 canary runs an
     hs-transport provider build).
7. **Before any G4 activation with `challengeReplica.hostPolicy.carriers`:** check the live minipc config. The INSTALLED
   agent `cfb69370` exits 2 when that path loads the runner. Do not enable carriers on it.

## 8. Rollback prerequisites

- **Restore the order:** first unset `ENCLAVE_HOST_SERVICES_FILE`, then restore the previous agent bundle and node files.
- **An app-less config breaks the older agent.** An older agent refuses an empty app list, and `run-network.cmd` would
  restart it every 10 s. Before rolling the agent back on such a box, remove that `privacy-config.json` (or the
  `hostServices` block), or keep the new agent.
- **Host services withdraw their own grants** on stop (revoke, then close). The exits also drop them on expiry.

## 9. Honest limits

- **Windows-only paths are not run.** The daemon tests run the Linux branch of runPrivacy. The Windows Shield/TPM branch
  and the real `run-network.cmd` and Task Scheduler loop are not executed; the Windows-specific configuration is covered
  only by the enrollment tests.
- **No live host, exit, DNS or policy anchor was touched.** The production policy was exercised only offline (held).
- **The agent's gate fetches policy documents from the default mirrors** (the 4 DO fronts), plus its persisted accepted
  policy. It does not use the policy-mirror carriers the host-role runner can use. A cold host with the fronts down holds
  host services until another path supplies the anchored document. This is a dependency on the same DO fleet, so it is
  not provider independence.
- **Reproducibility is proved across clones and paths** with the same lockfile-verified node_modules. A fresh `npm ci`
  (needs network) and a second machine or toolchain were not tried.
- **Host-side policy load.** The quorum read per 60 s (PRODUCTION_RPCS 3 of 4) is added only for hosts with
  hostServices, on top of the node's own. Public-RPC 429s can hold a restarted agent's host services.
- **Root's `root-service-empty-apps-probe.mjs` no longer passes as written.** It asserts the old exact message. Its
  minimal config carries a hostServices block, so it now passes the empty-list check and fails on a later required field
  (it has no `operatorKeyFile`). With a full config and no worker or runner it is refused with `version 2 app
  configuration required: … refused (the host-service ingress worker is missing …)`, which is tested. This is from code
  reading; the probe was not re-run.
