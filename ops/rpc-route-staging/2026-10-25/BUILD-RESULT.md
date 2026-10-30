# Route composition: BUILD RESULT (2026-10-25, revision 2 after root review)

**Scope (root-authorized):** source composition, builds and targeted tests only.
- No live mutation, SSH, DNS, service, wallet, funds, key or private-config read.
- No commit and no push: root commits.
- Every build and test ran through `work/claude-test-queue.py`. The 16 GiB floor was unchanged; caps were 1408 / 1024.

## 1. Source (ready for root to commit; two parts)

| item | value |
|---|---|
| path | `work/rpc-production-final-20261025/route-source` (an owned `git clone --local --no-hardlinks`), branch `compose/rpc-route-history`, HEAD = base |
| base | `aff1dafdf6f2ed8fe9a425574f7c4fe4bd1c6fa4` (tree `f2d157cd…`) |
| **part A: history patch (INDEX-STAGED, preserved as before)** | a206cab4 patch `74775140…fba` → staged tree **`36bec82496938f2f6843f0fa84948041abbec8ab`**. Diff `route-source-aff1dafd..36bec824.diff`, sha256 `747751408d7d…fba`, byte-identical to the patch. 4 files, +452/-19 |
| **part B: test-only rig teardown fix (WORKING TREE, not staged)** | `test/helpers/cli-independent-rig.mjs` (blob `8369486e`), `test/hosted-policy-cold-start.test.mjs` (blob `d3643de6`), new `test/cli-independent-rig-teardown.test.mjs` (blob `02da000d`, untracked). Diff `route-source-rig-teardown-fix.diff`, sha256 `3268bc515f3a…3093` |
| tree A+B | **`5f36d932def70fada30485702b4b78673c223f0c`** (computed with a scratch index; the real index still holds only part A) |
| suggested commits | 1) part A: "compose: public-rpc history closure (a206cab4) on the HTTPS compose aff1dafd"; 2) part B: "test rig: an RPC origin forward cut off by rig.stop() is recorded, not an unhandled rejection". Author/committer SteveDeFacto; the repo's pre-commit scanner runs at commit |

`network/host-services/packages/` is an untracked build output, as in F's tree.

## 2. Build pins (unchanged; no rebuild needed for part B)

Part B touches test files only, and none of them is a package or bundle input. These pins come from `logs/build-r2.out`
and `ARTIFACTS.sha256`:
- **Reproducible:** the working tree and an independent `git archive 36bec824` export each regenerated the gitignored
  `relay/network-runtime.bundle.mjs` (`b2d7a17d…`) first. All 16 artifacts are byte-identical.
- **Recipe control:** the bundle recipe reproduces G3's runner `c3c7d9f6` and stage-tool `91cc8868`.
- **Admission bundles:** `--check` reports them current.

