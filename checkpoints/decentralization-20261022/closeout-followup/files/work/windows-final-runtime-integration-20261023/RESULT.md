# Windows final runtime integration (on the immutable final baseline 1f19ad15 / source 30339303)

Written 2026-10-23 ~13:50Z, by F in a new isolated tree: work/windows-final-runtime-integration-20261023.

**Scope:**
- The earlier tree, `resume-after-checkpoint-20261022/windows-final-baseline-compose` (final 30339303, evidence 1f19ad15, report), is untouched, so D can capture it.
- **Not done:** no SSH, production, installed-host change, VM or service restart, wallet, funding, signing, contract change, cache allocation, node sync, toolchain, Wine or push.
- No other worker's tree was edited. Inputs were fetched as git objects only.
- **Queue:** every build, test, probe and scan went through `work/claude-test-queue.py` (unchanged 16 GiB floor, caps ≤ 1408 MiB).
- **Identity:** SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com>, author and committer, with hooks on.
- **Hold:** the NucBox experiment release and the restart permission are still unanswered. Nothing here is activated, and root owns activation.

## Final pins

**Source:** `candidate`, branch `final/windows-runtime`, head **0de09415815a9ca6382fc58af81b88cff193522c**, tree **5cbdb670f5b5e60cff2f91121c2bd3e127377c96**. There are five commits on 1f19ad15:

| Commit | What | Provenance |
|---|---|---|
| 896c5d49c | Published main 68b82926: PRODUCT.md, README.md, docs/security/nucbox-custom-vm-verifier.md, site/js/pages/sso-authorize.js | Shared rewritten anchor adf9c5bbf. Three files are unchanged here, so main's bytes are taken. README is a clean 3-way merge. |
| 2aef8ee8e | TLS: apptls, secrets, new origin-request.mjs and its test | Exact cherry-pick of **1957ff23425f6ee2e0abe2604bdc9735987eff47**. All 4 files are byte-equal. |
| 548bf5984 | M: manager reservation accounting; the installer keeps the owner's 96 | `git am` of the patch sha256 **eeab54d2…cb92** = 9f19b7c6. Every file is byte-equal, or (host/agent/chain) has exactly M's added and removed lines. |
| 42bb46368 | Shared `network/verified-chain.mjs` at A's final 554a251c; admission and metal bundles rebuilt; opt-in boundary test | A **554a251cbe14aa7ba8af4c160d9a8b9793e4071a**. Ours was A's base, so the file is taken whole (77cee386). |
| 0de094158 | Test-fixture repairs (below). No product source changes. | — |

**Node deploy closure:** derived from agent.mjs's import graph by `windows/node/deploy-files.mjs`.
- **89 files** (prior final: 88 plus `windows/node/origin-request.mjs` e5fe041d), listed in `node-deploy-files.{txt,sha256}`.
- **Package:** `node-closure.tar` = `git archive` of tree 5cbdb670 restricted to those 89 paths, sha256 **783797c03270d58f0ec56e8f8bb70e54814f0de401f4a628fbd8da224c941d8b**. It is byte-identical from an independent `--local --no-hardlinks` clone.
- **Verification** (`verify-closure.sh`, job v1):
  - the extracted package's bytes match the list;
  - the committed `closure()` walk, rooted in the extracted directory, resolves agent.mjs's whole graph with **0 problems** and exactly these 89 files, including origin-request.mjs.
- **Installer:** `install-host.ps1` 9ed6bda0 archives all of `windows/`. No hand-maintained file list exists.

Key closure pins (sha256 prefixes):

| File | Hash |
|---|---|
| agent | 3abaf559 |
| host | de8b48d1 |
| chain | c448b9cb |
| chain-reader | 907fd1c8 |
| network-enroll | 4e2f5e91 |
| apptls | 89db0311 |
| secrets | 71a262fa |
| origin-request | e5fe041d |
| host-admission.bundle | **6bd913516bbeeb72602720c2b5c29d00ced72d1c1ebb2046bb5c5abad447ff87** (`--check` clean) |
| lease-gas-runtime.bundle | 008cdca1 |
| host-service-transport | 43e7c115 |
| host-service-names | a46123cb |
| rpc-identity | 74cb965e |

**Outside that closure, shipped by the installer:**

