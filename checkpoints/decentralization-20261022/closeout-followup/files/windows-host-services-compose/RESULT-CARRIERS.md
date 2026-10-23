# Policy carriers for the privacy agent's host-service gate (RESULT-CARRIERS, 2026-10-23)

**Status.** Source only, in the isolated candidate. Nothing is deployed, signed, pushed or published.
**All evidence below is from offline FIXTURES**, not from deployed provider independence (§6).

## 1. Commits and patches

| what | value |
|---|---|
| commit | `candidate/` branch `compose/host-services`: `427780bb` → **`0757085e5b78ed38efc11920fb3cf4a25d7dfc4d`** |
| author / committer | SteveDeFacto |
| origin / push | none / nothing pushed |
| patch | `host-services-carriers.patch` = `git diff --binary 427780bb 0757085e`, sha256 `7e0b7ef5247ee0e65502e8d1bc1b35df84809379bec58f0b46e9b3cab3a98410` |
| size | 12 files, +465/−56 |
| scans (exactly those 12 files) | `.githooks/scan-crypto-keys.py --files`: exit 0; `gitleaks dir --config .gitleaks.toml` on a staged copy: no leaks (`carriers/gitleaks-carriers.json` = `[]`) |
| earlier lineage | unchanged: `d7f520bf` (composition) → `427780bb` (cold start, RESULT-COLD.md) → `0757085e` |

## 2. What changed

**The privacy agent can take an explicit policy block.** `enclaveNetwork.hostServicesPolicy`, validated by
`network/host-policy-gate-config.mjs` `hostServicesPolicyConfig`:
- `policy`: `"production"`, `"off"`, or an explicit `{book, hostOwnership, mirrors, …}`;
- `mirrors?`;
- `rpcs?`: 2 to 8 distinct providers, the rpc-identity rule;
- `carriers?`: `{ importDir?, policyMirrorStateDir?, peers? }`.

