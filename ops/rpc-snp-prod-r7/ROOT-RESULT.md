# Base-enabled SNP images r7 and r8: production runs, 2026-11-02

**Image r7** (`/vm/enclave-volumes/rpc-snp-image-r7`)
- Built from the accepted coverage set `ops/rpc-base-coverage-r1/activation-r4`, including blob-patch.json 8bad515d.
- Measurement (8 vCPU) 51bcd3ae…36dc. It booted, and the front attested.
- **FAILED:** enclave-rpc-identity refused with "Guest runtime changed".
  - The beacon-patch rewrite of chain_service.py (port 15052 -> 15053) changed that file's sha256.
  - identity.json runtimePins still held the original hash, 75c879ec…, so the el, cl and base clients never started.
  - Public L1 was down from 18:35 to 18:49Z.
- **Fix:** build_image.py now re-pins identity.json to the shipped chain_service.py (1c3a7dbc…). It also asserts, inside the build VM, that every runtime pin matches the shipped file.

**Image r8**
- Measurement 059fbeef…0ad0. Identity verified, and L1 and Lighthouse started.
- **Base refused**, because receipts and transactions history from block 48000000 is absent.
  - The disk was downloaded with `--with-*-distance 140000`, so it holds only static files from 52.5M up.
  - chain.json `baseRetention.historyFromBlock` is 48000000.
  - The coverage activation itself passed: it is checked before the history check.
- **Remedy:** `rpc/snp/base_history_backfill.py` adds exactly the 18 receipts and transactions archives for 48.0M–52.0M from the pinned snapshot manifest. Every output's blake3 is checked before it is moved into static_files, and the db is not touched.
- While the backfill runs, the enclave runs r8 with the L1 disk only (`prod-r8-l1.json`), and public L1 is served.

**Gateway:** the control-VM allowlist now accepts measurements b04f… (r6), 51bc… (r7) and 059f… (r8). The backup is `config.attested.json.r6-only`.

**Backfill runs** (work dirs `/vm/enclave-volumes/rpc-base-history-backfill-r{1,2,3}`)
- r1 failed before downloading: getty's vhangup on ttyS0 gave EIO to cloud-init's redirect. It was first misread as an apt lock.
- **r2, 11:57–15:03 MST, FAILED partway.**
  - It installed the 7 transactions archives for 49.0M–52.5M, each blake3-verified.
  - It then refused at receipts-48000000. The `.part` files in `data/.download-cache`, left by the earlier `base snapshot download` attempt, are not zstd ("unsupported format").
  - curl had resumed onto them, so the downloads had the right size but the wrong bytes.
  - Nothing unverified was installed.
- r3 uses the fixed tool (83b844f02):
  - foreign partials are rejected by their zstd magic;
  - an archive that fails extraction or verification is fetched once more;
  - installed archives are skipped;
  - status comes back through a results disk.
  - It has 11 archives left, 104 GB.
- **r3 succeeded** (15:04–17:54 MST, RESULT `receiptSha256` ba21a80d…):
  - 33 files were added, and the 7 archives r2 had installed were already present.
  - The receipts-48.0M and receipts-49.5M downloads came back truncated; both were rejected and fetched again.

**Image r8, both disks** (2026-11-03 00:55Z): Base checked L1 while reth was still starting and got ECONNREFUSED. Because the unit is `Restart=no`, it stayed down.

**Image r9** (fc6358f7…ac3c) adds `Restart=on-failure`/60 s for enclave-rpc-base.
- Every retry then refused at l1_ready: "local RPC failed" on block 0.
- The L1 reth has pre-merge history expired (earliest block 26150000) and answers block 0 with error 4444.
- Before r8, Base had never reached this check on this disk.

**Image r10** (cf6001bc…9797) applies `rpc/snp/l1_identity_patch.py`: genesis hash or exactly error 4444. This is the coverage gate's rule, accepted in the r4 review.
- Before the swap, the patched l1_ready passed on the host against the live attested L1.
- 01:37Z: **Base passed every start check and started.** That covers coverage activation, history from 48M, state history from 52.5M, L1 ready, canonical safe origin, origin receipts and blob serving.
- 01:40Z: it is syncing from the snapshot head 53048526 and receiving unsafe payloads at about 53440340.
- The gateway allowlist now holds b04f, 51bc, 059f, fc63 and cf60. Stale entries are to be pruned once r10 serves.

**Disk guard stop** (01:54Z): `enclave-rpc-snp-disk-guard-r10` stopped r10 when /vm fell to 213 GB, under its 200 GiB floor.
- base.qcow2 had grown about 160 GB while Base's TransactionLookup stage indexed blocks 48M–53.05M.
- Public L1 was down from 01:54Z until the restart at about 02:28Z.
- **Remedies:**
  - `rpc/snp/base_cache_prune.py` (prune r1, receipt 922d9e35…) removed the stale `base snapshot download` partials from `data/.download-cache`, each checked by exact size. The 761 GB state.tar.zst.part was mostly sparse, so this freed 36 GB on the host.
  - Seven model directories, unreferenced by any service config or release manifest and idle since September/October, are being moved to `/mnt/usb/enclave-volumes-archive-20261103`. So are the superseded SNP image builds r5, r7 and r9.
  - Copies are checksum-verified before the originals are removed.
- **Capacity:** the T710 /vm holds both chains, 1.7 TB of Base and 1.1 TB of the L1 chain, with about 0.3 TB free. That headroom needs a plan before ongoing growth reaches the guard floor.

**Second guard stop** (02:23Z): TransactionLookup restarts from checkpoint 0 after an interruption, so the restarted r10 rebuilt its ETL collect. /vm fell under the 200 GiB floor again, and the guard stopped r10.
- `/vm/enclave-volumes/rpc-production-maint` (the 86 GB Oct 28–30 maintenance OS backups) was moved to the USB archive. Nothing uses it as a backing file or references it. The copy was checksum-verified before the original was removed.
- That left /vm with 361 GB free. r10 and its guard were restarted, and public L1 was serving again.
- 03:41Z: TransactionLookup finished, /vm had 327 GB free, and Base had peers. The pipeline is downloading bodies toward 53442849 (checkpoint 53414526). Execution of the remaining ~394k blocks follows. The Base head is still the snapshot head 53048526, so Base is not yet serving at the tip.

**Base at the tip** (2026-11-04 04:34Z), after the writeback-cache restart (6e134d94e, 09:47Z on 11-03):
- 11-03: execution ran at ~9 blocks/s on average and ~11.4 in the last hour (6.4 before the restart). The restart cost 36 min of reth startup (a TransactionHashNumbers consistency prune, then the start checks).
- 11-03 22:34Z: MerkleExecute was at 61%. It and the later stages took about 3.5 h and 43 GB of host space, then a catch-up pass ran.
- 04:34Z: `eth_syncing` false, head 53488715.
- `BASE-VERIFY-r10.json` (produced by `base-verify.mjs`, through the attested front pinned to the r10 measurement):
  - chainId 8453, head 53488813, lag 0 against mainnet.base.org;
  - block hashes match public Base at 48.0M, 48.1M, 50.0M, 52.6M and the head, with receipts and tx-by-hash lookups working at each;
  - the Catalog, Ledger and Registry code is present, and historical state at 52.6M answers.
- The safe head (53468342 → 53471820 over 04:36–04:51Z) is closing the ~20k-block derivation gap at ~3.9 blocks/s.
- Growth at the tip over 15 min: base.qcow2 +3 MiB (ext4 reuses blocks freed inside it) and l1.qcow2 +102 MiB (~10 GB/day). /vm has 221 GB free, so the 200 GiB guard floor is about two days away at this rate. **A storage plan is needed**: the guest pins Base history from a fixed block (48M, state from 52.5M), so the Base disk grows without bound.
- The owner signing page (`enclave-rpc-owner-sign-r10`, 127.0.0.1:42290) is serving r10's PLAN.json. Status: fund and publish are ready; payout waits for the runner's registration, which needs funding first.

## Released to production (2026-11-04)

