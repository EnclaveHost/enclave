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