| File | sha256 |
|---|---|
| windows/vbslike/manager/server.mjs | 764834227b6b847e140250fb209acfdeb4e189d3fb768b8b8f0485b28e4ecf26 |
| windows/installer/install-host.ps1 | 9ed6bda04ba5213cec03156663d5f3721794c7a12c8d1a982a39a7e62364b6a4 |

- **metal/guest/host-policy.bundle.mjs** 228d4cf0824f31eae4eac8161099c9314bdd6cbb0ab95ebe48539f74031a1991 is a Linux image input. No image was rebuilt.

**JS artifacts:** `artifacts-js-final.sha256`, 22 files, byte-identical on two independent paths. Go was denied by a stub (rc 97), and no Go or Linux image was built.

| Artifact | sha256 |
|---|---|
| dist/privacy-agent.mjs | **029bdd3080c64c0c3214a34f8602742d0b63e610d1f7ce9502a0470431593454** |
| relay/network-runtime.bundle.mjs | b2d7a17d658b8956d8b4798775670867117e7d61b37695591b7ab71b6bc5e663 |
| policy-mirror | 440d3f90 (package 120aeb07) |
| route-dns | edaae81a (package 1daac8a3) |
| dist/wg-provider.mjs | f802ddbf |
| consumers: checker / dns / privacy-agent / provider | a0ee93a2 / 7c704374 / 31dbc8a5 / 0b50370c |
| bootstrap, directory, credit-vault (3), enclave-directory, ingress c952dce4, worker dcac53cb, reconcile-apps, wg-qualify | unchanged |

**Every changed artifact traces to A's verified-chain alone:**
- **dist bundles:** the privacy-agent dist differs by exactly the `allowCall` hunk plus one renamed local.
- **consumers:** their esbuild manifests show identical input lists. The only changed tracked input is network/verified-chain.mjs.
  - `dns.mjs` changes through the rebuilt `relay/network-runtime.bundle.mjs`, which inlines it.
- **TLS and M** files ship unbundled, in the node closure.

## A: Windows/host-services source closure from immutable 554a251c (included vs omitted)

**Included:** `network/verified-chain.mjs` only.
- Since c3a61fd1a it is the one shared module A changed. It is inlined in the admission, privacy-agent, network-runtime, policy-mirror and route-dns builds, so keeping df8's older copy would ship a stale shared module in one source tree.
- **The additions are opt-in per caller:**
  - pinnedClient/createVerifiedSnapshot `allowCall`, default off;
  - `verifierRequest`/`verifierClient`.
- **`test/verified-chain-optin-boundary.test.mjs` (5/5)** proves:
  - with no opt-in, `call` is refused by name and nothing is sent;
  - with the opt-in, eth_call is pinned to the block hash;
  - verifierRequest refuses everything but pinned state, headers by number and the head;
  - no windows/, network/, relay/ or metal/ source uses the opt-ins.

**Omitted, A's to integrate:**
- **CLI and MCP sources:** cli/enclave, cli/independent, mcp/independent (this lineage's copies differ from A's base) and the CLI/MCP-only files.
  - A's tests import those, so they can't run here.
- **`metal/guest/mcp-server.bundle.mjs`** and its manifest: not part of this lineage.
- **A's test rig** (cli-independent-rig with reth, witness-gateway, op-head-relay, op-commitment): used only as a scratch overlay for the e2e, never committed.
- **The credit-vault-submitter package:** it imports no CLI code here, so A's signer fix doesn't reach it. Its bytes are unchanged, a22cd7a8/2a4de6d5.

## Tests (each file alone in a private loopback-only namespace, denial stubs; honest per-file aggregation)

**The runner was rewritten** (`run-suite.py`):
- each file runs as its own `node --test`, with its exit code and the reporter's own counts;
- a suite FAILS on any non-zero exit, any fail or cancel, an empty file, or any skip beyond an explicit allowance;
- `NOT RUN (native gate)` skips go in their own column, never counted as passed;
- `--drop-caps` gives a file an empty capability bounding set; `--dummy-if` gives it a dummy interface inside its namespace;
- per-file tables are in `logs/*.files.tsv`.

The old wrappers exited 0 on failing files (ROOT-J3D-FAILURE-REVIEW).

