# NucBox production deployment record (nucbox-k11)

Drafted by enclave-b4 for enclave-87, 2026-09-26 (read 02:25Z). Reviewed by enclave-d1 (READINESS owner) 2026-09-26 03:00Z: the d1 rows below are filled from the box and ws files named in them.
`⟨owner: …⟩` marks a result that is pending or that its owner has to supply. Nothing here is estimated.

**In one paragraph.** nucbox-k11 runs the node from main as an OWNER-ONLY host of Hyper-V partitions, one per app, on
the custom type-1 path. The boundary is **T0-hv with the host NOT excluded**. The partition's report is signed by the
launcher, not by hardware. Report capture (B1) is PARKED, so **nothing here is a hardware-rooted isolation claim**. The
box serves only its operator and the owners who delegated to it. It is never tenant capacity, it never takes secrets,
and each app has to opt in by its own envelope. This is functional serving, not proven isolated hosting.

## 1. What runs

| Component | Deployed now | Next (v43) | Where / how |
|---|---|---|---|
| Node | main **`317b3152`** (the scan-slot fix E16, -NodeOnly ⟨d1: install time⟩), after main `07fc4f55e00a` (v42's node, attached v2 at 03:34:42Z, E12) | main **`f146127176f7`** = the re-attach fix (`682dc63d`: make-before-break when owners are ADDED, break-before-make when one is REMOVED, the app zone refusing an unserved owner) + judge-hv's per-image W^X (`8d036dff`), landed 05:55:37Z, Deploy 36222222964 detect-only; ONE -NodeOnly restart ⟨d1: install time⟩. It is also v43's node pin (enclave-53: archive `555becf2…`, MANIFEST `6a35018f…`) | task `\EnclaveHvNode` (SYSTEM, boot +90 s) runs `hvnode\<c8>\windows\node\agent.mjs` in a restart loop. The engine is retired, `APPS=1`, owner-only. Staged by `stage-hvnode.sh` (ROLLOUT.md v2.3) |
| Manager, launcher, IGVM | package **v42** `f813a88cfa8f60a9d0de7e575ce44c61fd7d8d0a85c0cd933d9fe83844358672` (reproduced end to end by enclave-bf), control tree `pkg/control-v42-e53` `90eab896`; IGVM `0891c740ddf18ded…` (VBS `A39E2F8C…C817`) from guest `298924ae`, canary PASSED both paths (E11); live since 03:34Z (E12). v40 `15f39ae4…` stays staged for rollback | package **v43** (enclave-53, not yet built final): control `pkg/control-v43-e53` `bd657ed0` (v42's control + judge-hv from `8d036dff` + `isolation/m2/judge.mjs` from `0c087de8`), node `f1461271`; IGVM `4950052785daf26d…` (VBS `61C61AD4…`, initrd `15833b62`) from the reviewed chain to `0c087de8` (front uid, seccomp, W^X at each attestation); dev-boot PASS (E20). Waits for the manager-path canary (after the soak and the v42 reboot acceptance) | task `\EnclaveHvManager` (SYSTEM, boot +30 s), 127.0.0.1:8091, data plane :8092; it runs from a verified copy `hvnode\manager-<pkg8>\` |
| M3 host prerequisites | **DONE** by d1 before 00:36Z: `AllowFirmwareLoadFromFile=1` and the 9001 GuestCommunicationServices GUID, both permanent | — | enclave-53's `host-prereq.ps1` (`9abdc36c`, sha256 `4a72dab8…`) through d1's `m3-run.ps1` (`c2cb589e…`); prior state at `C:\Users\claude\vbs-like\host-prereq\prior-state.json` |
| Relay attach (flip A) | **ON**: `RELAY_HVNODE_ATTACH=1` on nan at 00:55:25Z; api relay invocation `a84854b3375f`; the node's own first `attach ACCEPTED` 00:55:36Z (node.log); the acceptance run ACCEPTED 00:57:28Z. U7 is live on all 3 relays | — | nan `/etc/nan-relay/api-relay.env` (backup `api-relay.env.bak-hvattach-on-20260926T005525Z`) |
| Relay owner-only serving (B) + `RELAY_HVNODE_OPERATORS` | **Step 1 (B's code on nan) LIVE:** main `407f0936` (a re-cut onto `864be4e5`; `relay/` identical to `4d805c1e`), pushed 02:47:26Z; Deploy 36212790450 (relay + site success; run completed 02:50:31Z); api relay restarted 02:49:19Z; step 1 ACCEPTED 02:51:35Z (enclave-e3). `api-relay.js` sha256 `d40442cc…` unchanged. **Step 2:** `RELAY_HVNODE_OPERATORS=0x389c3f030a209d04d026228d2d053feb75dbadca` ON at 02:52:13Z (api relay `e9c016e2`), ACCEPTED 02:53:59Z. **Step 3:** `RELAY_REVERIFY=enforce` ON at 02:54:26Z (`95b9b0ac`), ACCEPTED 02:56:21Z. `TRUSTED_OPERATORS` unchanged throughout (line digest `3813a04e`). **Step 1b (us-west): HELD** (no Steven ssh master), so no owner-only app is reachable by its public hostname yet. (enclave-e3's times.) **Owner-only IS exercised:** the v42 node attached v2 at 03:34:42Z with `ownerOnly:true`, `served=[operator]` (E12); owner-only serving is proven live from outside (E15) and by TEST2's delegated owner (E18, E19) | B = `relay/hvnode-owner-only-v2` `4d805c1e` (files byte-identical to the reviewed `e4d9098d`): `api-relay.js` `d40442cc3c32c72cbe3b64096384b1dfa0e2fc3b0a1e5a3c64b920ad3c5769fd`, `relay.js` `68cd3b93…`, `fleet.mjs` `0441e47d…`; plus `RELAY_HVNODE_OPERATORS=0x389c3f03…dbadca` (never `TRUSTED_OPERATORS`) | nan (CI), AND us-west (step 1b, MANUAL: us-west carries all app SNI, and without B its U7 splice refuses a non-eligible host, so no owner-only app is reachable by its public hostname; needs Steven's us-west ssh master). The v42 node signs attach v2 and carries its delegations only when the relay's challenge offers `sigVersions` 2 |
| Hosting tray | in the node since `4ef0e862`: hosting controls on 127.0.0.1:9610 (loopback only, bearer token), the caps file under `hvnode\state\` | unchanged | installed with `-HostingTrayUser NUCBOX_K11\srbat` (ROLLOUT.md v2.2.5). The tray: `EnclaveTray.exe` sha256 `3614819de95316b3…` (built on the box from `4ef0e862`'s `windows/tray/`), installed as srbat through a one-shot Interactive task at 01:36:09Z into `%LOCALAPPDATA%\Enclave\Tray\`, HKCU Run value `EnclaveHostingTray`; it reads `%ProgramData%\Enclave\hosting\hosting-admin.token`. Caps file `hvnode\state\hosting-caps.json` (cpuShare 1, gpuShare 1 since 01:38:15Z). There is no AutoAdminLogon, so the tray runs only while srbat is logged on |

Identity: the registry entry `https://api.enclave.host/t/nucbox-k11` (id `0xd497d065…`), operator
`0x389C3f030a209D04D026228D2D053fEB75DbadcA` (its key is on the box only), payout wallet `0x29479Bf0…647C`.
Standing (DIRECTION.md): Secure Boot ON; the legacy task `\EnclaveWindowsNode` is Disabled (since 2026-09-25 15:56:32Z),
never deleted; the legacy `ee-engine` is never restored or signed; respawn is OFF.

## 2. What it claims, and what it does not

**Claims (each one bounded):**
- **Boundary: T0-hv, `host_excluded=no`** (live: E12; the relay's `/enclaves` row, E15 item 5).
  - `/availability`: `isolation: hyperv-partition-per-app` and `isolationBoundary {tier: T0-hv, hostExcluded: false}`.
  - The relay's verdict on the attach: tier `hv-node`, `hvNode.hostExcluded:false`.
  - The attach proves the HOST's boot state: an EK-rooted TPM quote, Secure Boot, no test signing. It says nothing
    about a partition.
- **Owner-only.** The served owners = {the operator} ∪ {owners of valid, unexpired `enclave-host-delegation-v1`
  delegations}. The payout wallet and `OWNER_WALLET` authorize nothing.
  - The node gates claiming, the sweep's hold and restart on that set.
  - With B, the relay serves a deployment on this row only when all three hold at decision time:
    - its ledger owner is served;
    - the row holds its live lease;
    - **its own envelope requires `hyperv-partition-per-app` (E4, per-app opt-in)**. PROVEN live (E15 item 1): a
      delegated owner's app whose envelope requires `snp-guest-per-app` was refused 503 on this row.
  - Every other path is refused (tenantRoute, /t, certs, SNI).
  - An owner whose delegation is REMOVED is refused while its lease is still live (E18: THE live undelegated-owner-with-
    lease refusal), and an expired delegation stops being served at the relay without waiting for a re-attach (E19).
- **Never tenant capacity** (live: E15 item 5 - the row's `eligible` false, `teeCpu` null, not in `/v1/relays`; its
  `availability.claimEnabled` false in `enclaves.json`).
  - The relay: the row is never eligible, placed, priced or counted in the aggregate, and never on the relay roster.
  - The node: `claimEnabled` false (no tier meets the isolation contract), and attested capacity false.
- **Secrets refused.**
  - The node refuses, before any claim, a deployment with staged secrets. It asks the relay's lease-free
    `/v1/secrets/exists`; an unknown answer means no claim (live: E5 was this defect, fixed in `c5d2266a`).
  - Nothing enters a partition (node-bridge, fail-closed).
  - The relay answers `/v1/secrets/fetch` 403 `host_ineligible` to an hv-node lease holder: TEST-LEVEL only (the relay's
    tests); no live row exercises it.
- **A publicly trusted certificate on the partition's own key.** The partition holds a ZeroSSL certificate (ZeroSSL ECC
  DV SSL CA 2, CN `31136008.app.enclave.host`) on its own key (SPKI `4d80b956…` = the manager's `transportKeySha256`),
  issued through hvcert and verified over the relay's `/x` splice (E12, E15 item 2). The public-HOSTNAME route waits for
  us-west step 1b (HELD).

**Does NOT claim:**
- **Any isolation from the host, or any hardware-rooted verdict.** B1 (report capture) is PARKED. The document is
  launcher-signed; "monitor-signed" is a verdict name. The independent verifier answers `unsupported` for it
  (READINESS.md §1, §5).
- `host_excluded` (B2 PARKED), neighbour denial (B3; the neighbour probe did not run, E11: INCONCLUSIVE), or a
  domain's inability to reach the 9001 signer (U5; P1 paused).
- Confidentiality against the NucBox's operator or host.
- The certificate by its public HOSTNAME: the owner-only app is reachable only through nan's `/t/nucbox-k11/x` splice
  until us-west step 1b (HELD).
- **The v40 guest's leaks** (the front's logging, domexec's app stdio) are FIXED in the serving guest since 03:34Z (v42,
  IGVM `0891c740`, E11, E12).
- The guest RNG is seeded with host-supplied entropy (READINESS.md §1.1).
- **That the attested wx self-test covers the running runtime.** On v40 and v42 it is an early snapshot: the front measures
  once at its own start, just after the runtime is exec'd and before it has compiled the app (enclave-b4, 2026-09-26;
  enclave-87's ruling). Fixed in v43: measured at each attestation (by the monitor, which can read the runtime), naming
  what it covered (v43's IGVM `49500527`: dev-boot PASS, E20; not installed). The NucBox's own judge (judge-hv, in the
  node and the manager from `f1461271`/v43) requires that form for every image after v42 and reports v42's as
  unmeasured. The production verifier checks the field's shape only.
- **That only the domain's front can have its key attested (a known residual of v42, enclave-87's words):** "on the NucBox a
  compromised runtime can obtain monitor reports for keys of its choosing and replace the front's listen socket (shared
  domain uid); fixed in v43 by a separate front uid and a front-only report channel". Found by enclave-bf 2026-09-26
  (monitor main.go: `/run/monitor.sock` 0666 bind-mounted into every domain, the caller named by uid alone, `/run` owned
  by the domain uid); it needs a runtime escape and exists on v40 and v42. The model is runtime-vs-front (enclave-87's
  ruling); domain-vs-domain isolation still holds. The reviewed fix is the chain front-uid `ee617cac` + wx-at-attest to
  `0c087de8` (enclave-bf's NO-GO on `ee617cac`, a W^X regression, closed; the chain GO), on top of the runtime seccomp
  filter; it is in v43's IGVM `49500527` (dev-boot PASS, E20), not yet installed. The SNP tier is not affected (its front is root, its report
  interface root-only).

