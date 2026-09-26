# v42 production reboot acceptance: GO-SHEET (run after the soak's final summary, ~16:01Z)

For enclave-5d or enclave-d1 (executor), from enclave-b4's read-only preflight for enclave-87. It applies REBOOT.md (same
branch) to what is live NOW. REBOOT.md stays the rule; this sheet says which commands to run, in what order, and where
today's live state differs from what REBOOT.md assumed. Deployment: test 1 `0x31136008aa0cf1d826d223777bed396efdf73e89ee5c82a5aabce2ca1aeeeee3`
(`ID` below). Every time is read with `date -u` (ws) or `(Get-Date).ToUniversalTime()` (box), never estimated.
At step 0, create the ws evidence dir `~/enclave-bench/reboot-v42-<stamp>/` and `tee` every ws step's output into it
(`… 2>&1 | tee ~/enclave-bench/reboot-v42-<stamp>/step<N>.txt`); step 12 adds the box OutDir and SHA256SUMS (G11).
`LR` below = `node <a checkout of windows/reboot-go-sheet>/windows/node/ops/hv-node-rollout/ledger-reboot.mjs` (read-only
chain reads; viem from `VIEM_DIR`, default `~/Projects/enclave`). Revised for enclave-bf's NO-GO on 5268d172 (R1-R4) and
enclave-87's ruling on bf's S1 (the freeze, G5).

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
  first serves its self-signed certificate. hvcert (node, 15 s after start, then every 60 s) must get a publicly
  trusted certificate (ZeroSSL or Let's Encrypt) for the NEW key inside the 30-min certificate window. This is the FIRST live issuance under f1461271's judge-hv
  per-image rule: v42's image `0891c740` is listed as legacy, and the record carries guestIdentity + image (above), so
  the legacy path applies ("runtime W^X unmeasured"). **Proven offline, read-only (enclave-87's G2(a)), with its
  evidence saved: 2026-09-26T06:43:50Z, `~/enclave-bench/reboot-go-v42/g2/20260926T064344Z/` on warden-host (README.txt;
  SHA256SUMS sha256 `62fb3134…`).** f1461271's own `hvcert.mjs hvJudge(view, view.runtimeId)` (the judging tree
  byte-identical to f146127176f7, tree.txt), with the manager's record read from GET /vms as the view (view-raw.json),
  judged test 1's LIVE attestation (a fresh nonce, nonce.hex; over b4's own TLS through `/x`; attestation.json, cert.pem,
  spki.der): HTTP 200, handshake spki = the manager's `4d80b956…`, a ZeroSSL chain the node's CA store verifies,
  `monitor-signed`, wxCoverage `runtime-unmeasured` (the v42 legacy path; verdict.json, run.txt). The earlier 06:32:13Z
  run printed only to a terminal and saved nothing, so it is not cited. G2's only remaining risk is issuance (the CA, the
  network). A failure backs off 5, then 10 min: **the certificate window is 30 min** (enclave-87).
- **G3. Do NOT stop or refund test 1 at the soak's end** (enclave-87's order): the final soak summary → enclave-e3's
  owner-grace relay window → THIS acceptance → the v43 manager-path canary → THEN test 1's stop and refund, if still
  wanted.
