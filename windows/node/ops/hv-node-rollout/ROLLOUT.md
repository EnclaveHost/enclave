# NucBox hv-node rollout: from "nothing serving" to the node from main on the custom type-1 path

Prepared by enclave-5d (node/runtime owner), 2026-09-26, for enclave-d1's review; b4 is copied (it is independently
reviewing windows/node). **d1 executes every box step; 63 (or e3) the nan steps. 5d runs nothing on the box.**

Approved by enclave-87 with Steven's authority (2026-09-26):
- M3, the permanent host prerequisites;
- deploying the new node on the NucBox, the one that doesn't need the legacy engine;
- `RELAY_HVNODE_ATTACH` on.

**v2.2.1**: R2b's `nosession` is INFO, outside the tally (enclave-87's ruling); `-OwnerRestart` makes a new domain
key, so A7 and R4 are re-run after it, once (b4).

**v2.2** (on d1's v2.1.1 box-run fixes, bf43e358): P5 pinned to main 013deb51 with the stage's hashes; `-FundExisting`
(8.1); b4's F1 (A9: N1 checked on the NODE; R2/R2b are relay checks, and R2b's `nosession` is a FAIL), F2/F3 (what a
removed delegation, a transfer and a lapse do), F4 (A4 fails without `availability.isolation`), F5 (test 2's
prerequisites), F6 (the closure is 25 files).

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

**Box facts, read-only by enclave-d1 at 00:36Z (the pins v2 uses):**
- node.exe v24.16.0, npm present, `C:\Python314\python.exe` 3.14.5;
- `hyperv.psm1` = 17ca4352… and `type1.vmgs` = 4f051697… (both = the pins);
- `C:\Users\claude\vbs\node\tpmattest.exe` = `ebc30d9fa54cf70043900165ce12631224075b3301653eaf8527342d18de6982`, the
  install's `-TpmattestSha256`;
- `operator.key` and `proof.key` present (67 bytes each; content never read); `node-transport.key` ABSENT, so the node
  mints a fresh transport key;