**How the gate is built from it.** `network/host-policy-carrier-gate.mjs` builds the UNCHANGED gate
(`host-service-gate.mjs` → `host-policy-runtime.mjs`, A's core: not modified). It uses the integrated runner's own carrier
fetch (`host-services/runner.mjs policyCarrierFetch` → `policy-carriers.mjs`), so there is no second carrier
implementation.

**The carriers** supply bytes, never authority:

| carrier | source | notes |
|---|---|---|
| `importDir` | the operator's import, from any channel | works fully offline |
| `policyMirrorStateDir` | this host's policy-mirror role store, read from DISK | the role need not run or be admitted for its own prerequisite |
| `peers` | other hosts' policy mirrors | over the network |

Every candidate is checked twice:
1. **By `freshVerifier`, before the gate sees it:** the digest asked for, and the book's CURRENT owner signing it at a fresh
   agreed block.
2. **Again by the gate:** the anchored digest, the owner, the sequence high-water (rollback refused), then bans and
   allowlist.

**Without the block, behaviour is exactly as at 427780bb.** The gate is then built from the process environment, with the
production default for the production book. Admin anchors, AddressBook migration (the book's current owner decides at each
fresh block), bans and allowlist, unknown/refusal semantics, the first-admit requirement and "no mode switch when apps
join or leave" are all the unchanged gate's and the 427780bb agent's.

**One implementation of the shared pieces.** `host-policy-gate-config.mjs` is dependency-free and holds:
- `CARRIER_MIRROR`, `MAX_CARRIERS`, `validateCarrierBases`; `policy-carriers.mjs` re-exports them unchanged;
- `runnerPolicyShape` / `hostPolicyGateEnv`, moved out of `challenge-replica-host.mjs`, which re-exports
  `hostPolicyGateEnv`;
- the block validator.

The challenge replica's `startChallengeReplica` now uses the same `hostPolicyCarrierGate`. That is the same gate inputs as
before, and challenge-replica-host passes.

**Enrollment** (`windows/node/network-enroll.mjs`):
- `ENCLAVE_HOST_SERVICES_FILE` may carry `hostServicesPolicy`. It is copied byte for byte, never dropped, and reported
  every pass while the agent would refuse it.
- `appLessRefusal` judges the explicit block (validity, and whether the policy is on) before an app-less config is written.
- A non-production node book becomes eligible ONLY through an explicit block.
- The new imports are dependency-free, so the node's deploy closure stays clean (`windows-node-deploy-files` passes).

## 3. The composition seam for A (verified chain authority) — exact

A owns the verified chain authority, and nothing in `host-policy-runtime.mjs` changed. The seam is one optional parameter:

**`hostPolicyCarrierGate(h, { snapshot })`** (`network/host-policy-carrier-gate.mjs`). When `snapshot` (an agreed-block
authority with the `quorumSnapshot` shape) is given:
- **The gate:** `createHostPolicyRuntime(resolved, { snapshot, store, fetch, log })`, passed to `createHostServiceGate` as
  `runtime`.
- **The carriers:** `runner.mjs policyCarrierFetch(shape, { snapshot })` → `freshVerifier({ snapshot })`, so they use the
  SAME authority. The policy's raw RPC quorum is neither built nor required (`runner.mjs` lines 151–168, +3/−2).
- **Test:** "verifier seam" in `test/host-services-carriers.test.mjs`. The block's own RPCs are dead, and only the injected
  authority answers:
  - it admits, and the injected snapshot is used by both the gate and the carrier;
  - the control without it admits nothing.

**What A must do.** The privacy agent passes no `snapshot` today. To switch verifier mode on, A passes its verified snapshot
at the privacy-agent call site (`network/privacy-agent.mjs`, the `hostPolicyCarrierGate(...)` call in runPrivacy). In that
mode the carriers then never open a raw quorum. Note that the no-block path still builds its own quorum through
`createHostServiceGate` env; that is A's existing seam.

## 4. Tests (all through `claude-test-queue.py`; none counted on 98/99)

**New: `test/host-services-carriers.test.mjs`, 9 of 9 pass** (logs/k1, queue 768, peak 277 MiB).
- **The rig:** the REAL daemon (`node network/privacy-agent.mjs --config`) via the new `test/helpers/privacy-agent-rig.mjs`.
  Its preload refuses and logs every `*.enclave.host` lookup AND every connection to the four DO fronts.
- **The fixture:** `test/helpers/platform-policy-world.mjs`: loopback JSON-RPC and admin-signed documents. It gained a
  read-only `document(digest)` and `anchor(digest)` (re-anchoring an older document).
- **The policy** is production-shaped: its mirrors are exactly `PRODUCTION_MIRRORS` (the 4 fronts), all refused.

**What it shows:**
- **Shared helper:** one carrier origin and base rule; strict block validation (12 malformed cases).
- **Empty state, fleet refused:** the first authenticated admit comes from the imported carrier. The fronts WERE tried and
  refused at the socket; no enclave.host lookup happened.
- **Never admits:**
  - missing data;
  - a validly signed but UNANCHORED document;
  - another document under the anchored name;
  - substituted content under the real signature;
  - the anchored content signed by another key.

  The real anchored document then admits, without a restart.
- **Admin ban and allow arrive through the carrier:**
  - the ban stops host services ("banned by platform policy #2 (operator): abuse");
  - the unban, until carried, never lifts the ban;
  - carried, it restarts them;
  - an update nobody carries fails closed after the grace;
  - an anchored ROLLBACK to an older document (still carried) never admits.
- **First app added, last app removed** (SIGHUP): host services started once and were never touched. A restart with the
  chain unreadable is held (nothing restored from local state admits); after the fresh agreed block it starts.
- **Other carriers:** this host's policy-mirror store (on disk, the role not running) and an independent HTTP peer's mirror
  each carry the document.
- **A malformed block:**
  - an app-less agent refuses before anything binds, with the exact reason;
  - with apps, it refuses host services only and the apps keep running.
- **Verifier seam** (§3).
- **Enrollment:**
  - the file carries the block byte for byte;
  - a non-production book is eligible only through it;
  - invalid, "off" or unknown-quorum blocks write nothing and are reported.

**Failing control on the exact 427780bb source** (`carriers/control-427.test.mjs`, a detached worktree, logs/k2):
- **Setup:** the same fixture, with the signed document in an import directory and the policy given the only way 427780bb
  accepts one (its environment).
- **Result:** HELD for the whole run, never started: "this node has not loaded the policy the book anchors at this block".
  It tried the fronts, which were refused.

**The ten previously skipped packaged-role tests, closed.**
- **Built only what they need.** I compiled only the contract sources the rig and tests load, with the repo's `foundry.toml`
  (solc 0.8.35 from the local svm, `--offline -j 1`, the via-IR and runs restrictions unchanged), in four queued jobs (1024
  lane). `carriers/forge-subset.sh`; logs/f2, f3, f4, f6.

| job | sources | peak |
|---|---|---|
| f2 | EnclaveRegistry, PaymentRouter, PinnedSessionVaultFactory (+SessionVault) | 147 MiB |
| f3 | EnclaveDeployments | 110 MiB |
| f4 | EnclaveAppCatalog, SessionMocks, EnclaveDeployments.multicallValue.t.sol (MockFeed) | **323 MiB** |
| f6 | EnclaveAddressBook, EnclaveHostOwnership | 57 MiB |

- **Peak 323 MiB.** The ">1536 MiB" figure applies to a whole-repository `forge build`, NOT to this subset.
- **Provenance:** all 12 artifacts are from the current sources, solc `0.8.35+commit.47b9dedd` (`carriers/forge-subset-artifacts.sha256`).
  They are gitignored, not committed. No `work/enclave` artifact was reused: its Registry and ProofOfTime sources differ.
- **Baseline at 427780bb:** all 16 tests in `hosted-policy-cold-start`, `credit-vault-submitter-runner` and
  `hosted-service-placement` PASS (logs/f5 + f7). That is all 10 former skips, plus the 6 that already ran.
- **On 0757085e:** they pass again (logs/k5, below).

**Regression on 0757085e:**

| batch | content | lane | result |
|---|---|---|---|
| **A** (logs/k4) | 14 files: carriers, cold-start, host-service-transport, challenge-replica-host, network-consumer-bundle, privacy-agent ×3, Windows enroll ×2, deploy-files, platform-policy-world-blocks, hosted-services-stage, hosted-services-appstatic | 768, peak 657 MiB | 77: 74 pass, 1 fail, 2 skip |
| **B** (logs/k5) | cold-start, hosted-services-stage, hosted-policy-cold-start, credit-vault-submitter-runner, hosted-service-placement | 1024, with anvil, peak 596 MiB | **31: 29 pass, 0 fail, 2 skip** |

- **The batch-A failure:** an existing cold-start assertion pinned the opt-in file's error text, which this change extends
  to `{ hostServices, challengeReplica?, hostServicesPolicy? }`. I updated the expected string only (same check). The file
  passes in batch B.
- **The batch-A skips:** `hosted-services-stage` without anvil (it ran with anvil in batch B).
- **The batch-B skips:** `hosted-services-stage`'s two archive tests need `STAGE_TAR`, the stage-1 archive from
  `work/hosted-services-activation/build-stage.mjs`. That is a separate activation build, not built here.

**Composed with F's lifecycle commit (trial only):**
- **The composition:** F's `24fb993c4f9df6868ca06f210ab7b9abec10e502` (host-service-lifecycle/candidate, read-only fetch;
  F's directory not touched) plus my commit. It cherry-picks with **no conflict** → trial commit `1a78c6af` in my scratch
  worktree `tmp/compose-f`, not a deliverable.
- **Tests on the composed tree** (logs/k7, queue 768, peak 495 MiB): **56 tests, 56 pass, 0 fail, 0 skipped.** The 6 files: host-services-carriers, host-services-cold-start, host-service-transport, F's host-service-lifecycle, privacy-agent-lifecycle, challenge-replica-host.
- **This is composition evidence only.** F's lifecycle claims remain F's to verify.

## 5. Package closure, pins, reproducibility

**Packages, rebuilt with locked inputs** (logs/k3). Only `policy-mirror` changed: it imports `policy-carriers.mjs`, which
now imports the shared config module.

| package | manifest sha256 | change |
|---|---|---|
| policy-mirror | **`0cec04fa4588adeb796ab479bbbff1ec0f3587d9b56c8ce4ab7cd60265b0cf80`** (was `56bf5c46…`), bundle `117bdd23…` | NEW PIN |
| directory-replica | `4aa032fa…82d6` | unchanged |
| bootstrap-replica | `7732950b…dffc` | unchanged |
| route-dns | `d60eb763…27a7` | unchanged |
| credit-vault-submitter | `45b98921…e1a3` | unchanged |

**Lockfiles:** unchanged (`package-lock.json` `9ada1611…`, `relay/package-lock.json` `e5d896ba…`).

**Reproducibility** (`cold/repro.sh 0757085e`, logs/k6, queue 1024, peak 641 MiB). An independent `--local --no-hardlinks`
clone in another path against the candidate: **`REPRODUCIBLE: 25 artifacts byte-identical`** (`carriers/artifacts.sha256`).

**Changed artifacts vs 427780bb:**
- `dist/privacy-agent.mjs` → `e16cb651…`;
- `consumers/privacy-agent.mjs` → `9c162ddb…`;
- `policy-mirror` (above);
- the Go binaries: only their embedded VCS stamp (new commit) changed. Go sources did not change.

**Windows release closure.** Ship together:
- the new `privacy-agent.mjs` bundle;
- the node control files `network-enroll.mjs`, `network/host-policy-gate-config.mjs`, `network/rpc-identity.mjs` (pulled in by the
  config module, dependency-free) and `network/platform-host-policy-config.mjs`;
- the `policy-mirror` package (new pin).

The challenge replica path is inside the agent bundle.

## 6. Fixture vs deployed independence (honest limits)

- **The cold path works with all four DO fronts refused, IN A FIXTURE.** The chain is a loopback JSON-RPC fixture, and
  the admin is a test key.
- **Production still has no carrier data.** No production host has a `hostServicesPolicy` block, an import directory, a
  policy-mirror store or a peer.
- **Production chain reads are still public RPC providers.** The production default policy reads `PRODUCTION_RPCS`, so
  the RPC dependency is unchanged here (RPC-priority work is separate). The carriers remove only the DOCUMENT dependency on
  the fleet mirrors.
- **The persisted accepted policy** helps a restart only with a fresh agreed block (tested). It never admits on its own.
- **Not run:**
  - the Windows Shield/TPM branch of runPrivacy (Linux branch only);
  - Task Scheduler;
  - a real WireGuard exit;
  - `hosted-services-stage`'s two archive tests.
- **Stop safety is F's scope.** The pending start/stop race root found is not addressed here and must not be claimed from
  these tests.

## 7. Integration order and activation prerequisites (root-owned)

**Integration order:**
1. Compose `427780bb` → F's lifecycle commit (`24fb993c` or its final) → this commit (`0757085e`). The cherry-pick applies
   cleanly onto `24fb993c` (§4).
2. A's verified-authority mode later wires its snapshot at the privacy-agent call site (§3).
3. Re-diff `network/privacy-agent.mjs` around the gate construction (my hunk: imports +2; gate block lines 251–265) against
   F's final `judge()` and lifecycle hunks: they are adjacent, not overlapping, on 24fb993c.

**Build from a clean checkout:** `npm ci` from the lockfiles, then:
- `node relay/build-network.mjs`;
- `node scripts/build-host-service-packages.mjs` and `--check`;
- `node network/build.mjs`.

Pin the new `policy-mirror` manifest.

**Per host, to use carriers:**
1. Put the admin's signed `{document, signature}` for the anchored digest under `<importDir>/<digest>.json`, by any channel.
   Alternatively point `policyMirrorStateDir` at this host's policy-mirror store, or name peers.
2. Add `hostServicesPolicy` to the `ENCLAVE_HOST_SERVICES_FILE` opt-in. For production: `{ "policy": "production",
   "carriers": { "importDir": "C:\\ProgramData\\Enclave\\policy-import" } }`.
3. **The admin must publish each new anchored document to at least one carrier.** A host whose carriers lack the anchored
   document fails closed (held, or stopped after the grace).

**Rollback:**
- Remove `hostServicesPolicy` from the opt-in file and the config; the agent returns to the 427780bb behaviour.
- Restore the previous agent bundle and the `policy-mirror` pin.
- RESULT-COLD.md §8 still applies to app-less configs.
