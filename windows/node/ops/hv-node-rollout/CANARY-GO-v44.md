# v44 MANAGER-PATH canary on the NucBox, then the v44 install: GO-SHEET (run after v43 is installed)

For enclave-d1 (executor), for enclave-87. Written by enclave-b4 in the shape of CANARY-GO-v43.md (bf GO 4fbf51da); nothing
here was run yet. 53's pins are placeholders `<…>`. Every time is read (`date -u` on ws, `(Get-Date).ToUniversalTime()` on
the box), never estimated. Test 1 = `0x31136008aa0cf1d826d223777bed396efdf73e89ee5c82a5aabce2ca1aeeeee3` (`ID`).
`HVJ` = `node <a checkout of windows/canary-go-v44>/windows/node/ops/hv-node-rollout/hv-doc-judge.mjs` (read-only; ws needs
`VIEM_DIR` for `ws`, the box needs only node). `LR` = REBOOT-GO-v42.md's `ledger-reboot.mjs` (windows/reboot-go-sheet 307a4a1d).
`T44` = a checkout of main `c6347dd20` with node_modules linked (`git worktree add --detach <dir> c6347dd20`): the node's own
judge (hvcert.mjs `0b0b3c2b…`, judge-hv.mjs `bae3916e…`, isolation/m2/judge.mjs `24311fe8…`).

## What this canary proves, and what already exists
- PRECONDITION: v43 is INSTALLED and accepted (CANARY-GO-v43.md B5-B7), with the v42 reboot acceptance done. If v43 is not
  installed, stop and ask enclave-87 (the rollback section covers v42).
- DONE, not repeated here: the v44 image `afa9633c…` passed its DEV BOOT (enclave-d1; evidence/nucbox-devboot-afa9633c
  `626a924f`, `windows/vbslike/evidence/devboot-afa9633c-20260926/`, verified by enclave-bf). The run of record is **V1b,
  07:08:42-07:11:25Z** (firmware verified `sha256 afa9633c973dd728…` at 07:09:11, Start-VM 07:09:15, `MON ready` 07:09:17,
  console read 07:09:17.420-07:11:03.042Z = 1265 bytes, the document fetched 07:09:18.604Z). V1 is superseded (it overlapped
  the 07:05:45Z api-relay restart; kept in `superseded-V1/`, same lines). V1b-console.txt carries the manifest's N5 lines
  EXACTLY:
  - `DOM1 seccomp: runtime filter installed (sha256 d4d17c9f53832439c92a3232fd09feed8b28f0e3c7dd357d26468a9566f62b66, 71 rules)`
  - `MON dom1 seccomp: runtime filter installed (sha256 d4d17c9f53832439c92a3232fd09feed8b28f0e3c7dd357d26468a9566f62b66)`
  - no `DOM<n> ERROR the runtime's seccomp …` and no `MON dom<n> ERROR the runtime's seccomp statement: …` line;
  - with `DOM1 report_as_root=refused`, `DOM front: not dumpable; none of its 3 threads traced`,
    `DOM runtime wasmtime/48.0.1 … id=ccadb38a6779615597f0614311a631c70810916c1bbeb9f5706ee3a637fd90c8`, `ready_ms=2898`;
  - the attested document (V1b-attestation.json, a fresh nonce, HTTP 200): `abi enclave-domain-abi/2`, `runtimeSelfTest` =
    `exec_pages=allowed wx=clean maps=3 runtime=1 front=1 init=1 seccomp=d4d17c9f53832439c92a3232fd09feed8b28f0e3c7dd357d26468a9566f62b66 scope=cgroup:/dom1`;
  - V2 (07:11:43-07:12:37Z): PROBE DOMAIN RESULT PASS (`seccomp=2`; the four `filtered_vsock_*` EPERM, the distinguishing
    `filtered_vsock_host_control` against the unfiltered `timed out`); V3 (07:12:37-07:13:33Z): ProbeNeighbor
    INCONCLUSIVE (the unchanged ENOENT reason, expected).
