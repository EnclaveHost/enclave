# v42 production reboot acceptance: GO-SHEET (run after the soak's final summary, ~16:01Z)

For enclave-5d or enclave-d1 (executor), from enclave-b4's read-only preflight for enclave-87. It applies REBOOT.md (same
branch) to what is live NOW. REBOOT.md stays the rule; this sheet says which commands to run, in what order, and where
today's live state differs from what REBOOT.md assumed. Deployment: test 1 `0x31136008aa0cf1d826d223777bed396efdf73e89ee5c82a5aabce2ca1aeeeee3`
(`ID` below). Every time is read with `date -u` (ws) or `(Get-Date).ToUniversalTime()` (box), never estimated.

## Live state, read-only preflight at 2026-09-26T06:28:06Z (box queries only; nothing changed)
- Node tree `C:\Users\claude\vbs-like\hvnode\f1461271\windows\node` (main `f146127176f7`, -NodeOnly 06:02:59Z). It
  contains the restart recovery (`fa4284db` is its ancestor), and the recovery line the capture script matches is
  unchanged in it (host.mjs:835).
- Tasks: EnclaveHvManager Running, EnclaveHvNode Running, EnclaveWindowsNode Disabled. BootId **69**.
- Hyper-V: exactly ONE VM on the box, `enclave-app-hv88b31102f90274-9c3d10f1`, Running, up 173 min.
- The manager's record for ID: instance `hv88b31102f902741d791a3e90b56f571b`, running, image `0891c740…` (v42),
  guestIdentity {wmi-openhcl-gen2-igvm-linux, igvm-linux-direct}, key `4d80b9566a3ab6c4…`.
- /availability: tier hv-node, registered, owner-only, isolation hyperv-partition-per-app, owners = [operator
  `0x389c…`] (0 delegations), gasRenewalsLeft 3600.
- node.log: the last attach ACCEPTED at 06:03:35Z (the f1461271 start). The soak (`~/enclave-bench/nucbox-soak`,
  every 5 min via x) was authorized on spki `4d80b956…` through 06:26:05Z.

## Where REBOOT.md no longer fits (GAPS), and what this sheet does instead
- **G1. R4 by public hostname cannot pass.** `hvnode-accept-remote.sh`'s R4 curls `https://31136008.app.enclave.host/`,
  and us-west step 1b is HELD, so it fails (as in E9). R4 here is the soak monitor's one-shot sample through nan's
  `/x` splice with a VERIFIED chain (as E12, E15): `soak.mjs --once --via x`. The script's hostname R4 is recorded as
  INFO (an expected FAIL), not as the acceptance.
- **G2. Serving on the NEW key now needs a NEW certificate.** After the reboot the fresh partition holds a new key and
  first serves its self-signed certificate. hvcert (node, 15 s after start, then every 60 s) must issue a ZeroSSL
  certificate for the NEW key inside the 15 minutes. This is the FIRST live issuance under f1461271's judge-hv
  per-image rule: v42's image `0891c740` is listed as legacy, and the record carries guestIdentity + image (above), so
  the legacy path applies ("runtime W^X unmeasured"). **Proven offline at 2026-09-26T06:32:13Z (enclave-87's G2(a),
  read-only):** f1461271's own `hvcert.mjs hvJudge(view, pin)`, with the manager's record as the view, judged test 1's
  LIVE attestation (a fresh nonce, over b4's own TLS through `/x`; handshake spki = the manager's `4d80b956…`):
  `monitor-signed`, wxCoverage `runtime-unmeasured` (the v42 legacy path). So G2's only remaining risk is issuance (the
  CA, the network). A failure backs off 5, then 10 min: **the certificate window is 30 min** (enclave-87).
- **G3. Do NOT stop or refund test 1 at the soak's end** (enclave-87's order): the final soak summary → enclave-e3's
  owner-grace relay window → THIS acceptance → the v43 manager-path canary → THEN test 1's stop and refund, if still
  wanted.
