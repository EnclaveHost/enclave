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