- **G1. Why the console lines come from the dev boot, not the manager path.** The manager's launcher reads COM1 only until
  `MON ready` (wmi-launcher.mjs `GUEST_READY_LINE`, one `startAndRead`), and the domain's lines are printed AFTER it, when
  the app is served (V1's console shows them after `MON ready`). Nothing on the manager path reads COM1 later:
  hvlab-accept.mjs (`5830dedc…`) reads no console. A second reader cannot be added safely: the launcher's own reader must
  attach BEFORE Start-VM, and a reader that won that race would fail the spawn. So the lines are proven on the IDENTICAL
  IGVM bytes by the dev boot, and the manager path proves the attested equivalent:
  - the monitor states `seccomp=<hash>` in the self-test ONLY after reading domexec's fd-4 statement AND finding
    `Seccomp: 2` on every runtime process at that attestation (contract.CheckRuntimeFiltered);
  - A4 captures that document, A5 records the manager's readiness verdict on it, and A5b judges it with the node's own
    judge, requiring `runtime-covered` and the exact hash.
  - The console evidence TRANSFERS only because the bytes are the same: A1 and A3 each check that the IGVM the manager
    path boots is BYTE-IDENTICAL (sha256) to the dev-booted `afa9633c973dd728…` (V1b: `firmware … verified … sha256
    afa9633c…`). ACCEPTED by enclave-87 (2026-09-26), on that condition.
- THIS canary: the same image under v44's MANAGER set, control `9de5996a` = bd657ed0's manager set +
  `windows/vbslike/verify/` and `isolation/m2/judge.mjs` byte-equal to main c6347dd2's (ONE judge with the node; enclave-87's
  ruling). From v44, judge-hv requires every image not in `SECCOMP_UNSTATED_IMAGES` (v42 `0891c740`, v43 `49500527`) to
  state `seccomp=<64 hex>` and the attest-time form (runtime ≥ 1, the roles summing to maps). `afa9633c` is in neither
  table, so `running` + `monitor-signed` on it IS the rule's positive answer, as in v43's A5. Its negative is unit-tested
  (wx-per-image.test.mjs "an image after v43 must state its runtime's seccomp filter") and was checked on 9de5996a's tree by
  53 (afa9633c's line without seccomp: refused).
- Order (as v43): the canary on the DRY package's image and manager set; then 53 finalizes (the canary field); then bf;
  then the install of the FINAL id.

## Pins
| | |
|---|---|
| DRY package | id = manifest sha256 `<53: v44 dry id>`, packed at ws `~/enclave-bench/pkg44/out-dry/<id16>`, box stage dir `C:\Users\claude\vbs-like\pkg\<id16>\`. `pkg.mjs verify --out` PASS; dry verify PASS `<53>`. Its status says "DRY RUN, NOT A PACKAGE" |
| IGVM | IgvmRel `<53: guest\igvm-vbs\vbs-linux-candidate-<build>-afa9633c.bin>` sha256 `afa9633c973dd7283613de99df97d3f7b7f3c41ff6eeaa65bac6a52fa95957dd` (78128764 B), VBS `D9B4E0A61C6E6C75C2A5548463B6ABEE37183C06E746C974CCE3DB25ED647761`; guest from isolation/seccomp-evidence `4cd26e58` (initrd `e87157754c2806fd…`, monitor `c1ba9ccecf4928ad…`; built twice by 53, byte-identical). Twin `<53: guest\igvm-vbs\PROBE-FIRMWARE-never-a-serving-candidate\…-DEBUG-TRUSTS-HOST-d0d4db7c.bin>` `d0d4db7ccf3eb4d5a0373c8a28d63eb65c77f668f80a8a1212ac56beff5c756c` (VBS `B435D554…`, refused; for reading a failed boot only). Both must be in vmWorkerRead |
| manager set | control tree `9de5996a5c3b83d6ccab4abb8b4de2b619f3c642` (pkg/control-v44-e53): bd657ed0 + `windows/vbslike/verify/judge-hv.mjs` `bae3916e4a9ee1c3…` (git 2e0885c3) + `isolation/m2/judge.mjs` `24311fe8b4a5cc60…` (git 13fb51ed), both = main c6347dd2's. Launcher `control\vbslike-host.exe` `10547aca82ad48be021828164cd11a649cd324e37932b388449f3f44530929ba` (unchanged; boxReuse from `C:\Users\claude\d1-v42-launcher\out\build1\vbslike-host.exe`, which must still exist); runtime.json `ccadb38a6779615597f0614311a631c70810916c1bbeb9f5706ee3a637fd90c8` (unchanged); A3's `hvlab-accept.mjs` `5830dedc7ccba6e1…` and `manager-accept.ps1` `2995bb6d475148a8…` (both unchanged from v43) |
| node (B) | main `c6347dd20` = judge-hv-seccomp (4dc75f46) + the claim back-off (c6347dd2); hvcert.mjs `0b0b3c2b…` (unchanged). Archive `<53/5d: hvnode-c6347dd2.tar.gz sha256>`, MANIFEST `<…>`, lock `<…>` (stage-hvnode.sh c6347dd20 `<cli commit>`) |
| runtime pin | the node's `ENCLAVE_ISOLATION_RUNTIME_ID` = `ccadb38a6779615597f0614311a631c70810916c1bbeb9f5706ee3a637fd90c8` (= the dev boot's `DOM runtime … id=`, and the /vms record's runtimeId). HVJ `judge --pin` takes THIS, never the record's |
| host | M3 stays (AllowFirmwareLoadFromFile=1, GCS 9001); BootId as read; tpmattest `ebc30d9fa54cf70043900165ce12631224075b3301653eaf8527342d18de6982` |
| rollback inputs | v43 FINAL `<53: v43 final id>` staged at `C:\Users\claude\vbs-like\pkg\<v43 id16>\`, with ITS node f1461271 (archive `555becf2976e9f4f…`, MANIFEST `6a35018f103c002c…`, lock `f8964448…`); v42 `f813a88c…` still staged (the v42 path) |
| the judge tool | `hv-doc-judge.mjs` + `hv-doc-judge.selftest.mjs` (this branch). Before A: `node hv-doc-judge.selftest.mjs --tree $T44` = `SELFTEST ALL OK` (and `2 BAD` against an f1461271 checkout, the control: that judge has no seccomp rule). Copied to the box as `C:\Users\claude\d1-canary-v44\hv-doc-judge.mjs`, its sha256 = the branch's |

## A. The manager-path canary (production PAUSED: manager-accept refuses while manager-owned VMs exist)
| # | Where | Command | PASS when |
|---|---|---|---|
| A0 | ws + box | enclave-87's go recorded with its time; tell e3 ("NucBox pause for the v44 canary"); `node soak.mjs --once --via x` (R4 before) | go recorded; R4 `ok:true` 200 authorized on the CURRENT key (the v43 partition's) |
| A1 | ws→box | `push.sh <dry pack dir> minipc-zt`, then `stage.ps1` and `check.ps1` (+ `-SelfTest`) with `-ManifestSha256 <dry sha>`. Staging only | stage exit 0 (every file ok; the VM worker can read afa9633c + its twin); check 0; SELFTEST all. **G1's byte identity:** the staged IgvmRel file's sha256 (check.ps1's line for it, or `Get-FileHash <P>\<IgvmRel>`) = `afa9633c973dd7283613de99df97d3f7b7f3c41ff6eeaa65bac6a52fa95957dd` = the dev-booted IGVM; any other value STOPS the canary |
| A2 | ws, box | `LR get $ID` (ws); `hvnode-rollback.ps1` (box: the PAUSE, tasks Disabled, test 1's VM destroyed through the manager, the lease HELD) | `ROLLED BACK`; 0 VMs; the ledger runner is still nucbox-k11, leaseUntil recorded |
| A3 | box | with `$P = 'C:\Users\claude\vbs-like\pkg\<id16>'`: `$P\control\windows\vbslike\manager\ops\manager-accept.ps1 -Tree $P\control -Pkg $P -IgvmRel <IgvmRel> -IgvmSha256 afa9633c973dd7283613de99df97d3f7b7f3c41ff6eeaa65bac6a52fa95957dd -Serve -WmiserveRel control\vbslike-host.exe -WmiserveSha256 10547aca82ad48be021828164cd11a649cd324e37932b388449f3f44530929ba -HvlabScript $P\control\isolation\m3\hvlab-accept.mjs` | `HVLAB-ACCEPT ALL PASS` and `RESTART-ACCEPT ALL PASS` (A0-A9); image `afa9633c973dd728…` on every spawn (the launcher hashes the firmware it defines against `-IgvmSha256`: G1's byte identity on the manager path itself); `TREE UNCHANGED`; `SETTING RESTORED`; harness exit 0 |
| A4 | box (parallel with A3, while its instance runs) | the CSR: `GET /.well-known/enclave-csr` on the record's `relay.port`, as v43's A4. The document: save the RUNNING instance's record, without a BOM: `$r = @((Invoke-RestMethod -Uri 'http://127.0.0.1:18091/vms' -TimeoutSec 10 -UseBasicParsing).vms) \| ? { "$($_.status)" -eq 'running' } \| select -First 1; [IO.File]::WriteAllText("$PWD\rec.json", ($r \| ConvertTo-Json -Depth 6 -Compress))`, then `node C:\Users\claude\d1-canary-v44\hv-doc-judge.mjs fetch --view rec.json --direct 127.0.0.1:<rec.relay.port> --out C:\Users\claude\vbs-evidence\mgraccept-<stamp>\doc` | CSR 200: CN = SAN = `4e62e60d.app.enclave.host`, SPKI = the record's transportKeySha256. fetch exit 0: HTTP 200, `spki … = the record's transportKeySha256`, `nonce-echo true`, `abi enclave-domain-abi/2`, **`runtimeSelfTest` = `exec_pages=allowed wx=clean maps=N runtime=R front=F init=I seccomp=d4d17c9f53832439c92a3232fd09feed8b28f0e3c7dd357d26468a9566f62b66 scope=cgroup:/dom1` with R ≥ 1, R+F+I(+root+other) = N, and the hash EXACTLY this one** (the dev boot: `maps=3 runtime=1 front=1 init=1`) |
| A5 | box | the record: `GET :18091/vms` during the run | `status running`, `verdict` = `monitor-signed`, and the image `afa9633c973dd728…`, all RECORDED. Under v44's readiness rule (judge-hv `bae3916e…`), with afa9633c in neither table, that verdict exists only for a self-test in the attest-time form WITH a seccomp statement (G1) |
| A5b | ws | `scp` A4's `doc` directory back to `~/enclave-bench/canary-v44-<stamp>/doc`; `HVJ judge --tree $T44 --in <that dir> --pin ccadb38a6779615597f0614311a631c70810916c1bbeb9f5706ee3a637fd90c8 --expect-seccomp d4d17c9f53832439c92a3232fd09feed8b28f0e3c7dd357d26468a9566f62b66` | exit 0: `VERDICT monitor-signed wxCoverage=runtime-covered`, wxWhy `… every runtime process under the seccomp filter with program sha256 d4d17c9f53832439…`, `PASS … seccomp d4d17c9f… named=true`. verdict.json's `files` = hvcert `0b0b3c2b…`, judgeHv `bae3916e…`, judgeMjs `24311fe8…` (the node's bytes = the control's) |
| A6 | box | RESUME: `Enable-ScheduledTask` both; start the manager; wait for `/health canStart`; start the node | node.log: `renewed 0x31136008` or `claimed` (if lapsed), `attach … v2 … ACCEPTED`, `0x31136008 isolation spawned … image=4950052785daf26d…` (still v43's manager until B), then `certificate: … installed` |
| A7 | ws | tell e3 ("resumed"); `node soak.mjs --once --via x` | R4 `ok:true` 200 authorized, spki = the NEW test-1 key (v43 image) |
- **Canary PASS = A1, A3-A5 and A5b all PASS** (A1 and A3 including G1's byte identity), with A2/A6/A7 clean. The N5
  console lines are V1b's in `626a924f` (G1).
- Evidence: `~/enclave-bench/canary-v44-<stamp>/` (A5b's dir, with its verdict.json) and
  `C:\Users\claude\vbs-evidence\mgraccept-<stamp>\` (A4's `doc` dir: view.json, nonce.hex, attestation.json, cert.pem,
  spki.der, fetch.json).
- Send 53 (its OWN message): {evidence commit, README path, result line, run stamp}. 53 fills the canary field, runs the
  final build under the guard, and sends the final id to bf.
- FALLBACK if the dry package cannot be staged: the lab tree, as v43's fallback. The canary tree is the staged v43 control
  plus 9de5996a's two changed RUNTIME files (`isolation/m2/judge.mjs` `24311fe8…`, `windows/vbslike/verify/judge-hv.mjs`
  `bae3916e…`), each hash-checked against git. The IGVM goes on the lab path the dev boot used
  (`C:\Users\claude\d1-canary-afa9633c\`) with the `*S-1-5-83-0:R` grant, removed and reset after.

## B. The v44 install (after 53 finalizes the canary field and bf gives GO)
| # | Where | Command | PASS when |
|---|---|---|---|
| B1 | ws→box | `push.sh`, `stage.ps1`, `check.ps1` (+ SelfTest) for the FINAL id; `node-preflight.ps1` | stage 0, check 0, selftest all; preflight PASS except the 3 ports production holds |
| B1a | box | BEFORE B2, the rollback's inputs: `C:\Users\claude\vbs-like\pkg\<v43 id16>\win\check.ps1 -ManifestSha256 <v43 final>`; `Get-FileHash` of `C:\Users\claude\vbs-like\pkg\<v43 id16>\node\hvnode-f1461271.tar.gz` and its MANIFEST. If v43 is NOT installed (87's call only): `C:\Users\claude\vbs-like\pkg\f813a88cfa8f60a9\win\check.ps1 -ManifestSha256 f813a88cfa8f60a9d0de7e575ce44c61fd7d8d0a85c0cd933d9fe83844358672` and `hvnode\stage\hvnode-f1461271.tar.gz` | the package still staged and check exit 0; the node archive present at `555becf2…` (MANIFEST `6a35018f…`). If either fails, STOP: no rollback path |
| B2 | ws, box | `LR get $ID` (ws); `hvnode-rollback.ps1` (box: stop) | `ROLLED BACK`; lease held; 0 VMs |
| B3 | box | `<final pkg>\win\node-install.ps1 -Replace -Pkg <final pkg> -ManifestSha256 <final sha> -NodeArchive <final pkg>\node\hvnode-c6347dd2.tar.gz -NodeArchiveSha256 <…> -NodeManifest <final pkg>\node\MANIFEST-hvnode-c6347dd2.txt -NodeManifestSha256 <…> -LockSha256 <…> -TpmattestSha256 ebc30d9fa54cf70043900165ce12631224075b3301653eaf8527342d18de6982 -HostingTrayUser NUCBOX_K11\srbat` | every step `ok`; manager-config names the v44 IGVM `afa9633c973dd728…`, the launcher, and runtime.json |
| B4 | box | start the manager (canStart), then the node | `attach signature v2, 0 delegation(s)` ACCEPTED; `0x31136008 isolation spawned … image=afa9633c973dd728…`; then `0x31136008 certificate: 31136008.app.enclave.host installed in partition <new> (key <new16>…, <ZeroSSL or Let's Encrypt>; domain monitor-signed)`. The node's certificate pass judges with c6347dd2's judge-hv, so `monitor-signed` on afa9633c is again reachable only with the seccomp statement (a publicly trusted certificate within the 30-min window, as REBOOT-GO-v42.md G2) |
| B5 | box | `hvnode-accept.ps1 -Commit c6347dd20 -DeploymentId $ID`, the script at windows/negative-probes-zero-id `4bd3a9ce` (sha256 `f9208e143f6f8ed71ab08bd5bac8c83d08b7ca9726dacaae618247ea8b9b8223`, checked with `Get-FileHash` before use): A9's negative restart probes aim at the zero id, never `$ID` (enclave-87's hard rule; REBOOT-GO-v42.md G9). The older script must not be run with `$ID` | all PASS (A4's gas figure INFO in the first 12 min); A9: `none=401` on the zero id PASS, the stranger's line INFO (its proof: test/windows-node-restart-gate.test.mjs) |
| B6 | ws | `node soak.mjs --once --via x` | `ok:true`, status 200, `authorized:true`, a publicly trusted chain, `spkiSha256` = the NEW key = the manager's transportKeySha256 (`=vm`) |
| B7 | ws | the production record, READ-ONLY (REBOOT-GO-v42.md G2's q2.ps1): `ssh minipc-zt "powershell -NoProfile -Command -" < q2.ps1 > rec.json`, where q2.ps1 is `@((Invoke-RestMethod -Uri 'http://127.0.0.1:8091/vms' -TimeoutSec 10 -UseBasicParsing).vms) \| ? { "$($_.name)".ToLower() -eq '<ID lowercase>' } \| ConvertTo-Json -Depth 6 -Compress`; `HVJ fetch --view rec.json --x --out ~/enclave-bench/install-v44-<stamp>/doc`; `HVJ judge --tree $T44 --in <that dir> --pin ccadb38a… --expect-seccomp d4d17c9f…` | fetch: HTTP 200 via `/x`, the spki = the record's, a publicly trusted chain. judge exit 0: `monitor-signed`, `runtime-covered`, the self-test in the attest-time form with `seccomp=d4d17c9f53832439…` (v44's seccomp evidence now in PRODUCTION) |
| B8 | box | `Select-String C:\Users\claude\vbs-like\hvnode\logs\node.log -Pattern 'claim failed\|not asked again'` over the lines since B4 | INFO: none expected. The back-off acts only on a claim transaction that fails; test 1 is this box's own live lease, which the scan skips |
| B9 | ws | tell e3 (the verifier pin for v44, if any); `DEPLOYMENT.md` rows (the seccomp statement live on the NucBox) | recorded |

## Rollback (at any point after B2)
To v43 (the expected case: v43 was installed):
1. `<final v44 pkg>\win\node-rollback.ps1` (tasks disabled, VMs destroyed under the lock, the lease held, nothing deleted).
2. Re-install v43 FINAL with ITS node f1461271, the pair that passed v43's B5:
   `C:\Users\claude\vbs-like\pkg\<v43 id16>\win\node-install.ps1 -Replace -Pkg C:\Users\claude\vbs-like\pkg\<v43 id16> -ManifestSha256 <v43 final>`
   `-NodeArchive <v43 pkg>\node\hvnode-f1461271.tar.gz -NodeArchiveSha256 555becf2976e9f4fbfb26beecff66baab86de077aaa1f2678ee59cb18c6d9387`
   `-NodeManifest <v43 pkg>\node\MANIFEST-hvnode-f1461271.txt -NodeManifestSha256 6a35018f103c002cc12f0d4a6596cfeec9061bf7b0c9c8919d215a46ac68ac88`
   `-LockSha256 f8964448da57ad5b3754806e7ab53d6c3fa062097b17dec65e71b811a7a5a818 -TpmattestSha256 ebc30d9f… -HostingTrayUser NUCBOX_K11\srbat`.
   (c6347dd2's judge would also admit v43's 49500527, which SECCOMP_UNSTATED_IMAGES lists; but a rollback restores the pair
   that ran, and is not the place to try a new one.)
3. Start the manager, then the node. Test 1 respawns on `49500527…` (the attest-time W^X form, its seccomp filter "NOT
   positively attested"). Then R4 (`soak.mjs --once --via x`).
4. Tell e3 to put the verifier pin back to v43's, if v44's landed. M3 is unaffected either way.

To v42 (only if enclave-87 let v44 go in while v43 was NOT installed): CANARY-GO-v43.md's rollback, unchanged:
`C:\Users\claude\vbs-like\pkg\f813a88cfa8f60a9\win\node-install.ps1 -Replace -Pkg C:\Users\claude\vbs-like\pkg\f813a88cfa8f60a9 -ManifestSha256 f813a88cfa8f60a9d0de7e575ce44c61fd7d8d0a85c0cd933d9fe83844358672`
with the same node f1461271 inputs from `hvnode\stage\hvnode-f1461271.tar.gz`. Test 1 respawns on `0891c740` (the listed
legacy image, reported runtime-unmeasured). Then R4, and e3's pin back to v42's.