- **G7. The lease** (enclave-87, from enclave-d1's cadence). The node renews only within its 15-min lead, +30 min each
  time (test 1's land at about :20 and :50), so leaseUntil is 15-45 min ahead depending on the minute; ≥60 is out of
  reach without an operator transaction, which is not done. So step 5 starts RIGHT AFTER the node's own `renewed
  0x31136008` line, with leaseUntil read on chain ≥ 40 min out (≈44). After the boot the FIRST renewal must land before
  that leaseUntil: none is a FAIL (the recovery held the lease).
- **G4. `-Commit` is `f146127176f7`** (REBOOT.md predates it).
- **G5. No re-attach churn** (682dc63d). With no delegation files the owners cannot change, so node.log since the boot
  must show ONE `attach ACCEPTED` and no `attaching again` or `REMOVED` line. The capture script does not check this;
  step 8 does.
- **G6. The lab lock.** The capture script does not test it. `uefi-probe.lock` EXISTS on the box, which is normal: it
  is an exclusive-open lock. Step 0 tests it the way hvnode-rollback.ps1 does.
- **Unchanged by f1461271, and covered as before:**
  - Off → retire → ONE fresh spawn, a new instance and key, and no reboot-recovery hold: the capture script.
  - No release tx, the same runner, the balance moving on: step 10's ledger read.
  - No renewal while held: test-level (test/windows-node-norenew.test.mjs), INFO here as in REBOOT.md.
  - The scan fix: test 1 is this box's own live lease, which the ledger scan skips, so the recovery never passes
    through it.

## Commands, in order (ws = warden-host, `cd ~/enclave-bench/nucbox-soak` for soak.mjs; box = `ssh minipc-zt`)
| # | Where | Command | PASS when |
|---|---|---|---|
| 0 | box | `try { $l=[IO.File]::Open('C:\Users\claude\uefi-probe.lock','OpenOrCreate','ReadWrite','None'); $l.Close(); 'free' } catch { 'HELD' }` · `Get-VM` · `Get-ScheduledTask \| ? State -eq Running` | `free`; `Get-VM` lists only the one test-1 VM (anything else has its owner's OK); no install or lab run active; enclave-87's go recorded with its time |
| 1 | ws | `node soak-summary-ecfb7b3f.mjs --summary 20260926T040105Z.jsonl` (the soak's own final summary, d1), then `node soak.mjs --once --via x --out before-once.jsonl` | the summary is recorded; the one-shot sample: `ok:true`, status 200, `authorized:true` (a publicly trusted chain: ZeroSSL or Let's Encrypt, the issuer INFO - the relay fails over between CAs, enclave-d1), `spkiSha256` = `4d80b956…` |
| 2 | box | `hvnode-accept.ps1 -Commit f146127176f7 -DeploymentId $ID` (read-only: no `-KillRecovery`, no `-OwnerRestart`) | all PASS |
| 3 | box | `hvnode-reboot-capture.ps1 -Phase pre -DeploymentId $ID -OutDir C:\Users\claude\vbs-like\hvnode\reboot-<UTC stamp>` | exit 0; `pre: BootId 69; … VMs 1; record hv88b31102… running; key 4d80b956…` |
| 4 | ws | `hvnode-accept-remote.sh $ID 4d80b9566a3ab6c4d898b03ad09a9309f326b891f2b1ddc5bb63ab10046cccb1` | all PASS except R4's hostname lines (G1: INFO). Keep R1 (verifiedAt, bootCounter), R3 (gas ≥ 0.0005 ETH, nonce latest = pending), and the ledger's leaseUntil (≥ 30 min out), balance6 and runner |
| 5 | box | wait for a fresh `renewed 0x31136008` line in node.log and read leaseUntil on chain (G7), then `shutdown.exe /r /t 60 /d p:0:0 /c "enclave hv-node reboot acceptance"`, and record `(Get-Date).ToUniversalTime()` | leaseUntil ≥ 40 min after the shutdown; issued within ~10 min of that renewal; abortable for 60 s with `shutdown /a` |
| 6 | ws | `until ssh -o ConnectTimeout=10 minipc-zt hostname; do sleep 20; done` (read-only reachability) | the box answers |
| 7 | box | `hvnode-reboot-capture.ps1 -Phase post -DeploymentId $ID -OutDir <the same dir>`, re-run read-only until PASS or the deadline | exit 0. It judges: BootId 70, Secure Boot ON, the legacy task Disabled, both tasks Running, ≤ 15 min; ONE tagged VM, the NEW instance's; the old vmId gone; ONE record, running, not recovered, NEW instance, NEW key; owner-only, tier hv-node; `<ID10> restart recovery: the recovered VM hv88b31102f902741d791a3e90b56f571b (Off) was retired; starting ONE fresh partition`; no reboot-recovery hold; no `card price now`. Note the printed NEW key |
| 8 | box | `Select-String C:\Users\claude\vbs-like\hvnode\logs\node.log -Pattern 'attach ACCEPTED\|attaching again\|REMOVED\|certificate' \| select -Last 12` | since the boot: ONE `attach ACCEPTED`; no `attaching again` and no `REMOVED`; `0x31136008 certificate: 31136008.app.enclave.host installed in partition <NEW instance> (key <NEW key16>…, <issuer>; domain monitor-signed)` within 30 min of the boot (G2; a `certificate: none … retry` before it is INFO); and the FIRST `renewed 0x31136008` after the recovery, before the pre-reboot leaseUntil (G7) |
| 9 | box | `hvnode-accept.ps1 -Commit f146127176f7 -DeploymentId $ID` | all PASS (A4's gas figure is INFO for the node's first 12 min) |
| 10 | ws | `hvnode-accept-remote.sh $ID <NEW key>` | all PASS except R4's hostname lines (G1); R1 bootCounter = step 4's + 1, verifiedAt after the reboot. Ledger: the same runner (nucbox-k11), a live lease, NO release transaction for ID, balance6 moving on |
| 11 | ws | `node soak.mjs --once --via x --out after-once.jsonl` | `ok:true`, status 200, `authorized:true` (a publicly trusted chain; the issuer INFO), `spkiSha256` = the NEW key (≠ `4d80b956…`) |

**PASS = step 7 within 15 minutes of the boot; steps 8-11 within 30 minutes of it (the certificate window, G2); the first
renewal before the pre-reboot leaseUntil (G7); and no operator action.** Keep every output in the reboot OutDir
(box) and in `~/enclave-bench/reboot-v42-<stamp>/` (ws). Then G3's stop and refund, if still wanted.

## What the soak monitor shows
- **Before** (its last samples, and step 1's one-shot): `via:"x"`, `ok:true`, status 200, `authorized:true`,
  `cert.spkiSha256` `4d80b956…`.
- **After:** the 12 h soak has ended by then, so step 11's one-shot is the monitor's word. It must show the same fields
  on the NEW key.
- **In between:** the relay row is absent while the box is down (404 on /x). That is expected, and it is outside the
  soak's window.

## Rollback (REBOOT.md's, unchanged)
- The tasks do not start at boot: `Start-ScheduledTask EnclaveHvManager`, wait for /health canStart, then
  `Start-ScheduledTask EnclaveHvNode`. The acceptance FAILED (an operator acted).
- Held (`isolation: reboot recovery: … held`): the owner's session restart
  (`hvnode-accept.ps1 -DeploymentId $ID -OwnerRestart`), then A7 and step 11 again. FAILED.
- Everything passes except the certificate within 30 min: record FAIL(cert) (G2) and restart NOTHING. hvcert retries by
  itself; record when the install line lands.
- The node misbehaves otherwise: `hvnode-rollback.ps1` (nothing serving, nothing deleted).
- Secure Boot is off, or the legacy task changed: stop, touch nothing, report to enclave-87 and Steven.
- The box does not come back: someone has to be at the machine. Say so at once.