- ports 8091/8092/9600 free; the new tasks and `hvnode\` absent;
- **M3 is DONE**: host-prereq's record is at `C:\Users\claude\vbs-like\host-prereq\prior-state.json`, so step 2 is
  already complete.

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
| P1 | **N1 on main**: LANDED, windows/node-hv-fixes → main 013deb51 (pushed 2026-09-26 00:42:12Z; the deploy was detect-only). The restart route needs the OWNER's session (401/404), then this box's live lease and the served-owner set (409) | b4 | an unauthenticated restart of any deployment (REVIEW-NODE.md N1) |
| P2 | **the owner set on main**: LANDED (same commit). `ownerSet()` = {operator} ∪ {valid delegations read from `NODE_DIR\delegations\*.json`}. payoutWallet and OWNER_WALLET authorize nothing. It gates claiming, the scan, the sweep's hold and restart. `/availability` publishes `owners` and `isolation` (host.mjs availability()) | b4 | 87's decision; bf's blockers |
| P3 | **e3's B deployed on nan**: an hv-node row may carry a deployment only for a served owner (tenantRoute, /t, certs, SNI daemons); secrets stay refused | e3 | on main an hv-node row is never eligible, so nothing would route to it |
| P4 | N2 resolved by B (87) | e3 | |
| P5 | **PINNED:** the node `<c>` = main **013deb51cbef481c23bdc66f5922d991c3058f02**; the CLI `<cc>` = **154b41a9e1e14bac386b6375275d7a3049e50271** (isolation/app-config-m1: `deploy --isolation` is not on main yet). The stage hashes are in step 0 (d1 and 5d each staged them; identical). The stage ships whole trees plus the CHECKED import closure (it includes `host-delegation.mjs`), so it does not rely on `windows/node/sync.sh`'s list | 5d | the stage's inputs |

The node deployed is **main with N1 in it**. **The node HOLDS every lease whose owner is neither the operator nor a
delegator** (intended, 87): it does not renew it, respawn it or release it early, so the lease lapses on the ledger's
clock. What it already RUNS for such an owner (host.mjs, the sweep's owner hold; b4's F3):
- **after a TRANSFER** (the ledger's owner is no longer the one it ran the app for): stopped AT ONCE;
- **a delegation removed, expired or unreadable** (a transient file-system error looks the same): held and not
  renewed, and the partition keeps serving until the lease LAPSES; then it is stopped. Nothing is released on chain;
- a lease that lapsed while held is stopped, and not re-claimed.
So:
- test 1 needs nothing extra;
- test 2 needs our agent-key delegation file in `hvnode\state\delegations\`;
- Steven's apps need his Trezor-signed delegation there BEFORE any of them is moved to the NucBox.

The v41 fixes (the front console guard, final at 4cdd5169, and domexec's app-stdio discard) are NOT needed for this first
NON-SENSITIVE test on v40. The rollout counts as DONE only on v41 (87).

## Steps
Each step says who runs it and where. "box" means d1, elevated PowerShell on the NucBox:
`powershell -ExecutionPolicy Bypass -File <script>` from `C:\Users\claude\vbs-like\hvnode\stage\`.

**0. Stage (workstation, 5d or d1).** `windows/node/ops/hv-node-rollout/stage-hvnode.sh <c> <cc> <outdir>` builds:
- `hvnode-<c8>.tar.gz`: the node's import closure (25 files at 013deb51, checked) plus the lockfile, relay fixtures and
  fetcher, in the repo layout (45 files);
- `cli-<cc8>.tar.gz`;
- their MANIFESTs, written OUTSIDE the tree they list (v2.1.1).

It prints every sha256, and the archives are deterministic (two runs are identical). **The pins for 013deb51 / 154b41a9**
(d1 staged them for the box run; 5d's restage at v2.2 reproduced every one):

| file | sha256 |
|---|---|
| hvnode-013deb51.tar.gz (45 files) | `fd145fcad76b4e4d1526d53404deb9287ab92c48495dd7b8352752c6ecef02db` |
| MANIFEST-hvnode-013deb51.txt (45 lines) | `c58d3af32dc9a1917abe69fed964359ada69eaef49353ce461ed682d5dbef2b6` |
| windows/node/package-lock.json (`-LockSha256`) | `f8964448da57ad5b3754806e7ab53d6c3fa062097b17dec65e71b811a7a5a818` |
| cli-154b41a9.tar.gz | `9579912d2c39f3f1844af8441c903e3ff08361e5b734cf74b1e3a814d6886c08` |
| MANIFEST-cli-154b41a9.txt | `73f35e0077e6777180ee0c3e64c47cbb16717980a7188f9f265a5e761b3de564` |

 d1 copies the archives, the
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

**2. M3 (box): ONE M3 path (enclave-87). DONE by d1 before 00:36Z.** It is enclave-53's `host-prereq.ps1` (windows/vbslike-pkg-v41-e53 @
9abdc36c, sha256 `4a72dab8981a50269ef9c4f77fad997d46a158b3c1c8902f820fd244c58721c6`), run through d1's runner
`C:\Users\claude\m3\m3-run.ps1` (c2cb589e7fd20e4c38e874f9cb416fbb0d8838130c59912518491d1d35b3aa53), already staged on the box:
`powershell -ExecutionPolicy Bypass -File C:\Users\claude\m3\m3-run.ps1 -Script <host-prereq.ps1> -Sha256 4a72dab8…`
The runner goes: `-Check`, an HKCU rehearsal (including a lock-held refusal), then `-Install`, then `-Check -Require`.
Each step is recorded, and the real install happens only if every earlier step exits as expected. host-prereq:
- takes the shared lab lock (`C:\Users\claude\uefi-probe.lock`);
- refuses unless Secure Boot is ON and test signing and nointegritychecks are off;
- records the prior state once at `C:\Users\claude\vbs-like\host-prereq\prior-state.json` (with its regRoot);
- sets `AllowFirmwareLoadFromFile=1` (DWORD) and registers the 9001 GUID.
No reboot is needed. My earlier hvnode-m3.ps1 is withdrawn; don't mix M3 scripts on one box.

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
- sets `hvnode\state\`'s ACL (SYSTEM + Administrators only) FIRST, then COPIES the operator and proof keys (and
  `node-transport.key` if present) into it: byte-identical, never overwriting a differing file, never printed;
- copies the package's `control\` to `hvnode\manager-<pkg8>\`. It checks EVERY file the package's `MANIFEST.json` lists
  (55 in v40), and refuses any other file outside `node_modules` (e.g. a `__pycache__`). `node_modules` (12,438 files,
  installed and verified at stage time, not in the MANIFEST) must be a byte-identical copy of the staged package's:
  the sorted (path, sha256) lists must be equal. The manager runs from that copy with
  `PYTHONDONTWRITEBYTECODE=1`, never from the staged package (enclave-d1's box rule). The IGVM, runtime.json and the
  launcher stay hash-pinned, read-only references into the package;
- copies `tpmattest.exe` into `hvnode\bin\` at its pin;
- writes the configuration: `manager-config.cmd` (the package's `managerEnv` resolved), `node-config.cmd`, and
  `run-manager.cmd` / `run-node.cmd`;
- writes `run-manager.cmd` / `run-node.cmd` as bounded RESTART LOOPS (the process, then 10 s, then again), with the
  script by its ABSOLUTE path, and the 10 s pause is `ping -n 11 127.0.0.1`, since `timeout` exits at once without
  a console. Task Scheduler's restart-on-failure does not reliably fire on a process that exits, and
  the absolute path lets the acceptance and the rollback match the process by path, never by name;
- registers the two NEW tasks `\EnclaveHvManager` (boot +30 s) and `\EnclaveHvNode` (boot +90 s): SYSTEM, highest,
  NO run-time limit. It does NOT start them. Every native command runs under ErrorAction Continue and is judged by
  its exit code (the PowerShell 5.1 stderr trap);
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

**7. Acceptance, box half.** `hvnode-accept.ps1 -Commit <c> [-KillRecovery] [-DeploymentId <id> [-OwnerRestart]]`
(read-only without -KillRecovery and -OwnerRestart):
- A1: Secure Boot ON; the legacy task present and Disabled.
- A2: both tasks Running; one agent and one manager process; run-node.cmd names tree `<c8>`.
- A3: the manager's `canStart`, backend `hyperv-partition-per-app`, `catalog.runtimeId` = the node's, and
  `boundary.hostExcluded` never true.
- A4: node `/availability` shows role `windows-hv-node`, teeCpu null, claimScope owner-only, operator 0x389C…,
  `owners` = [the operator] (plus each delegation once added), registered, `gasRenewalsLeft > 200`, relay verdict tier
  `hv-node`, and `isolation` = `hyperv-partition-per-app` (a missing one is a FAIL: b4's F4); `/v1/health` shows engine
  retired.
- A5: node.log never starts ee-host, and has the attach lines.
- A6: M3 applied, and host-prereq's record at `C:\Users\claude\vbs-like\host-prereq\prior-state.json` is for the HKLM root.
- A9 (with `-DeploymentId`; b4's F1): **N1 on the NODE**, through its loopback port 9600. B refuses these paths at the
  relay before the node sees them, so only here is the node's own answer checked:
  - `POST /v1/deployments/<id>/restart` with NO session: **401**;
  - a throwaway wallet's OWN session, minted on the node (`/v1/auth/nonce` + `/v1/auth/login`): **404** (not the
    owner);
  - with `-OwnerRestart` (it really restarts the app, so not read-only): the operator's own session (its key read in the
    check script from `state\operator.key`, never printed): **200**. The restart retires the partition and spawns a new
    one with a **NEW domain key** (b4): re-run A7 and then R4's key comparison against the new `transportKeySha256`.
    Run it ONCE, never in a loop (under M4 each restart also costs a certificate issuance).
  The throwaway key lives only in that script. The script is written into the node tree (so `viem` resolves) and
  deleted after.
- A8 (`-KillRecovery`, not read-only): it kills the agent's node.exe and then the manager's, by exact PID. Each must
  come back through its run loop with a NEW PID, and /availability or /health must answer within 60 s. **Run it here,
  on the EMPTY node, BEFORE test 1** (enclave-d1): killing the manager while an app VM runs can leave that VM failed,
  and ENCLAVE_ISOLATION_RESPAWN is off.

**7r. Acceptance, relay/public half (workstation, read-only).** `hvnode-accept-remote.sh [<deployment id>]`:
- R1: `/enclaves` has the `nucbox-k11` row: mode `hv-node`, `hvNode.hostExcluded:false`, a recent `verifiedAt`, and
  the omission `platform-firmware-unpinned`;
- R2 and R2b are **RELAY** checks (what a stranger gets through api.enclave.host); the node's own N1 answers are A9's:
  - R2: `POST https://api.enclave.host/t/nucbox-k11/v1/deployments/<id>/restart` with NO session is REFUSED
    (401/403/404/409/503), never 200;
  - R2b (b4's check with a real STRANGER): a throwaway wallet logs in to the node THROUGH the relay (its own SIWE
    session) and asks to restart the test deployment. It must be refused: 404 (not the owner), or 401 if the relay
    strips the credential. Never 200. **`nosession` is a FAIL** (enclave-87): a check that never reaches the restart
    proves nothing, so (enclave-87's ruling, v2.2.1) it is **INFO**, not a PASS, and left out of the tally: "the relay
    refuses /v1/auth for this hv-node box (by design); N1 evidenced by A9". Under B that is what it reads (b4: B
    default-denies paths that name no deployment). A9 on the box stays the hard N1 check; R2 the relay's;