| Job | Scope (why) | Result |
|---|---|---|
| J1 (76 files) | TLS worker's 60 import-coupled files ∪ M's 41 coupled ∪ M's 2 new ∪ 3 host-importing Foundry suites | 644 tests over 76 files. **72 files pass outright.** The other 4: hosting passed with 1 skip; shield-startup failed 4 tests; heartbeat was cancelled at J1's 300 s file bound; and the 2 pre-existing failures below. The first three are rerun in J1b. |
| J1b | windows-shield-startup after its fixture reads the manager's RAM view (M semantics; it was refusing "RAM not read") | **15/15** |
| J1b | windows/node/hosting.test.mjs with a dummy non-loopback interface (its misconfigured-bind negative had been a skip) | **21/21** |
| J1b | offchain-heartbeat-writers with its own 900 s bound (J1's 300 s file bound cancelled it) | 2 pass, **1 allowed skip**: its negative control needs a base supervisor.js that isn't provided |
| J2 | verified-chain + opt-in boundary, windows-chain-authority, network-owner-verifier, admission policy/retry/runtime, platform-host-policy, the hosted roles' carriers/cold start/lifecycle/transport/stage, policy-mirror race, service index, metal launcher, challenge supervise/front/host, privacy-agent lifecycle, network-host canary | 25 files, 181 tests: 169 pass, 2 fail (host-services-carriers, service-index), 10 skips (8 need the built packages, 2 need STAGE_TAR). All handled in jfix. |
| J2 | **shipped admission bundle** (ADMISSION_BUNDLE_TEST) | **7/7** |
| J2 | **parity** against the reproduced installed 6bef372d | **14/14** |
| jfix | host-service packages built (8 skips needed them); host-service-verifier-roles, hosted-policy-cold-start, **host-services-carriers 9/9** (needed the packages), **service-index 15/15** (fixture fix), the TLS-coupled manager `ops/multi-accept` | **42/42** |
| jfix | hosted-services-stage | 1 pass, **2 allowed skips** that need the external Linux stage-1 archive (STAGE_TAR) |
| J3 | site-independent-management, three runs | **10/10, 10/10, 10/10**, including the real Safe/passkey identity and delegation case |
| J3 | windows-release-journal with an empty capability bounding set | **7/7** |
| J3 | release-journal negative control, with capabilities | **fails #4 as required**: the guard detects the writable directory |
| J3 | windows-node-lease-readiness | 8 pass, **1 NOT RUN native gate** |
| J4 | `windows-verifier.e2e` on the COMMITTED head: real reth v2.8.0 --dev + A's patched Helios (hash-checked cc962e2b / 8cdd1f35), A's 554a251c test rig as a scratch overlay | **6/6, peak 746 MiB** |
| final | the closure check (above); `windows-node-deploy-files` 3/3 in J1 | PASS |

**Covered by these runs:**
- **TLS behaviour:** origin-request 9/9.
  - verification kept: a wrong-name or self-signed certificate is refused and not routed around;
  - HTTP refusals, backoff and redirects are answers, never rotated around or followed;
  - a request is never resent after it is sent;
  - no cross-origin retry;
  - DNS order kept.
- **Memory accounting:**
  - windows-hv-memory-accounting 9/9 and installer-app-ram 3/3;
  - preclaim, scan-slot and hosting;
  - the manager's own test suites;
  - lease-renewal-keeper 16/16 (keeper cadence);
  - host-app-funded 3/3 (app-paid lease gas).
- **Challenge lifecycle and front:** challenge supervise, front and host.
- **Mirrors:** parity, and no fleet address in any bundle.
- **Admin rights:** ban and unban, AddressBook owner migration, and ERC-1271 owner verification in the e2e and the role suites.

**Baseline fixture repairs** (commit 0de09415; ROOT-J3D-FAILURE-REVIEW):
- **Safe/passkey code:** `test/helpers/safe-passkey-code.mjs` no longer reads mainnet.base.org. It etches `test/fixtures/base-code/safe-passkey-code-base.json` (sha256 b08c9a60…).
  - **Snapshot:** taken once by the new `scripts/test-fixtures/snapshot-safe-passkey-code.mjs` in job p1, a read-only probe in the queue (eth_chainId/blockNumber/getCode/call). It read Base block 52984972 from two RPCs that had to agree.
  - **Pins:** all 11 pinned contracts hash to the reviewed `codeHash` pins in `site/js/core/account-providers.js`, checked at snapshot time and at every use.
  - **Signer singleton:** 0x4e27b51350e6c2083ee19011120f50dafec5ca50, keccak 0x2f10c1de…. It has **no reviewed pin of its own**. Its address is embedded in the pinned factory's code, and its bytes are two-RPC-agreed only. Root may want to pin it.
  - Real Safe v1.4.1, passkey signer and 4337 coverage is unchanged, with no network guard disabled and no generic wallet.
- **Management 409 cascade: a fixture race, not a product regression.**
  - The gateway's LeaseReader authorizes at a confirmed block (`confirmations: 1`, the agreed head minus one).
  - The rig mines every 1 s, so an operation sent right after `claim` could read the block below the claim. It was correctly refused with 409 `not_current_runner`, and that refusal was cached for the gateway's 15 s negative TTL (`management-gateway.mjs:245`).
  - Every later operation in the window then failed too. All 8 failing tests ran within that window, and both 14d1 and the candidate showed it.
  - **The fix:** the test mines the confirming block after each claim. Lease authorization and the admin checks are unchanged. Result: 3/3 runs pass.
- **release-journal #4** requires EACCES from its read-only directory before relying on it, and runs with dropped capabilities. The negative control proves a capability override now fails instead of passing vacuously.
- **lease-readiness:** the PowerShell cutover gate (`../../cutover/tools`, outside the repo) is `NOT RUN (native gate)` without PWSH. It is reported, not passed, and no toolchain was installed.
- **service-index:** the schema-4 registry comes from the in-tree `test/fixtures/registry-schema4`.
  - That file is byte-equal to this history's ca137530, the authorized rewrite of b17db9a3 (map in `outputs/tinfoil-lowercase-cleanup-20261021`).
  - Pre-rewrite b17db9a3 is not in this history and was **not** fetched, because that would import old-ancestry objects.
- **windows-shield-startup:** the host reads the real manager's `/health` before claiming, as the agent does since M (the same adaptation M made to preclaim and scan-slot).

**Pre-existing failures, not from this composition** (identical on base 1f19ad15, and on 4106 per the TLS worker):

| Suite | Failure | Note |
|---|---|---|
| `catalog-platform-enforcement` #1 | SyntaxError: the test's `evalmachine` extraction of `#walletPolicyState` | — |
| `registry-reconcile` #8 | "the supervisor sends no heartbeat": the Linux `supervisor.js` still contains `sendOperatorTx(... "heartbeat")` | A real gap against the off-chain-heartbeat requirement, in the Linux supervisor, which this Windows composition does not touch. Owner: the Linux runtime workstream. |
| `site-independent-account-startup` | The Safe-held `deployOnChain(prepareOnly)` creates no record | Fails identically on the control: 1f19ad15 plus only the offline Safe fixture. The site's deploy flow is unchanged here; its refusal toast is not captured by the test. Owner: the site/wallet (E/S) scope. |

**Not run:**
- anything Windows-native: PowerShell, Hyper-V, a real manager restart or an installer run (M's installer test is structural only);
- the cutover gate (NOT RUN, above);
- A's CLI/MCP suites (A's scope).

**Scans:** `scan-crypto-keys --range 1f19ad15..HEAD` 0, gitleaks over 5 commits: no leaks.
- Checkpoint archive files inherited from 14d1 still contain the pre-rewrite brand literal (9 files under `checkpoints/`). No commit here adds one, and product source has none.

## Activation delta vs installed (R3 08:01Z) and recipe (root; NOT done)

| Installed | Installed → final | Notes |
|---|---|---|
| network\privacy-agent.mjs | cfb69370 → **029bdd30** | |
| windows-circuit-worker | 13ce44f1 → dcac53cb | label-only |
| ingress | c952dce4 | = |
| control\windows\node\agent | 76cac355 → 3abaf559 | |
| network-enroll | a9729786 → 4e2f5e91 | |
| host | ea0f6b8a → de8b48d1 | keeper + A wiring + M |
| chain | 3e9fae03 → c448b9cb | keeper + A + M |
| apptls | 2fb25b00 → 89db0311 | |
| secrets | d034d871 → 71a262fa | |
| origin-request.mjs | (new) e5fe041d | |
| chain-reader.mjs | (new) | |
| host-service-transport | de5bb98a → 43e7c115 | |
| names, rpc-identity | = | |
| windows\node\host-admission.bundle.mjs | 6bef372d → **6bd91351** | mirrors `[]`; parity proven |
| lease-gas-runtime.bundle | 159108d1 → 008cdca1 | rename-only |
| partition manager server.mjs | → 76483422 | |
| install-host.ps1 | → 9ed6bda0 | |
| enclave-wg.exe, enclave-circuit-firewall.exe | **KEEP** | Unknown Go provenance; not rebuilt. |

**Default behaviour on the box after activation:**
- legacy provider quorum (no ENCLAVE_CHAIN_AUTHORITY);
- no host services or challenge replica configured;
- TLS origin failover on the node's own relay requests.

**Memory-accounting order:**
- **Installed manager (no `memory` field):** the new node reads it as "no pool rule", so floor accounting continues, as today. Either order is safe.
- **Once node and manager both run the new code:** the node advertises the manager's reservations.
- **Recovered or unknown partitions:** new claims are refused while partitions are unknown, without retiring running apps.
  - This holds after a manager restart: partitions are reported `recovered`.
  - Existing VMs keep their spawn-time size. Resizing happens only through the existing restart-recovery path, which M's gap 2 records: the node retires a recovered VM and respawns one at the new pool × share.
- **Root decision:** whether that relaunch at 96 is wanted.

**Steps (after the experiment release and root's 96/restart decision):**
1. Root read-only preflight:
   - bind each running privacy-agent and node-agent process to its script sha (loaded-process gate);
   - fresh boot and authority verification after the 0xEF bugchecks (native-kernel gate);
   - capture hashes of the 4 files without a baseline record.
2. Stage the 89-file node closure (tar 783797c0), the privacy-agent 029bdd30 and the partition manager/installer from this tree. Keep the Go executables.
3. Run the installer. It validates the owner's `NODE_APP_RAM_GB=96` against physical RAM and writes 96 unchanged to node-config.cmd and shield-config.cmd.
   - It warns, and does not clamp, when that leaves under 16 GiB outside the pool: 15 GiB on the NucBox.
   - **This is not proven natively.** The PowerShell behaviour has not run.
4. Restart the manager, then the node (root's restart permission).
5. Read back `/health.memory` against `/v1/local` capacity. Expect `ramSource` "manager", app-pool free ≠ physical free. Expect 0 free until recovered partitions are reconciled.
6. Read the TLS and keeper logs.

**Rollback:**
- reinstall the previous control files (cfb69370 / 76cac355 / a9729786 / ea0f6b8a / 3e9fae03 / 6bef372d / 159108d1 and the previous manager/installer);
- or revert the commits: 548bf5984 for memory, 2aef8ee8e for TLS, 42bb46368 for the shared module and bundles.
- The config files are unaffected: root already set 96 in all three.

**Open:**
- physical headroom for any RPC service VM (outside admission accounting; M's gap 1);
- native PowerShell and Hyper-V verification;
- the signer-singleton pin decision;
- the Linux supervisor heartbeat (registry-reconcile);
- A's CLI/MCP integration and E's receipt seam.

No production-independence claim is made.

## Files here

- **Inputs:** `setup.sh` (refs/in/{tls,mem,a,main}).
- **Compose and commit:** `compose1.sh`, `commit2.sh`, `msgs/`.
- **Build and verify:** `build-admission.sh`, `build-js.sh`, `verify-closure.sh`, `snap.sh`, `scan.sh`.
- **Test runner:** `run-suite.py`.
- **Jobs:** `j1.sh`, `j1b.sh`, `j2.sh`, `j3.sh`, `j4.sh`, `jfix.sh`, `jrun.sh`, `jfinal.sh`.
- **Logs:** `logs/`.
- **Pins and package:** `artifacts-js-final.sha256`, `node-deploy-files.{txt,sha256}`, `node-closure.tar(.sha256)`.
- **Worktrees** (scratch, read-only use): `base` and `base-fx` (1f19ad15 + only the Safe fixture).

## Evidence commit (added after the above)

**dda47a35008e989cc6e62c1a79f0fefde49b29f5** on 0de09415 is evidence only. It adds `checkpoints/windows-final-runtime-integration-20261023/`: this RESULT as of that commit, `artifacts-js-final.sha256`, `node-deploy-files.sha256` and `node-closure.tar.sha256`.
- The **source pin stays 0de09415** (tree 5cbdb670).
- Rescan over 1f19ad15..dda47a35008e989cc6e62c1a79f0fefde49b29f5 (6 commits): scan-crypto-keys 0, gitleaks no leaks.
- Not pushed.
