# Windows installed baseline → F 4106c311 / A df8fbafa: upgrade delta (F phase-A gate A1)

Started 2026-10-23T08:05Z, this text written from 09:03Z (`date -u`).
- **Scope:** source and artifact review only. No SSH, production, wallet, signing, restarts, installs or VM changes, and no
  edits to F's or A's trees. Jobs ran through the shared queue.
- **Inputs from root:**
  - R3 installed hashes: `outputs/decentralization-audit/windows-host-services-installed-baseline-20261023.json`, 08:01:05Z;
  - config state: `windows-host-services-config-state-20261023.json`, 08:31:42Z;
  - ROOT-EXPERIMENT-AND-OWNER-HOLD.txt in this directory, 08:41Z: NucBox stays untouched while the experiment runs.

## Decision

**A1 is resolved for every installed JS file.** Each one maps to an exact local source and build (§1); none is guessed.
The two Go executables are the exception: their build source cannot be identified locally (§6).

**F 4106c311 must not ship as the Windows upgrade as it stands.** Against the installed bytes it has two regressions, and
A's work is missing:

| # | What | Evidence | Fix |
|---|---|---|---|
| **R1** | **The challenge lifecycle fixes and the managed front are missing.**<br>• F's `challenge-replica-host.mjs` and `enclave-network-host.mjs` come from the older lease-readiness baseline **32fecf5** (commit d7f520bf8 says so), plus C's carrier edit.<br>• The installed cfb69370 has two later layers on top: the managed front (challenge-host-tls, g4 composition) and root's lifecycle fixes (retry, progress readiness, admin recheck, cancellation).<br>• F also lacks `network/challenge-front-declaration.mjs` entirely. | §2 and §4: `receipts/diffs/network_challenge-replica-host.mjs.diff`. | Port the installed sources onto F (§5). |
| **R2** | **The host-admission bundle's default policy mirrors are the 4 former DigitalOcean fronts.**<br>• This is the ONLY byte difference between F 3438cdf2 and the installed 6bef372d.<br>• F's in-progress compose (host-service-rpc-closure, 3-way merge of A's `platform-host-policy-config.mjs`) still keeps them: neither the merge base nor A changed that line, so "ours" wins. | `receipts/bundles/host-admission-delta.json` | `PRODUCTION_MIRRORS = []`, then rebuild. |
| **P1** | **A's Windows consumer wiring (df8fbafa) is on the 493 lineage, not on F's.**<br>• In a trial 3-way merge onto F, 8 Windows files merge cleanly, 4 are new, and 1 doc conflict is in the example cmd.<br>• The admission bundle must be rebuilt, not merged. | §5, `receipts/proposals/a-port/` | F/A port it; root decides activation. |

**Everything else** falls into one of four groups:
- byte-identical;
- a proven label-only or rename-only bundle change;
- comment-only;
- functional but gated on host services. The opt-ins are absent on the box (R3 `optInConfigured false`; config bd18bbe3 has
  no `hostServices`, `hostServicesPolicy` or `challengeReplica`), so this code stays inactive.

The default (apps) path gets two small hardening changes, listed in §2.

**Go executables:**
- **enclave-circuit-firewall:** its source has been unchanged since 2026-10-14 (6b7b4e476), so a stamp-only difference is
  expected, but it is unproven.
- **enclave-wg:** F's source adds UDP/53 ingress (`udpIngress`, `udpforward.go`) for a host's own DNS role. That is a
  functional, additive change. The canary plan treated the installed cbaf8313 as the build without it.

## 1. Installed baseline: exact provenance

| Installed file (R3) | sha256 | Exact local source and build |
|---|---|---|
| network\privacy-agent.mjs | cfb69370 | `work/g4-challenge-retry-package-20261022`: build.mjs over `src/`. Its 1938-input manifest is `candidate/privacy-agent.mjs.inputs.json`. Baseline 7ef4e230 = g4-network-composition `out/g4`, plus exactly 2 changed inputs: challenge-replica-host 9c3e4d10 and enclave-network-host 2c1b84aa (`build-result.json`). Root's retry review is `g4-config-independent-review-20261021/revision2/root-retry-review/RESULT.json` (21/21 lifecycle tests; the pre-fix negative test fails 3). |
| network\windows-circuit-worker.mjs | 13ce44f1 | g4-network-composition `out/g4` plus its `.inputs.json` (19 inputs) |
| network\host-service-ingress.mjs | c952dce4 | g4-network-composition `out/g4` (4 inputs); **F is identical** |
| control\windows\node\agent.mjs, network-enroll.mjs | 76cac355, a9729786 | `work/root-control-final-20261022/control-package/files` (manifest composedFrom lease-readiness frozen-control + g4 retry package) |
| control\windows\node\host.mjs, chain.mjs | ea0f6b8a, 3e9fae03 | Windows lease renewal keeper (root's 07:13 post-check receipt); **F is identical** |
| control\network\host-service-transport.mjs, host-service-names.mjs | de5bb98a, a46123cb | root-control-final files, which are the g4 composition's; **names: F is identical** |
| control\network\rpc-identity.mjs | 74cb965e | **F is identical** |
| windows\node\host-admission.bundle.mjs | 6bef372d | root-control-final files (G4 package: "admission, NOT rebuilt"). No input manifest exists locally. |
| windows\node\lease-gas-runtime.bundle.mjs | 159108d1 | root-control-final files |
| network\enclave-wg.exe, enclave-circuit-firewall.exe | cbaf8313, 78daec71 | **Not identifiable locally.** The G4 package's KEEP pins and the minipc canary plan (cbaf8313 → dea45347 for UDP ingress) record no build revision. See §6. |

The other files in F's 87-file node deploy closure (`host-services-final-compose/node-deploy-files.sha256`):
- **75 are byte-identical** to the root-control-final package.
- **4 have no baseline record** (§6): fetch-cid.py 729e6a0c, install-node.cmd 28633765, package.json 2192d65f and
  package-lock.json f8964448.

Two installed sources are not in any git repo and have no copy outside work/:
- **enclave-network-host c02bb1f1** (blob) / 2c1b84aa (sha256): it exists only as files in `g4-challenge-retry-package-20261022/src` and
  `g4-config-independent-review-20261021/revision2/network-tree`.
- **challenge-replica-host:** blob f6dd524f is in checkpoint commit bb7fcfcfd, as an archived file under
  `checkpoints/.../g4-config-independent-review-20261021/revision2/network-tree/`. It is not in a normal tree.

Both belong in the next source batch.

## 2. Delta, file by file (installed → F 4106c311)

| File | Installed → F | Class | What changes |
|---|---|---|---|
| privacy-agent.mjs (bundle) | cfb69370 → 6480ca9b | **FUNCTIONAL, including regression R1** | Input-level delta in §3 |
| windows-circuit-worker.mjs | 13ce44f1 → dcac53cb | **label-only** | Replacing every `../../enclave/node_modules/` with `node_modules/` turns 13ce44f1 into dcac53cb byte for byte. The 19 inputs are content-identical. (`receipts/bundles/windows-circuit-worker-delta.json`) |
| host-service-ingress.mjs | c952dce4 = c952dce4 | identical | |
| enclave-wg.exe | cbaf8313 → 4e686c5d | **functional source delta, very likely**; installed provenance unknown | F's Go source (20 files under network/wg and network/windows-firewall, including go.mod/go.sum) equals the g4 composition's byte for byte. Against checkpoint 9a307f3ea it adds `udpforward.go` (+322), `forward.go` (+6) and the `udpIngress` / port-53 handling in `cmd/enclave-wg/main.go`. These are used only when a host-service circuit configures DNS ingress. F's binary is stamped vcs.revision=4106c311, vcs.modified=true, go1.27.2, -trimpath. |
| enclave-circuit-firewall.exe | 78daec71 → 243a371c | **stamp-only, expected but unproven** | `network/windows-firewall` is unchanged since 6b7b4e476 (2026-10-14). If the installed build is from that source, only the VCS stamp differs. That needs the buildinfo in §6. |
| agent.mjs | 76cac355 → e530ff3b | functional, host-services-gated | +4 lines: `hostServicesFile` (ENCLAVE_HOST_SERVICES_FILE, unset = null) and the `hostServiceRefusal` hook, which reads `host.platformPolicy?.serviceRefusal?.()`. |
| network-enroll.mjs | a9729786 → a51e9de8 | functional, host-services-gated | Opt-in file, `hostServicesPolicy` and app-less write. With no opt-in file and no `hostServicesPolicy`, `want` is identical, so the config bytes and restarts don't change. `challengeReplica` stays byte-for-byte. |
| host-service-transport.mjs | de5bb98a → 43e7c115 | functional, host-services-gated | F's lifecycle 6c38c048: cancel/withdraw on stop, `hostServiceLifecycle`. |
| host-policy-gate-config.mjs, platform-host-policy-config.mjs, host-policy-carrier-gate.mjs | absent → acc321cb, 6422d065, 7d24a332 | new | Carrier/gate config. 6422d065 holds the **R2 DigitalOcean list**. |
| host-admission.bundle.mjs | 6bef372d → 3438cdf2 | **REGRESSION R2** | The only delta is `PRODUCTION_MIRRORS` going from `[]` to the 4 DigitalOcean URLs (byte proof). |
| lease-gas-runtime.bundle.mjs | 159108d1 → 008cdca1 | **rename-only** | Same length. Every differing byte is in a ≤2-character minified name with unchanged token boundaries, and none is quoted. Its 2 changed inputs are not reachable from the entry, which imports only `parseDeploymentRecord` (unchanged). (`receipts/bundles/lease-gas-runtime-rename-check.json`) |
| relay/snp-verify.mjs | 10520dd2 → 93f9e9d2 | comment-only | The installed file predates the 2026-10-21 repository rewrite. Applying that rewrite's transform to the installed bytes gives F's 93f9e9d2 exactly; the only change is one provider name in a line-2 comment. (Wording edited 09:40Z for publication so the rewritten literal is not reintroduced; the raw diff stays local.) |
| host.mjs, chain.mjs, host-service-names, rpc-identity | = | identical | |

`lease-gas-owner.mjs` (ddd3ba9b → 92cc322a) and `route-record.mjs` (be3bfab7 → 9ba9f6d3) are functional as source, but they
don't reach the lease-gas runtime bundle:
- lease-gas-owner adds the rate-0 vs paid cadence for owner cost display;
- route-record serves a record's still-qualified routes instead of refusing the whole record.

They matter only where those modules run unbundled.

**Lease gas, heartbeats and liveness.** The keeper's host.mjs and chain.mjs are identical, and the runtime bundle is
rename-only. The default app path changes in only two ways:
- **privacy-agent:** `start()` re-checks `closed` before creating its intervals (a stop-during-startup fix).
- **wg-circuit-runtime:** it takes an optional `signal` (null by default). `live()` checks after each await, and a rejected
  wait now clears its timer. Grant withdrawal applies only to `service` circuits.

## 3. privacy-agent bundle: input delta

**w0, installed manifest vs F's blobs** (`receipts/w0/privacy-agent-installed-inputs-vs-F.json`): of the 1938 installed
inputs, 1926 are identical in F, including every node_modules file.
- **Identical via symlink (2):** F commits `relay/net-guard.mjs` and `relay/vbs-runtime.mjs` as git symlinks, and their
  targets equal the installed bytes.
- **Absent from F (1):** `network/challenge-front-declaration.mjs` 67e67a01.
- **Changed (9):**

| Input | Installed → F | Reading |
|---|---|---|
| network/challenge-replica-host.mjs | 9c3e4d10 → 52e02b93 | **R1:** 32fecf5's 33433eb3 plus the carrier-gate refactor |
| network/enclave-network-host.mjs | 2c1b84aa → 7c2f8af5 | **R1:** 7c2f8af5 is exactly 32fecf5's, with no managed-front check and no `superviseChallengeReplica` |
| network/privacy-agent.mjs | a3f08aca → 5e56973d | host-services gate and lifecycle, app-less mode, start/stop timer fix (§2) |
| network/host-service-transport.mjs | de5bb98a → 43e7c115 | F lifecycle |
| network/host-services/runner.mjs | 7d63742b → 3902ca36 | optional shared `snapshot` for the carrier verifier (additive) |
| network/policy-carriers.mjs | ce06bc1d → 05d5fb6c | refactor: the definitions moved to host-policy-gate-config.mjs unchanged (same CARRIER_MIRROR, MAX_CARRIERS, regex and body) |
| network/wg-circuit-runtime.mjs | ff778443 → 77b842e8 | cancellation, timer clearing, service-grant withdrawal |
| relay/secrets-release.mjs | be22b456 → 1cb53b64 | relay release-status read by id with a 4 s bound; this is a relay HTTP handler compiled into the bundle |
| relay/snp-verify.mjs | 10520dd2 → 93f9e9d2 | comment |

**w1, F's rebuild** (`tools/w1-inputs.sh`, attempt 3, queue 512, 09:19:50–55Z, peak 262 MiB, rc 0):
- **Reproduced F's own artifact hashes exactly:** privacy-agent 6480ca9b, worker dcac53cb, ingress c952dce4.
- **Manifests:** `receipts/w1/*.inputs.json`. The normalized delta is `receipts/w1/w1-normalized-delta.json`. `w1-delta.json`
  lists every package as removed+added only because of the installed `../../enclave/` path labels.
- **privacy-agent:** 1938 → 1940 inputs. 1926 have the same bytes and the same 9 are changed as in w0; every node_modules
  file is byte-identical.
  - **Relabelled:** `relay/net-guard.mjs` → `net-guard.mjs`, the same bytes.
  - **Removed:** `challenge-front-declaration.mjs` (R1), and `relay/vbs-runtime.mjs`. The latter is deduplicated, not lost:
    the installed tree bundled a real copy of `isolation/contract/runtime.mjs` (both 8bb7f911) as a second module, while F's
    symlink leaves one module.
  - **Added:**
    - `network/entries/privacy-agent.mjs` and `network/main-guard.mjs`, F 427780bbc's bundle entry;
    - `host-policy-gate-config.mjs` and `host-policy-carrier-gate.mjs`.

**main-guard fixes a latent defect in the installed cfb (source reading, not run).**
- Inside one bundle, `import.meta.url` is the bundle's own URL. So `network/host-services/runner.mjs`'s main-script check
  (installed bundle line 62983) is true when the agent runs.
- The installed `challenge-replica-host.mjs:384` reaches it with `await import('./host-services/runner.mjs')` whenever
  `challengeReplica.hostPolicy.carriers` is set. The runner's command line would then run inside the agent: usage, then
  `process.exit(2)`. F's commit comment records exactly this failure.
- It is dormant today, because no challengeReplica is configured.
- **Consequences:**
  - Do not configure a challengeReplica with carriers on cfb69370.
  - The port must keep F's main-guard entry. Porting onto F does that automatically.
- **Default path:** `process.argv[1]` now reads `<path> (enclave bundle entry)` to every bundled module, and the daemon
  starts from `mainScript()`. The other argv[1] checks in the bundle (vbs-tcglog, avf-verify, vbs-verify, vbs-credential)
  only match their own file names, so they stay false, as before.

## 4. Bounded semantic test

**t1** (`tools/t1-challenge.sh`, queue 768, 09:21:57–09:23:52Z, peak 379 MiB, rc 0). It runs in a throwaway clone of F
4106c311 with F's real node_modules, in a private network namespace with the ssh stubs. TAP output is in `receipts/t1/`.
- **V0** = F exactly.
- **V1** = F plus the port: challenge-replica-host 93bc81fd, enclave-network-host 2c1b84aa, challenge-front-declaration 67e67a01.
- **Tests:** the installed tree's own reviewed tests (revision2/network-tree, root retry review 21/21) and F's suites that
  import the ported modules.

| Suite | V0: F 4106c311 | V1: F + port |
|---|---|---|
| installed `challenge-replica-supervise` 1dbd849d (root's lifecycle fixes) | **fails to load** (F exports no `superviseChallengeReplica`) | **8/8** |
| installed `challenge-front-managed` a6918e69 | **fails to load** (no `challenge-front-declaration.mjs`) | **5/5** |
| installed `challenge-replica-host` f9918823 | 7/9: **#8 fails** (a missing release takes the network host down) and #9 e2e fails (env) | 8/9: #9 e2e fails (env) |
| F's `challenge-replica-host` 5ef2b89c | 8/9: #9 e2e fails (env) | 7/9: #8 fails **by design** and #9 e2e fails (env) |
| F's `enclave-network-host-canary`, `privacy-agent-lifecycle`, `network-policy-outage`, `local-byo-config` | 5/5, 3/3, 1/1, 3/3 | 5/5, 3/3, 1/1, 3/3 |

**Reading:**
- F lacks the installed lifecycle and front, as the source diff says.
- The port restores them without breaking F's suites that touch these modules.
- **F's test #8 encodes the pre-fix regression.** It asserts that a missing replica release REJECTS `createNetworkHost`.
  The installed test asserts the fix: the failure is logged and the network keeps running (g4-config-independent-review C3).
  The names are identical, and F never changed this test from 32fecf5's 5ef2b89c, so the 3-way merge (installed, 32fecf5,
  F) is exactly the installed f9918823. **The port must take the installed test.**
- **The e2e (#9) failure is my environment gap, not a code result.** The test builds the replica release from the
  gitignored `relay/network-runtime.bundle.mjs` (ENOENT), and t1 did not run `relay/build-network.mjs` first. t2 closes it.

**t2** (`tools/t2-challenge-e2e.sh`, queue 768, 09:24:58–09:25:18Z, peak 419 MiB, rc 0). It runs `relay/build-network.mjs`
first (network-runtime bundle dced8384); TAP output is in `receipts/t2/`.
- **V0:** F with its own test: **9/9**, including e2e.
- **V1:** the port with the installed test f9918823: **9/9**, including e2e. The e2e builds the replica release, starts it
  through the host package and serves a Shield guest push through its HTTPS front, with refusals and restart.

**The port therefore:**
- passes the installed lifecycle (8/8) and managed-front (5/5) suites;
- passes the installed host suite (9/9) with F's carrier-gate tests (#5–#7) inside it;
- passes F's 4 neighbouring suites (12/12).

**Not run here:**
- root's extra "ban during indexing" case (`root-retry-review/admin-index.out`; I have no separate test file for it);
- F's full regression.

Both are F's to run on the composed tree.

## 5. Exact files for the eventual final package (F/A compose; root activates)

**Challenge, fixing R1.** Proposals are in `receipts/proposals/challenge/`; they are not F's tree.
- `network/challenge-replica-host.mjs` = `git merge-file`, with ours = installed 9c3e4d10, base = 32fecf5's 33433eb3 and
  theirs = F 52e02b93.
  - The merge is clean, giving **93bc81fd**.
  - It keeps F's `host-policy-gate-config` / `host-policy-carrier-gate` imports and exports a superset of F's names
    (adding `superviseChallengeReplica`, `frontDeclaration`, `writeDeclaration`, FRONT_PROOF_PATH and the DECLARATION_* constants).
- `network/enclave-network-host.mjs` = installed **2c1b84aa** as is (F's file is 32fecf5's byte for byte, so there is
  nothing to merge).
- `network/challenge-front-declaration.mjs` = installed **67e67a01** (new to F).
- Tests, all from revision2/network-tree: `test/challenge-replica-supervise.test.mjs` 1dbd849d (new to F),
  `test/challenge-front-managed.test.mjs` a6918e69 (new to F), and `test/challenge-replica-host.test.mjs` **f9918823
  REPLACING F's 5ef2b89c**. F's test #8 asserts the pre-fix behavior; f9918823 is also the clean 3-way merge result.

**Admission, fixing R2.**
- Set `network/platform-host-policy-config.mjs` `PRODUCTION_MIRRORS = Object.freeze([])`, as A df8fbafa has it.
- Then rebuild `windows/node/host-admission.bundle.mjs`. Before A's port, F's tree with that one line changed should rebuild
  to the installed 6bef372d. That is a checkable reproduction target. After A's port, the expected bundle is A-lineage
  (A's own is 28778491).

**A's Windows consumers (P1).** Trial 3-way merges onto F 4106c311 (base = A-before 71448f63, theirs = A df8fbafa) are in
`receipts/proposals/a-port/`:
- **Clean (8):** windows/node agent.mjs, chain.mjs, host.mjs, network-enroll.mjs, host-identity.mjs, host-onchain.mjs,
  session-api-auth.mjs, and network/verified-read-client.mjs (new).
  - chain.mjs and host.mjs merge onto the KEEPER's 3e9fae03 / ea0f6b8a, not onto A's pre-keeper base.
- **New to F (take whole):** windows/node/chain-reader.mjs, network/host-admission-node.mjs and network/verified-chain.mjs.
  - F's compose-a already TAKEs verified-chain.mjs and lease-reader.mjs.
- **Doc conflict only:** windows/node/node-config.example.cmd.
- **Rebuild:** host-admission.bundle.mjs.

These merges are textual only. F/A must run their suites.

**Unchanged and to keep exact:** host.mjs/chain.mjs (keeper), host-service-names, rpc-identity, host-service-ingress
c952dce4, and the 75 identical closure files. The worker and the lease-gas runtime may ship as F's label- or rename-only
bytes, or stay installed. Shipping them is not a functional change.

## 6. Missing for a root read-only capture (no SSH from here; after the NucBox experiment is released)

1. **Go buildinfo of the installed `network\enclave-wg.exe` cbaf8313 and `network\enclave-circuit-firewall.exe` 78daec71:**
   vcs.revision, vcs.time, vcs.modified, the Go version and the -trimpath flag (the `go version -m` fields), or a copy of
   the two files.
   - It decides whether firewall 78daec71 → 243a371c is stamp-only.
   - It decides whether the installed enclave-wg lacks `udpIngress`.
2. **sha256 of the installed `control\windows\node\fetch-cid.py`, `install-node.cmd`, `package.json` and
   `package-lock.json`**, against F's 729e6a0c, 28633765, 2192d65f and f8964448.
3. **The loaded-process identity of the privacy agent and node agent.** R3 is on-disk only. Root's 08:31:42Z
   config-state receipt names a node.exe PID 2140, started 08:31:31Z after the 08:29 reboot. Its script hash is not
   recorded.

## 7. Residual gates (native kernel / loaded process / config)

- **Loaded process vs disk.** R3 hashes are files on disk. Before any swap, root must bind each running privacy-agent and
  node-agent process to its script sha (as in the G4 preflight).
- **Config.** bd18bbe3: 17 apps, no hostServices, no hostServicesPolicy, no challengeReplica, verifier not selected, 5 RPCs.
  - The structure does not prove what is active in memory.
  - `ENCLAVE_HOST_SERVICES_FILE` is unset per R3. Absence of a file at any path is unproven.
  - With these absent, R1 is dormant but still a regression: the lifecycle fixes are needed the moment `challengeReplica`
    is configured.
- **Native kernel.** Three bugcheck 0xEF reboots: 08:03:43Z, 08:07:55Z and 08:29:19Z.
  - These happened during root's experiment, per the human's confirmation. They are not to be read as a hardware fault or
    as caused by this package.
  - Any native swap waits for the experiment's release and a fresh boot or authority verification.
- **Owner-only hold.** Root's offline review: `scope()` downgrades to owner-only when the admission window is absent after
  reboot. This delta changes neither host.mjs nor the delegation semantics (host.mjs is identical), so it neither causes
  nor fixes that hold.
- **Go executables.** A swap of enclave-wg restarts circuits (20 copies per circuit directory on minipc). It needs its own
  bounded window and the existing [privacy] egress evidence per app.

## 8. Handoff

`D-WINDOWS-UPGRADE-DELTA.txt` (sha256 e3933722…) was written at 09:26Z as a NEW file. It went outside their git trees,
and nothing of theirs was edited:
- `host-service-rpc-closure/` (F)
- `rpc-priority/` (A)

The same copy is in this directory. Items:
- **F1:** challenge port plus tests (required).
- **F2:** admission mirrors `[]` plus rebuild (required).
- **F3/A:** A's Windows consumers port.
- the proven non-regressions;
- the Go and file capture list for root.

**Recheck at 09:26:33Z against F's newest commit 14d1e4954** (host-service-rpc-closure, after bb86e0ceb and 30123801a): R1
and R2 are still present.
- challenge-replica-host 52e02b93, enclave-network-host 7c2f8af5, no challenge-front-declaration, test 5ef2b89c;
- `PRODUCTION_MIRRORS` still lists the DigitalOcean fronts; admission bundle 3438cdf2.

## Attempts (logs retained under rawlogs/)

- **w1, F bundle rebuild with input manifests.**
  - Attempt 1 (`w1-inputs.*`) and attempt 2 (`w1-inputs-2.*`, with F's recipe of removing packages and running
    build-network first) both rebuilt privacy-agent as b259a83b, not F's 6480ca9b.
  - The cause was symlinked node_modules: esbuild records the out-of-tree real path.
  - Attempt 2's output is kept as `rawlogs/w1-attempt2-output/privacy-agent.b259a83b.mjs`.
  - An earlier aborted run's logs are in `rawlogs/aborted-w1-attempt1/`.
  - Attempt 3 (`w1-inputs-3.*`) uses real `cp -a` copies. It reproduced all 3 F hashes and passed, after 26 queue
    "not started" retries (08:40–09:19Z, logged in `w1-inputs-3.retries`).
- **t1** reported the e2e test as failing. That was my missing `relay/build-network.mjs` step, which t2 adds; t1's logs are
  kept.
- **My own errors, corrected:**
  - The first w0 pass mapped `../../enclave/network/node_modules` to the root node_modules and reported 190 false absences.
    It was rerun with the correct mapping, so its receipt holds only the corrected result.
  - Two diffs (`*.SYMLINK-TEXT-NOT-CONTENT.diff`) compared against git symlink text. They are kept and labelled.