**Owner transactions** (signed by the owner's Trezor from the r10 signing page; all status 1 on Base). Full record: `release-r10/DEPLOYMENT.json`.
- fund: block 53491090, 0.001 ETH to the runner.
- publish: block 53491100. Enclave RPC 1.0.0 is version index 1 of app 0x0f62…b537, CID bafkreibywtty…nvabe, pinning measurement cf6001bc…9797.
- payout: block 53491131.
- create: block 53491138, deployment **0x1abe9a34c07b5c9a2d0f85fd1873c1329d4fd92c3705b6c0e785ca282b970f2e**.

**Runner:** registered host 0x71ca90ce…b93b (block 53491119). After the deployment id was set in runner-prod.json, it claimed the zero-rate lease (block 53491149) and now renews it.

**HOST_DATA:** r10 was relaunched at 05:56Z with `hostData` set to the deployment id. The live report carries that HOST_DATA, measurement cf6001bc…9797 and policy 0x30000. `chain-policy.mjs resolveDeploymentPolicy` against two Base RPCs returns that measurement, that HOST_DATA, version 1.0.0 and the CID.

**Gateway** (control VM, 06:00Z): the drop-in now runs release 3ae9ab477 (byte-identical to main's gateway, attested-fetch, chain-policy and snp-verify) with `config.deployment.json`. See `release-r10/gateway-50-attested-l1.conf`.
- The attested origin is bound to the on-chain deployment. The hand-kept r6–r10 measurement list is gone.
- Ethereum stays attested-only.
- Base routes to the enclave first; the previous four providers remain as fallbacks, so the Base control plane survives an enclave outage.
- Tested locally first: with the right deployment, Base and L1 answered through the pin, including a 48M receipt; with a wrong deployment id the gateway refused.
- AMD KDS rate-limits VCEK fetches (HTTP 429, Retry-After 10). The first request after a gateway restart can therefore fail until the VCEK is cached.

**Public check, 06:10Z:** `https://api.enclave.host/rpc/ethereum` returned 26339568, equal to the enclave head. `/rpc/base` returned 53491646, equal to the enclave head and 10 blocks (~20 s) behind mainnet.base.org at query time. It serves a receipt at 48.0M.
- The relaunch cost Base ~2.4k blocks, its last persisted head, which it replayed in ~10 min.
- **Open:** Base's derived safe/finalized head is still 53471820, ~20k blocks behind, and L1 derivation is catching it up (it ran at ~3.9 blocks/s before the relaunch). The `safe`/`finalized` tags lag until it does.

**Still open:**
- All units are transient systemd-run units, so a host reboot stops production until they are started again.
- Storage: /vm has ~220 GB free, with ~10 GB/day growth at the tip, and Base history is pinned from a fixed block.
- Coverage verdict and image before ≈ 2026-11-11 16:50Z.
- The guest should require the blob-patch sha.

## Boot persistence, a stuck Base and disk churn (2026-11-05)

**Units at boot.** The five host services are now user units from `rpc/snp/systemd/`, enabled at boot (the user manager lingers):
- the guest;
- its disk guard;
- the LAN forward;
- the local proxy;
- the runner.

The node services run from `~/.local/share/enclave-rpc-snp/releases/37d9541c6/` (`git archive` plus viem 2.53.1), not from a working tree. The runner restarted cleanly: it read its registration and lease from Base and resumed renewing without sending anything.

**Disk guard floor 200 → 100 GiB (04:47Z).** /vm had fallen to 202.6 GiB. The L1 disk was briefly growing ~1 MiB/s, so the guard was within hours of stopping the enclave. 100 GiB still leaves room for the other workloads on /vm.

**Base stuck for 19 h.** From 2026-11-04 09:17Z, Base reth sat in its Bodies stage (checkpoint 53497231, target 53502760, 8 peers), while L1 and the beacon stayed at the tip.
- The gateway still sent Base to the enclave first. From then until 04:51Z, `api.enclave.host/rpc/base` returned a head ~35k blocks old.
- Fixes:
  - At 04:51Z the enclave moved to the end of the gateway's Base list.
  - At 05:00Z gateway release 52b83cbe1 with `maxLagSeconds` (base 120 s, ethereum 180 s) went live. It probes every upstream's latest block every 15 s and tries a stale upstream after the fresh ones. The enclave is first again and is demoted while behind; it logged `upstream-stale` within seconds.
- A guest restart at 04:53Z cleared the stall: Bodies completed, then two pipeline runs. Base was back at the tip at 07:43Z, 11 blocks behind public.

**Where /vm space went.** Read from each qcow2's ext4 superblock (`qemu-io -r -U`):
- **L1:** the guest holds 414 GiB, but the qcow2 holds 608 GiB on /vm.
- **Base:** the guest holds 1704 GiB, but the qcow2 holds 1748 GiB.

The disks were attached without discard, so blocks freed by reth's rolling prune (140k blocks) and Lighthouse's blob expiry (~4100 epochs) never returned to the host. That churn, not chain data, was the ~18 GiB/day. `launch.py` now takes a per-disk `"discard": true` (`discard=unmap`); this is host-side, outside the measurement. The measured image already enables `fstrim.timer` (weekly, Monday 00:00 UTC). At 07:43Z the guest was restarted with discard on both disks, under its persistent unit. The first trim should return ~238 GiB.

**After the discard restart:**
- The guest stopped cleanly in 25 s, so Base lost no blocks, and it was back at the tip at 07:49Z.
- QEMU runs both chain disks with `discard=unmap` and the same HOST_DATA.
- At 07:49:25Z the gateway logged the enclave `upstream-fresh`. Public `/rpc/base` returned 53537808, 5 blocks behind mainnet.base.org, and `/rpc/ethereum` returned 26347243.
- A failed probe counts as stale, so free providers (mostly drpc) flip stale/fresh every few minutes. That only reorders the fallbacks.

**Still open:**
- Base safe/finalized re-derivation after the restarts.
- The first fstrim (2026-11-09) needs confirming on /vm.
- Base history is pinned from 48M, so it is unbounded.
- /health doesn't report guest disk usage; the next image should add it.
- Coverage verdict and image before ≈ 2026-11-11 16:50Z.
- The guest should require the blob-patch sha.

## Base down 4.5 h, a stuck gateway and a third restart (2026-11-05 afternoon)

**Base exited and stayed down.** At 10:26–10:32Z both chain clients in the guest stalled:
- Base reth logged read transactions held open for ~315 s.
- Base's L1 watcher could not fetch logs from the guest's L1 EL (`127.0.0.1:18645`).
- After its retries ran out (`RetriesExhausted`, L1 block 26347907), the rollup node exited with status 0.

`enclave-rpc-base.service` restarts only `on-failure`, so it stayed down from 10:32Z, at Base block 53539494. The guest's L1 log had already rotated past that point by the time it was read, and the host journal shows nothing at that time, so the stall itself is unexplained.
- The gateway's freshness probe demoted the enclave, so public `/rpc/base` stayed current from the fallback providers.
- Source fix 25ca2a072 makes the restart drop-in `Restart=always`. It takes effect in the next measured image; r10 is unchanged.

**Gateway answered every Ethereum request "RPC upstream unavailable" (seen 15:04Z).** Ethereum has no fallback, so `/rpc/ethereum` was down.
- At the same time, the enclave's L1 answered attested requests from this host. From the control VM, a fresh process using the same release, config and deployment policy got the head immediately, and the policy read passed 4 times (213–687 ms).
- Each failure took ~1.2 s, about one policy read. The process had made 7 upstream errors since 04:57Z, all of them these test requests, so when it started failing is unknown.
- The catch block dropped the reason, so the cause could not be read before `systemctl restart enclave-rpc-gateway` at 15:07Z, which restored Ethereum.
- Possibly related: the runner renewed the lease at 15:03:18Z (block 53550826), and at 15:03:56Z every Base fallback failed one probe.
- A watcher on the control VM re-runs the policy read every 8 s across later renewals.

Gateway releases 48fe29f5c and 0a1b93638 (live since 15:13Z) now log `upstream-error` and `upstream-probe-error` lines with the network, upstream index and a redacted reason (with the HTTP status for a non-2xx), once a minute per reason.

**Third guest restart, 15:08Z.** This is the only way to restart a guest service. The guest stopped in 26 s and started under the persistent unit, with discard on both disks. `systemctl show` still flags the unit as transient (an attribute left from the earlier switch); it runs the persistent unit's settings and loads from the file at boot.

**Catch-up after the 15:08Z restart:**
- L1 was back at the tip by 15:11Z.
- Base started at 53539474. Gossip delivered tip blocks within minutes, but reth backfilled the 11,770-block gap as one pipeline run: Bodies 15:17–15:22Z, Execution at ~900 blocks/min until ~15:41Z, then MerkleExecute.
- That run committed at ~16:08Z. Two shorter runs followed, and latest was at the tip at 16:24Z (53553244, 8 s old).
- During the move from Bodies to Execution, host I/O pressure was 30–40% and the guest's L1 fell ~100 s behind for about 2 minutes, then recovered.
- The lease renewed at 15:23:23Z, and the control-VM policy watcher passed straight across it (leaseUntil 1793892799 → 1793894005). Since 15:13Z the gateway has logged no Ethereum errors after the guest's L1 came back.
- Safe/finalized were still at 53517842. The rollup node had just left `AwaitingELSyncCompletion` and was searching back for a derivation start; at this morning's ~130 blocks/min net, they should reach the tip around 21:00Z.

## Base stalled on its memory limit; guest restarted with 64 GiB (2026-11-05 evening)

**Base stopped executing at 16:37Z.** Latest stuck at 53553652 (16:37:31Z), one block before 53553653 (638 txs, 106.6 Mgas):
- Every attempt failed with `read transaction has been timed out` (reth's 5-minute MDBX read limit), followed by `Receipt root task received incomplete receipts`.
- Base's RPC stopped answering (`/health` base `TimeoutError`). Its EL had 0 peers, and the rollup node could not reach the guest's L1 EL at times.
- All 8 vCPUs were at 100%. qemu read the Base disk at ~1.5 GB/s (48k reads/s, all on the Base disk's worker threads).
- The image limits `enclave-rpc-base.service` to `MemoryHigh=7168M` / `MemoryMax=8192M`, and page cache is charged to that cgroup. Base's database working set no longer fits, so it re-reads instead of executing.
- The gateway's freshness probe demoted the enclave, so public `/rpc/base` stayed current from the fallbacks the whole time.

**Base's Denim upgrade activated during the stall.** At 18:00:01Z (block 53556127, timestamp 1793901600), Base moved from 2-second blocks to 5 per second. The guest's `base` v1.5.1 is the release Base requires for Denim, and the binary contains the activation timestamp. The stall began 83 minutes earlier, so it is unrelated to the upgrade.

**Fourth guest restart, 21:25:46Z, with 64 GiB.**
- `prod-r10.json` `memoryMiB` went from 34816 to 65536; the old config is kept at `prod-r10.json.pre-mem64`.
- Memory is not in the SNP launch digest (`release.py` measures vCPUs only). The new guest answered a measurement-pinned (cf6001bc…) health check, and the gateway's chain policy accepted it.
- The guest stopped cleanly in 76 s. Public `/rpc/ethereum` was down ~4 minutes, back at 21:30:00Z, 13 s behind.
- The extra memory helps L1 and the page cache outside the clients. It cannot lift Base's 8 GiB limit, which is inside the measured image.

**Source fix for the next image:** `build_image.py` raises Base to 30/32 GiB and the clients slice to 58/60 GiB, sized for a 64 GiB guest. The release that ships it should launch with `--mem-mib 65536`.

**After the 21:25Z restart:**
- Base backfilled 53553645 → 53624992 in one pipeline run. Execution ran at ~100 blocks/s (300–600 Mgas/s), well past the block that had stalled. It committed at 22:53Z, and a second run reached the tip at 23:08Z.
- After a short `sync_start` walk-back, safe/finalized began re-deriving at ~700 blocks/min. Latest was at the tip at 23:18Z.
- At ~23:45Z, following the tip live at 5 blocks/s, Base thrashed again: 1.1 GB/s reads, ~5.7 cores busy, execution down to ~30 Mgas/s.
- It fell behind and re-entered pipeline backfill at roughly 7–8 blocks/s, barely above the chain's 5. Safe/finalized slowed to ~80 blocks/min.
- Under r10's 8 GiB Base limit, the enclave cannot reliably follow Base after Denim. The gateway's maxLag keeps public `/rpc/base` on the fallbacks while the enclave lags.
- The fix is a new image with the d57d70ba0 limits, which needs a new catalog version and owner-signed release steps.

## Public Ethereum down again: TLS session resumption, and a root-image throttle (2026-11-06 00:10–00:29Z)

**Base's thrash starved the guest.** Most of the 1.1–1.8 GB/s was reads of the verity root image (`rootd`), not the Base disk, which read ~14 MB/s. Base's own program pages kept being evicted under its 8 GiB limit, and faulting them back meant dm-verity hashing plus bounce buffering. qemu ran ~900% CPU, and the front answered slowly.
- At 00:22:32Z, QMP `block_set_io_throttle` capped `d1` (Base disk) at 200 MB/s and 6000 IOPS. That had no effect, so it was cleared.
- At 00:23:42Z, the cap moved to `rootd`: 100 MB/s, 3000 IOPS. qemu fell to ~143%. L1 and the front keep their pages resident, so they are unaffected.
- Base stays starved at that cap until a new image raises its limit.
- The throttle is runtime-only and is lost at the next guest restart. `scratchpad/qmp.py rootd 0 0` clears it.

**The gateway stayed down after the guest recovered: "attestation unavailable".** A fresh request from the control VM to the front succeeded, and so did the host's own attestation fetch, but the running gateway kept failing.
- Root cause: Node's default HTTPS agent caches TLS sessions. Once the front closes an idle connection, re-attestation reconnects on the cached session. That connection resumes without the front's certificate (`isSessionReused`, no peer certificate), or resets.
- Once the pin was dropped (here by the starved guest), every re-attestation failed until the process restarted. This also explains the 15:04Z outage.
- Reproduced on the control VM: two "attestation unavailable" in a row on release 0a1b93638, then `0x1` each time with the fix. Over loopback on this host, Node cached no session, so the host did not reproduce it.
- `systemctl restart enclave-rpc-gateway` at 00:28:48Z restored Ethereum at 00:29:01Z.
- Fix 184ee05a5: attested requests use an agent with `maxCachedSessions: 0`, with a live test added. Release 184ee05a5 is live on the control VM since 00:39:45Z. The 0a1b93638 drop-in is kept at `/etc/enclave-rpc/50-attested-l1.conf.pre-184ee05a5`.
- At 00:40Z, `/rpc/ethereum` was 5–11 s behind and `/rpc/base` 0–1 s, the latter from the fallbacks.

## Released r11 (Enclave RPC 1.1.0) to a new deployment (2026-11-06 23:00–23:16Z)

r11 raises Base's limit to 30/32 GiB (r10's 8 GiB was the evening stall), and lets Base restart after L1
prunes the coverage origin (`base_restart_patch.py`), so no image is due before 2026-11-11. Full record:
`release-r11/DEPLOYMENT.json`.

**Owner transactions** (Trezor, r11 signing page; status 1). Fund and payout from r10 still applied.
- publish: block 54078152. Enclave RPC 1.1.0 is version index 2 of app 0x0f62…b537, CID bafkreifddyf4…brpqi,
  measurement 75f488ef…f6ef.
- create: block 54078292, deployment **0x694d872e5b4a9c0f02b6076efcc45384a00768f3b9c489ae7b7f5be89d8b5510**.

**Runner** (release e4b7243d4, `runner-prod.json` with the new deployment and measurement; the r10 file is
kept as `runner-prod.json.pre-r11`): re-registered the measurement (block 54078621) and claimed the new
deployment's lease (block 54078627). `resolveDeploymentPolicy` then passed in full against two Base RPCs and
allows only 75f488ef…f6ef. The r10 deployment 0x1abe…0f2e stays active on Base; its lease is no longer renewed.

**Guest swap:** r10 units disabled; `enclave-rpc-snp-prod-r10` stopped 23:02:45–23:08:11Z (clean, 5.4 min).
`enclave-rpc-snp-prod-r11`, `disk-guard-r11` and `local-proxy-r11` (release e4b7243d4) enabled and started at
23:08Z on the same L1 and Base disks, 64 GiB. At 23:09Z the attested front on 18443 reported measurement
75f488ef…f6ef, HOST_DATA = the new deployment.

**Gateway** (control VM): `config.deployment.json` moved to the new deployment, versionIndex 2, at 23:09:20Z;
the drop-in is unchanged. See `release-r11/gateway-50-attested-l1.conf`.

**Public Ethereum was down 23:02:45–23:11:22Z** (8.6 min: guest stop, boot, L1 catch-up), then one probe
timed out at 23:15:48Z. At 23:16:31Z `/rpc/ethereum` was 10 s behind and `/rpc/base` 0 s, from the fallbacks.

**Base:** the guest's Base RPC answered from boot (`syncing: true`, head 53658729, the r10 stall point).
- 23:16–01:09Z: Base's pipeline downloaded and executed the 424k-block gap to 54082270 (Headers, Bodies,
  SenderRecovery, Execution, Account/StorageHashing all at 54082270 by 00:45Z), then sat in MerkleExecute. The
  Base disk's `/data/reth.toml` (from the snapshot) keeps reth's Ethereum defaults, `[stages.merkle]
  incremental_threshold = 7000, rebuild_threshold = 100000`: a gap over 100k blocks rebuilds the whole state trie.
  On Base (5 blocks/s) 100k blocks is 5.5 h, so a rebuild longer than that would leave a gap that triggers another.

**Base trie: incremental instead of a full rebuild (2026-11-07 01:09–01:14Z).** Guest stopped (clean, 43 s);
with the qcow2 exposed through a `qemu-storage-daemon` FUSE export, `debugfs` set `rebuild_threshold = 5000000`
(~11 days of Base) in `/data/reth.toml`, owner 994:985, mode 0640, previous file kept as
`/data/reth.toml.pre-incremental`; `e2fsck -fn` clean. The same read showed `/data/enclave-origin-served.json`
= {l1Block 26262339, blobSlot 15501577, toBlock 26292338, snapshotBlock 53048526}: Base passed its first start on
r11, so pruning of the origin no longer blocks restarts. The file is on the host disk, outside the measurement,
like the rest of the L2 state (REVIEW.md (d)); it changes only how the trie is computed, not the root reth checks.
Guest restarted 01:10Z, attested 01:11:44Z; public Ethereum was down 01:09:22–01:14:10Z.
- Follow-up: have the guest set `[stages.merkle]` itself in the next image rather than rely on the disk's copy.

**That change was wrong; the rebuild resumes instead (2026-11-07 04:35–04:59Z).** From 01:32Z MerkleExecute
held at 53658729 with the Base disk reading ~26 MiB/s; from ~02:15Z Base's RPC timed out intermittently, and by
04:28Z the guest re-read its root image at 1.75 GB/s with the Base disk idle and qemu at 674% CPU: Base was
pinned at its 30 GiB MemoryHigh, refaulting its executables. Cause, from `merkle.rs` at reth 7134be3: the
00:45–01:09Z pass had taken the rebuild path, which clears `AccountsTrie`/`StoragesTrie` and commits each
progress step, so the trie tables held only that partial rebuild. The incremental path then recomputed most of the
trie from hashed state inside one uncommitted transaction. The rebuild path resumes from its saved
`MerkleCheckpoint` when its target is unchanged; reth resumes the unfinished pipeline at 54082270, so it is.
Guest stopped 04:35:32–04:36:30Z (clean). `/data/reth.toml` now has `rebuild_threshold = 420000`,
`incremental_threshold = 2000` (same owner and mode; the 5000000 copy kept as `/data/reth.toml.incremental-5m`);
`e2fsck -fn` clean. Restarted 04:37:01Z, attested with HOST_DATA = the deployment.
- 04:58:52Z: "Committed stage progress … MerkleExecute … stage_progress=7.09%", one commit every ~4 s, reth ETA
  ~7.5–8 h; root image reads 0, Base disk 25 MiB/s read and 3.6 MiB/s write.
- 420000 sits just under this gap (423540 blocks), so this run rebuilds. The next run's gap (54082270 to the tip
  when this run's Finish commits, ~300k blocks if that is ~16:00Z) takes the incremental path in 2000-block
  chunks. It would rebuild again only if Finish commits after ~22:30Z.
- Public Ethereum was down from 04:35:32Z to at most 04:43:25Z. Public Base stays on the fallbacks, current.

**Enclave Base at the tip (2026-11-07 14:11Z).** The rebuild ran at ~11.6%/h with no thrash (root image reads 0)
and MerkleExecute finished ~12:40Z. The indexing stages took minutes, and Finish committed 54082270 at ~12:49Z.
The next pipeline run (target 54325392, a 243k gap) took the incremental path as planned:
- Execution: 12:49–~13:10Z.
- MerkleExecute in 2000-block chunks: ~13:12–13:58Z, Base disk reads up to ~50 MiB/s, root reads still 0.
- Finish committed 54325392 at ~14:00Z; the engine then reached 54350163 at 14:07Z.

At 14:09Z the rollup node walked back through the sequencing window to find its safe head ("Searching for L2 safe
block beyond sequencing window"), so the head held for ~3 min. From 14:11:28Z it followed every block at 0 s lag
(`/health` base `syncing: false`). The gateway's journal shows Base upstream 0 (the enclave) `upstream-stale` from
the cutover at 2026-11-06 23:09:21Z, then `upstream-fresh` at 14:06:31Z. It was stale again 14:09:02–14:10:53Z
(the safe-head walk), then fresh. Public `/rpc/base` is served by the attested enclave again.
- The disk keeps `rebuild_threshold = 420000`, `incremental_threshold = 2000`. In source since 2026-11-07:
  `rpc/snp/base_merkle_patch.py` (applied by `build_image.py` after `base_restart_patch.py`) makes the guest set
  `[stages.merkle]` to incremental 2000 / rebuild 5000000 in Base's `reth.toml` on every start, before reth runs.
  It takes effect with the next image; r11 is unchanged. Before that image starts on this disk, confirm Base's
  MerkleExecute is not mid-rebuild.

## Gateway retries Base admission reads (2026-11-08 07:37Z)

**Symptom.** From the catch-up (2026-11-07 14:15Z) to 2026-11-08 05:47Z the gateway logged 23
`upstream-error` events on the enclave (Base upstream 0): `chain refuses enclave: eth_call failed`, about one
every 40 min. The enclave itself stayed at the tip.
- Cause: every 60 s the gateway re-reads the deployment and catalog version from each configured Base RPC
  (`rpc/snp/chain-policy.mjs`), and all of them must answer. One refused read (the public RPCs rate-limit; the
  journal shows 341 HTTP 429s over the same period) dropped the enclave's pin and failed that request over to
  the fallback providers until the next request re-read the chain.

**Fix b1c8ca472.** Each `eth_call` gets one retry after 500 ms. Every RPC must still answer and agree, and every
chain fact is still required. A failure now names the HTTP status, never the RPC URL (provider URLs carry keys).
- Tests: `test/rpc-snp/chain-policy.test.mjs` (7) and `test/rpc-gateway.test.mjs` pass. The live attested-fetch
  tests (6) pass against r11 at `https://127.0.0.1:18443`.
- Before switching, the release's `resolveDeploymentPolicy` admitted the production deployment on the control
  VM from its real config: 2 RPCs, version 1.1.0, measurement 75f488ef…, 268 ms.
- Deployed: `/opt/enclave-rpc/releases/b1c8ca472/` (root:root, files hash-checked against the commit; the
  deployed 184ee05a5 files were identical to source before the change). The drop-in
  `50-attested-l1.conf` now points there; the previous one is `/etc/enclave-rpc/50-attested-l1.conf.pre-b1c8ca472`.
  Gateway restarted at 07:37:21Z; public `/rpc/base` and `/rpc/ethereum` answered at the tip at 07:37:40Z, with
  no enclave upstream events after the restart.
- Watch 07:37:21–10:38:37Z (every 15 min): no enclave upstream events of any kind (the old rate would have
  given ~4–5 drops); public `/rpc/base` 0–1 s behind and `/rpc/ethereum` 2–14 s throughout.

## Offline trim of the r11 chain disks (2026-11-08 17:38–17:58Z)

**Why.** `/vm` had 117 GiB free and was losing ~7 GiB/day against the disk guard's 100 GiB floor. Space the
guest's filesystems had freed (mostly pruned L1 data) was still allocated in the qcow2 files, and the guest's
first weekly fstrim (2026-11-09 00:00Z) had not run. The guest has no shell, so the trim was done offline.

**Method** (scripts and log: `offline-trim-20261108/`):
- e2fsck's own `-E discard` issued no discards through a FUSE export (rehearsed on a scratch qcow2), so
  `punchfree.py` punches holes over exactly the ranges the ext4 block bitmaps mark free, shrunk inward to the
  64 KiB qcow2 cluster. It refuses a filesystem that is not clean or whose journal needs recovery.
- Rehearsal on a scratch overlay with a backing file: the freed space was returned exactly, kept files were
  byte-identical, `e2fsck -fn` and `qemu-img check` clean, backing file unchanged.
- Production, per disk: writable `qemu-storage-daemon` FUSE export with `discard=unmap` on both nodes;
  `e2fsck -fn` clean; punch; `e2fsck -fn` clean (same block and inode counts); close; `qemu-img check`.

**Result.**
- Guest stopped 17:38:53–17:39:34Z (clean shutdown), started 17:47:03Z.
- Base disk: 1766 → 1693 GiB, check clean.
- L1 disk: 673 → 376 GiB (its backing chain is opened read-only). Check reported 24 leaked clusters (1.5 MiB,
  0 corruptions), repaired with `qemu-img check -r leaks`, then clean.
- `/vm` free: 117 → 485 GiB.
- The guest attested with measurement 75f488ef… and HOST_DATA = the deployment.
- Public Ethereum (no fallback provider) was down from 17:38:53Z to 17:49:51Z, current again from 17:50:38Z.
  Public Base stayed up on the fallbacks; the enclave Base caught up ~14 min of blocks and the gateway marked it
  fresh at 17:57:41Z.
- The guest's weekly fstrim still runs; it now has little to free.

## Keeping /vm from filling: guard, guest discard, Base history window (2026-11-08 20:00–20:40Z)

**The guest's weekly fstrim never reached the chain disks.** r11's `fstrim.service` runs
`fstrim --listed-in /etc/fstab:/proc/self/mountinfo`. fstrim stops at the first non-empty file, and `/etc/fstab`
names only the read-only root; the chain disks are mounted by systemd units (`Options=rw,noatime`). The
2026-11-09 trim this record expected would therefore have freed nothing. After the offline trim, L1's qcow2
regrew 376 → 392 GiB and Base's 1693 → 1699 GiB in ~2.5 h with their filesystems' usage unchanged: rewrites
landed in the punched holes.

**Host guard, live since 20:23:17Z (48564a41a).**
- `disk_guard.py` logs free space, loss rate, days to the floor and each disk's reclaimable space every 10 min.
  Reclaimable is the qcow2 allocation minus the ext4 superblock's usage, read with `qemu-io -r -U`; L1's
  backing chain holds ~35 GiB of its data, so its estimate runs low. It warns under 250 GiB or 7 days. Under
  150 GiB with ≥50 GiB reclaimable it starts `enclave-rpc-snp-offline-trim-r11`; under 100 GiB otherwise it
  stops the guest as before.
- `offline_trim.py` is the 2026-11-08 procedure with its checks enforced (details in its docstring): at most
  daily, never after a failed run, the guest held stopped if a check fails after a punch began.
  `~/.local/state/enclave-rpc-snp/offline-trim-r11.json` was seeded with the manual run (result ok, 17:38:53Z).
- The free-range parser used at 17:38Z read dumpe2fs's unindented header count (`Free blocks: N`) as block N.
  Ranges merge only with the previous entry, and that entry came first, so it could only join a range starting
  at N+1. N was 864625149 (L1) and 519951077 (Base), and group 0 holds blocks below 32768, so it stayed one
  block, which whole-cluster alignment always drops. Fixed and tested in `offline_trim.py`.
- First status: 462.8 GiB free; L1 392.3 GiB allocated / 426.9 GiB used, Base 1699.4 / 1744.2.

**Next image: guest discard and daily fstrim (53ef2d18a).** Drop-ins give both chain mounts
`rw,noatime,discard` (the build refuses if the seed's mount units change). `fstrim.service` reads
`/proc/self/mountinfo` and runs daily, catching frees smaller than a 64 KiB cluster. QMP shows r11's chain
devices already advertise discard.

**Next image: Base history window (0eacf8edc).** `base_history_patch.py` keeps the reviewed absolute `before`
mode and raises its block at each Base start: the newest headers file's first block minus 7,000,000, whole
files, never below 48,000,000. A weekly guest timer restarts Base alone (Sunday 06:00 UTC + ≤1 h) so the floor
advances. State history (from 52.5M), coverage checks and chain.json (bound by `chainConfigSha256`) are
unchanged, and the first start prunes nothing new. Base on r11, by size: MDBX 1060 GiB, transactions
289 GiB, receipts 207 GiB, storage changesets 83 GiB, rocksdb 62 GiB, headers 31 GiB, account changesets 9 GiB.

Not yet verified: the guest-side changes run only in a new image (owner-signed release); after it boots,
confirm the qcow2 allocations track filesystem usage and the first weekly Base restart prunes to the floor.

## Image r12 (Enclave RPC 1.2.0) built and qualified, awaiting the owner (2026-11-09 04:40–05:20Z)

**Why now.** With the guard live, `/vm` lost ~220 GiB/day overnight (462.8 → 389.4 GiB, 20:23–04:23Z): the L1
qcow2 grew 59 GiB while its ext4 usage held at ~428 GiB, Base's 14 GiB. The guard would run its first offline
trim at 150 GiB (~2026-11-10 06:30Z) and then about daily, each an ~11 min public Ethereum outage. r12 makes the
guest return freed blocks itself.

**Build.** `build_image.py /vm/enclave-volumes/rpc-snp-image-r12 ops/rpc-base-coverage-r1/activation-r4` at
main 44356ac2a (126 s), as r11 was. Root hash 3d3e94be…0d29. Compared with r11 it adds e4363d333 (Base
`[stages.merkle]` set at each start), 53ef2d18a (chain mounts `discard`, daily fstrim over mountinfo) and
0eacf8edc (Base history window). `release.py --version 1.2.0 --vcpus 8 --mem-mib 65536`: measurement
**220e5ec06282a00b9bbaefc2e43f4b4729da37ee79692422392bf34ecdf4b15dd72ba15ee7bde72aadb97f86bcb91159**,
manifest CID bafkreigcdalt2wtxwqrf2pvn2mjgit3yfod7aytpiwmju6yifn26z6flmi (pinned). Records: `release-r12/`.

**Static checks of root.img** (debugfs): both mount drop-ins `Options=rw,noatime,discard`; the fstrim
overrides; `enclave-rpc-base-history.timer` enabled; `chain.json` byte-identical to r11's (so the coverage
receipt still binds it); `identity.json` pins the shipped `chain_service.py`; its diff from r11's is exactly the
merkle and history patches.

**Base history on the real disk.** Read-only (`qemu-storage-daemon`, force-share) the Base disk's
`/data/reth.toml` and static-file list: newest headers file 55000000, so the floor is 48000000 and r12's prune
flags equal r11's. That holds while the newest file starts at 55.0M (until Base passes 55.5M, ~2026-11-10
06:00Z); a later first start prunes 48.0–48.5M, as designed. The disk's `[stages.merkle]` is still
incremental 2000 / rebuild 420000; r12 sets rebuild 5000000.

**SNP smoke boot** (8 GiB, scratch 4 GiB chain disks with the production filesystem UUIDs, `discard: true`):
the live VCEK-signed report carried measurement 220e5ec0…1159. Both chain mounts succeeded with the drop-ins;
the chain clients failed on the empty disks, as expected. A 256 MiB orphan inode seeded on the scratch L1 disk
was freed at mount without a discard (ext4's mount-time orphan cleanup does not issue one; fstrim covers it).
QEMU's `unmap_operations` stays 0 even when discards do reach the image, so qcow2 allocation is the measure.

**Plain-KVM functional test** (not SNP; same kernel, initrd, root.img and root.verity, cmdline plus
`systemd.debug_shell=/dev/ttyS1`): `findmnt` showed both chain disks `rw,noatime,discard`, DropInPaths the
discard.conf, `discard_max_bytes` 2 GiB. Writing and deleting 300 MiB on the L1 disk shrank its qcow2 260 → 104
MiB. With `nodiscard` remounted on the Base disk, a deleted 300 MiB stayed allocated (305 MiB) until
`systemctl start fstrim.service` (Result=success; "3.6 GiB trimmed on /dev/vdc", "3.9 GiB trimmed on /dev/vdd"),
which took it to 4.8 MiB. `list-timers`: fstrim daily (next 00:30Z), base-history Sun ~06:00Z.

**Owner page.** `enclave-rpc-owner-sign-r12` serves `release-r12/PLAN.json` on 127.0.0.1:42290 (the r11 page,
all steps done, was still running there and is stopped). Fund and payout already apply (runner 0.00086 ETH,
registered); publish (catalog version index 3) and create remain.

**Cutover after signing** (host units `rpc/snp/systemd/*-r12.service`, prepared, not installed): runner and
gateway to the new deployment, check Base MerkleExecute is not mid-rebuild, stop r11 and start r12 on the same
disks (public Ethereum down ~6–11 min). Then verify the qcow2 allocations stop growing beyond ext4 usage and
the first daily fstrim returns the L1 disk's free space.

## Production on Enclave RPC 1.2.0 (image r12), deployment 0x5ff56a4d…454f (2026-11-10 07:50–07:57Z)

**Owner transactions.** The first publish request (09 21:26Z page click) was dropped when MetaMask reloaded at
20:25Z; a second was sent at 21:27Z. The owner signed at 07:50Z: publish `0xa0beb644…3195` (block 55533092,
catalog version index 3) succeeded; two queued duplicates, `0xa0763e44…d528` and `0x3964669c…393b`, reverted
(version 3 already present; gas only, nothing published twice). Create `0x0f531018…c624` (block 55533535)
made deployment `0x5ff56a4d600191f13ac43e1c600965673555f229472846a9da201785d396454f`. The runner claimed it
at 07:53:09Z (`0x60b59c76…897d`) and, restarted on the updated `runner-prod.json` (r11 copy `.pre-r12`),
registered the r12 measurement (`0xae134306…5536`, block 55534304) and holds the lease. Record:
`release-r12/DEPLOYMENT.json`.

**Cutover.** `prod-r12.json` is r11's with image r12, run dir `rpc-snp-prod-r12` and the new HOST_DATA; same
two chain disks (discard, Base writeback), 64 GiB, 8 vCPU. 07:53:09 r11 disk guard and local proxy stopped;
07:53:09–07:53:54 r11 guest stopped (clean); the r11 units disabled, the `-r12` units from
`rpc/snp/systemd/` installed and enabled (FragmentPath checked; offline-trim stays static). 07:54:22Z port
18443 attested measurement 220e5ec0…1159, HOST_DATA 5ff56a4d…454f. The control VM's
`config.deployment.json` moved to the new deployment, version index 3 (r11 copy `.pre-r12`), and the gateway
restarted at 07:54:35Z (`release-r12/gateway-50-attested-l1.conf`). Base was at the tip before the stop, so
the restart gap (~1k blocks) is far under the merkle rebuild threshold.

**Serving.** Public Ethereum returned at 07:57:19Z, 7 s behind (down ~3.5 min). Public Base stayed at the tip
through the provider fallbacks while the enclave's Base starts; with newest headers file 55500000 its
history floor is now 48500000, so this first start prunes 48.0–48.5M as designed. The gateway marked the enclave's Base fresh
again by 08:06:50Z (~12 min after the guest start); public Base then 7 s and Ethereum 14 s behind.

**Disk baseline** (07:55Z): /vm 258 GiB free; L1 qcow2 562.0 GiB and Base 1730.1 GiB allocated. Next: check the
allocations track ext4 usage and that the first daily guest fstrim (~00:30Z plus up to 1 h) frees the L1
backlog; the r11 deployment's lease lapses unrenewed.

**Disk after r12 (2026-11-10 16:57Z).** Within the first hour of the r12 guest /vm went from 254 to 498 GiB free:
the L1 qcow2 from 564.9 to 379.1 GiB allocated (ext4 used 430 GiB) and Base from 1730.1 to 1672.1 GiB. The
first-hour timing suggests the fstrim timer's catch-up run, which cannot be confirmed from the host. Since
08:53Z the allocations track ext4 usage (L1 379→381, Base 1672→1678 GiB) and /vm went 498→490 GiB in 8 h,
~24 GiB/day of real chain growth instead of ~220 GiB/day of churn. The disk guard reports 0 GiB reclaimable,
so its offline trim is no longer due.

**Fleet app (2026-11-12).** The RPC deployment is now claimed and run by fleet host metal0 through the ordinary
claim path, not by its dedicated runner. Source: `metal/snpvm-supervisor-patch.py`, `rpc/snp/vm-manager.mjs`,
`runner.mjs --release`, `enclave-rpc-snp-disk-guard-fleet.service` (51b949df5, d947cefaa, 69c614782).

*Preparation (05:10–05:38Z).* metal0's control image rebuilt from its deployed tree (metal-deabf8f90) plus the
snpVm patch: `~/enclave-prod/dist-snpvm-b4446c3`, measurement c9fe2438…12d5, added to the relay's
`METAL_ALLOWED_MEASUREMENTS` (backup `linux-leasegas-measurements.env.before-snpvm-b4446c3`); metal0 restarted on it
(config backup `config.json.before-snpvm-b4446c3`), admitted, and re-adopted 0xda09d0f2 and 0xef514ed3. Host
manager `enclave-snpvm-manager` on 127.0.0.1:8099 binds the deployment to image r12, the two chain disks of
`prod-r12.json`, hostfwd 18443→8443, unit `enclave-rpc-snp-guest`, run dir `rpc-snp-fleet-r12`. Owner signed
`setConfig` with `{"placement":{"hostId":0x4dde6d1b…68be},"snpVm":{"app":"enclave-rpc","measurementsFrom":
"catalog://0x0f628585…b537/3"}}`.

*First attempt (≈05:17Z) refused.* metal0 claims with app-funded lease gas only; the RPC's reserve was funded
(0.0002 ETH by `enclave-gas-refill@rpc`) but its policy had never been configured, because the dedicated runner paid
its own gas: "the app's owner has not enabled a lease-gas reserve". Rolled back to prod-r12 and the runner (RPC down
~5 min). Owner then signed `EnclaveLeaseGasReserve.configure` (self-hosted policy, as 0xda09d0f2); `reserveOf`
enabled at 05:38:45Z. Before the second attempt the rest of `_check` was read off chain: `rateFor` 0 against
`capOf` 1, `leaseSec` 1800 ≥ `minExtension`, metal0's payout wallet = the owner.

*Cutover.* 05:41:06Z runner stopped; 05:41:06–05:41:54 prod-r12 guest stopped (clean); 05:42:04 the runner's lease
released (0xcabac1ae…a490, block 56358745); 05:42:52 metal0's claim landed (0xa79d91db…fba2), the app's reserve
paying 2204523593855 wei; 05:42:55 the manager launched VM svc5c9c7e782de8357 as `enclave-rpc-snp-guest`. Port
18443 attests measurement 220e5ec0…1159 and HOST_DATA 5ff56a4d…454f. L1 and Base answered from the guest by
05:47:31Z (L1 at head), Base at the tip by 05:49:13Z; public Base stayed at the tip on the provider fallbacks
meanwhile. Ledger runner is metal0's enclave id; the relay lists the deployment `running` on `metal0`.

*Host state.* `enclave-rpc-snp-prod-r12` and `enclave-rpc-snp-runner` are stopped and disabled: starting either
beside the fleet guest would contend for the chain disks (the manager refuses a launch while they are open) or for
the lease (the runner ignores the placement pin). `enclave-rpc-snp-disk-guard-fleet` guards the fleet guest; the
local proxy and LAN forward are unchanged (still 127.0.0.1:18443). At boot `enclave-metal` and
`enclave-snpvm-manager` start and the supervisor relaunches the guest from its record. Rollback: stop
`enclave-rpc-snp-guest`, start prod-r12 and the runner (the runner re-claims once metal0's lease lapses or is
released).

*Open.* The live control image predates the certificate-pass skip for whole-VM apps (this commit), so metal0 logs
"no certificate for 5ff56a4d.app.enclave.host (guestd answered 404…)" on a growing back-off; harmless, gone with the
next control image. The refill session for the RPC's reserve has a 5 USDC budget.

*First app-funded renewal.* 06:08:40Z metal0 renewed the lease (0x4b930730…d456) to 06:38:39Z, the app's reserve
paying 1223369848543 wei. The claim was not a one-off: the fleet path carries the RPC from one lease to the next.

*Dashboard row.* The row showed its Open control in pulsing amber ("no answer yet"). The dashboard derived
`https://5ff56a4d.app.enclave.host` and probed it, but a whole-VM app ends TLS on its own attested certificate and
its host publishes no app-zone route, so nothing can answer there. Main c2b36aa62: a row whose catalog version is
runtime `sev-snp-vm` has no address, no Open link and no phone pairing, and says so (catalog version 3's inline
config, read off chain, carries the runtime). The live site is the additive composite r4, built from the
reconstructed graph and not from main, so the fix reaches it as its own additive release:
`site-whole-vm-row-r5/` (CID bafybeigmmb…slyaq). The operator activated it on the four edges 2026-11-12 06:35Z to
06:38Z (each edge: 1570 files verified, two roots switched, r4 tree kept; evidence in its `activation/`). The live
row now reads "no app address · an API served on the VM's own attested certificate" with no Open control, seen in a
signed-in browser with no console errors.

*Not done.* A whole-VM app has no browser address at all. Giving it one needs a publicly trusted certificate held
by the guest (a new image and catalog version) or a measured terminator in front of it, plus route proofs for
whole-VM apps in the network agent, the relay and the checkers. Separate work.

## Image r13 (Enclave RPC 1.3.0): a browser address for the whole-VM app, built and qualified (2026-11-12)

*Why.* The row said "no app address". The owner asked for what every other app has: a URL, an Open control and a
page behind it. Main 154f4f458 and 6b8079c10 give a whole-VM app that address without moving its key out of the VM:
the guest's front serves a page at `/`, answers `?nonce=` attestation bound to the key it serves, and writes a CSR
for `<8 hex>.app.enclave.host` on that key; the manager has the relay's certificate service issue for the name
(the host must hold the live lease) and installs the chain in the guest, which refuses any certificate that is not
for its own key; the host agent admits the VM on a fresh AMD-signed report (measurement listed by the lease's
catalog version, HOST_DATA the deployment, report_data the served key and the nonce) and then routes the name to
the VM's port byte for byte.

*Build.* `rpc/snp/build_image.py` at main 6b8079c10 into `/vm/enclave-volumes/rpc-snp-image-r13` (110 s). Root
hash `34e4b48c…7a00`, kernel 6.8.0-147, 8 vCPU launch measurement `f3e72089…4b5c`, manifest
`bafkreid6dijafkq5nndcy2hhwoe4xygi6zwvwgcgsv3akbffckz2ghhofi` (pinned on this host). Records in `release-r13/`.
`chain.json` is byte-identical to r12's: the chain clients and their data layout do not change.

*Qualified by an SNP boot* on a scratch deployment id with empty scratch chain disks
(`/vm/enclave-volumes/rpc-snp-smoke-r13`, since stopped):

| Check | Result |
|---|---|
| live report's measurement | equals the offline one |
| `GET /` on the app name | 200, the page, hash-pinned CSP |
| `/l1`, `/base`, `/beacon/`, attestation | as r12 |
| CSR | CN and SAN the app name, on the served key |
| report with a nonce, judged by `relay/snp-verify.mjs` with this host's VCEK and chain | accepted |
| same report: other deployment, other nonce, other key, r12's measurement list, no VCEK, microcode floor 255, empty policy | each refused |
| agent probe against the boot (self-signed) certificate | refused: not a WebPKI chain for the name |
| installing a certificate for another key | 422 |
| guest clock | synchronised, skew 0 |

The accepted report and its refusals are kept as a test (`test/fixtures/snp-vm/r13-smoke.json`,
`test/snp-vm-app.test.mjs`).

*Found by the qualification.* metal0's agent names its own verifier module for its other guests, so the AMD chain
was seeded into that copy only; the verifier the whole-VM path bundles held none and, judging offline, would have
refused every report. The agent now seeds both.

*Not exercised.* The relay issuing a certificate for the app name, and the chain manager → guest install →
`route.json` → reconciler → agent admission, need a real lease on the name: they first run at the production
cutover. Nothing here is live: production is still r12 (1.2.0) with no app address.

## r12 → r13 cutover: prepared, waiting for the operator and the owner (2026-11-12)

Everything the move needs is built and checked without touching production; `release-r13/README.md` has the order,
the scripts, the rollback and what first runs live.

- *Owner.* `rpc/snp/owner-sign/upgrade-plan.mjs` builds the three transactions from the release record (publish
  version 4; stop; set the version, the config and start in one multicall); the signing page offers a step only
  when the chain and the host's manager binding are ready for it, and simulates it from the owner address first.
- *Host.* `release-r13/host-prepare.sh`: the network agent and reconciler with the whole-VM path on the deployed
  tree (266c98d1f, whose rebuild equals the deployed bundles byte for byte), and the manager on release 19572bf2c
  with the certificate service and the r13 binding. Each swap is verified and undone if its check fails.
  `release-r13/finish.sh`: after the start, the host-local proxy and the gateway's chain policy follow to r13 and
  version 4, then the certificate, the route and the app address are waited for.
- *Site.* `site-whole-vm-address-r6/` (CID bafybeihcq2…e5ia), built on r5 and preflighted: the row shows its
  address and Open link once its version declares `endpoints.web`.

The production steps are the operator's (`release-r13/run-cutover.sh`) and the three signatures the owner's.
Production is unchanged until then: r12, catalog version 3, no app address, site r5.

## r12 → r13 cutover run; an outage while metal0 was unregistered after its restart (2026-11-12 08:44–16:19Z)

Run and times: `release-r13/README.md`. Production is Enclave RPC 1.3.0 (image r13, measurement f3e72089…4b5c) on
catalog version 4, with site release r6 on the four edges.

- *What worked on the first live run.* Owner publish, stop and start; metal0's claim and the manager's launch on the
  r13 binding (front ready 13 s after launch); the relay's certificate for `5ff56a4d.app.enclave.host` (ZeroSSL, not
  after 2027-02-10), installed in the guest; route record, reconciler enrolment, agent admission, edge routing; the
  dashboard row RUNNING with its address and Open link (10:19Z). L1, beacon and Base were at head by 14:55Z.
- *Guest front.* The first certificate delivery raised on its own log line after the chain was in service; the
  manager's retry a minute later was confirmed. Fixed in `rpc/snp/front.py` (bdacc0f1a); image r13 carries the bug.
- *Platform host policy quorum.* metal0 did not claim for 45 minutes because the control image read the policy
  through 3 of 4 Base RPCs of which two no longer answer keyless traffic. Main 5b292efce: five endpoints, majority 3.
  Control image `~/enclave-prod/dist-snpvm-16520ea` (initramfs a6b7e1a7…51e0, measurement a74528dc…e1e8) is the
  running tree with that one change; in service since 14:47:56Z (`release-r13/control-image.sh apply`): relay
  allowlist extended (previous kept as `linux-leasegas-measurements.env.before-snpvm-16520ea`), metal0's config kept
  as `config.json.before-snpvm-16520ea`. Admitted 14:48:10Z.
- *Gateway.* Chain policy on version 4 since 14:53Z (previous config kept as `.pre-r13` on the control VM).
- *Outage 15:04:39Z to 16:18:34Z: metal0 unregistered.* A supervisor start needs one registry transaction from the
  operator key `0xC9D0835Cd8eBc7eaE84304d9DB0A76253EebE6aB`; the key held 4.8e-7 ETH and the transaction was refused
  for cost from 14:48Z. Unregistered, metal0 neither renews nor claims: the lease ended 15:04:39Z, and the address,
  the agent and the gateway refused the still-running guest, as they should. A retry was accepted when the fee fell,
  16:16:43Z (3.17e-7 ETH); metal0 claimed 16:18:00Z and adopted the running VM; address, gateway and dashboard row
  were back by 16:18:43Z.
- *Open.* The operator key holds 1.6e-7 ETH: the next start of metal0 stops at the same transaction unless the key is
  funded first (the operator's step). The proof-of-time checkpoints spend from the same key, emptied it, and have
  failed since 03:51Z.
- *Funding it.* A plain transfer to that key reverts (it is EIP-7702-delegated to the lease executor, which has no
  payable entry). The owner signing page has a top-up plan (`rpc/snp/owner-sign/topup-plan.mjs`): one contract
  creation whose init code is `73 <operator> ff`, simulated on both RPCs and executed on a local fork;
  `release-r13/TOPUP-PLAN.json` is that plan for 0.001 ETH. The owner signed it at 18:09:41Z (`0xbdeff637…4717`,
  block 56583032): the key holds 0.001 ETH more, delegation and nonce unchanged, and the checkpoints land again since
  18:13:11Z.
- *Open.* A checkpoint costs the key about 9e-7 ETH, about 2.6e-4 ETH a day, so the top-up lasts about 3.8 days at
  this fee and nothing refills the key by itself. Before any restart of metal0, read the key's balance first.

## Operator key drain: checkpoints for a free lease; control image 66335ab, active 2026-11-13 00:11Z

Detail: `control-image-66335ab/README.md`.

- *Cause.* Enclave RPC is leased at rate 0 (the owner's host, the owner's app). The ledger credits rate x proven
  time, so its proof-of-time checkpoints credit nothing, yet metal0's supervisor posted one every 300 s from the
  operator key: about 9e-7 ETH each, 2.6e-4 ETH a day. That is what emptied the key before the 15:04Z outage, and
  what would empty the 18:09Z top-up about 2026-11-16.
- *Source.* Main 1186ab801: `supervisor.js` proves no lease whose mirrored rate is exactly 0 (steady and final
  period), names it once (`[proof] no checkpoints for <id>: a free lease (rate 0) has nothing to credit`), and
  measures the operator key's runway (`[gas] operator key … is low`, `operatorGas` on the host record).
  `metal/free-lease-proof-patch.py` applies the same text to the supervisor generation metal0's image overlays;
  `test/free-lease-proof.test.mjs` (8 tests).
- *Image.* `~/enclave-prod/dist-snpvm-66335ab`: 16520ea plus that patch; initramfs 1a6e0cf0…9ae1, measurement
  5d91b402…536a. Only `/app/supervisor.js` and the added `/app/windows/node/gas-runway.mjs` differ. The measurement
  is computed with the command line the host launches with (`metal.mode=snp` in place of the `cmdline` file's
  `${MODE}`); the same command reproduces b4446c3 and 16520ea as the relay accepted them.
- *Active.* The operator ran `control-image-66335ab/control-image.sh apply`: metal0 restarted on the image
  2026-11-13 00:11:42Z, the relay accepted measurement 5d91b402… at 00:11:56Z, registered 00:12:02Z, adopted the
  running VM 00:13:00Z (guest not restarted), named the free lease 00:17:54Z, renewed 00:36:01Z until 01:06:00Z. No
  checkpoint since the restart; the key held 9.359e-4 ETH at 00:12Z and at 00:36Z. A restart costs it 5.0e-7 ETH
  (registration and price), so it now lasts for about 1,800 restarts instead of four days.

## Image r14 (Enclave RPC 1.4.0): memory the guest was not asked for; built and qualified, not live (2026-11-13 02:20Z)

*Why.* The owner asked for Enclave RPC to use less memory. Measured on r13: the guest's unit is charged 82.84 GiB
on the host, about 61 GiB of it pinned guest memory (64 GiB given by the catalog version; SEV-SNP, no balloon, no
swap) and about 18 GiB host page cache for the Base disk, which the host can take back. Inside, the root is a
read-only verity image under a tmpfs overlay, so every log line is guest memory: Base writes about 1,243 MB of log
text a day and r13 keeps it twice (journal and rsyslog's file). The client limits are bytes sized for 64 GiB, so
the guest could not simply be made smaller, and nothing reports what the clients need.

*Change.* Main 25dbcf4d6: journal capped at 256 MB and not copied to syslog, Base in its own 256 MB journal
namespace, 39 stock units masked, limits as shares of the guest's memory, `GET /memory` on the guest's local name,
and a working-set probe (`rpc/snp/memprobe.py`) that for 48 hours asks a quiet clients' slice for 0.2% of its
memory a minute and sets no limit. Clients, versions and data layout unchanged.

*Build.* `/vm/enclave-volumes/rpc-snp-image-r14` (115 s), root hash `d0b6040a…1a58`, kernel 6.8.0-147, 8 vCPU launch
measurement `aa1807f5…42e0`, manifest `bafkreiepolr6ewdbfzvxd4forprmpyp57ey5mydrpn42xq4blki7xg2xma` (pinned on this
host). Records, scripts and the order of the move in `release-r14/`.

*Qualified.* Plain KVM, r13 and r14 on the same rig with the same 380 MB flood into each journal
(`rpc/snp/kvm_check.py`):

| | r13 | r14 |
|---|---|---|
| running services at idle | 16 | 13 |
| resident memory at idle | 195,692 kB | 157,244 kB |
| overlay (guest memory) after the flood | 1,286 MB, 536,684,887 bytes of it the syslog copy | 512 MB, at the two caps |
| stock units | none of the 39 masked, 20 active | all masked |

SEV-SNP boot on a scratch deployment id (`/vm/enclave-volumes/rpc-snp-smoke-r14`, 02:10:40Z to 02:12:46Z, since
stopped): live measurement equals the offline one; the repository's verifier accepts it and refuses r13's
measurement and another deployment; `/memory` answers on the local name only; limits are 90% / 94% of the 8 GiB
the smoke guest was given.

*Not exercised.* The clients on the real chain disks under r14, and the probe against real clients: both first
run at the cutover.

*Not live when this was written* (live since 02:54Z, next section). Production was still r13 (1.3.0, version 4). The move is the operator's
`release-r14/run-cutover.sh` and three owner signatures (publish version 5, stop, start): an outage for the stop
and start. r14 at 64 GiB does not lower what the host pins; it stops the growth and makes the need readable. The
reduction is a later catalog-only version with a smaller memory size, chosen from the probe's report.

## r13 to r14 (Enclave RPC 1.4.0, catalog version 5): in production 2026-11-13 02:54Z; host memory unchanged, as expected

*Run.* The operator ran `release-r14/run-cutover.sh` (manager bound to r14 at 02:33:35Z); the owner signed publish
(02:34:49Z, `0x5bf5bbce…dd50`), stop (02:35:05Z, `0x1b086c6e…16ba`) and start (02:53:22Z, `0xda8d4cca…2180`). metal0
tore r13 down at 02:35:55Z, claimed 45 seconds after the start (`0x44a9b830…5d7b`) and launched r14 at 02:54:11Z
(8 vCPU, 65536 MiB). Front attested with `aa1807f5…42e0` at 02:54:32Z, certificate 02:55:26Z, gateway on
`versionIndex` 5 at 02:56:52Z, app address 200 at 02:57:06Z, Ethereum at head 02:57:28Z, Base at head 03:15:40Z.
Full table and hashes in `release-r14/README.md`.

*Outage.* Public Ethereum about 21 minutes (02:35:55Z to 02:57Z), 17 of them the wait for the start signature.
Base in the guest 40 minutes; public Base falls back to its providers by design (not read during the outage).

*Memory, measured.* 03:26Z, all clients at head: clients' slice 55.65 GiB, on its high limit (anonymous 9.66,
file 40.29); Base 43.79 GiB; `/var/log` 129 MB and capped at 512. The host charges the guest's unit 84.4 GiB
(r13: 82.84): **r14 at 64 GiB lowers nothing on the host.** It was 27.5 GiB for the first minutes only.

*The probe does not measure.* Base walks its mapped database at about 62 MB a second and re-reads 5% of what it
gives up; the probe's 1.9 MB a second never brings the slice off its limit, and the limit's own reclaim is the
pressure that holds the probe. Harmless (no limit set, stops after 48 hours), and not a working-set reading.

*Next.* A catalog-only version with less memory (same image and measurement; owner-signed publish, stop, start).
48 GiB leaves Base the 30 GiB it had on r13 if the Ethereum clients stay at the 12 GiB they hold on r14 (half of
r13's reserve for them, seen for half an hour); lower is untested (8 GiB failed on 2026-11-05). Read the anonymous
memory and the Ethereum node's re-read rate after a day first. Rollback from r14: an owner-signed start on version 4
with `~/.config/enclave/snpvm.json.r13`.

## Enclave RPC 1.4.1 (image r14 in a 48 GiB guest, catalog version 6) in production since 2026-11-13 16:30Z

*The run.* The owner signed publish (`0x1c9b1e48…7724`, 16:26:44Z), stop (`0x08fd352a…b5f5`, 16:27:08Z) and start
(`0xada0d998…daef`, 16:29:09Z), before the day-later reading the section below asks for. metal0 tore the guest
down at 16:27:55Z, released and claimed the lease, and launched at 16:30:13Z with `8 vCPU, 49152 MiB`; qemu runs
with `-m 49152`, same image and measurement as 1.4.0. `finish.sh` moved the gateway to `versionIndex` 6 at
16:33:11Z (`.pre-1.4.1` kept). Public Ethereum was out from 16:27:55Z for about five to six minutes; the minute it
answered again is not on record. The guest's Base was within the gateway's lag limit again at 16:36:49Z.

*Checked 18:13Z to 18:20Z.* Deployment active and leased on `/6`, route record on `/6`, app address 200, gateway
answering both chains, reth, Lighthouse and Base at head, no `oom` or `oom_kill` in any client's `memory.events`.

*Measured.* Before the move (64 GiB, 16:21Z, 13 h 27 min up): anonymous 14.38 GiB and still rising about 0.14 GiB
an hour; reth held 18.15 and Lighthouse 16.84 (25.5 of it page cache), **Base 20.66, at head**: Base does not need
the 28 to 30 GiB the sizing assumed. After (48 GiB, 18:17Z, 1 h 47 min up): MemTotal 46.09 GiB (estimated 46.3),
slice 41.48 on its limit, anonymous 11.97 and rising as after any start, Base 29.34 (page cache 20.84), reth 5.51,
Lighthouse 6.64; Base reads back 6.0% of what is taken from it (7.8% over the whole 64 GiB boot).

*The host.* 46.37 GiB of the guest unit's charge is pinned (`unevictable`), against about 60 of 64 GiB before:
about 14 GiB less now, 16 less than the old guest would have reached. The unit's total charge is still 79 GiB
because the host's own page cache for the disk images is counted in it and fills what is free. Host MemAvailable
50.7 of 124.8 GiB (28.3 at 06:40Z).

*Not known.* Whether it holds over a day: where the anonymous memory stops, and whether Base stays at head once
reth and Lighthouse have filled their page cache inside a 41.5 GiB slice. A reading is due about 2026-11-14
16:30Z. Not looked into: metal0's hourly `[isolation] … no certificate … guestd answered 404` line for this
deployment while its address answers with a certificate. The way back (owner-signed start on version 5 and the
gateway's `.pre-1.4.1`) is not scripted and not exercised. Details and tables: `release-r14-48g/README.md`.

*Also.* `rpc/snp/memtrend.py` no longer measures growth across a restart of the guest (it compared 14.38 GiB
before with 11.84 after and printed a fall).

## Enclave RPC 1.4.1: as prepared, before it was published (2026-11-13 06:55Z; live since 16:30Z, section above)

*What exists.* Release `/vm/enclave-volumes/rpc-snp-release-r14-48g` (copies in `release-r14-48g/`): r14's image
and measurement, `res [0,0,49152,0]`, manifest `bafkreieeaqac6x…qjv4` pinned on this host. Owner plan: publish
version 6, stop, start (publish simulated from the owner, nothing sent). Signing page up at
http://127.0.0.1:42295 (unit `enclave-rpc-owner-sign-r14-48g`), nothing signed; its lead text says not to sign
before the day-later reading. `release-r14-48g/run-cutover.sh` and `finish.sh` are written and syntax-checked,
**not run**: `finish.sh` reads the launched qemu's `-m` (the reader was tried on the running guest: 65536) and stops
if it is not 49152. The host needs no change: the size comes from the catalog version, the image and the proxy's
pin are r14's.

*Reading 06:40Z, 3 h 46 min after the start, all clients at head.* Slice 55.64 GiB on its limit; anonymous 13.28
(reth 3.48, Lighthouse 5.06, Base 4.74), page cache 36.63 (Base 32.84); Base re-reads about 7% of the 35 to 48
MB/s taken from it. **The anonymous memory is still rising**: 9.23 GiB at 03:24Z, 13.26 at 06:24Z, +0.75 GiB an
hour over the last two hours.

*What 48 GiB would give (estimated, not measured).* MemTotal about 46.3 GiB, slice about 41.6; with reth and
Lighthouse at today's 13.2 GiB Base gets about 28.4 GiB in total, **below the 30 GiB it had on r13**, and less by
whatever the anonymous memory still adds. This corrects the "48 GiB leaves Base the 30 GiB" of the section
above. The host gets back at most 16 GiB.

*Not known.* Where the anonymous memory stops; how much page cache Base needs to keep following the chain.
Conditions for signing, the larger size to make instead (52 GiB) and the way back (owner-signed start on version
5, not scripted, not exercised) are in `release-r14-48g/README.md`.

*Also here.* `rpc/snp/memtrend.py` (host-side: a table and the anonymous-memory growth from stored `/memory`
reports and the probe's half-hourly samples), `test/rpc-snp/test_memtrend.py`; `release-r14-48g/reading.sh` stores
one reading. No timer takes readings.

## Enclave RPC after a host boot: what brings it back (read 2026-11-12, not exercised)

Read from the host's units and configuration; the host was not rebooted (up since 2026-11-01 19:28 MST).

- *The chain of starts.* User units start without a login (`Linger=yes`). Enabled: `enclave-metal` (metal0's control
  VM, after `enclave-guestd`), `enclave-snpvm-manager`, `enclave-rpc-snp-local-proxy-r13`, `enclave-network-agent`,
  `enclave-network-reconcile.timer`, `enclave-rpc-snp-lan-forward-r1`, `enclave-rpc-snp-disk-guard-fleet`,
  `enclave-gas-refill` and its instances. The guest unit `enclave-rpc-snp-guest` is transient: the manager creates
  it with `systemd-run` when metal0's supervisor asks. So the guest returns only after metal0 has attested to the
  relay, been admitted, registered (one transaction from the operator key), claimed or resumed the deployment and
  called the manager (`POST /vms`, 201). That launch path ran once in production, at the r13 cutover (10:14:59Z);
  the restarts since then adopted the running VM (409) instead.
- *Disks.* `/vm` (image, chain disks) is a LUKS volume opened from a key file by `systemd-cryptsetup@cryptvm`, no
  prompt. The root volume is LUKS too (`rd.luks.name=…=cryptroot`, no TPM option on the kernel command line); at the
  last boot its unlock took 28 s, which is a passphrase typed at the console. **After a power cycle the host, and
  with it Enclave RPC, stays down until someone types that passphrase.** That is the machine's design, not changed.
- *Kernel.* The host runs 7.2.11 with only 7.2.14 (and older) modules on disk, so the next boot is a kernel change.
  None of the three running guests uses vhost-vsock. SEV-SNP launch under 7.2.14 is not tested.
- *Gas.* Each boot costs the operator key one registration and one price write (5.0e-7 ETH on 2026-11-13). With the
  checkpoints stopped (above) the key holds about 1,800 of those.
- *Lease.* If the host is down past the lease end (30 minutes at most), the address, the agent and the gateway
  refuse the app until metal0 claims again; the chain data needs no resync beyond the downtime.
- *Not exercised.* A reboot of this host with Enclave RPC as a fleet app. The first certificate delivery after a
  fresh guest boot gets no answer in image r13 (fixed in source bdacc0f1a); the manager's retry a minute later lands.
