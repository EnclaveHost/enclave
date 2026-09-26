# v43 MANAGER-PATH canary on the NucBox, then the v43 install: GO-SHEET (run after the v42 reboot acceptance)

For enclave-d1 (executor), for enclave-87. Written by enclave-d1 while the v42 soak ran; nothing here was run yet.
Every time is read (`date -u` on ws, `(Get-Date).ToUniversalTime()` on the box), never estimated. Test 1 =
`0x31136008aa0cf1d826d223777bed396efdf73e89ee5c82a5aabce2ca1aeeeee3` (`ID`).

## What this canary proves, and what already exists
- DONE, not repeated here: the v43 image `49500527…` passed its DEV-BOOT canary (E20: evidence/nucbox-devboot-49500527
  `fecc47ae`):
  - the front on its own uid;
  - the runtime refused a report;
  - seccomp denials;
  - `wx=at-each-attestation`;
  - `runtimeSelfTest … runtime=1 front=1 init=1 maps=3`;
  - ProbeDomain PASS.
- THIS canary: the same image under v43's MANAGER set (control `bd657ed0` = v42's `90eab896` + b4's per-image judge-hv
  `8d036dff` + the per-release `isolation/m2/judge.mjs`), through the manager's READINESS rule.
  - From v43, judge-hv requires the attest-time W^X form for every image not in `LEGACY_WX_IMAGES` (only v42's `0891c740` is listed).
  - A v43 partition whose self-test lacks it NEVER becomes `running`.
  - So `running` on this image is the rule's positive answer. Its negative is unit-tested in `wx-per-image.test.mjs`.
- Order (enclave-87): the canary on the DRY package's image and manager set; then 53 finalizes (the canary field: status +
  firmwareRecord, so the final id changes); then bf; then the install of the FINAL id.