- R3: gas ≥ 0.0005 ETH (below it, top up from the operator gas tank), latest nonce = pending.
- After acceptance, test 1 soaks for **12 h** (the DONE soak, enclave-87), then stops: `enclave refund <id>` by the
  operator on the box, the same way it was created.

**8. Test deployments, in 87's order** (each non-sensitive; each passes 7 and 7r before the next):
1. **Operator-owned.** An app owned by the operator `0x389C…` itself, at the normal rate (a few cents, approved):
   - fund the operator with 0.10 USDC from the agent wallet (workstation: `usdc-to-operator.mjs`, key from
     `ETH_AGENT_WALLET` only);
   - then, on the box: `hvnode-test1.ps1 -CliArchive … -CliArchiveSha256 … -CliManifest … -CliManifestSha256 …` deploys hello-world 1.0.4
     (`catalog://0x5356e8bd…/4`, bundle/1: 128 MB, no ports) with `--isolation hyperv-partition-per-app --cpu 0.01
     --fund 0.05`, signed by the operator key read from `hvnode\state\operator.key` into that one process's
     environment and cleared after. The CLI runs through Start-Process with its output REDIRECTED TO FILES, so its
     `created <id>` line is on disk as it prints, and `hvnode\test1-created.txt` records the id even if the deploy then
     fails;
   - **if the deploy CREATED but did not FUND** (the CLI can read the new row before its RPC shows it), re-run with
     `-FundExisting <id>` (enclave-d1's design, approved by 87). It funds that id and creates nothing:
     - it first polls the ledger's `get(id)` on TWO RPCs (publicnode + blastapi) until BOTH name the operator as the
       owner, for at most `-VisibleTimeoutSec` (180);
     - it REFUSES an id another address owns (exit 3 of the check) and a timeout, and then nothing moves;
     - then `enclave fund <id> --usdc <FundUsd> --yes`, with the same key handling (the key only in that child's
       environment; output to files);
     - `hvnode\test1-funded.txt` records the id, the amount, the exit code and the transaction hashes;
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
   (ACL SYSTEM + Administrators).
   - **Prerequisites (b4's F5; NOT in 013deb51):**
     - b4's follow-up node, windows/node-hv-attach (ab7cdbb0, in review): the attach carries the valid delegations
       (`rad.delegations`, as written, ≤ 8) and a **v2 operatorSig** (e3's `attachMessageV2` over the name, the nonce,
       the transport SPKI and the EK), only when the relay's challenge offers v2. It re-attaches, at most every 2 min,
       when the delegation set changes. The relay learns delegations ONLY at attach;
     - e3's relay half: the challenge offers v2 and verifies it, and **0x389C… is in nan's `TRUSTED_OPERATORS`**;
     - then main with that commit, staged and installed with `-Replace` ("A node upgrade later", under Rollback).
   - The node re-reads the directory every tick, so no restart is needed; its `/availability` `owners` then lists
     `0x2947…`; the relay's served set changes at the node's NEXT attach (b4's re-dial).
   - **PASS** as in test 1, plus (b4's F2):
     - with the file REMOVED: the node holds that owner's lease and does not renew it. The partition keeps serving
       until the lease LAPSES, then it is stopped. `owners` drops `0x2947…` at the next tick, and the relay's served set at
       the next attach;
     - a TRANSFER of the deployment to an owner this box does not serve stops the partition AT ONCE (host.mjs
       owner hold). Test it only if 87 wants it; it moves the deployment.
3. **Steven's apps**, later, via his Trezor-signed delegation. Only on v41 (the console guard + domexec fixes), after
   S5 and the release decision.

**9. Last: hosting caps + tray (slot for enclave-87's hosting tray).** The hosting-caps file (the CPU and GPU share
caps, 0..1, default 1.0, JSON under `hvnode\state\`), the admin token's ACL (SYSTEM + Administrators), and the tray
install. Written by the tray's author when it lands; reviewed by 5d as node owner. Lowering a cap never evicts.

## Rollback
- **Node + manager (box):** `hvnode-rollback.ps1 [-Unregister]`. It:
  - disables and ends `\EnclaveHvNode` first (no new lease; held leases lapse on the ledger's clock);
  - destroys every manager VM THROUGH the manager (`DELETE /vms/<id>`), then disables and ends `\EnclaveHvManager`;
  - turns off and removes any leftover manager-tagged VM (guest-state copies kept), ONLY while holding
    `C:\Users\claude\uefi-probe.lock` exclusively. If a lab run holds it, the cleanup is skipped and reported;
  - matches processes by the install's absolute paths only, and stops each run loop's cmd.exe before its node.exe;
  - with `-Unregister`, exports each task's XML and then removes it.
  It never enables or deletes `\EnclaveWindowsNode`: the legacy node is retired, so rollback means "nothing serving",
  not "the old node back". Nothing under `hvnode\` is deleted.
- **M3 (box):** `host-prereq.ps1 -Rollback`. It restores exactly the recorded prior state, only while each setting is
  still what `-Install` set, and removes the GUID only if it was absent before and is still its own. Anything else is
  reported as "LEFT: …", with exit 4.
- **Relay (nan):** `sh relay-hvnode-attach-off.sh` removes exactly its one line (line-wise, other lines untouched) and
  restarts. The node's next attach is refused by name.
- **A node upgrade later:** stage a new `<c8>` and re-run the install with `-Replace` (a new tree beside the old one,
  and the same state\). Roll back by pointing `run-node.cmd` at the previous tree.

## What this does NOT claim
- **Not isolated hosting.** T0-hv, monitor-signed, `host_excluded=no`. The node's `attestedCapacity()` is always false,
  and meetsIsolationContract is false for every tier, hence owner-only.
- **The first test runs on v40.** v40 carries the front logging leak and domexec's app-stdio leak (both fixed on
  isolation/front-console-guard 4cdd5169, going into v41). So its apps are non-sensitive, and DONE is on v41.
- **TLS.** An isolated app serves the guest's self-signed certificate until M4 relays its CSR to the platform
  certificate service (5d, with e3's relay half). R4 with `-k` proves the partition path, NOT public TLS, so **M4 is on
  DONE's critical path** (enclave-d1).
- **Logs.** `hvnode\logs\node.log` and `manager.log` grow without bound. Rotation comes later; the 12 h soak is fine.

## Files (this directory)
| file | runs where | what |
|---|---|---|
| ROLLOUT.md | | this procedure |
| GAS.md | | the operator's balance and costs, read 2026-09-26 00:01:45Z |
| stage-hvnode.sh | workstation | the deterministic node and CLI archives, plus manifests |
| hvnode-preflight.ps1 | box | step 1, read-only |
| hvnode-install.ps1 | box | step 4 |
| hvnode-accept.ps1 | box | step 7, read-only |
| hvnode-accept-remote.sh | workstation | step 7r, read-only |
| usdc-to-operator.mjs, hvnode-test1.ps1 | workstation, box | step 8.1 (`-FundExisting <id>`: fund only) |
| hvnode-rollback.ps1 | box | rollback |
| relay-hvnode-attach-on.sh / -off.sh | nan | steps 5 / rollback (line-wise, tested with a harness) |