- **G7. The lease** (enclave-87, from enclave-d1's cadence; enclave-bf's R4). The node renews only within its 15-min
  lead, +30 min each time (test 1's land at about :20 and :50: `LR events` read Renewed at blocks 51805323, 51806223,
  51807128, leaseUntil 06:04:49Z, 06:34:49Z, 07:04:49Z), so leaseUntil is 15-45 min ahead depending on the minute; ≥60 is
  out of reach without an operator transaction, which is not done. **The ONLY lease criterion: `leaseUntil − (the shutdown
  command's read time + 60 s) ≥ 40 min`**, leaseUntil read with `LR get` and the time read on the box. Right after a
  renewal that leaves only a few minutes, so step 5 computes it from the box's clock BEFORE issuing and issues the
  command only if it holds (enclave-87's hard rule: never act first and rely on `shutdown /a`); if it does not, nothing
  is issued and the run waits for the next renewal. After the boot the FIRST renewal must land before that leaseUntil:
  none is a FAIL (the recovery held the lease).
- **G4. `-Commit` is `f146127176f7`** (REBOOT.md predates it).
- **G5. No re-attach churn** (682dc63d). With no delegation files the owners cannot change, so node.log since the boot
  must show ONE `attach ACCEPTED` and no `attaching again` or `REMOVED` line. The capture script does not check this;
  step 8 does. An api-relay restart (a push to main on any path redeploys it) also ends the tunnel and re-attaches, so
  **the run is FROZEN (enclave-87's ruling on enclave-bf's S1): from step 5 (the shutdown) to step 10, no pushes to main
  on any path, no relay windows, no us-west or nan changes.** PRECONDITION of step 5: the executor tells enclave-87 at
  step 4, enclave-87 announces the freeze to every session, and the executor waits for enclave-87's ack. A re-attach
  during the freeze is then a FAIL to investigate, not INFO.
- **G9. The negative restart probes aim at the ZERO id** (enclave-87's hard rule, 2026-09-26: a check never sends a
  production apply at live state and relies on a guard to refuse it). Steps 2/4/9/10 run the acceptance scripts at
  windows/negative-probes-zero-id `4bd3a9ce` (merged into this branch): `hvnode-accept.ps1` sha256 `f9208e143f6f8ed7…`,
  `hvnode-accept-remote.sh` sha256 `e3906a57aa513fbc…`; check both hashes before use (the box: `Get-FileHash`). Their A9 and
  R2/R2b POST `/v1/deployments/0x00…00/restart`, never `$ID`: no session → 401 (A9) / refused (R2) stay PASS/FAIL;
  a stranger's own session is INFO (a 200 FAILS), its proof test-level (test/windows-node-restart-gate.test.mjs:
  "restartRequest: a valid session for ANOTHER address is 404 (as on Linux), and nothing restarts" and "a STRANGER's
  opted-in deployment is refused, and ensureApp is never reached"); test/hvnode-negative-probes.test.mjs pins it. The
  older scripts (fa3f1cad/bed0517c blobs) must NOT be run with `$ID`.
- **G10. The hosting TRAY survives the reboot** (enclave-87: Steven's EnclaveTray, main 4ef0e862, is part of DONE).
  From windows/tray/install-tray.cmd (read, not assumed): the exe lives in the tray user's
  `%LOCALAPPDATA%\Enclave\Tray\EnclaveTray.exe`, and it starts at THAT user's logon through `HKCU\Software\Microsoft\
  Windows\CurrentVersion\Run` value `EnclaveHostingTray` = `"<that exe>"`. hvnode-install.ps1 only sets the node's
  `HOSTING_TRAY_USER`, which grants the user read on the token the node re-mints at every start
  (`%ProgramData%\Enclave\hosting\hosting-admin.token`). The sliders' caps persist in the node's `hosting-caps.json`
  (NODE_DIR = `C:\Users\claude\vbs-like\hvnode\state`). The box has no AutoAdminLogon (REBOOT.md; read back as `''`), so
  after the boot the tray runs only once srbat signs in: with no session that is INFO, never a FAIL.
  `hvnode-tray-check.ps1` (this branch) reads all of it, READ-ONLY: the user's hive only when Windows has it loaded (never
  `reg load`, which would lock NTUSER.DAT), the token's ACL and write time (never its content). Preflight on the box at
  2026-09-26T07:32:21Z (print-only, then a pre/post pair in a scratch dir, removed): srbat signed in (session 1),
  EnclaveTray pid 13992 as NUCBOX_K11\srbat from the installed exe, exe sha256 `3614819de95316b3…`, the Run value =
  that exe, caps cpuShare 1 / gpuShare 1 (file `f0c774b166fdc57a…`), the token grants srbat read and was re-minted after
  the current boot; controls: a changed exe hash and changed caps each FAIL the post phase, an unchanged pair does not.
- **G11. Three reads the capture does not make, and the evidence on ws** (enclave-87, after enclave-5d's DONE audit and
  enclave-b4's independent read at 07:37Z, ~/enclave-bench/done-audit-b4/). Step 7a runs `hvnode-reboot-reads.ps1`
  (this branch, READ-ONLY; it never reads the hosting token): the NEW record's image must be v42's `0891c740…`; the node
  tree must be the one before the reboot (run-node.cmd sha256 `5f1a79b4c1927433…`, running `…\hvnode\f1461271\windows\
  node\agent.mjs`, exactly one such node.exe); and :9610 (the tray's backend) must listen on loopback only, be owned by
  that agent's pid and answer an unauthenticated GET with the hosting handler's 401. Checked on the box at 07:3xZ: all
  PASS; controls (a wrong image, run-node sha or tree) each FAIL. Every ws output goes into
  `~/enclave-bench/reboot-v42-<stamp>/` from step 0, and step 12 brings the box OutDir there and writes SHA256SUMS.
- **G8. The ledger** (enclave-bf's R2). hvnode-accept-remote.sh prints neither leaseUntil nor balance6, and nothing in it
  looks for a release; a release followed by a re-claim would still end "same runner, live lease". `LR get <ID>` prints
  the block, runner, leaseUntil (and the minutes left), balance6 and spent6 (steps 4, 5, 10); `LR events <ID> <B4>`
  lists every Claimed(id) and Released(id) from step 4's block B4 to now, and PASSES only on 0 of each (Renewed is
  INFO). Checked read-only on test 1 at 06:44:50Z: `get` block 51807871, runner nucbox-k11, leaseUntil 07:04:49Z,
  balance6 58400, spent6 21600; `events` over 51804871..51807871: 0 Claimed, 0 Released, 3 Renewed.
- **G6. The lab lock.** The capture script does not test it. `uefi-probe.lock` EXISTS on the box, which is normal: it
  is an exclusive-open lock. Step 0 tests it the way hvnode-rollback.ps1 does.
- **Unchanged by f1461271, and covered as before:**
  - Off → retire → ONE fresh spawn, a new instance and key, and no reboot-recovery hold: the capture script.
  - No release tx, the same runner, the balance moving on: step 10's `LR get` and `LR events` (G8).
  - No renewal while held: test-level (test/windows-node-norenew.test.mjs), INFO here as in REBOOT.md.
  - The scan fix: test 1 is this box's own live lease, which the ledger scan skips, so the recovery never passes
    through it.

## Commands, in order (ws = warden-host, `cd ~/enclave-bench/nucbox-soak` for soak.mjs; box = `ssh minipc-zt`)
| # | Where | Command | PASS when |
|---|---|---|---|
| 0 | box | `try { $l=[IO.File]::Open('C:\Users\claude\uefi-probe.lock','OpenOrCreate','ReadWrite','None'); $l.Close(); 'free' } catch { 'HELD' }` · `Get-VM` · `Get-ScheduledTask \| ? State -eq Running` | `free`; `Get-VM` lists only the one test-1 VM (anything else has its owner's OK); no install or lab run active; enclave-87's go recorded with its time |
| 1 | ws | `node soak-summary-ecfb7b3f.mjs --summary 20260926T040105Z.jsonl` (the soak's own final summary, d1), then `node soak.mjs --once --via x --out before-once.jsonl` | the summary is recorded; the one-shot sample: `ok:true`, status 200, `authorized:true` (a publicly trusted chain: ZeroSSL or Let's Encrypt, the issuer INFO - the relay fails over between CAs, enclave-d1), `spkiSha256` = `4d80b956…` |
| 2 | box | `hvnode-accept.ps1 -Commit f146127176f7 -DeploymentId $ID` (G9's script, sha256 `f9208e14…`; read-only: no `-KillRecovery`, no `-OwnerRestart`) | all PASS; A9: `none=401` on the zero id PASS, the stranger's line INFO |
| 3 | box | `hvnode-reboot-capture.ps1 -Phase pre -DeploymentId $ID -OutDir C:\Users\claude\vbs-like\hvnode\reboot-<UTC stamp>` | exit 0; `pre: BootId 69; … VMs 1; record hv88b31102… running; key 4d80b956…` |
| 3a | box | `hvnode-tray-check.ps1 -Phase pre -OutDir <the same OutDir> -ExpectCapsSha256 f0c774b166fdc57a44f0f76a3cd954a814477b51c3285bf73aa7f51cdd1f44c3` (G10; the caps as read 07:32Z, cpuShare 1 / gpuShare 1: if Steven has moved a slider since, re-read the file and confirm the new value with enclave-87 before 3a) | exit 0: `TRAY (pre): no FAIL` - the caps FOUND with that sha256 (a mis-resolved path FAILS, enclave-bf's S1); the exe present (its sha256 recorded); the token grants srbat read; query.exe exited 0/1 and every session where srbat runs EnclaveTray or explorer was parsed (S2); IF srbat is signed in, the Run value = the installed exe and EnclaveTray running in srbat's session |
| 4 | ws | `hvnode-accept-remote.sh $ID 4d80b9566a3ab6c4d898b03ad09a9309f326b891f2b1ddc5bb63ab10046cccb1` (G9's script, sha256 `e3906a57…`; R2/R2b on the zero id), then `LR get $ID`; then tell enclave-87 the run is at step 4 (G5's freeze) | all PASS except R4's hostname lines (G1: INFO). Keep R1 (verifiedAt, bootCounter), R3 (gas ≥ 0.0005 ETH, nonce latest = pending), and from `LR get`: its `block` (**B4**, the from-block of step 10's `LR events`), runner = nucbox-k11, leaseUntil, balance6, spent6 |
| 5 | ws, then box | enclave-87's freeze ack recorded with its time (G5); wait for a fresh `renewed 0x31136008` line in node.log; `LR get $ID` (ws: leaseUntil); then, BEFORE issuing anything, read the box's clock `$now = (Get-Date).ToUniversalTime()` and compute `leaseUntil − ($now + 60 s)`; ONLY if that is ≥ 40 min, `shutdown.exe /r /t 60 /d p:0:0 /c "enclave hv-node reboot acceptance"` (box), recording `(Get-Date).ToUniversalTime()` as the command time. If it is < 40 min, issue nothing and wait for the next renewal (enclave-87's hard rule: the criterion is checked before the action, never after it) | the freeze ack precedes the command; the criterion computed BEFORE the command was ≥ 40 min, and `leaseUntil − (command time + 60 s) ≥ 40 min` still holds for the recorded command time. `shutdown /a` (within the 60 s) is only for an operator slip, never the plan |
| 6 | ws | `until ssh -o ConnectTimeout=10 minipc-zt hostname; do sleep 20; done` (read-only reachability) | the box answers |
| 7 | box | `hvnode-reboot-capture.ps1 -Phase post -DeploymentId $ID -OutDir <the same dir>`, re-run read-only until PASS or the deadline | exit 0. It judges: BootId 70, Secure Boot ON, the legacy task Disabled, both tasks Running, ≤ 15 min; ONE tagged VM, the NEW instance's; the old vmId gone; ONE record, running, not recovered, NEW instance, NEW key; owner-only, tier hv-node; `<ID10> restart recovery: the recovered VM hv88b31102f902741d791a3e90b56f571b (Off) was retired; starting ONE fresh partition`; no reboot-recovery hold; no `card price now`. Note the printed NEW key |
| 7a | box | `hvnode-reboot-reads.ps1 -DeploymentId $ID -OutDir <the same OutDir>` (G11) | exit 0, `READS: no FAIL`: ONE record for ID, running, image `0891c740ddf18ded1ea903495b70c799a5cfbe498d05843e47c7b84106ed7998`; run-node.cmd sha256 `5f1a79b4c192743360344c640291457249b25c51f6bdafde1e12d9c0888a4507`, running the f1461271 agent.mjs, exactly one such node.exe; :9610 on 127.0.0.1 only, owned by that agent's pid, unauthenticated GET → the hosting handler's 401. reads-post.json in the OutDir |
| 8 | box | `$pre = Get-Content -Raw <the OutDir>\capture-pre.json \| ConvertFrom-Json; Get-Content C:\Users\claude\vbs-like\hvnode\logs\node.log \| Select-Object -Skip ([int]$pre.nodeLogLines) \| Select-String -Pattern 'attach ACCEPTED\|attaching again\|REMOVED\|certificate\|renewed 0x31136008'` (everything since the pre capture, no `-Last`: hvcert's per-pass `certificate: none … retry` lines would push the attach lines out of a tail) | since the boot: ONE `attach ACCEPTED`; no `attaching again` and no `REMOVED` (a re-attach in the freeze is a FAIL, G5); `0x31136008 certificate: 31136008.app.enclave.host installed in partition <NEW instance> (key <NEW key16>…, <issuer>; domain monitor-signed)` within 30 min of the boot (G2; a `certificate: none … retry` before it is INFO); and the FIRST `renewed 0x31136008` after the recovery, before the pre-reboot leaseUntil (G7) |
| 9 | box | `hvnode-accept.ps1 -Commit f146127176f7 -DeploymentId $ID` (G9's script) | all PASS (A4's gas figure is INFO for the node's first 12 min); A9 as step 2 |
| 9a | box | `hvnode-tray-check.ps1 -Phase post -OutDir <the same OutDir>` (G10) | exit 0: the exe's sha256 = 3a's; the caps (file sha256, cpuShare, gpuShare) = 3a's; the token re-minted after THIS boot and granting srbat read; the session parse trustworthy (S2: query.exe 0/1, and no srbat-owned EnclaveTray or explorer in an unparsed session). IF srbat has signed in since the boot: the Run value still = the installed exe (and = 3a's) and EnclaveTray running in srbat's session; else INFO `starts at srbat's next logon`. **What 9a's DONE covers without AutoAdminLogon: the exe, the caps and the token. "The Run value and the running tray" are confirmed by a 9a re-run after srbat's next logon** (enclave-bf's nit, enclave-87) |
| 10 | ws | `hvnode-accept-remote.sh $ID <NEW key>` (G9's script); `LR get $ID`; `LR events $ID <B4>` | all PASS except R4's hostname lines (G1); R1 bootCounter = step 4's + 1, verifiedAt after the reboot. `LR get`: runner nucbox-k11, a live lease, spent6 above step 4's (renewals burned), balance6 moving on. `LR events`: PASS = 0 Claimed and 0 Released from B4 (G8); the Renewed rows are INFO and include step 8's first renewal |
| 11 | ws | `node soak.mjs --once --via x --out after-once.jsonl` | `ok:true`, status 200, `authorized:true` (a publicly trusted chain; the issuer INFO), `spkiSha256` = the NEW key (≠ `4d80b956…`) |
| 12 | ws | the evidence: `scp -r "minipc-zt:C:/Users/claude/vbs-like/hvnode/reboot-<UTC stamp>" ~/enclave-bench/reboot-v42-<stamp>/box/`; then in `~/enclave-bench/reboot-v42-<stamp>/`: `find . -type f ! -name SHA256SUMS -print0 \| sort -z \| xargs -0 sha256sum > SHA256SUMS` and `sha256sum -c SHA256SUMS` (G11) | the box OutDir (capture-pre/post.json, tray-pre/post.json, reads-post.json, the step outputs) and every ws output (steps 1, 4, 5's `LR get`, 6, 10, 11, as tee'd from step 0) are in the ws dir; SHA256SUMS written and `-c` all OK; its own sha256 sent to enclave-87 with the result |

**PASS = step 7 within 15 minutes of the boot; steps 8-11 within 30 minutes of it (the certificate window, G2); the first
renewal before the pre-reboot leaseUntil (G7); 0 Claimed and 0 Released from B4 (G8); no re-attach in the freeze (G5);
7a with no FAIL (G11: image, node tree, :9610); 9a with no FAIL (G10: the tray); step 12's SHA256SUMS checked (G11);
and no operator action.** The freeze ends when step 10 is recorded: the executor tells enclave-87. The evidence is the
reboot OutDir (box) and `~/enclave-bench/reboot-v42-<stamp>/` (ws, with SHA256SUMS, step 12). Then G3's stop and refund,
if still wanted.

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
  (`hvnode-accept.ps1 -Commit f146127176f7 -DeploymentId $ID -OwnerRestart`, G9's script: its negative probes stay on the zero
  id, and only this deliberate restart sends `$ID`), then A7 and step 11 again. FAILED.
- Everything passes except the certificate within 30 min: record FAIL(cert) (G2) and restart NOTHING. hvcert retries by
  itself; record when the install line lands.
- The node misbehaves otherwise: `hvnode-rollback.ps1` (nothing serving, nothing deleted).
- Secure Boot is off, or the legacy task changed: stop, touch nothing, report to enclave-87 and Steven.
- The box does not come back: someone has to be at the machine. Say so at once.
