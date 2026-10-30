# Consumer final readiness. Verdict: no uncovered consumer code gap at 64156dcd that can be fixed without a KVM API change. Two features stay blocked under blackout: the relay writer authority, and custody v2 (see `logs/claude-finalized-writer-integration.md`). The exact-HEAD Windows 6/6 run: my attempt ABORTED (no result); root-owned `root-consumer-head-windows-1150` is pending

- **Stage:** `consumer-final-readiness-stage/`. It contains one job only, no patch.
- **Source pin:** `rpc-final-candidate-20261026/tree` HEAD `64156dcd91ff1e769e74f9c26a846be19254c716`. Verified; clean except the untracked node_modules symlinks.
- **Not done:** no SSH, no live access, no network, no commits, no wallet requests, no source or frozen-stage edits.

## 1. Root's 0452 blackout e2e failures were wrong inputs, not consumer bugs (and root has since re-qualified)
**Root `logs/root-canonical-final-0452.out` ran repo 10cdf913b with genesis `cc045d9d` (`reth-dev-8453-genesis.json`).** That genesis has no EIP-2935 history contract; `-2935.json` (`99138899`) has it.

| Test | Result at 0452 | What happened | Re-qualified |
|---|---|---|---|
| `chain-consumer-closure.e2e` | 0/7 | All 7 are `hookFailed` at `before` (`'needs the EIP-2935 genesis'`, test line 101); no consumer code ran | Root `logs/root-consumer-genesis-0453.out` with the 2935 genesis: **rc 0, 7/7, 0 skip**, peak 1204 MiB (receipt `logs/root-consumer-genesis-20261026T050042Z/`) |
| `windows-verifier.e2e` | 0/6 | `need proofs: {checker, roots}`, a fixture/helper API mismatch | Root `windows-proof` r1 3/6, r2 5/6, r3 only the stale-head case 1/1. The fixes were committed as HEAD 64156dcd. **No single full 6/6 run at HEAD existed**, so that is the one verification gap → §3 |

**The closure 7/7 carries to HEAD by identity.** `git diff --name-only 10cdf913b 64156dcd9` touches 6 files:
- `cli/enclave.mjs` (independent-CLI secrets only);
- 3 CLI tests;
- `test/helpers/windows-chain-driver.mjs`;
- `test/windows-verifier.e2e.test.mjs`.

None of them is loaded by `chain-consumer-closure.e2e`. That test imports `cli-independent-rig`, `move-release-rig` and `verifier-runtime`, which import only `network/rpc-runtime.mjs`, `network/gossip-head-source.mjs` and viem. `supervisor.js` only *mentions* `cli/enclave.mjs` in a comment (line 314). I did not re-run the closure test: its measured peak (1204 MiB) exceeds my 1024 MiB queue cap, and a duplicate run adds nothing.

**What that closure e2e actually proves:**
- **Setup:** the real `supervisor.js` with `ENCLAVE_CHAIN_AUTHORITY=verifier`, under a preload that records and refuses every non-loopback origin. `BASE_RPCS` points at a counting provider that must never be asked, and the real Helios/witness-check/listener sit on the reth canonical-trie rig.
- **Claims:** a claim, adoption on the verified receipt, and renewal.
- **Proof-source outage:** new claims are refused, the running app keeps serving, a restart during the outage keeps it, and claims resume when proofs return.
- **Lost submission answer plus restart:** nothing is sent twice.
- **Administrative controls:** owner veto, admin delisting, and AddressBook migration all go through the verifier.
- **Controls:** a legacy positive control, and direct mode.

That is the blackout+restart harness the task asked for. It already exists, against the real consumer.

## 2. Source integration status (64156dcd survey)
- **Verifier available, opt-in, no public fallback once selected:**
  - supervisor; Windows node, owner CLI and agent; lease relay (`TX_BACKEND` required);
  - api-relay, store, sessions, MCP; relay LeaseReader;
  - dns-relay, fleet and challenge replica; directory; platform policy gate; custodian v1; standalone MCP.
- **Refusals:** a mixed config is refused, and an invalid selection is a refusing authority.
- **Signing vs reads:** under the verifier, submissions, nonces and fees go only to `ENCLAVE_CHAIN_TX_BACKEND` (loopback/private, head-bound). Success is shown only by a receipt the verifier checks. Legacy wallets sign over the same public lists they read from.
- **Endpoint trust vs authority:**
  - the site's `own-rpc` mode and the legacy quorums are endpoint trust;
  - the `l1-finalized-derived` tier is the KVM worktree's derived reader (`enclave-deployment-lifecycle`, `network/derived-reader/*`), which is not wired to any consumer. Not duplicated here;
  - every consumer above uses the helios opstack verifier, the unsafe tier.