## 3. Evidence index

"ws:" = warden-host; "box:" = nucbox-k11.

| # | Acceptance | When (UTC) | Result | Evidence |
|---|---|---|---|---|
| E1 | M3 host prerequisites (bf GO; 87 GO) | 00:33:33–00:33:39Z | DONE: `AllowFirmwareLoadFromFile=1` (DWORD) and GCS `00002329-facb-11e6-bd58-64006a7986d3` (ElementName 'enclave report signing (wmiserve, hv_sock port 9001)'), both Absent before; the rehearsal's lock-held refusal was OK | box: `C:\Users\claude\vbs-like\host-prereq\prior-state.json`, `C:\Users\claude\vbs-evidence\m3-20260926T003333Z\`; ws: `~/enclave-bench/nucbox-m3/` (`m3-run-output-20260926T003332Z.txt`, `m3-TIMELINE.txt`: the run started after bf's GO was delivered) |
| E2 | Stage + preflight + install, node `013deb51` (ROLLOUT v2.1.1 `bf43e358`) | run 1 00:46:44Z; run 2 00:48:54Z; manager canStart 00:54:37Z; node 00:55:00Z; attach ACCEPTED 00:55:36Z after flip A | Run 1 STOPPED before any key or task (PS 5.1 `ConvertFrom-Json` refuses the lockfile's `""` key; fixed in v2.1.1 with a regex; the stage manifest also listed itself, fixed). Run 2: `ok` on every step (tree = manifest, 45 files; npm ci at the locked versions; keys SYSTEM+Administrators; manager copy = package control, 55 files + 12438 node_modules byte for byte; both tasks registered; legacy task untouched), exit 0 | ws: `~/enclave-bench/hvnode-stage-013deb51/SHA256SUMS.txt` (`fd145fca…`), `~/enclave-bench/hvnode-install-20260926T004644Z.txt`, `hvnode-install-run2-20260926T004854Z.txt` |
| E3 | Relay flip A | 00:55:25–00:57:28Z | ACCEPTED | ws: `~/enclave-bench/hvnode-attach-20260925/flip.log`, `accept-on.txt`. The latter also has one FAIL outside the hv-node attach, on the SNP release-ticket (403, expected 503) ⟨63: disposition⟩ |
| E4 | A-series on the EMPTY node (`013deb51`), then remote R1–R3 | box 00:55:39Z; remote 00:56:55Z | A1, A3, A4 PASS; A2 two FAILs ("exactly one node/manager process ()": PS 5.1 single-element unrolling in the check, fixed by 5d in v2.2.2 `c05a1d49`, PASS on the re-run at 01:29:31Z); A4 gasRenewalsLeft null until the first heartbeat (INFO; populated at 3624 at 02:19:50Z on `4ef0e862`); A8 kill-recovery PASS. Remote: 5 PASS, 0 FAIL, R2b INFO (the relay refuses `/v1/auth` for an hv-node box by design). N1: `:9600` with no or a garbage token → 401 | ws: `~/enclave-bench/hvnode-accept-empty-20260926T005539Z.txt`, `hvnode-accept-remote-empty-20260926T005655Z.txt` |
| E5 | Pre-claim defect, live: test 1 `0x31136008…` claimed at 01:00:29Z (tx `0x0340540e…`), then held 2 s later ("hasSecrets … not known") | 01:00:29Z | defect → fixed in `c5d2266a` (verdict before any claim) | box `hvnode\logs\node.log` (read 03:0xZ): `00:59:57` and `01:00:27 ledger: taking 0x31136008 …`; `01:00:29 claimed 0x31136008 (tx 0x0340540ef5980f58…)`; `01:00:31`, `01:00:32`, `01:00:58`, `01:01:28 0x31136008 isolation: hasSecrets: whether the deployment has staged secrets is not known here, and this tier refuses what it cannot verify`; `test/windows-node-preclaim.test.mjs` |
| E6 | Price-once defect, live at `013deb51`: "card price now 0" sent twice (`0xe4368ba9…` 00:55:04, `0x79ebd389…` 00:55:33) | 00:55Z | defect → fixed in `c5d2266a` (one tx, persisted). PROVEN live: `4ef0e862` started FIVE times (01:28:14Z install; 01:31:40Z after an agent kill; 01:33:05Z after the A8 kill; 02:04:45Z and 02:51:12Z, resumes after the two canary pauses), and every start listed "price 12/sec cpu" with no card price. node.log holds exactly the two 00:55 `card price now` lines and no other (read 03:0xZ) | box `hvnode\logs\node.log`; `test/windows-node-price-once.test.mjs` |
| E7 | Redeploy node `4ef0e862` (v2.2.5, `-HostingTrayUser`) | install 01:26:49Z; node up 01:28:14Z | DONE: rollback (stop) → install `-Replace -HostingTrayUser NUCBOX_K11\srbat` (`ok` on every step, tree = manifest, 46 files; exit 0) → manager → node; hosting controls on :9610; attach ACCEPTED; no price tx | ws: `~/enclave-bench/hvnode-stage-4ef0e862/SHA256SUMS.txt`, `~/enclave-bench/hvnode-install-4ef0e862-20260926T012649Z.txt` |
| E8 | Tray UI proof (the real tray in srbat's session, driven through its own window) | 01:37:14–01:38:18Z | PASS: the CPU slider set to 20% (01:37:14Z) reached the node: caps and `/availability` 0.74 → 0.19, read in that first run, with test 1 still serving. `ui-out.txt` holds the second, restoring run: set back to 100% (trackbar 20 of 20) → caps `{cpuShare:1,gpuShare:1}`, `/availability cpuShareFree 0.74`, apps.running 1; the tray's own log shows both sets | ws: `~/enclave-bench/nucbox-tray/d1-tray-ui.ps1`; box: `C:\Users\Public\enclave-tray\ui-out.txt` (sha256 `5370d147…`), `hvnode\state\hosting-caps.json` |
| E9 | Test 1 (operator-owned hello-world 1.0.4, `0x31136008aa0cf1d8…eeeee3`): A7 + R4 over loopback (the guest's key = the manager's `transportKeySha256`) | 01:29:31Z (box), 01:29:43Z (remote), 01:30:25Z (owner restart); again after each resume (02:04Z, 02:53:47Z) | PASS: `ACCEPT (box): all PASS` (A1–A4, A7; A4 gasRenewalsLeft INFO until the first heartbeat); A9 N1: no session 401, a stranger 404, the owner 200 (forced relaunch → new partition, new key). Loopback: 200 "Hello World!", and the guest's TLS SPKI = `transportKeySha256` every time (latest: hv373a3111…, key `619479c8…`, 02:53:47Z). Public R4 FAILed as expected before B (000; the relay drops TLS) | ws: `~/enclave-bench/hvnode-accept-test1-20260926T012931Z.txt`, `hvnode-accept-remote-test1-20260926T012943Z.txt`, `hvnode-accept-ownerrestart-20260926T013025Z.txt`, `~/enclave-bench/canary-0891c740/resume.txt`; box `C:\Users\claude\d1-r4-loopback.ps1` |
| E10 | v41 candidate canary `252602c8` (guest `4cdd5169`, package v41 `23a41fbd`): production node paused for it (`hvnode-rollback.ps1`: both tasks disabled, test 1's VM `hv9e568cd8…` destroyed through the manager; 01:42:37–01:42:51Z), resumed 02:04:41Z (test 1's lease had ENDED at 02:00:31Z, so the node RE-CLAIMED it: tx `0x88988cab…`, 02:04:48Z) | 01:42:37–02:04:41Z | **FAILED**: every domain `DOM1 ERROR runtime exited status=126` | ws: `~/enclave-bench/canary-252602c8/` (`harness-output.txt`, `pause.txt`, `resume.txt`); box: `C:\Users\claude\vbs-evidence\mgraccept-20260926-014333\` |
| E10a | ↳ cause: domexec opened `/dev/null` inside a chroot that has no `/dev`. Fix `683798d0f`: the monitor hands the null device on fd 3. Plus `139c3fdd4`: the front is non-dumpable and Yama ≥ 2 | 02:00–02:13Z | reviewed GO (b4, bf) | b4's reproduction (userns chroot, runtime fds = null only; control = status 126): `evidence/domexec-null-device-20260926/` (README.txt) |
| E11 | Rebuilt candidate canary: IGVM `0891c740…` (A39E2F8C), guest `298924ae`, CANARY-v41.md §0–6. Production paused 02:30:16Z, resumed 02:51:09Z (the lease was held: renewed, no claim; test 1 back on v40 as hv373a3111…) | 02:32:02–02:50:37Z | **PASS, both paths.** (i) dev boot: `MON yama ptrace_scope=1 -> 2` before `MON ready` on all 4 boots; `DOM front: not dumpable; none of its 3 threads traced`; no status=126; sentinel discard and keep-alive guard PASS. (ii) manager path (v42 manager files + launcher `10547aca`), twice: HVLAB-ACCEPT ALL PASS + RESTART-ACCEPT ALL PASS; enclave-csr for `4e62e60d.app.enclave.host` signed by the transport key. NOT RUN: kit item 4 and the neighbour probe (the dev-boot script's probe pin lacks the IGVM) | branch `evidence/nucbox-canary-0891c740` `8d488dbf`, `windows/vbslike/evidence/canary-0891c740-20260926/README.md` |
| E12 | R4 PUBLIC with a VERIFIED chain, on v42 (node `07fc4f55`, package `f813a88c`, IGVM `0891c740`): through nan's owner-only splice `wss://api.enclave.host/t/nucbox-k11/x/<id>/https` (us-west step 1b is held, so the public NAME path waits) | 03:38:11–03:38:35Z | **PASS**. The node attached v2 at 03:34:42Z, and the relay row read ownerOnly:true, served=[operator], servesDeployments=[test 1]. Test 1 respawned on 0891c740 (hv88b31102…). hvcert installed `31136008.app.enclave.host` at 03:37:38Z: ZeroSSL ECC DV SSL CA 2, until 2026-12-25. Over the splice, TLS was verified against Node's CA store with SNI `31136008.app.enclave.host`: 3/3 `x=open ca=200 k=200`, authorized=true, CN=SAN=`31136008.app.enclave.host`, status 200 with body `Hello World!`. The served SPKI sha256 `4d80b9566a3ab6c4d898b03ad09a9309f326b891f2b1ddc5bb63ab10046cccb1` = the manager's `transportKeySha256` for the partition | ws: `~/enclave-bench/v42-install/` (`v42-stage-*.txt`, `v42-check-*.txt`, `v42-preflight2-*.txt`, `stop.txt`, `v42-install-*.txt`, `start.txt`, `r4-x-verified.txt`); tool: `windows/node/ops/hv-node-rollout/test2/xsplice.mjs` (rollout `319e224f`) |
| E13 | Soak: test 1 for 12 h, then stopped (`enclave refund`) | ⟨start⟩ | ⟨pending⟩ | ⟨d1⟩ |
| E14 | Reboot acceptance (REBOOT.md; the manager-only variant first) | ⟨pending⟩ | ⟨pending⟩ | box: `C:\Users\claude\vbs-like\hvnode\reboot-<stamp>\capture-{pre,post}.json` |
| E15 | B, live OUTSIDE acceptance (bf; 9 requests from outside the box) | 04:22:25–04:24:27Z | **PASS 5/5.** (1) A stranger, hookbin `0x0ddbd824` (owner `0x2947`), via `wss://api.enclave.host/t/nucbox-k11/x/<id>/https`: 503 at 04:23:19Z and 04:23:32Z (ownerOnlySplice, api-relay.js ~2757). `0x2947` WAS delegated to this box from 04:23:18Z, so this is the E4 rule live: its app requires `snp-guest-per-app`. At 04:23:12Z, 404: no tunnel, during the owners-change re-attach (the re-attach gap: fixed in `682dc63d`, not yet installed; see the residuals). Plain `/x/<id>/https` reaches its own SNP host (a verified chain on SPKI `d6391ba7…`), never nucbox. (2) Test 1 via `/t/nucbox-k11/x` at 04:23:02.7Z: 200, authorized (ZeroSSL ECC DV SSL CA 2, CN=`31136008.app.enclave.host`), SPKI `4d80b956…`. (3) A no-session `POST /t/nucbox-k11/v1/deployments/<stranger>/restart` at 04:24:27Z: the relay's own 503 `host_ineligible` JSON (tunnelTenantRefusal); nothing forwarded. (4) `/v1/relays` at 04:22:41Z = [us-west] only; DNS app labels → 5.78.85.108; `nucbox-k11.app.enclave.host` → 46.62.128.36, the zone wildcard, not a nucbox record. (5) `/enclaves` at 04:22:25Z: nucbox-k11 is an hv-node, attach attestation, ownerOnly true, operator `0x389c…`, eligible FALSE, teeCpu null, teeGpu absent, apps.inTee false (no badge input); metal-iso0 is alone eligible (teeCpu amd-sev-snp) | ws: `~/enclave-bench/b-outside-acceptance-20260926/` (bf): `ERRATUM.txt` (sha256 `158400229b5509511e86be5598973ce26ebf1a6ea3518ea41e18bfebe172f06c`: item 1's owner is the payout wallet `0x29479bf0`, delegated at 04:23:18Z, so those 503s are the E4 rule, not an owner refusal; the live owner refusal is E18), `RESPONSES.txt` (sha256 `553cf7e6105fd91adb12a445dab3d345c50a8fdf71ebf95104bc3858370042d3`: every request with its UTC time and exact response), `enclaves.json` (04:22:25Z), `enclaves2.json` (04:24:08Z), `relays.json` (04:22:41Z), the probes `xprobe.mjs` and `wsraw.mjs` (the soak monitor's verified-TLS client at `37f057b8`), `SHA256SUMS` |
| E16 | TEST2 defect, live from 04:27:40Z (d1): the ledger scan's one claim per pass was taken by a delegated owner's OLDER row with no isolation envelope (scan policy passed; consider() then refused it on the retired-engine rule), every 30 s, so the owner's newer hyperv row `0x958ae6e9…` was never reached. No tx, no gas | 04:27:40Z → | defect → fixed in `317b3152` (main, fast-forward from `18b28218`; reviews bf + 5d GO): one claim predicate for the scan and consider(); the slot spent only at claim SEND; standing refusals held until an input changes; at most 16 declines a pass. Pushed alone 04:56:34Z; Deploy 36219319524 detect-only (relay, contracts, release, site skipped; 04:57:05Z). Install: ⟨d1: -NodeOnly install time, then 0x958ae6e9 considered in the first pass⟩ | `test/windows-node-scan-slot.test.mjs` (8/8; 11 mutants killed); box `hvnode\logs\node.log` ⟨d1⟩ |
| E17 | The relay window for the SNP tier (context for this row's owners: which SNP releases are served beside it) | 04:22:01–04:58:42Z | DONE: rs-8 at 04:22:01Z (52156652 retired); pc-2 at 04:38:08Z (main `18b28218`, the certificate set separate from the installed set); cs-3 at 04:58:42Z (`SECRETS_RELEASE_CERT_RELEASES` = f7888d86). The SNP tier then admitted AND certified only f7888d86. Since rs-9 (ACCEPTED 05:23:24Z) it admits {f7888d86, 5db18199}; rs-10 pending | branch `security/attested-release` `30ab206a` (e3): `docs/security/relay-window-20260926b/` (README, scripts; `evidence/`: `cs3-rerun.txt` = step 3's accepted run 04:56–04:58Z, `health-after-2.txt` + `deploy-run.txt` = step 2 Deploy 36218107562, `remote-3-{on,off}.txt` = step 3's first try auto-rolled back 04:45:33Z); `docs/security/attested-release-integration/retire-52156652/` (rs-8: `apply-accept.log`, `accept-sh-outputs.txt`, `nan-stage.txt`); ws raw copies `~/enclave-bench/relay-window-20260926b/`, `~/enclave-bench/relay-slice-20260925/rollout.log`. The api relay now runs `9797c8f3` |
| E18 | TEST2 (c), d1: an owner whose delegation is REMOVED is refused while its lease is still live | 05:06:32–05:29:24Z | **PASS.** ID2 `0x958ae6e9` (owner `0x2947`): delegation file removed 05:06:32.818Z, re-attach with 0 delegations accepted 05:06:58Z, relay 503 from 05:07:12Z with the lease live to 05:28:55Z; held with 0 renewals; lapse retire 05:29:24Z. THE live undelegated-owner-with-lease refusal (it replaces enclave-bf's two-cause `a69dcbba` follow-up). A second instance: after E19's re-attach the 0-delegation attach kept refusing (503) while that lease ran to 06:01:25Z | ws: `~/enclave-bench/test2/stepc-{before,removed,reattach,lapse}.txt`, `watch-958ae6e9.log` lines 79-80 (d1) |
| E19 | TEST2 (b), d1: an EXPIRED delegation stops being served at the relay, before any re-attach | 05:40:57–05:41:29Z | **PASS.** The relay stopped serving no later than 3.1 s after the delegation's signed expiry (05:41:02Z), before the node's re-attach (05:41:29Z): last 200 05:40:57.741Z, first 503 05:41:05.075Z on the OLD attach; the bound is set by the ~7 s probe cadence, not measured. The 404s at 05:41:20Z and 05:41:25Z are that re-attach's gap | ws: `~/enclave-bench/test2/stepb-{sign,served,expiry-probe,lapse}.txt` (d1); `~/enclave-bench/test2-5d/row.log` lines 156-157 (5d) |
| E19a | TEST2 (a) | — | SKIPPED ⟨d1: reason⟩ | — |
| E20 | v43 candidate dev-boot (d1): IGVM `4950052785daf26d9c712a710f118211c853a04e03c01b8d77d8ac44a50327ab` (78021436 B, VBS `61C61AD447123E42…`, initrd `15833b62ac654132…`) from the chain to `0c087de8` | ⟨d1: time⟩ | **PASS.** Console `DOM runtime selftest exec_pages=allowed wx=at-each-attestation`, no FAILED; the attested document states `exec_pages=allowed wx=clean maps=3 runtime=1 front=1 init=1 scope=cgroup:/dom1` (runtime ≥ 1, roles summing to maps), which judge-hv requires of every image after v42. Not installed | branch `evidence/nucbox-devboot-49500527` `fecc47ae` (d1; enclave-53's check) |

Source-side (no box): every windows-node suite passes at `07fc4f55`, 307/307 under the warden-host guards. The node's
own attach against the real relay (`test/windows-node-hv-attach-relay.test.mjs`) gives v1 host-only on today's relay
and v2 owner-only on main+B. b4's node landings were each pushed alone and detect-only (Deploy 36205813636,
36208165412, 36208281464, 36208809559, 36209446162, 36210014221); the recovery landing `fa4284db` Deploy 36209525281 (01:46:04Z) and the hvcert landing `bab1e36b`+`e1c665fd` (pushed together: ONE run on `e1c665fd`) Deploy 36208848926 (01:33:49Z), both detect-only; also 5d's cli/address-book-fallback `c2bbf951` Deploy 36213407535 (02:59:40Z), detect-only; b4's scan fix `317b3152` Deploy 36219319524 (04:57:05Z), the re-attach fix `682dc63d` Deploy 36221794652 (05:47:32Z) and judge-hv `f1461271` Deploy 36222222964 (05:56:00Z), each pushed alone and detect-only (read with `gh run view`).

## 4. Operations

**Rollback, per component:**

| Component | How | Leaves |
|---|---|---|
| Node + manager | box: `hvnode-rollback.ps1 [-Unregister]`: node task first, VMs through the manager, then the manager task; leftover tagged VMs only under `uefi-probe.lock` | nothing serving; `hvnode\` kept; held leases lapse on the ledger's clock. Resume (as at 02:04:41Z and 02:51:09Z): `Enable-ScheduledTask` both; `Start-ScheduledTask EnclaveHvManager`; wait for `GET 127.0.0.1:8091/health` canStart=true; `Start-ScheduledTask EnclaveHvNode`; then check node.log for `renewed` (the lease still held) or `claimed` (it lapsed), `attach ACCEPTED`, `isolation spawned`; then `/vms` and the loopback key check (`d1-r4-loopback.ps1`) |
| Node version | `hvnode-install.ps1 -Replace` stages a new tree beside the old; roll back by pointing `run-node.cmd` at the previous tree | the same `state\` |
| Package (manager, IGVM) | ⟨53: v42 → v40 rollback; v40 stays staged at `pkg\15f39ae4d1fab954\`⟩ | |
| M3 | `host-prereq.ps1 -Rollback`: restores the recorded prior state only where it is still what `-Install` set, else "LEFT: …" (exit 4) | |
| Relay flip A | nan: `relay-hvnode-attach-off.sh` (line-wise, one restart); the node's next attach is refused by name | |
| B / `RELAY_HVNODE_OPERATORS` | In reverse (security/attested-release `docs/security/hvnode-owner-only-rollout` `bf14037b`): step 3 `b-3-reverify.sh off` (unsets `RELAY_REVERIFY`); step 2 `b-2-hvops.sh off` (removes `RELAY_HVNODE_OPERATORS`: every attach is then host-only); step 1b `b-rollback-uswest.sh` (restores the `*.pre-b` relay.js/fleet.mjs, restarts tcp-relay); step 1 `b-rollback-code.sh` (a revert of B's two commits pushed to main = a relay + site redeploy) | |
| Tray | As srbat: `uninstall-tray.cmd` (from `C:\Users\Public\enclave-tray\`): stops the tray, deletes HKCU Run `EnclaveHostingTray` and `%LOCALAPPDATA%\Enclave\Tray`. The caps stay as last set, so set 100% first if wanted. The node's loopback hosting controls stay; `HOSTING_TRAY_USER` is removed by an install without `-HostingTrayUser`. Lowering a cap never evicts | the node's `hosting-caps.json` |

**Gas and renewal** (GAS.md, read 00:01:45Z; the later R3 read at 01:29:43Z, enclave-d1):
- Operator balance: 0.001450481 ETH at 01:29:43Z (nonce 1902 = 1902, nothing stuck); 0.001456565 ETH at 00:01:45Z. The floor is 0.0005 ETH; below it, top up from the operator
  gas tank (approved).
- Heartbeat: every 10 min.
- Renewal: every 30 min per live lease, inside a 15-min lead.
- Checkpoints: every 5 min per CHARGED lease; skipped at rate 0 (payout-wallet-owned = free self-hosting).
- Test 1 is charged: about 0.00027 ETH/day including heartbeats, so about 5 days on the current balance.
- The card price is 0 (engine retired). It is sent at most once and remembered across restarts for a 10-min settle.
- **Not renewed while not serving:**
  - held on the plan (`planHeld`);
  - held and not running (`isolationHeld`);
  - a failed reboot recovery (`rebootHeld`).
  At lapse such a lease is retired locally, and nothing is released on chain (`30659bf8`, `fa4284db`).
- **An unserved owner** (delegation removed or expired): the relay refuses its deployment at once (removed: from the
  re-attach, E18; expired: at serve time, before any re-attach, E19); the node holds the lease, does not renew it, and
  retires it at lapse.
  A TRANSFER stops the app at once.
- **Reboot recovery** (`fa4284db`): the recovered VM is retired, and ONE fresh partition starts on a new key in the same
  lease. A failure holds the lease until a forced relaunch, or the owner's resize or config edit.

**Owner levers (delegations):**
- Create: `node scripts/host-delegation.mjs text --owner 0x… --operator 0x389c… --box nucbox-k11 [--days 90]`, sign it
  in the owner's own wallet, and check it with `verify`. The relay refuses an expiry beyond 180 days, and at most 8
  delegations ride one attach.
- Install the `{message, signature}` file in `hvnode\state\delegations\` (ACL SYSTEM + Administrators).
  - The node re-reads that directory every tick.
  - It re-attaches, at most every 2 min, when the set changes. From `f1461271`: make-before-break when an owner is
    ADDED (no gap), break-before-make when one is REMOVED (the relay stops serving it at once, whatever becomes of the
    new attach), and the app zone refuses an unserved owner's deployment. Before it, every change drops the row ~10-30 s.
  - The relay learns a delegation only at attach, re-verifies it every minute, and checks its expiry at every decision.
- **There is no revocation list.** The owner's levers:
  1. `setConfig` to drop `isolation.require`: the app stops being served here at once;
  2. the delegation's expiry;
  3. transfer or cancel the deployment.
  The operator's lever is deleting the file: the relay refuses that owner's apps from the re-attach (E18), and the node
  holds the lease until it lapses.

**Known residuals and backlog:**

| Item | State | Owner |
|---|---|---|
| KAT cert set | DONE: pc-2 (04:38:08Z, main `18b28218`) landed the certificate set separate from the installed set; cs-3 (04:58:42Z) set `SECRETS_RELEASE_CERT_RELEASES` = f7888d86. The KAT-only `5c3561f9` and `6f14ce75` stay installed and are NOT certifiable (E17) | e3 |
| ownerOf grace | (enclave-e3, verbatim, verified against B as it will deploy, `4d805c1e`:) "recheckOwnerOnly (relay/tunnel.js:217-237) re-reads the name's on-chain owner every 60 s. A FAILED read (the RPC throws) reaches ownerOf's catch (:263-264), which returns the owner cached at attach, so an RPC blip does NOT end serving (the cached owner is kept with no time limit: it is replaced only by the next successful read, and cleared by a relay restart, after which the node must re-attach and, without a successful read, attaches host-only) (delegation expiry is still enforced, from the clock, at every decision); a name with no cached owner reads as none. A read that returns a DIFFERENT owner, none (deregistered or inactive), or an owner no longer in RELAY_HVNODE_OPERATORS ends owner-only serving at that re-check, i.e. within 60 s (:228 clears operator, served and delegations), until the node attaches again under the new owner's v2 signature. Independently, each deployment is served only while ITS ledger owner is served and this row holds its live lease, checked at every decision." | e3 |
| Separate front uid | DONE in the v43 chain (`ee617cac` + wx-at-attest to `0c087de8`, GO): the front runs as its own uid, `/run` is the front's 0700, the report channel answers the front alone. In v43's IGVM `49500527` (dev-boot PASS, E20); NOT yet installed | 53 (v43) |
| SNP front hardening | Carried since release f7888d86 (S7, 03:12:59Z) and in 5db18199 (S8, live 05:25:50Z) | 5d / 53 |
| Pre-warm | Landed with pc-2 (main `18b28218`, 04:38:08Z). The pacing follow-up `e85019c6` + `0a512d93` is GO and lands after rs-10 | e3 |
| Reboot capture S1/S2 | Required by 87: the recovery line bound to the pre instance, and pre requires the one tagged VM. DONE in `c040c9ce` (and `b8478ab0`: the reboot is decided by the box's BootId counter, exactly +1); reviewed GO by b4 | 5d |
| Front's unsolicited-response guard on the hv tier | UNREACHABLE by any app the tier serves today. The hv manager serves only bundle/1 (`manager/server.mjs` `SERVES = [DERIVATION]`): a wasi:http proxy under `wasmtime serve`, whose HTTP server frames every response. Measured with wasmtime 48.0.1 (the guest's runtime) by enclave-5d, 2026-09-26: a HEAD answered with a body goes out as headers only (chunked, or with an explicit content-length), and a GET that declares a shorter content-length than it writes is truncated to that length; no bytes land on an idle upstream connection. The vector becomes reachable only when the manager serves bundle/2 (wasi:cli apps with their own TCP server, e.g. hookbin, whose HEAD carries its body on a keep-alive connection; isolationPlan refuses them on hv today). Until then the guard's hv evidence is the canary's lab bundle/2 load (CANARY-v41.md item 2) plus its unit tests; the 12 h hv soak's leak check is NOT IN SCOPE (enclave-87's ruling). enclave-d1's live control on test 1 (02:26:30Z) agrees: a loopback `HEAD /` got headers only and 0 bytes after, and COM1 carried 0 bytes. Details: `windows/node/ops/hv-node-rollout/soak-sentinel/SOAK-SENTINEL.md` (rollout `e37a29a91`) | 5d |
| m3 monitor: user namespaces + io_uring | bf GO (runtime-seccomp `ab2aa9a5`, with the front-uid/wx chain); in v43's IGVM `49500527`, not yet installed | 53 (v43) |
| Re-attach gap | Fixed: main `682dc63d` (make-before-break when owners are added, 0 of 15 samples absent against the real relay; break-before-make when one is removed, refused at once; the app zone refuses an unserved owner), bf + 5d GO; in `f1461271` ⟨d1: -NodeOnly install⟩. Until installed, every owners change drops the row ~10-30 s (E15 item 1's 404, E19's 404s) | b4 / d1 |
| Logs | `node.log` and `manager.log` grow without bound; rotation later | 5d |
| B1 / B2 / B3, P1, U5 | parked or paused (READINESS.md §4, §5); they gate any isolation claim | Steven / provider |
