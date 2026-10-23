# Windows runtime composed into the normal source tree: RESULT (2026-10-23 UTC)

**Status:** a source-only merge candidate, committed locally in a NEW isolated clone. Not pushed or merged, not built into
a release, not deployed.
- main-repo, the frozen candidates, other workers' directories, live files and root's staged nucbox bytes were only
  read; checkpoint publication stays with worker E.
- No SSH, network, wallet or production action.
- Requirements read: `work/effective-goal-requirements.txt`, md5 `c66f26fc…`.

## 1. Candidate and hashes

**Repo:** `windows-compose/candidate`
- A `git clone --local --no-hardlinks` of `source-checkpoint-20261022/main-repo`.
- Branch `compose/windows-runtime-20261022`, from **`f58e03ec483d9ec28b04f5adc01c7d4fce182954`** (that clone's HEAD, which was clean).
- The origin remote was removed.

**HEAD:** **`a6fb7aabb8931116b8bd8c95aa1bad9d136cc1fc`**, tree `5ef5db11e0c88e48ae6fc982358b7a9cecd8f8e3`.
- 7 commits; every author and committer is SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com>.

**Patch:**
- `windows-compose.patch` = `git diff --binary f58e03ec4 a6fb7aab`, sha256 **`6fc1e5d2668feac559015b34f4a3daf9f83f3ca2c49c4e4109b3df05e45871d4`** (20 files, +2225/−184).
- `patches/0001…0007` = `git format-patch` of the same range.

| # | commit | origin |
|---|---|---|
| 1 | `8ba64343` | Network side of the D1 wallet hold (see §2) |
| 2 | `f666306d` | Windows node: D1 channel + lease readiness = the installed control baseline `32fecf5` (see §2) |
| 3 | `49afbb60` | cherry-pick -x of `ad4a72a` (wallet grant refresher), unchanged |
| 4 | `81fb5489` | cherry-pick -x of `2afa673` (renewal keeper; chain `renewDeployment(id,{gate})`), unchanged |
| 5 | `993d92ec` | cherry-pick -x of `829a881` (serving-first), unchanged |
| 6 | `d281007c` | cherry-pick -x of `e7e5057` (F1 TrackedSet epochs, F3 per-id guard), unchanged |
| 7 | `a6fb7aab` | NEW focused test `test/windows-node-wallet-channel-bundle.test.mjs` (`bea43b21…`) |

**All four cherry-picks applied without conflict.** The composed tree's runtime pair is byte-identical to the reviewed
final pair and to root's staged nucbox bytes, which were not touched:

| file | normal f58e03e | composed |
|---|---|---|
| `windows/node/host.mjs` | `e41122d7` | **`ea0f6b8ab9562e95cc20e82ea0d6cc6c7a242445d0a8608195f50ebb711c00de`** |
| `windows/node/chain.mjs` | `86c81124` | **`3e9fae0392497841f5c4e084c9d11f6c01243d339b0bdf3395b569f921a12938`** |
| `windows/node/agent.mjs` | `c2fe0fff` | `76cac35597133132…` (installed) |
| `windows/node/appzone.mjs` | `ba9d9bb1` | `65cbb69a898a1290…` (installed) |
| `windows/node/network-enroll.mjs` | `2d97a0e1` | `bdc6019cd82d3586…` (composed, see §2) |
| `windows/node/host-admission.bundle.mjs` | `7aeb5de9` | **`3438cdf29f2b5e41b3ce3e963bf35ea20f713cbbbe32cf5c007060b2941660f8`** (rebuilt, see §2) |
| `network/wallet-admission.mjs` | absent | `0fa7678f7586388b…` (D1) |
| `network/wg-manager.mjs` | normal | `c27049e2d7f7ee9c…` (D1) |
| `network/local-app-router.mjs` | normal | `40a8240afc8a5cb4…` (D1) |
| `network/host-admission-runtime.mjs` | `f9e009da` | `cb42269dad71148d…` (D1 decision()) |
| `network/privacy-agent.mjs` | `3a250868` | `d5885d2caa8f5e40…` (composed, see §2) |

## 2. Dependency-closure audit and composition decisions

**What the normal tree's files were.** Each normal Windows file (host, agent, appzone, network-enroll) is the installed
baseline `32fecf5` (host `9634cb40`) MINUS the D1 wallet hold channel and lease readiness. I checked every normal-only
line: each is the older form of a line the baseline changed. Nothing in them is missing from the baseline. `chain.mjs` was
identical. So the lineage could be composed as "the baseline wiring, then the four commits", with no line of the normal
tree's features dropped.

**Required closure of host `ea0f6b8a` + chain `3e9fae03`:**
- **Host imports and calls:**
  - `../../network/wallet-admission.mjs` (`WalletAllowWriter`, `walletHoldAcknowledged`);
  - `hostAdmission.decision()`, without which the channel refuses to start ("older host-admission bundle");
  - the privacy agent's `status.walletAdmission` (the hold ACK);
  - agent wiring: `walletAdmission` → enrollment, `appZoneAdmitted`, `servingWithdrawn` → `zone.closeDeployment`, and
    `/v1/host/state` `leaseReadiness`;
  - the lease-gas runtime bundle API (`configuredLeaseSender`, unchanged).
- **The network agent that enforces the channel:**
  - privacy-agent wallet admission (`withWalletAdmission`, serialized `snapshot()`, `admit()`);
  - `wg-manager.admissionSettled`/`retireCircuit`/detached allocation;
  - `local-app-router.revoke`.
- **Packaging:** `windows/installer/stage-bundle.sh` copies the control tree by import closure; its regex follows
  `import("../../network/wallet-admission.mjs")`. network/build.mjs inlines wallet-admission into the privacy-agent
  bundle. No installer change is needed.

**Composition decisions:**
1. **D1 network sources, verbatim from the reviewed package** (node-hold PACKAGE-RESULT inventory):
   - wallet-admission `0fa7678f`, wg-manager `c27049e2`, local-app-router `40a8240a`, host-admission-runtime `cb42269d`;
   - the baseline's host-admission-runtime test (+2 decision cases).
   - Normal-only lines in these files were all superseded forms.
2. **privacy-agent.mjs = D1 `a3f08aca` minus its host-services hunks** (`tools/compose-privacy-agent.py`, asserting its
   inputs):
   - the hunks removed are the `hostServicesPreflight`, `HostServiceTransport`, `fs_sync` and `keccak256/toBytes`
     imports, and the hostServices start/close;
   - every removed hunk restores the normal line;
   - the diff from the normal file is exactly the wallet hunks.
   - **Why:** host services belong to the host-service-transport workstream (G1–G4), whose runtime is not in this tree
     (§3). Importing the preflight alone would have pulled `host-service-transport.mjs` and `host-service-names.mjs` for a
     feature that cannot start here.
3. **network-enroll.mjs = normal + only the baseline's `walletAdmission` block**, verbatim and kept last
   (`tools/compose-network-enroll.py`). The baseline's `hostServices` and `challengeReplica` preservation are not composed
   (§3).
4. **host-admission bundle: rebuilt from the composed sources** with `scripts/build-host-admission.mjs`:
   - **Control:** the unmodified tree reproduced its own `7aeb5de9`, and metal `a19af83c`, byte for byte (wc1).
   - **Result:** `3438cdf2`, which is the hash the D1 host review predicted for a tree build. metal
     `host-policy.bundle.mjs` is unchanged.
   - **Token diff against the installed `6bef372d`:** the ONLY difference is the `PRODUCTION_MIRRORS` list, 4
     DigitalOcean `…/platform-policy` URLs here and `[]` in the live-recipe build (see `network/platform-host-policy-config.mjs`).
   - I did not change the mirror list. It is this tree's existing configuration. Dropping it would be an unrelated
     behaviour change, and so would shipping the live 0-mirror bytes (which `--check` would then call stale). **Root's
     activation keeps using its reviewed `6bef372d`.**
5. **Kept the normal tree's NEWER files where the baseline is older:**
   - lease-gas runtime bundle `008cdca1` and its manifest (bca7af7ee cost-estimate fix), `network/lease-gas-owner.mjs`
     and its tests;
   - `test/helpers/platform-policy-world.mjs` (immutable numbered blocks);
   - `relay/secrets-release.mjs` (bb5599a4), `supervisor.js`, the docs, and the rest.
   - Host/chain use only the bundle's unchanged API (`configuredLeaseSender`, `renewLeadMs`, journal). The scripted
     keeper fixture resolves its own sender.
6. **The lease-readiness test** reads root's cutover tooling from `../../cutover` (outside any repo). For the runs I placed
   an unmodified copy of `work/lease-readiness-20261022/cutover` at `windows-compose/cutover`, hash-identical to the
   serving-first copy. It is not committed, and the test is unchanged.

## 3. Precise source differences NOT composed (installed baseline `32fecf5` vs composed tree)

These are not in the closure of host `ea0f6b8a` / chain `3e9fae03`. They are reported, not imported:

**Host-service transport (P2/G1–G4).**
- Baseline-only files:
  - `network/host-service-{transport,names,ingress}.mjs`;
  - `network/host-services/packages/{bootstrap-replica,credit-vault-submitter,directory-replica,policy-mirror,route-dns}.*`;
  - `network/wg-provider/{dns-probe,host-services-config}.mjs`;
  - `network/wg/udpforward{,_test}.go`;
  - `test/host-service-transport.test.mjs`, `test/fixtures/challenge-replica-reviewed.json`.
- Differing files: `network/{build,enclave-network-host,wg-circuit-runtime,wg-grants,wg-control}.mjs`,
  `network/wg-provider/{control,install.sh,kernel,main,provider}.mjs`, `network/wg/{cmd/enclave-wg/main.go,forward.go}`,
  `network/host-services/{roles,stage-tool}.mjs`, `windows/installer/stage-bundle.sh`.
- Also the hostServices hunks of privacy-agent and network-enroll.

**Challenge replica (G4).** The `challengeReplica` block preservation in network-enroll.

**Other baseline-only changes outside the Windows closure:** `network/public-directory.mjs` (same-route re-sign
handling) and `metal/guest/{mcp-server,platform-api}.bundle.mjs`.

> **Deployment hazard (pre-existing in this tree, not introduced here).** On a box whose `enclaveNetwork` carries
> `hostServices` or `challengeReplica` (nucbox's installed control does), THIS tree's network-enroll would drop those
> sections and restart the privacy agent. Do not activate this tree's network-enroll on such a box until the
> host-service workstream is composed. Root's staged nucbox package uses its own enroll; this candidate does not change
> that.

## 4. Windows/Linux parity audit (report only; supervisor.js unchanged)

**Shared code.** Linux `supervisor.js` imports the SAME `windows/node/host-admission.bundle.mjs`. Its
`hostWalletRefusal` still calls `refusal()`, which through `decision()` now also throws "catalog snapshot expired during
admission" when the agreed catalog block is more than 90 s old or more than 5 s ahead. `LeaseReader.agreed` already
refuses stale blocks, so this adds no new failure mode in practice. It is still a shared change, and the Linux suites
that load the bundle ran (§5).

| aspect | Windows (composed) | Linux supervisor |
|---|---|---|
| renewals off the slow pass | 30-s keeper (`renewDue`), fresh row + fresh wallet decision, permit epoch + send-time gate | 60-s renewal clock (`stage("renew")`), fresh ledger row + placement + wallet check, `_renewing` guard. **Parity in intent** |
| UNKNOWN host-wallet policy (RPC quorum outage) | HOLD: not served, renewed or released; the domain is kept only on the agent's ACK, otherwise retired; the lease is never released for an unknown | `hostWalletRefusal` returns "host wallet policy unavailable…" as a REFUSAL, so renewal and audit call `retireForPlacement`, which stops the container and **releases the lease**. **DIVERGENCE (pre-existing, Linux; not changed: measured-image input, no speculative fix)** |
| network allow channel | wallet-admission file → privacy agent | none (no per-app network hold on Linux) |
| serving-first ordering | reconcile tracked before the claim sweep | renew before sync/audit/sweep; serving is container-resident, so N/A |
| lease readiness evidence | `leaseReadiness()` for the cutover gate | none (Windows cutover only) |
| routine liveness | unchanged; the new timers send no registry tx (see §5 heartbeat) | unchanged |

## 5. Tests (queue; offline)

**Runner** (`job.sh`): ssh/scp/sftp denial stubs (rc 97) proven first; `unshare -rn --pid --fork --kill-child`;
`node --test --test-timeout`; `timeout -k`. Every run is listed, including those that do not count.

| run | cap | result |
|---|---|---|
| `wc1-build-check` | 512 | unmodified tree: `build-host-admission.mjs --check` **PASS** (7aeb5de9, a19af83c reproducible) |
| `wc2-build` | 512 | composed sources: bundle → `3438cdf2`; metal unchanged |
| `KILLED-wc3-focus` | 512 | **not counted**: my own background wrapper hit its 600-s limit about a minute after admission |
| **`wc3b-focus`** | 512 | **91/91, 0 skipped** (peak ≈285 MiB); suite list below |
| **`wc4a-reg`** | 512 | 52 Windows suites importing host/chain/agent/appzone/enroll/bundle: **324 pass, 0 fail**, 13 skipped (needs anvil; run in wc4b/wc9) |
| **`wc4b-relay`** | 768 | 8 Anvil/relay suites: **34 pass**, 2 fail, 1 cancelled; triage below |
| `GUARDSTOP-wc5-bundle` | 512 | **not counted**: guard stop at 663 MiB (metal-launcher-isolation's wasmtime children) |
| **`wc5b-bundle`** | 768 | composed: new test + 17 admission/network/Linux-consumer suites: **73 pass**, 5 fail (all pre-existing), 12 skipped (anvil/forge). Shipped-bundle host-admission-runtime **7/7**. Controls below |
| `GUARDSTOP-wc6`, `GUARDSTOP-wc6b` | 768, 1536 | **not counted**: session-api-auth's forge build (two solc-0.8.35) exceeded 768, then 1536 |
| `wc7` | 1536 | normal-tree control of the 5 failures **valid** (identical). Its `forge build -j 1 --offline` was guard-stopped at 1536 (two solc, 736+727 MiB), so the heartbeat suite did NOT run |
| **`wc8-scan`** | 256 | `scan-crypto-keys.py --range f58e03ec4..HEAD` **0**; gitleaks (HEAD `.gitleaks.toml`) **7 commits, no leaks** |
| **`wc9`** | 768 | windows-current-runtime with anvil: **3/3** (peak 223 MiB). These are the 3 app-funded chain-module cases wc4a skipped |

**`wc3b-focus` suites:**
- host-admission-runtime (+decision cases);
- windows-node-appzone-wallet-hold, -lease-readiness (including the pwsh 7.6.6 cutover-gate case), -lease-renewal-keeper
  (16), -wallet-enroll, -wallet-grant-refresh, -wallet-network-hold (the REAL PrivacyAgent on the composed privacy-agent
  enforcing the Host's channel);
- privacy-agent-config/-lifecycle/-proofs, wg-manager, local-app-router, windows-node-network-enroll.

**`wc4b` triage:**
- **relay-fresh-attestation-shield:** `ERR_MODULE_NOT_FOUND relay/network-runtime.bundle.mjs`, a gitignored build product
  absent from candidate trees; the file then timed out. The same environment gap as hv-attach-relay, which was excluded
  up front because it hangs.
- **windows-release-journal case 4:** chmod 0500 does not stop a mapped root under `unshare -r`. It fails identically on
  the unmodified tree (wc5b control 3c). The release path passes no gate, and its chain.mjs code is unchanged.
- **Everything else passed:** windows-host-app-funded 3/3, release-journal cases 1–3 and 5–8, and the four lease relay
  suites and provider-canary (zero-ETH, app-paid claim/renew/release).

**`wc5b` failures, all identical on the unmodified tree (`wc7` control):**
- catalog-platform-enforcement: the vm-slice SyntaxError (recorded earlier on the lineage base);
- network-consumer-bundle and platform-host-policy-process "PACKAGED relay": the missing gitignored relay bundle;
- registry-reconcile: the source-pin "the supervisor sends no heartbeat";
- supervisor-wallet-policy: a vm-slice `HOST_POLICY_GATE is not defined`.

**Base controls** (unmodified tree with the composed test files, `tmp/norm`):
- **The new test fails 0/2** for the right reasons: `h.walletChannelStart is not a function`, and
  `admission.decision is not a function` (bundle 7aeb5de9).
- **The shipped-bundle host-admission-runtime suite fails exactly its 2 decision cases.**

**New test `windows-node-wallet-channel-bundle` (composed: 2/2):**
- the real Host + the real shipped bundle + the real channel writer;
- the channel starts EMPTY; the allow's `validUntil` equals the 40-s-old authority snapshot + 90 s (the chain deadline,
  not a fresh lifetime);
- `refusal()` is `decision().refusal`;
- an administrator **yank** refuses the deployment and withdraws its published allow.

**NOT RUN (stated plainly):**
- **`offchain-heartbeat-writers`.** It needs `contracts/foundry/out`, which is gitignored, and building it does not fit
  1536 MiB (wc6b, wc7). `work/enclave`'s out cannot be linked, because `EnclaveRegistry.sol` and `EnclaveProofOfTime.sol`
  differ from this tree.
  - **Static evidence instead:** the composition's new timers are `renewDue` (30 s), which sends only
    `chain.renewDeployment` for served, keeper-eligible leases inside their app renewal window, and the wallet channel
    heartbeat (10 s) and refresher, which write a local file only. No registry or liveness transaction is added.
- **`session-api-auth`.** The same forge build limit.
- **hv-attach-relay.** It hangs without the gitignored relay bundle.
- **Not done:** no native Windows run and no mutation run beyond the base controls. The lineage's own mutation and base
  evidence stands (2afa RESULT-renewal, serving-first-fixes RESULT).

### 5a. wc9
The real Windows chain module (composed `3e9fae03`) on anvil. All three cases pass:
- it claims, renews and releases a self-hosted app from its reserve with **zero operator ETH**;
- a partial sponsorship configuration refuses even when the host wallet could pay;
- it respects an **admin contract migration** and refuses stale gas configuration without spending.

With wc4b, every anvil-gated suite of wc4a has now run.

## 6. Requirements check

- **Administrator rights:** platform moderation stays mandatory in `decision()` (fresh agreeing catalog reads; a yank
  refuses and withdraws the network allow, tested). Admin, platform, placement, owner and boundary gates are unchanged.
  No contract or ownership change.
- **App-funded leases:**
  - the keeper renews through `leaseSend` (sponsored when lease-gas is configured; the host's ETH is never used instead);
  - the zero-ETH and app-paid suites pass (wc4b; wc9 3/3, including admin contract migration);
  - the normal tree's newer lease-gas bundle is kept.
- **Off-chain routine liveness:** no new periodic chain write except the existing lease renewal, now on its own clock. The
  heartbeat suite is not run (§5).
- **Owner policy:**
  - the host-wallet decision is unchanged in content; `decision()` adds only its deadline;
  - an UNKNOWN answer holds (never a refusal-release on Windows);
  - the owner-set and owner-only suites pass (wc4a).
- **Every existing feature:** the normal-only lines were audited (§2). The lease-gas, relay and directory newer code is
  kept, and 324 + 91 + 34 + 73 cases pass. The not-composed host-service features are listed in §3.
- **No secrets, config values, caches or generated bulk:**
  - node_modules are untracked copies;
  - the only generated file committed is the tracked admission bundle, rebuilt reproducibly;
  - no contract changes.

## 7. Activation notes (root)

- This is a reviewer tree, not an activation. Root's staged nucbox pair (host `ea0f6b8a`, chain `3e9fae03`) is
  byte-identical to the composed files. Nothing here changes the staged bytes or its recipe, which keeps bundle
  `6bef372d`, the D1 package files and its own network-enroll.
- **Before this tree could feed a Windows release:** compose or decide the host-service transport and challenge-replica
  workstreams (§3), and settle the PRODUCTION_MIRRORS question (§2.4) as a separate decision.
- **Rollback:** the candidate is a local branch; nothing was published.

## 8. Files

- `candidate/`: the git repo. node_modules there are untracked real copies of `work/enclave`'s, for tests only.
- `windows-compose.patch`, `patches/`.
- `tools/compose-privacy-agent.py`, `tools/compose-network-enroll.py`.
- `job.sh`, `job5.sh`, `job6.sh`, `job7.sh`, `job8.sh`, `q.sh`, `stubs/`.
- `logs/`: every run; KILLED-/GUARDSTOP- prefixes mark the runs that do not count.
- `cutover/`: a read-only copy for the readiness test.
- `tmp/norm`: the unmodified f58e03e control copy.
- Progress: `../windows-source-composition-progress.txt`.
