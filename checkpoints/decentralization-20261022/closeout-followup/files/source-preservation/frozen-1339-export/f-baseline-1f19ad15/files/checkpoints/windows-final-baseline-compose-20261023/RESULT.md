# Windows final baseline compose (on immutable 14d1e4954)

Written 2026-10-23 ~12:20Z.

**Scope:** source and offline tests only.
- No SSH, production, host/VM restarts, wallet, funding, signing, contract changes, cache allocation or push.
- No Go or Linux image was rebuilt or swapped.
- Every build, test and scan went through `work/claude-test-queue.py` (16 GiB floor, caps ≤1408 MiB).
- **Commits:** SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com>, author and committer, hooks on.
- **Deployment:** this is a candidate for root. Root decides deployment once the NucBox experiment (08:41Z hold) is released.

## Final pins

**Source:** `candidate` branch `final/windows-baseline`, head **30339303bedcb5cb9a6d8fe2e495f381f05d7c74** (tree da9c417b). There are three commits on 14d1e4954:

| Commit | What |
|---|---|
| 6fd9a787d | **R1:** installed challenge lifecycle and managed front; installed tests |
| c335c76cf | **R2:** `PRODUCTION_MIRRORS = []`; tests name the former fleet explicitly |
| 30339303b | **A:** Windows/shared consumers of df8fbafae plus the c3a61fd1a ERC-1271 owner fix; bundle entry; bundles |

**Node files (committed, `--check` clean):**

| File | sha256 |
|---|---|
| windows/node/host-admission.bundle.mjs | `c987a877b7ae96f4abe54348973be7e833691e2f3bb3d1f8add1ba4bab6d6453` |
| metal/guest/host-policy.bundle.mjs | `e65cc948e6fee59d8115da1cae5a194765736f546ab72f5fc6642c222c33921e` |
| windows/node/lease-gas-runtime.bundle.mjs | `008cdca1…` (unchanged from F) |

- The metal bundle is a **Linux image input**. It differs from 14d1's a19af83c and has NOT been imaged.
- The node deploy closure is derived by `windows/node/deploy-files.mjs` from agent.mjs: **88 files**, listed in `node-deploy-files.sha256`.
- **JS release artifacts:** `artifacts-js-final.sha256`, 22 files. They are byte-identical between this tree and an independent `--local --no-hardlinks` clone. Go was denied by a stub (rc 97); no `.exe` was produced.

Key JS artifact pins:

| Artifact | sha256 |
|---|---|
| dist/privacy-agent.mjs | `a5135e984981d4f42edd3276a4c4f7bccc495995b9a0efd0fb95833d4c3807a5` |
| dist/windows-circuit-worker.mjs | `dcac53cb…` (= F; D: label-only vs installed) |
| dist/host-service-ingress.mjs | `c952dce4…` (= installed) |
| relay/network-runtime.bundle.mjs | `4045d206fb7319027d066d11c375258ad3ff7da1a248dacacdfa2f9a5b433cde` |
| consumers/privacy-agent.mjs | `0ec2bcd9…` |

Package pins:

| Package | Bundle | package.json |
|---|---|---|
| policy-mirror | 8c4d762f | 1d476a04 |
| route-dns | 75f58671 | 7691d39a |
| bootstrap-replica | 1e45e75f | 7732950b |
| directory-replica | 45dc2321 | e9cff328 |
| credit-vault-submitter | 2a4de6d5 | a22cd7a8 |