| artifact | sha256 | vs F aff1dafd build |
|---|---|---|
| public-rpc.package.json | **d631cae1a274ea487cdba88cde7d216a80495bcc6a85b99c88267b8f2d5bf186** (= a206cab4's) | changed (was 78f06b5b) |
| public-rpc.mjs | **24aabe4b6514c6e3a43b1659053ad6f278bbe01bb140004e92f4ff9c514a8c88** | changed |
| service-tls.package.json | **8afcd969bc676a39a39dba0c9d4708c9d70be39873f9d4a41ee68789a6ded727** | changed: its only differing input is public-rpc-config.mjs |
| service-tls.mjs | **feda13d354dbcca5e18c166ecec976d5c67b2c903573112b0a48d93f0ca93937** | changed |
| hs2/host-services-runner.mjs | **39ba68c8072d16fd5c1584612f323d83c95eec74814f2032c60e76fe36aabf15** | changed (was 8150a635) |
| hs2/stage-tool.mjs | **7c460cbc55d4748c9d3ad8068987eeb0133ecf1be3be4fb180c59480478c1831** | changed (was ddd78ec0) |
| bootstrap-replica, credit-vault-submitter, directory-replica, policy-mirror, route-dns | ARTIFACTS.sha256 | same |

## 3. The hosted-policy-cold-start unhandled rejection: cause, evidence, fix

**Symptom (r1, `logs/s3-lifecycle.03.out`):**
- all 5 tests passed;
- the file then failed with: `Test hook "before" at test/hosted-policy-cold-start.test.mjs:112:1 generated asynchronous
  activity after the test ended. This activity created the error "TypeError: fetch failed" ... unhandledRejection`;
- node printed no stack.

**Cause (the fixture):**
1. The `before` hook calls `startRig()` (`test/helpers/cli-independent-rig.mjs`), which creates the three JSON-RPC
   origin proxies. Their `http.createServer(async (req, res) => …)` handler forwards to anvil with `await fetch(rpc)`
   (line 159; line 156 for blackhole-send). It has no catch, and http ignores the handler's promise.
2. `rig.stop()` pops its cleanups last-in first-out. It closes the origins first: `closeAllConnections` ends the sockets
   at once, but a handler that has already started keeps running. It then SIGKILLs anvil.
3. A forward still in flight at that moment rejects with `TypeError: fetch failed` (`ECONNREFUSED` to anvil). That is an
   unhandled rejection in the async context of the hook that created the server: `before`.
4. The rejections in that context come only from these proxy handlers: the viem clients' requests are all awaited. It
   is timing-dependent: 1 failure in 4 route-source runs (r1 + r2), none in the 4 fixed runs of r3.

**Failing evidence (deterministic).**
- `test/cli-independent-rig-teardown.test.mjs` holds one forward in flight across `rig.stop()` by wrapping fetch for
  the anvil URL only, then releases it after anvil is gone.
- **Control run (r3) on the UNFIXED helper.** This is HEAD's blob `aff0109b`, copied to a temporary
  `test/helpers/cli-independent-rig.control-head.mjs` (removed afterwards) and selected with `RIG_MODULE`.
  - Result: FAIL 0/2 (`logs/r3-control-unfixed.00.out`).
  - Case 1 reproduces the exact error: `TypeError: fetch failed … at async Server.<anonymous>
    (…cli-independent-rig.control-head.mjs:159:19) { [cause]: Error: connect ECONNREFUSED 127.0.0.1:33221 }`.
  - Case 2 shows the unfixed origin also never answers a client whose forward failed: the client hung until the 200 s
    child timeout.

**Fix (part B, test-only; genuine errors are not swallowed).**
- `stop()` sets `stopping = true` first.
- Every failed forward is recorded in `rig.rpcFailures` as `{ i, stopping, error }` and answered 502 if the socket is
  still open.
- **Only** a failure with `stopping: true` (the rig's own teardown having killed the chain) is not rethrown.
- A failure at any other time is recorded **and rethrown**, so it stays the loud unhandled rejection it was before.
- The regression file's case 2 asserts exactly this, in a child process: `seen == ['fetch failed']`,
  `{ i: 1, stopping: false }`, client 502.
- `hosted-policy-cold-start` `after()` prints any teardown-cut forwards as evidence. None appeared in the r3 runs.

## 4. Tests

Each test file ran alone in the strict runner (`jobs/run-suite.py`): any skip, cancel or fail fails the suite.
- ssh/scp/sftp are replaced by denial stubs, proven first;
- the namespace is loopback-only;
- binaries are the pinned PINS.sha256 `69db0ff5…` set: reth v2.8.0, helios `cc962e2b`, witness-check `4fe0cd3b`;
- consumers are B `1ec87930…` and E dc2e5d74; CONTROL_PKG is `78f06b5b`/`b1e8f62e`.

| run | cap / peak | what | result |
|---|---|---|---|
| r1 | 1408 / 1044 MiB | s1 role/history/TLS: public-rpc 13, history E2E 6, service-tls 42, public-rpc-https 5 | **PASS 66/66** |
| | | s2 consumers: witness E2E 5, wallet E2E 3, browser 2 | **PASS 10/10** |
| | | s3 lifecycle (before the fix) | FAIL 57/58 (hosted-policy-cold-start file, §3) |
| r2 | 1024 / 583 MiB | build + reproducibility (§2); hosted-policy-cold-start ×3 on route-source, ×3 on F aff1dafd | build PASS; 6/6 runs PASS (classification only) |
| **r3** | **1408 / 653 MiB** | control on the unfixed helper | **FAIL as expected** (§3 evidence) |
| | | regression test, fixed | **PASS 2/2** |
| | | hosted-policy-cold-start ×3, fixed | **PASS 5/5 each** |
| | | **full lifecycle suite** (fixed): host-service-lifecycle 13, host-service-verifier-roles 4, host-service-transport 14, hosted-policy-cold-start 5, host-services-cold-start 12, host-services-carriers 9, rig-teardown 2 | **PASS 59/59, 0 skipped, 0 cancelled** |
| | | other users of the rig: public-rpc-https 5, hosted-service-placement 5 | **PASS 10/10** |

**Recipe failure propagation.**
- `jobs/r2.sh` used to end with `exit 0` even when the classification failed. It now exits with the classification's
  rc.
- `jobs/r3.sh` fails when any suite fails or when the control unexpectedly passes.
- `jobs/build.sh` fails on a non-reproducible build (exit 9) and runs its build pipelines under `pipefail`.
- `all.sh` and `tests.sh` already propagated.

**Not rerun after part B.** These suites did not change, and none of them uses the rig: s1 role/history/TLS, except
public-rpc-https, which was rerun (r3); and s2 consumers.

**Not run.**
- The other 20 rig users (cli-independent-*, mcp-*, site-publish, move-release-*, windows-verifier, …). The fix only
  changes what a failed forward does; nothing changes for a successful one.
- Pre-existing exclusions: service-index schema-4, hosted-services-stage (STAGE_TAR), privacy-agent suites.
- Windows and Go builds; mainnet-size block material; a public CA.

## 5. Staged configs (examples/)

- **Control CVM: `host-controller.chainVerifier.relay-mode.json`.**
  - The staged image `dist-rpc-ec56a70f1` is **relay mode**, not `--control direct`.
  - The member is host-level in the metal0 host controller's `config.json`. It travels through fw_cfg, and gsup
    re-checks it.
  - It is **not** the HOST_DATA-bound direct config: a direct launch refuses a host-level member
    (`metal/enclave-metal.mjs:263`).
  - Applying it is a guest relaunch with no rebuild; the measurement stays `c2442941…`.
- **`public-rpc.role.json`:**
  - node `http://127.0.0.1:28545/`;
  - perSecond 500 / burst 1000;
  - maxLogRange 5000;
  - block material 16 MiB, 4 in flight;
  - no rawTransactions.
- **Opt-in fragments:**
  - `service-tls.fragment.json`: orders held;
  - `host-services.agent.fragment.json`;
  - `exit-provider.hostServices.fragment.json`: DO exits stay bare transports.
- **Runner policy verifier:** `host-rpc-runtime.metal0.json` + `host-services-runner.policy-verifier.fragment.json` (§6).
- **Node payload: none.**
  - The LIVE **node-payload-v4** already configures `--rpc.forwarding-endpoint https://mainnet-sequencer.base.org`
    explicitly and disables transaction backup. Its authoritative source is ops `ddd47accb`.
  - Base is not running yet, so the route is **configured, not broadcast-proven**.
  - The earlier v3-derived forwarding patch is **OBSOLETE: DO NOT INSTALL**. It was moved to `OBSOLETE-DO-NOT-INSTALL/`,
    with a NOTICE, and the README's instruction to apply it is removed.

## 6. Host-local verifier for the runner's platform policy (no startup cycle)

The startup order is:
1. the node (`127.0.0.1:28545`);
2. a host-local `rpc-runtime` on metal0, with `proofSources.untrusted = ["http://127.0.0.1:28545/"]` only and the
   verifier on `127.0.0.1:28590`;
3. the runner with `chainAuthority: verifier` (`platformHostPolicyRpcs` removed: the runner refuses both at once);
4. public-rpc + service-tls;
5. the guest verifier (its proof source is the public `rpc-<b32>` name);
6. the supervisor.

The proof-source role never gates itself. No new code is needed: the runner accepts a loopback verifier, and
rpc-runtime accepts a loopback http proof source.

It fails closed:
- if the host verifier is down, the gate stops the role;
- the guest then has no fresh witness, and its reads refuse;
- nothing falls back to providers.

One node is one vote: both verifiers use the node as an untrusted witness, never as a quorum member.

## 7. Lease relay and other consumers

- **The app-funded lease relay must migrate.** Today it reads, simulates, broadcasts to every peer and takes receipts
  through `LEASE_RELAY_RPCS` public providers, and it has no verifier authority.
- **That migration is underway separately in `lease-relay-source`.** It is outside this stage's source. The requirement
  as found is recorded in `LEASE-RELAY-VERIFIER-MIGRATION.md`.
- **Every production consumer must eventually switch for the goal:**
  - relay/api-relay, fleet, Windows node, site, custody host, policy mirrors, browser profiles, and the lease relay;
  - this is not an optional ruling;
  - **this stage switches none of them.** Its boundary is the host-services role, the TLS/runner composition and staged
    examples for the metal0 control CVM and runner.

## 8. Remaining deployment requirements (root; none done)

1. Commit parts A and B. Pin the §2 packages and hs2 bundles into the metal0 host-services stage. Activate the runner
   and role files together with their config.
2. R0: the chain VM synced. R1: root confirms from v4 (ops `ddd47accb`) that the forwarding flag and the disabled tx
   backup are present. A route counts as broadcast-proven only after a send has a receipt the verifier checked.
3. Host-local rpc-runtime on metal0, wait for `ready.json`, then switch the runner to the verifier.
4. service-tls with orders approved by a separate bundle, ≥1 exit opted in, route-dns publication, then the external
   HTTPS probe.
5. A relay-mode canary guest with the host-level member, then the production control CVM relaunch.
6. The lease relay migration (`lease-relay-source`), then the remaining consumers' switches.
7. Live fields: `ROOT-LIVE-FIELDS.txt` (A6 and A8 resolved).
8. The Denim Helios re-pin before 2026-11-05 ~18:00Z.

**Caveats:**
- A forward is not inclusion.
- The pending nonce is only a hint.
- There is still one sequencer route.
- L1 forced inclusion is not app-funded (~3e9 of ~8e14 wei).
- An 1800 s lease against a 43200 s worst-case deposit delay means continuity is never guaranteed.
- The node serves proofs only for about the last hour (proof window 1800 blocks).
- slirp exposes `10.0.2.2:28545` to every user-net guest on metal0 (A5).
- Mainnet-size block material is untested; an oversize answer fails closed with 502.
