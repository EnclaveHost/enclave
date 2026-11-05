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