- **Unchanged vs 14d1:** bootstrap, directory and credit-vault (all 3), checker, enclave-directory, ingress, worker, reconcile-apps, wg-qualify.
- **Changed vs 14d1, each with a named cause:**
  - mirrors `[]`: policy-mirror, route-dns and wg-provider (wg-provider's only diff is the mirrors line);
  - R1 and A code: the privacy-agent dist and consumer, dns, provider and the network-runtime bundle.
- **No former DigitalOcean fleet address in any artifact, bundle or closure file.** The one textual hit is a pre-existing source *comment* in the privacy-agent egress replay code (a 2026-10-18 TLS incident note). It is not a mirror or an authority.

## What was composed and how (all git-object merges; inputs hash-checked)

**R1, challenge lifecycle and managed front.** This follows D's recorded proposals exactly:
- `network/challenge-replica-host.mjs` is a 3-way merge (installed 9c3e4d10, base 32fecf5, theirs 14d1). The result 93bc81fd is byte-equal to D's proposal.
- `enclave-network-host.mjs` is the installed 2c1b84aa.
- `challenge-front-declaration.mjs` is installed 67e67a01.
- The installed tests are carried: `challenge-replica-host` f9918823 (replacing F's #8, which asserted the pre-fix behaviour), `challenge-replica-supervise` 1dbd849d and `challenge-front-managed` a6918e69.
- F's main-guard entry is kept: the bundle has `(enclave bundle entry)`. Both `superviseChallengeReplica` and `FRONT_PROOF_PATH` are in the shipped privacy-agent bundle.

**R2, default mirrors.**
- `PRODUCTION_MIRRORS = Object.freeze([])`. 4106c311 with only this line changed rebuilds the admission bundle to the **installed 6bef372d byte-for-byte** (job b1).
- No DigitalOcean authority is restored anywhere.

**A's consumers (from immutable e32dd607b55b9c6afd605482a4bc31c9d30528d6; lineage 71448f63b → df8fbafae → c3a61fd1a → e32dd607b):**
- **Windows files:** agent, chain, host, network-enroll, host-identity, host-onchain and session-api-auth are 3-way merges onto the installed keeper lineage. All are byte-equal to D's a-port proposals.
  - The delta 14d1→final of each of the seven is **exactly A's 71448→df8 added/removed lines**; host, host-identity, host-onchain and session-api-auth have identical patch-ids.
  - The keeper host ea0f6b8a and chain 3e9fae03 are therefore preserved line for line. `windows-node-lease-renewal-keeper` passes.
- **Taken whole from df8:** chain-reader, host-admission-node, host-service-gate-carriers, verified-read-client and their tests.
- **`enclave-network-host.mjs`:** c3a61fd1a's owner-verification change is merged onto the **installed** source, not A's copy. The final file is installed plus that one change. It is in the bundle as `const authenticated = pins || leaseReader?.authority === "verifier"`.
- **Bundle entry:** `scripts/build-host-admission.mjs` now uses `network/host-admission-node.mjs`, as in A. The merged chain and chain-reader import the verified-read exports from the bundle.
- **Left to A (CLI-only):**
  - e32dd607b's cli/ and mcp/ changes;
  - its opt-in `pinnedClient` `allowCall` in `network/verified-chain.mjs`. That file stays df8's e55f0359, and `allowCall` is absent from the bundle.
- **Modes and fallbacks:**
  - Verifier mode exists only under the explicit `ENCLAVE_CHAIN_AUTHORITY=verifier`.
  - Unset, the legacy provider quorum is unchanged. Admission status reports `chainAuthority: 'provider-quorum'`.
  - No public-RPC fallback was added.
- **Parity test:** `test/node-policy-carriers.test.mjs` is the installed carrier package's own test (4e949c09). Its parity case now tolerates exactly one additive status field, `runtime.chainAuthority` (from 14d1/A 437d6ced6), and asserts that the field equals `'provider-quorum'`. Everything else must equal the installed bundle 6bef372d.

## Tests (offline, private loopback-only namespace, ssh/scp/sftp denial stubs)

| Job | What | Candidate | Base 14d1 (classification) |
|---|---|---|---|
| J1 | Challenge supervise, front, host; enclave-network-host consumers; privacy-agent ×3; network-owner-verifier; windows-chain-authority; carriers; session-api-auth; admission ×3; platform-host-policy | 98/108 pass. The 1 fail and 9 skips were environment errors, fixed in J1b and rerun in J4 | — |
| J1b | Parity vs the reproduced installed bundle; session-api-auth with Foundry | session-api-auth 14/14; parity failed on the additive field above, then adapted | — |
| J2 | All 90 `windows-*` suites, Foundry on PATH (enrollment, wallet, keeper cadence, deploy files, host identity, platform policy…) | 610/613 pass; 1 skip ("c2bc3cc6 object unavailable") | The 2 failures are pre-existing (below) |
| J3 | Shared consumers (authority pins, verified-chain ×2, policy callsites, native/site policy, mirrors, metal launcher, management ×5, carriers, cold starts, verifier roles, lifecycle, transport, stage, placement); parity; host-admission-runtime against the **shipped** bundle | Group 2: 69/71 (2 skips need `STAGE_TAR`). **Parity 14/14, shipped-bundle 7/7, strict** | site-independent-management (below) |
| J4 | After the bundle rebuild (verified-chain → df8): the J1 set plus 15 Windows enrollment/keeper/wallet/policy/identity suites | **87/87; 125/126** | lease-readiness (below) |
| J5 | `windows-verifier.e2e` on the committed head, real reth v2.8.0 --dev (canonical trie) plus A's patched Helios (hash-checked cc962e2b / 8cdd1f35). Scratch worktree overlaid with A's e32d **test rig only** (rig, witness-gateway, op-head-relay, op-commitment), never committed | **6/6, strict, peak 736 MiB** | — |

J5 covers:
- Positive reads equal the chain.
- **Admin AddressBook migration is followed, and an outsider cannot repoint it.**
- Endpoint ownership.
- A **terminated session is refused** on the next request.
- **Tampered or missing witnesses and a stale head refuse, with zero calls to BASE_RPCS.**
- The **network agent's SessionVault (ERC-1271) owner** verifies through the verifier, and book migration and stale/missing proofs refuse it. EOA is unchanged.

The challenge suites cover:
- retry (a transient refusal and a missing release recover);
- admin recheck (refusal while indexing, and a fresh refusal at readiness);
- cancellation (a start in progress, and a pending ready health response);
- the network never being delayed by the challenge service;
- the managed front (5/5);
- the host e2e.

**Baseline failures. All are identical on base 14d1 and none is dismissed as a source result:**
- `windows-node-lease-readiness` #1: "PWSH is required". No pwsh is installed, and no new toolchain is allowed.
- `windows-release-journal` #4: "cannot be written" expects a write refusal. It runs as namespace root, which bypasses chmod.
- `site-independent-management`:
  - **nondeterministic on both trees.** The candidate gave 9/10 and 2/10; base 14d1 gave **2/10 and 9/10**. The 409 "not_current_runner" cascade follows setup.
  - The Safe-passkey case fails "fetch failed" on every run on both.
  - The only module it imports that changed is session-api-auth, whose legacy path (`snapshot = null`) is unchanged.
- **Not run:** the 3 J1 privacy-agent suites (above) were not run again after the bundle change; J4 reran them. pwsh-only checks; anything Windows-native.

**Scans:** `scan-crypto-keys --range 14d1e4954..HEAD` 0, gitleaks over 3 commits: no leaks.

## Activation delta vs installed (R3 08:01Z)

Today's config has no hostServices, hostServicesPolicy, challengeReplica or ENCLAVE_CHAIN_AUTHORITY.

| Installed file | Installed → final | Class |
|---|---|---|
| network\privacy-agent.mjs | cfb69370 → **a5135e98** | Functional. Contents:<br>• F's host-services-gated code, lifecycle and main-guard;<br>• the installed challenge lifecycle and front kept (R1 closed);<br>• the ERC-1271 owner path, active only under the verifier authority. |
| network\windows-circuit-worker.mjs | 13ce44f1 → dcac53cb | Label-only (D) |
| network\host-service-ingress.mjs | c952dce4 = | Identical |
| network\enclave-wg.exe, enclave-circuit-firewall.exe | cbaf8313, 78daec71 | **KEEP installed.** Not rebuilt or swapped. The Go provenance gate stays open (D §6). |
| control\windows\node\agent.mjs | 76cac355 → **5305be6a** | F hooks plus A wiring (env-gated) |
| control\windows\node\network-enroll.mjs | a9729786 → **4e2f5e91** | F opt-in plus A |
| control\windows\node\host.mjs | ea0f6b8a → **16e466e8** | Keeper plus A's startup reader (quorum default) |
| control\windows\node\chain.mjs | 3e9fae03 → **c31399b8** | Keeper plus A's verifier consumers (quorum default) |
| control\network\host-service-transport.mjs | de5bb98a → 43e7c115 | F lifecycle |
| host-service-names, rpc-identity | = | Identical |
| windows\node\host-admission.bundle.mjs | 6bef372d → **c987a877** | A-lineage entry. The carriers wrapper is a no-op unless `ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS` is set. Mirrors stay `[]`. Parity is proven against 6bef372d. |
| windows\node\lease-gas-runtime.bundle.mjs | 159108d1 → 008cdca1 | Rename-only (D). It may stay installed. |

- **New node files** relative to F's 87-file closure (75 of them identical to installed, per D): `windows/node/chain-reader.mjs` (907fd1c8).
- **Other files changed vs F:** platform-host-policy-config a7c1d8bf, host-identity 827b30d3, session-api-auth 48cf482c, plus the five above.
- **For root:**
  - Activating this closure does not switch the chain authority.
  - Verifier mode needs an operator-chosen local verifier and an explicit env, and is not proposed here.
  - The current production anchor is unanchored, which authorizes nothing.

## Preserved gates, and limits

- **Gates (D §6/§7):** these are root's operational gates. This compose neither closes nor relaxes them, and it adds no signature requirement.
  - **Loaded process:** bind each running privacy-agent and node-agent to its script sha before any swap.
  - **Native kernel:** three 0xEF bugchecks during the experiment. Any native swap waits for its release and a fresh boot or authority check.
  - **Go provenance:** the installed enclave-wg cbaf8313 and firewall 78daec71 buildinfo is unknown, so both stay installed.
  - **Four files without a baseline record:** fetch-cid.py, install-node.cmd, package.json and package-lock.json are unchanged from F (729e6a0c, 28633765, 2192d65f, f8964448). They still need root's read-only hash capture.
  - **Owner-only hold:** host.mjs changes only at the startup chain reader (A's `chainReader`, quorum by default). `scope()` and the delegation semantics are untouched, so this neither causes nor fixes that hold.
- **No Go or Linux image was rebuilt.** The metal bundle change is recorded for the next Linux image decision only.
- **No production-independence claim:**
  - Default mode is still the provider quorum.
  - J5 uses a test-signed head on a local chain, as Node on Linux, not a Windows host.
- **Not done here:** Windows-native execution, a live install, the TLS patch, and CLI/MCP integration (A's).

## TLS worker integration point (`tls-integrate.sh <full sha>`)

- **How it works:** the script fetches objects only, never the worker's uncommitted tree. It then:
  1. requires the series to be based on 4106c311;
  2. requires it to touch only `windows/node/{apptls,secrets,origin-request}.mjs`, its test and RESULT files;
  3. trial-merges it with `git merge-tree`.
- **Today's result** for 1957ff23425f6ee2e0abe2604bdc9735987eff47: a **clean** merge onto 30339303, tree 56cc36af. Its four files are untouched on this lineage since 4106c311, so the patch applies byte-identically.
  - No bundle input changes.
  - The node closure gains origin-request.mjs through apptls/secrets.
- **Next steps** for the worker's FINAL sha:
  1. Cherry-pick its code commits.
  2. Run `windows-node-origin-request` plus the J2 set.
  3. Re-derive `node-deploy-files.sha256`.

## Files here

- **Scripts:** `setup.sh`, `compose.sh`, `commit.sh` (+ `msgs/`), `build-admission*.sh`, `build-js.sh`, `scan.sh`, `tls-integrate.sh`.
- **Jobs:** `j1b.sh`, `j2.sh`, `j3.sh`, `j3d.sh`, `j4.sh`, `j5.sh`.
- **Logs:** `logs/`.
- **Inputs:** `installed/` (+ `installed.sha256`).
- **Pins:** `artifacts-js-final.sha256`, `node-deploy-files.{txt,sha256}`.
