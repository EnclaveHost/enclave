# DONE-evidence audit: warden-host files the deployment record did not cite

enclave-5d, 2026-09-26, for enclave-87's DONE-evidence audit of `windows/vbslike/DEPLOYMENT.md` (branch
windows/custom-vbs-like-hyperv, head `f55cd7f87`). These are byte-identical copies of files saved on warden-host
under `~/enclave-bench/`. `ws/` keeps their relative paths. Nothing here was produced for this commit. The only
new files are this README, `ws/SHA256SUMS` and `.gitattributes`.

`.gitattributes` sets `-text`: the box's files keep their CRLF line endings, so they hash as they were saved.

Check the copies here: `cd ws && sha256sum -c SHA256SUMS`. Check the originals: `cd ~/enclave-bench && sha256sum -c <this
dir>/ws/SHA256SUMS`. Both passed at commit time, for 31 files. `ws/SHA256SUMS` sha256 =
`9d6738a68f4f10f74653988211cdf235dc814644a6116c46f547e01e93abacdf`.

Times are UTC, read from each file's own lines or its mtime.

## 1. v42 kit item 4 / the neighbour probe (for E11 and E12). Producer: enclave-d1

DEPLOYMENT.md E11 says "NOT RUN: kit item 4 and the neighbour probe". They ran on v42 at 03:40Z, after the install
(03:34Z), on the dev-boot path with the production IGVM `0891c740`. Test 1 was untouched.

| File | sha256 | What it shows |
|---|---|---|
| `ws/v42-install/item4/N-devboot.txt` | `ea5ac80a5309269a033720473b04c4a22b6347fc6a2847fd887dedb90573618e` | IGVM verified `0891c740…`. At 03:40:38Z: `NEIGHBOUR ACCEPTANCE: INCONCLUSIVE` (other_app_absolute and other_front_socket = ENOENT, target existence unshown; READINESS B3). Setting: before `Present`, 03:40:40Z `SETTING RESTORED to Present (verified)` |
| `ws/v42-install/item4/prod-before.txt` | `7d70e32152f9833a9f1352daeec5045856163d482cf1829b09d9a13838b17431` | before: test 1's record `hv88b31102…` running, key `4d80b9566a3ab6c4`; both tasks Running |
| `ws/v42-install/item4/prod-after.txt` | `995d02003c6d1f2332e7ba41581eba57b42a3101b9bd71c472702e0a3ddd85ed` | after: the same record, VM and key (up 306 s → 395 s); both tasks Running |

## 2. The tray install and UI proof (for E7 and E8). Producer: enclave-d1

E8 cites the script and the box-only `ui-out.txt`, and says the first (20%) run was "read". Both runs were saved on
warden-host, and their ui-out.txt content is inside these files. All of it ran on node `4ef0e862` + v40 (test 1 on
`hv9e568cd8…`), before v42.

| File | sha256 | What it shows |
|---|---|---|
| `ws/tray-token-acl-20260926T013517Z.txt` | `6024b17be1108863cda159b62c5e604330871fe041d737ba5bbd32b6d3f2309a` | the hosting dir and token ACL: SYSTEM and Administrators F, srbat RX (paths only, no token value) |
| `ws/tray-install-20260926T013553Z.txt` | `62244417d3abd5b4e323d9f4e58c98af72dcf72fad08a12ca5e079502dd4cca4` | the first install attempt (superseded by 013607Z) |
| **`ws/tray-install-20260926T013607Z.txt`** | `3b32b53b97fc84319fb074c7b27c4abea9817289060f33ecddf5314d03ed1ec2` | the one-shot task's result 0x0 at 01:36:07Z; `EnclaveTray.exe` running as `NUCBOX_K11\srbat` in session 1; HKCU Run `EnclaveHostingTray` |
| `ws/tray-ui-check-20260926T013632Z.txt` | `fd36c3455bc35ce99e37d52d5f2beffc31742600cd0bd9740028eb28c80a4fff` | the first UI attempt (superseded by 013709Z) |
| **`ws/tray-ui-check2-20260926T013709Z.txt`** | `29dc824383b598912e95c6a44a6a0e29d8386bc1a33f0fc25f1d8cfda50b6e9b` | **the 20% run**: the panel opened by the tray icon's click; trackbar 20 → 4; node `/v1/local/hosting` caps cpuShare 0.2; `/availability cpuShareFree 0.74 → 0.19`; the tray log `01:37:14Z set CPU 20%`; node.log `hosting caps set on this box: CPU 100% -> 20%`; test 1 still running |
| `ws/tray-ui-restore-20260926T013750Z.txt` | `b8b3c92f01400348ba3df7fcd74b027d769022ff12a70cfb580eb3fa12bd8ac7` | the first restore attempt (superseded by 013809Z) |
| **`ws/tray-ui-restore-20260926T013809Z.txt`** | `1fe03c3e33d1f2132c7316af96f20fc0a205dc702d63bce768d59942abdc6b7e` | the restore: trackbar 4 → 20; caps `{cpuShare:1,gpuShare:1}`; `cpuShareFree 0.74`; the tray log shows both sets; test 1's loopback key = the manager's `transportKeySha256`, 200 |

