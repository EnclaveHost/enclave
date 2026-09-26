# NucBox hv-node rollout: from "nothing serving" to the node from main on the custom type-1 path

Prepared by enclave-5d (node/runtime owner), 2026-09-26, for enclave-d1's review; b4 is copied (it is independently
reviewing windows/node). **d1 executes every box step; 63 (or e3) the nan steps. 5d runs nothing on the box.**

Approved by enclave-87 with Steven's authority (2026-09-26):
- M3, the permanent host prerequisites;
- deploying the new node on the NucBox, the one that doesn't need the legacy engine;
- `RELAY_HVNODE_ATTACH` on.

Steven's standing rules (DIRECTION.md), which bind every step:
- the custom type-1 path only;
- Secure Boot stays ON;
- the legacy `ee-engine` is never restored, signed or test-signed;
- `host_excluded=no`;
- nothing is deleted.

## Start state (checked by step 1)
- Secure Boot ON (boot 68 and later); test signing OFF.
- The legacy node is retired. Its task `\EnclaveWindowsNode` has been **Disabled since 2026-09-25 15:56:32Z** (backup
  `C:\Users\claude\d1-legacy-task-backup-20260925-155629\`). It stays disabled and is **never deleted**, and its
  directory `C:\Users\claude\vbs\node\` is only READ.
- **v40 staged** at `C:\Users\claude\vbs-like\pkg\15f39ae4d1fab954\`, manifest `nucbox-ownguest-40.json` sha256
  `15f39ae4d1fab954f61a5195a6f8cf59c8bf8786000b95ddbb4e47aaa9efd1df`. It holds:
  - the manager at e3acc392 (= isolation-manager 76af33b4);
  - the IGVM `b7ba7731…` (VBS digest 56FBB27F…; initrd 1539d5b2);
  - the launcher `vbslike-host.exe 435717de…`;
  - `guest/runtime.json ccadb38a…`.
- The node's chain identity: the registry entry `https://api.enclave.host/t/nucbox-k11` (id 0xd497d065…) has operator
  `0x389C3f030a209D04D026228D2D053fEB75DbadcA` (its key is ON the box) and payout wallet `0x29479Bf0…647C`. Its gas
  is 0.001457 ETH (GAS.md).
- The relay: U7 is live on all 3 relays; `RELAY_HVNODE_ATTACH` is unset; an hv-node row is never eligible on main.

## End state
- **The node from main runs the hv backend**:
  - a new task `\EnclaveHvNode` runs `windows/node/agent.mjs` from `C:\Users\claude\vbs-like\hvnode\<c8>\`, with the
    engine retired (`ENCLAVE_ENGINE` unset);
  - `APPS=1`, owner-only;
  - it attaches with `windows-hv-node/v1` evidence (EK-rooted TPM quote, Secure Boot, no test signing);
  - its apps are Hyper-V partitions through the manager.
- **The v40 manager**: a new task `\EnclaveHvManager` runs the package's `control\windows\vbslike\manager\main.mjs`
  on 127.0.0.1:8091, with its data plane on 127.0.0.1:8092.
- **M3 applied permanently**: `AllowFirmwareLoadFromFile=1` and the hv_sock 9001 GUID, with the prior state recorded.
- **The relay**: `RELAY_HVNODE_ATTACH=1` on nan, on top of e3's owner-only rule (B).
- **Served owners** = {the node's operator} ∪ {owners of valid signed delegations} (enclave-87's final decision). The
  payout wallet never authorizes; it only says where earnings go.
- `host_excluded=no` and T0-hv (monitor-signed) throughout. This is **functional serving, not proven isolated
  hosting**.

## Prerequisites: landed before d1 starts (the procedure refuses to start without them)
| # | what | owner | why |
|---|---|---|---|
| P1 | **N1 on main**: windows/node-hv-fixes (4fcb1740 APPROVED by 5d; bf re-reviewing). The restart route needs the OWNER's session (401/404), then this box's live lease and the served-owner set (409) | b4 | an unauthenticated restart of any deployment (REVIEW-NODE.md N1) |
| P2 | **the owner set on main** (same branch): `ownerSet()` = {operator} ∪ {valid delegations read from `NODE_DIR\delegations\*.json`}. payoutWallet and OWNER_WALLET authorize nothing. It gates claiming, the scan, the sweep's hold and restart. Still to add: `availability.isolation` (5d's ask; test 1 needs it) | b4 | 87's decision; bf's blockers |
| P3 | **e3's B deployed on nan**: an hv-node row may carry a deployment only for a served owner (tenantRoute, /t, certs, SNI daemons); secrets stay refused | e3 | on main an hv-node row is never eligible, so nothing would route to it |
| P4 | N2 resolved by B (87) | e3 | |
| P5 | the node commit `<c>` = main at or after P1+P2; the CLI commit `<cc>` = one carrying `deploy --isolation` (isolation/app-config-m1 06bdcbdf or later). The stage ships whole trees plus the CHECKED import closure (it now includes `host-delegation.mjs`), so it does not rely on `windows/node/sync.sh`'s list (b4 is fixing that list) | 5d | the stage's inputs |

The node deployed is **main with N1 in it**. **The node HOLDS every lease whose owner is neither the operator nor a
delegator** (intended, 87): it does not renew it, respawn it or release it early, so the lease lapses on the ledger's
clock. So:
- test 1 needs nothing extra;
- test 2 needs our agent-key delegation file in `hvnode\state\delegations\`;
- Steven's apps need his Trezor-signed delegation there BEFORE any of them is moved to the NucBox.

The v41 fixes (the front console guard 0475ae50 and domexec's app-stdio discard) are NOT needed for this first
NON-SENSITIVE test on v40. The rollout counts as DONE only on v41 (87).

## Steps
Each step says who runs it and where. "box" means d1, elevated PowerShell on the NucBox:
`powershell -ExecutionPolicy Bypass -File <script>` from `C:\Users\claude\vbs-like\hvnode\stage\`.

**0. Stage (workstation, 5d or d1).** `windows/node/ops/hv-node-rollout/stage-hvnode.sh <c> <cc> <outdir>` builds:
- `hvnode-<c8>.tar.gz`: the node's import closure (24 files, checked) plus the lockfile, relay fixtures and fetcher,
  in the repo layout;
- `cli-<cc8>.tar.gz`;
- their MANIFESTs.

It prints every sha256, and the archives are deterministic (two runs are identical). d1 copies the archives, the
manifests and this directory's scripts to `C:\Users\claude\vbs-like\hvnode\stage\`.

**1. Preflight (box, read-only).** `hvnode-preflight.ps1 -Pkg C:\Users\claude\vbs-like\pkg\15f39ae4d1fab954`. It
checks:
- Secure Boot, test signing;
- the legacy task Disabled, and no legacy node or ee-host running;
- the new tasks absent;
- the Hyper-V features and vmms;
- the package pins and the two box files (`hyperv.psm1 17ca4352…`, `type1.vmgs 4f051697…`);
- node ≥ 22, python, npm;
- the legacy operator and proof keys PRESENT (never printed);
- `tpmattest.exe`'s sha256, which step 4 pins;
- ports 8091, 8092 and 9600 free.

It reports M3's current state. Any FAIL stops the rollout.

**2. M3 (box).** `hvnode-m3.ps1 -Apply`, which:
- records the prior state (`hvnode\m3-prior-state.json`);
- sets `AllowFirmwareLoadFromFile=1` (DWORD);
- registers `GuestCommunicationServices\00002329-facb-11e6-bd58-64006a7986d3` (port 9001).

It needs no reboot. `-Status` shows it; `-Revert` restores exactly the recorded prior state. enclave-53's v41 carries
the same as packaged scripts; don't mix the two on one box.

**3. Gas (workstation, read).** The operator must hold ≥ 0.0005 ETH, with no stuck nonce (GAS.md): 0.001457 ETH
now. Test 1's app is CHARGED (its owner, the operator, is not the payout wallet), so its lease checkpoints every 5 min:
~0.00027 ETH/day with heartbeats. enclave-87: the soak is MULTI-HOUR. Test 1 runs as the soak target for 12 h after
acceptance and then stops (about 0.00014 ETH), and there is no ask to Steven. If the balance falls below 0.0005 ETH, top it
up from our operator gas tank (approved).

**4. Install (box).** `hvnode-install.ps1 -Pkg … -NodeArchive … -NodeArchiveSha256 … -NodeManifest …
-NodeManifestSha256 … -LockSha256 … -TpmattestSha256 …`. It:
- checks every input against its pin;
- expands the tree to `hvnode\<c8>\` and checks EVERY file against the manifest (the exact count);
- runs `npm ci --omit=dev --ignore-scripts` from the pinned lockfile, and checks ws, viem and tweetnacl at the locked
  versions;
- COPIES the operator and proof keys (and `node-transport.key` if present) into `hvnode\state\` (byte-identical, never
  overwriting a differing file, never printed; ACL SYSTEM + Administrators only);
- copies `tpmattest.exe` into `hvnode\bin\` at its pin;
- writes the configuration: `manager-config.cmd` (the package's `managerEnv` resolved), `node-config.cmd`, and
  `run-manager.cmd` / `run-node.cmd`;
- registers the two NEW tasks `\EnclaveHvManager` (boot +30 s) and `\EnclaveHvNode` (boot +90 s): SYSTEM, highest,
  NO run-time limit, restart ×3. It does NOT start them;
- leaves `\EnclaveWindowsNode` untouched: it refuses unless the task is present and Disabled, before and after.

The node configuration (no key in it; `NODE_DIR` holds them):

| setting | value | why |
|---|---|---|
| backend opt-in | `ENCLAVE_ISOLATION_MANAGER=http://127.0.0.1:8091` | sets the backend `hyperv-partition-per-app` (host.mjs:91, 171-174) |
| manager handle | `ENCLAVE_ISOLATION_DATA_ADDR=127.0.0.1:8092`, `ENCLAVE_ISOLATION_RUNTIME_ID=ccadb38a…` | the data plane, and the runtime the manager serves (it must equal its `catalog.runtimeId`, or every spawn is refused) |
| claim policy | `CLAIM_SCOPE=owner-only` (forced on an engine-retired node anyway); the served owners = {operator} ∪ {delegations} (P2) | `OWNER_WALLET` is NOT set: it no longer authorizes |
| relay | `RELAY_URL=wss://api.enclave.host/v1/fleet-tunnel`, `PUBLIC_URL=https://api.enclave.host/t/nucbox-k11`, `NODE_NAME=nucbox-k11` | the registered endpoint; the id is keccak(PUBLIC_URL) |
| identity | `NODE_DIR=…\hvnode\state` (the operator and proof keys copied from the legacy node), `TPMATTEST_EXE=…\hvnode\bin\tpmattest.exe` | the same registry entry and operator; no re-registration |
| loopback | `LOCAL_HTTP_PORT=9600` | acceptance, and the hosting tray (last step) |
| off | `ENCLAVE_ENGINE`, `ENCLAVE_ISOLATION_RESPAWN`, `CLAIM_LEGACY`, `OWNER_WALLET` | the legacy engine is retired; respawn is Steven's call (default off) |

**5. The relay switch (nan, 63 or e3), after P3.** `sh relay-hvnode-attach-on.sh <sha256 of B's api-relay.js>`, as
root on nan. It:
- refuses unless the running api-relay.js is B's, `hvnode-verify.mjs` and `fixtures/tpm-roots.pem` are deployed, and
  the env is 600/root with a final newline and no hv-node line;
- appends ONE line `RELAY_HVNODE_ATTACH=1` (verified +1, old lines identical);
- restarts once;
- checks: the relay active, `/enclaves` 200, no hv-node error at start.

The scripts write all scratch in a private 0700 directory.

**6. Start (box).** `Start-ScheduledTask -TaskName EnclaveHvManager`. Wait for
`curl.exe -s http://127.0.0.1:8091/health` to read `"canStart":true`, then `Start-ScheduledTask -TaskName
EnclaveHvNode`. The logs are `hvnode\logs\manager.log` and `node.log`.

**7. Acceptance, box half (read-only).** `hvnode-accept.ps1 -Commit <c>`:
- A1: Secure Boot ON; the legacy task present and Disabled.
- A2: both tasks Running; one agent and one manager process; run-node.cmd names tree `<c8>`.
- A3: the manager's `canStart`, backend `hyperv-partition-per-app`, `catalog.runtimeId` = the node's, and
  `boundary.hostExcluded` never true.
- A4: node `/availability` shows role `windows-hv-node`, teeCpu null, claimScope owner-only, operator 0x389C…,
  `owners` = [the operator] (plus each delegation once added), registered, `gasRenewalsLeft > 200`, relay verdict tier `hv-node`, and (P2) `isolation`; `/v1/health` shows engine
  retired.
- A5: node.log never starts ee-host, and has the attach lines.
- A6: M3 applied and recorded.

**7r. Acceptance, relay/public half (workstation, read-only).** `hvnode-accept-remote.sh [<deployment id>]`:
- R1: `/enclaves` has the `nucbox-k11` row: mode `hv-node`, `hvNode.hostExcluded:false`, a recent `verifiedAt`, and
  the omission `platform-firmware-unpinned`;
- R2 (**b4's live check**): `POST https://api.enclave.host/t/nucbox-k11/v1/deployments/<id>/restart` with NO session
  is REFUSED (503 today; 401/403/409 once P1 and P3 are live), never 200;
- R2b (b4's check with a real STRANGER): a throwaway wallet logs in to the node (its own SIWE session) and asks to
  restart the test deployment. It must be refused: 404 (not the owner), or 401 if the relay strips the credential.
  Never 200;
- R3: gas ≥ 0.0005 ETH (below it, top up from the operator gas tank), latest nonce = pending.
- After acceptance, test 1 soaks for **12 h** (the DONE soak, enclave-87), then stops: `enclave refund <id>` by the
  operator on the box, the same way it was created.

**8. Test deployments, in 87's order** (each non-sensitive; each passes 7 and 7r before the next):
1. **Operator-owned.** An app owned by the operator `0x389C…` itself, at the normal rate (a few cents, approved):
   - fund the operator with 0.10 USDC from the agent wallet (workstation: `usdc-to-operator.mjs`, key from
     `ETH_AGENT_WALLET` only);
   - then, on the box: `hvnode-test1.ps1 -CliArchive … -CliArchiveSha256 …` deploys hello-world 1.0.4
     (`catalog://0x5356e8bd…/4`, bundle/1: 128 MB, no ports) with `--isolation hyperv-partition-per-app --cpu 0.01
     --fund 0.05`, signed by the operator key read from `hvnode\state\operator.key` into that one process's
     environment and cleared after;
   - PASS when:
     - the ledger's runner = 0xd497d065… with a live lease;
     - `hvnode-accept.ps1 -DeploymentId <id>` A7 holds (the manager's VM is running, T0-hv, hostExcluded not
       claimed);
     - `hvnode-accept-remote.sh <id>` R4 holds: `https://<id8>.app.enclave.host/` answers 200 "Hello" over the
       guest's TLS, whose key sha256 = A7's `transportKeySha256`.
     The certificate is the guest's self-signed one until M4 lands (the check uses `-k` and compares the key).
2. **Agent-wallet delegation.** A deployment owned by the agent wallet `0x2947…`, served through a delegation signed
   by OUR agent key. The format is enclave-e3's `enclave-host-delegation-v1` (owner/operator/box/chain/registry/
   expires ≤ 90 days; the relay refuses > 180). The file `{message, signature}` goes into `hvnode\state\delegations\`
   (ACL SYSTEM + Administrators). The node re-reads the directory every tick, so no restart is needed; its
   `/availability` `owners` then lists `0x2947…`. PASS as in test 1, plus: with the file removed, the node stops serving
   that owner at the next tick (held, not renewed).
3. **Steven's apps**, later, via his Trezor-signed delegation. Only on v41 (the console guard + domexec fixes), after
   S5 and the release decision.

**9. Last: hosting caps + tray (slot for enclave-87's hosting tray).** The hosting-caps file (the CPU and GPU share
caps, 0..1, default 1.0, JSON under `hvnode\state\`), the admin token's ACL (SYSTEM + Administrators), and the tray
install. Written by the tray's author when it lands; reviewed by 5d as node owner. Lowering a cap never evicts.

## Rollback
- **Node + manager (box):** `hvnode-rollback.ps1 [-Unregister]`. It:
  - disables and ends `\EnclaveHvNode` first (no new lease; held leases lapse on the ledger's clock);
  - destroys every manager VM THROUGH the manager (`DELETE /vms/<id>`), then disables and ends `\EnclaveHvManager`;
  - turns off and removes any leftover manager-tagged VM (guest-state copies kept);
  - with `-Unregister`, exports each task's XML and then removes it.
  It never enables or deletes `\EnclaveWindowsNode`: the legacy node is retired, so rollback means "nothing serving",
  not "the old node back". Nothing under `hvnode\` is deleted.
- **M3 (box):** `hvnode-m3.ps1 -Revert` restores the recorded prior value (or its absence), removes the GUID only if
  `-Apply` added it, and verifies both.
- **Relay (nan):** `sh relay-hvnode-attach-off.sh` removes exactly its one line (line-wise, other lines untouched) and
  restarts. The node's next attach is refused by name.
- **A node upgrade later:** stage a new `<c8>` and re-run the install with `-Replace` (a new tree beside the old one,
  and the same state\). Roll back by pointing `run-node.cmd` at the previous tree.

## What this does NOT claim
- **Not isolated hosting.** T0-hv, monitor-signed, `host_excluded=no`. The node's `attestedCapacity()` is always false,
  and meetsIsolationContract is false for every tier, hence owner-only.
- **The first test runs on v40.** v40 carries the front logging leak and domexec's app-stdio leak (both fixed on
  isolation/front-console-guard 0475ae50, going into v41). So its apps are non-sensitive, and DONE is on v41.
- **TLS.** An isolated app serves the guest's self-signed certificate until M4 relays its CSR to the platform
  certificate service (5d, with e3's relay half).

## Files (this directory)
| file | runs where | what |
|---|---|---|
| ROLLOUT.md | | this procedure |
| GAS.md | | the operator's balance and costs, read 2026-09-26 00:01:45Z |
| stage-hvnode.sh | workstation | the deterministic node and CLI archives, plus manifests |
| hvnode-preflight.ps1 | box | step 1, read-only |
| hvnode-m3.ps1 | box | step 2, -Status / -Apply / -Revert |
| hvnode-install.ps1 | box | step 4 |
| hvnode-accept.ps1 | box | step 7, read-only |
| hvnode-accept-remote.sh | workstation | step 7r, read-only |
| usdc-to-operator.mjs, hvnode-test1.ps1 | workstation, box | step 8.1 |
| hvnode-rollback.ps1 | box | rollback |
| relay-hvnode-attach-on.sh / -off.sh | nan | steps 5 / rollback (line-wise, tested with a harness) |