## Pins
| | |
|---|---|
| DRY package | id `7dfc9db3ff45…` ⟨53: full manifest sha256 + the packed dir; dry verify PASS 361 ok (e3's fixture `f9452584`)⟩ |
| IGVM | `guest\igvm-vbs\…49500527….bin` sha256 `4950052785daf26d9c712a710f118211c853a04e03c01b8d77d8ac44a50327ab`, VBS `61C61AD4…` ⟨53: its exact IgvmRel in the package⟩ |
| manager set | control `bd657ed0` (⟨53: the package's control tree sha⟩), launcher `vbslike-host.exe` ⟨53: sha; 10547aca if unchanged⟩, runtime.json `ccadb38a…` ⟨53: confirm⟩ |
| node | main `f146127176f7` (live since 06:02:59Z): archive `555becf2976e9f4f…`, MANIFEST `6a35018f103c002c…`, lock `f8964448…` |
| host | M3 stays (AllowFirmwareLoadFromFile=1, GCS 9001); BootId per the reboot acceptance; tpmattest `ebc30d9f…` |

## A. The manager-path canary (production PAUSED: manager-accept refuses while manager-owned VMs exist)
| # | Where | Command | PASS when |
|---|---|---|---|
| A0 | ws + box | enclave-87's go recorded with its time; tell e3 ("NucBox pause for the v43 canary"); `node soak.mjs --once --via x` (R4 before) | go recorded; R4 `ok:true` 200 authorized on the CURRENT key (after the reboot acceptance: its new key) |
| A1 | ws→box | `push.sh <dry pack dir> minipc-zt`, then `stage.ps1` and `check.ps1` (+ `-SelfTest`) with `-ManifestSha256 <dry sha>`. This is staging only: nothing runs, and production is untouched | stage exit 0 (every file ok; the VM worker can read the v43 IGVM + twin); check 0; SELFTEST all |
| A2 | box | ledger read (depget); `hvnode-rollback.ps1` (the PAUSE: tasks Disabled, test 1's VM destroyed through the manager, the lease HELD) | `ROLLED BACK`; 0 VMs; the ledger runner is still nucbox-k11 |
| A3 | box | `<dry pkg>\control\windows\vbslike\manager\ops\manager-accept.ps1 -Tree <dry pkg>\control -Pkg <dry pkg> -IgvmRel <v43 IgvmRel> -IgvmSha256 4950052785daf26d… -Serve -WmiserveRel <dry pkg>\control\vbslike-host.exe -WmiserveSha256 <launcher sha> -HvlabScript <dry pkg>\control\isolation\m3\hvlab-accept.mjs` | `HVLAB-ACCEPT ALL PASS` and `RESTART-ACCEPT ALL PASS` (A0-A9); image `4950052785daf26d…` on every spawn; `TREE UNCHANGED`; `SETTING RESTORED`; harness exit 0 |
| A4 | box (parallel with A3) | the CSR and document fetch via the lab manager's relay (the record's `relay.port` on :18091): `GET /.well-known/enclave-csr` and `GET /.well-known/enclave-attestation?nonce=<fresh 64 hex>` | CSR 200: CN = SAN = `4e62e60d.app.enclave.host`, SPKI = the record's transportKeySha256. Document: `abi enclave-domain-abi/2`, **`runtimeSelfTest` = `exec_pages=allowed wx=clean maps=N runtime=R front=F init=I scope=cgroup:/dom1` with R ≥ 1 and R+F+I(+root+other) = N**, as the dev boot showed (`maps=3 runtime=1 front=1 init=1`) |
| A5 | box | the record: `GET :18091/vms` during the run | `status running` on image 49500527. Under v43's readiness rule, that IS judge-hv's `runtime-covered` verdict (the legacy form is refused for this image) |
| A6 | box | RESUME: `Enable-ScheduledTask` both; start the manager; wait for `/health canStart`; start the node | node.log: `renewed 0x31136008` or `claimed` (if lapsed), `attach … v2 … ACCEPTED`, `0x31136008 isolation spawned … image=0891c740…` (still v42's manager until B), then `certificate: … installed` |
| A7 | ws | tell e3 ("resumed"); `node soak.mjs --once --via x` | R4 `ok:true` 200 authorized, spki = the NEW test-1 key (v42 image) |
- **Canary PASS = A1 and A3-A5 all PASS**, with A2/A6/A7 clean.
- Evidence: `~/enclave-bench/canary-v43-<stamp>/` and `C:\Users\claude\vbs-evidence\mgraccept-<stamp>\`.
- Send 53 the result line: harness runs, the image, readiness `running`, runtimeSelfTest, CSR.
- FALLBACK if the dry package cannot be staged: the lab tree, exactly as canary 0891c740 (8d488dbf).
  - The canary tree is the staged v42 control plus bd657ed0's two changed files (`isolation/m2/judge.mjs`, `windows/vbslike/verify/judge-hv.mjs`), each hash-checked against git.
  - The IGVM goes on a lab path (`C:\Users\claude\d1-canary-49500527\`) with the `*S-1-5-83-0:R` grant, removed and reset after.

## B. The v43 install (after 53 finalizes the canary field and bf gives GO)
| # | Where | Command | PASS when |
|---|---|---|---|
| B1 | ws→box | `push.sh`, `stage.ps1`, `check.ps1` (+ SelfTest) for the FINAL id; `node-preflight.ps1` | stage 0, check 0, selftest all; preflight PASS except the 3 ports production holds |
| B2 | box | read leaseUntil; `hvnode-rollback.ps1` (stop) | `ROLLED BACK`; lease held; 0 VMs |
| B3 | box | `<final pkg>\win\node-install.ps1 -Replace -Pkg <final pkg> -ManifestSha256 <final sha> -NodeArchive <final pkg>\node\hvnode-f1461271.tar.gz -NodeArchiveSha256 555becf2976e9f4fbfb26beecff66baab86de077aaa1f2678ee59cb18c6d9387 -NodeManifest <final pkg>\node\MANIFEST-hvnode-f1461271.txt -NodeManifestSha256 6a35018f103c002cc12f0d4a6596cfeec9061bf7b0c9c8919d215a46ac68ac88 -LockSha256 f8964448da57ad5b3754806e7ab53d6c3fa062097b17dec65e71b811a7a5a818 -TpmattestSha256 ebc30d9fa54cf70043900165ce12631224075b3301653eaf8527342d18de6982 -HostingTrayUser NUCBOX_K11\srbat` | every step `ok`; manager-config names the v43 IGVM `4950052785daf26d…`, the launcher, and runtime.json |
| B4 | box | start the manager (canStart), then the node | `attach signature v2, 0 delegation(s)` ACCEPTED; `0x31136008 isolation spawned … image=4950052785daf26d…`; then `certificate: 31136008.app.enclave.host installed in partition <new> (key <new16>…, <ZeroSSL or Let's Encrypt>; domain monitor-signed)` |
| B5 | box | `hvnode-accept.ps1 -Commit f146127176f7 -DeploymentId $ID` | all PASS (A4's gas figure INFO in the first 12 min) |
| B6 | ws | `node soak.mjs --once --via x` | `ok:true`, status 200, `authorized:true`, a publicly trusted chain, `spkiSha256` = the NEW key = the manager's transportKeySha256 (`=vm`) |
| B7 | ws/box | the v43 document through the partition (A4's fetch, via the production manager's relay port) | `runtimeSelfTest` in the attest-time form (runtime ≥ 1, the roles sum to maps): v43's W^X now in production |
| B8 | ws | tell e3 (the verifier pin for v43, if any); `DEPLOYMENT.md` rows | recorded |

## Rollback to v42 (at any point after B2)
1. `<final v43 pkg>\win\node-rollback.ps1` (tasks disabled, VMs destroyed under the lock, the lease held, nothing deleted).
2. Re-install v42 with the SAME node (f1461271 has run with v42's manager since 06:02:59Z):
   `C:\Users\claude\vbs-like\pkg\f813a88cfa8f60a9\win\node-install.ps1 -Replace -Pkg C:\Users\claude\vbs-like\pkg\f813a88cfa8f60a9 -ManifestSha256 f813a88cfa8f60a9d0de7e575ce44c61fd7d8d0a85c0cd933d9fe83844358672`
   with the same `-NodeArchive/-NodeManifest/-LockSha256/-TpmattestSha256` as B3 (from `hvnode\stage\hvnode-f1461271.tar.gz`), and `-HostingTrayUser NUCBOX_K11\srbat`.
3. Start the manager, then the node. Test 1 respawns on `0891c740` (the listed legacy image, reported runtime-unmeasured). Then R4 (`soak.mjs --once --via x`).
4. Tell e3 to put the verifier pin back to v42's, if v43's landed. M3 is unaffected either way.