## 3. B's relay rollout (steps 1-3), for DEPLOYMENT.md §1's B row. Producer: enclave-e3

DEPLOYMENT.md has no evidence row for B. A subset of these files is also on security/attested-release
`docs/security/hvnode-owner-only-rollout/evidence-20260926/`. This is the whole warden-host directory, including
`rollout.log`, which the branch does not carry.

| File | sha256 |
|---|---|
| **`ws/b-rollout-20260926/rollout.log`** | `667d824c467d73a7405eae9fa96d949de0e515c627bf042e039886e19d862b47` |
| `ws/b-rollout-20260926/deploy-run.txt` | `4bafef24d9e2064757507a57ba02a285f1eb3b704ecc515745faa1ec8fee4395` |
| `ws/b-rollout-20260926/deploy-watch.txt` | `ada8884730626ddcf7de7cd2e787bd138416ee6e1cb073790b8de50ea8052db9` |
| `ws/b-rollout-20260926/health-{before,after}-*.txt`, `inv0-*.txt`, `remote-{2,3}-on.txt`, `trusted-*.txt` | in `ws/SHA256SUMS` |

What `rollout.log` records:
- step 1 pushed `407f0936` at 02:47:26Z, Deploy 36212790450, ACCEPTED 02:51:35Z;
- step 2 `RELAY_HVNODE_OPERATORS` on 02:52:12Z, ACCEPTED 02:53:59Z;
- step 3 `RELAY_REVERIFY` on 02:54:25Z, ACCEPTED 02:56:21Z;
- the `TRUSTED_OPERATORS` line digest stayed `3813a04e46c5f1ee` throughout.

**Read with it:** at steps 2 and 3 the log says owner-only was **NOT EXERCISED** ("its node has not attached with a v2
signature yet"; "owner-only null"). Step 2 did record a stranger's deployment on the splice path → 503. So owner-only
serving is proven by E12, E15, E18 and E19, not by B's own acceptance. This is the last saved read of the two env
lines. The api relay has been restarted or edited since, by pc-2, cs-3, rs-9, rs-10 and rs-11.

## 4. The relay row watched from outside during TEST2 (for E18 and E19). Producer: enclave-5d

DEPLOYMENT.md E19 cites `~/enclave-bench/test2-5d/row.log` lines 156-157 without a hash. Both files are read-only
polls of the relay's public view of the `nucbox-k11` row, from warden-host. They are independent of enclave-d1's box
reads, but not of the tools enclave-5d wrote (the `-NodeOnly` installer).

| File | sha256 | What it shows |
|---|---|---|
| **`ws/test2-5d/row.log`** | `155b31282999abf37233d39b5f093c5816a1d598a64d075b5ca5d8e6ab3e9863` | one line about every 30 s from 04:22:14Z to 06:52:01Z, with no gap over 60 s. Each line: the served owners (delegation expiry), the deployments the row serves with their lease ends, and the node's lastSeen |
| `ws/test2-5d/watch-958ae6e9.log` | `4cb50110ff208092a08a3fed3007d3a6cf467111cd019b2595e79c1a816e794a` | two reads of ID2 `0x958ae6e9…`: 04:24:24Z `served=no`, 05:05:40Z `served=yes` |

Lines in `row.log` that bear on the record:
- `04:23:15Z row ABSENT`: the owners-change re-attach gap (E15 item 1's 404 at 04:23:12Z).
- E18 (c), delegation file removed at 05:06:32.8Z:
  - `05:06:33Z` still shows `served=[0x2947(04:22:26Z),0x389c(op)]`, with `0x958ae6e9` in deps;
  - by `05:08:05Z` it shows `served=[0x389c(op)]`, `0x958ae6e9` is gone from deps, and lastSeen is `05:06:59Z` (the
    0-delegation re-attach).
- E19 (b), delegation expiry at 05:41:02Z:
  - `05:40:41Z` shows `0x958ae6e9@05:41:02Z` in deps;
  - `05:41:12Z` shows it gone from deps while lastSeen is still `05:37:24Z` (no re-attach yet);
  - `05:41:43Z` shows lastSeen `05:41:29Z` (the re-attach).
- The f1461271 install: lastSeen moves to `06:03:35Z` (the attach ACCEPTED of the -NodeOnly start at 06:02:59Z). The
  served set stays `[0x389c(op)]`, so no owners change happened on f1461271 while this watch ran.