- **Known non-code limits (not fixed here; owners noted):**
  - **Paid wg-provider in local `verifier` mode** still requires and uses `cfg.rpc` for paid-path reads and sends (`network/wg-provider/attested-authority.mjs:82-84`, `main.mjs:84,163`). Only `attested-verifier` mode removes it. This is provider/runtime, **KVM/root-owned, not duplicated.** Cutover must use `attested-verifier` or accept public reads on the paid path.
  - **Custodian v2:** public-only by design and refused under the verifier, so it stays fail-closed.
  - **Site:** browser reads are endpoint trust only.
  - **Windows egress probes:** contact public origins for connectivity only.
  - **`lease-relay-migration-check.mjs`:** has no verifier mode (an ops tool).

## 3. Exact-HEAD qualification (the one gap closed here)
- **Job:** `consumer-final-readiness-stage/jobs/head-windows-verifier-e2e.sh`, run as `bash jobs/q-exit-status.sh claude-consumer-head-windows-e2e 1024 unshare -Urn bash …`.
- **Inputs:** root's verified 10cdf repo copy, with every tracked file replaced by `git archive 64156dcd9` and checked with `tar -d`, plus root's pinned runtime-bin and the 2935 genesis.
- **Scope:** the full `windows-verifier.e2e` with no name filter; it must be 6/6 with 0 skips.
- **Result: ABORTED, no result.** My CLI exited and the background job vanished with it.
  - Root verified that no queue, test, reth, helios or listener PIDs remained.
  - `test.tap` holds only the TAP header, and no `.rc` exists. **This is neither a PASS nor a running job.**
  - The partial receipt `logs/claude-consumer-head-windows-e2e.out` and the stage's `runs/head-windows-*` are kept as-is.
- **Now root-owned and pending:** `root-consumer-head-windows-1150` (1024 queue, the same exact-HEAD 6-test job). I have not restarted it and will not run a duplicate.

## 4. Current production ≠ source (cutover items, from `live-consumer-inventory-20261026`)
See the checklist below.

## Root cutover checklist (order; each step reversible by restoring the previous env/config)
0. **Preconditions:**
   - the Base holder is synced and its own coverage gate has passed;
   - the local verifier runtime (`helios 8250f08a`, `witness-check 4fe0cd3b`, `listener 9ca75047`) is running on loopback on each host;
   - an own tx backend is reachable (loopback/private).
   Without these, keep the legacy quorums; verifier mode refuses rather than falling back.
1. **NUCBOX_K11 Windows node (`agent.mjs` pid 4716, legacy `chain.mjs`, `BASE_RPCS`):**
   - deploy the 64156dcd Windows build;
   - set `ENCLAVE_CHAIN_AUTHORITY=verifier`, `ENCLAVE_CHAIN_VERIFIER=<loopback>` and `ENCLAVE_CHAIN_TX_BACKEND`;
   - remove `BASE_RPCS` (a mixed config exits);
   - expect `'provider fallback (BASE_RPCS)'` to no longer appear in the log.
2. **Lease relay (pid 4552, `LEASE_RELAY_RPCS`):** switch to verifier + `TX_BACKEND` and remove `LEASE_RELAY_RPCS`/`QUORUM`. Run `lease-relay-migration-check.mjs` *before* the switch (it is quorum-only).
3. **Relay/api/mcp host behind the `enclave-control-tunnel` (from `4.15.13.178`):**
   - first resolve which host serves `127.0.0.1:30443/30080` (unresolved in the inventory);
   - then set the verifier env and remove `BASE_RPC`/`NETWORK_CHAIN_RPCS`/`SECRETS_RELEASE_CATALOG_RPCS`;
   - note that under the verifier, secrets-release lease generation is refused (`writer_authority_unproven`). Apps whose config names `ENCLAVE_WRITER_AUTHORITY` then depend on the guest's measured public quorum, so under blackout they do not start. This is a **blocked feature**; the boundary and the KVM requests are in `logs/claude-finalized-writer-integration.md`.
4. **dns-relay/fleet/challenge replica, directory, platform policy gate:** set the verifier env and remove `BASE_RPC`/`APP_CHALLENGE_RPCS`/`*_SHIELD_RPCS`/`config.rpc`/`PRODUCTION_RPCS`.
5. **Enclave supervisors:** use `planDirectBoot` with a bound `chainVerifier`, or relay mode with the verifier env. Qualified by the closure e2e (§1).
6. **Fronts ×4 (`enclave-network-provider` `native-recovery-464cad3`, `provider-pinned-8b37c37.json` rpc = mainnet.base.org/publicnode/drpc):** provider/runtime cutover is **KVM-owned**. Use `attested-verifier` mode; local `verifier` mode still reads/sends paid-path state over `cfg.rpc`.
7. **Custody:** v1 → `CUSTODY_CHAIN_SOURCE=verifier`. v2 stays refused (fail-closed); lease consumers HOLD as now.
8. **Blackout acceptance on each host after the switch:** stop the host's public egress (or point the legacy vars at a counting sink). Then confirm:
   - claims/renewals/reads still succeed through the verifier;
   - a verifier outage refuses new actions while running apps keep serving;
   - a restart during the outage keeps them.
   This is the same matrix the closure e2e proves offline. **Grep or socket sampling alone is not acceptance.**
9. **Rollback:** restore the previous env (legacy quorum lists). There is no implicit fallback in either direction.
