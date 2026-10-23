# Indexer-free cold snapshot (A9): inventory, refresh plan and what it really recovers (local/source only, 2026-10-22)

Nothing was run against the network, SSH or production. No secret was printed: `app.seed` and `backup.pass` were only
checked for presence. Root owns execution.

## 0. Findings first

1. **A9 is already done for today.** Root ran the existing runner at 19:56:45Z:
   - Run: `20261022T195643Z-c16c22ef`.
   - Export: 1488 keys / 1489 objects, read-only.
   - Snapshot: `0e5b28c9dc53a5ac65e1bace6cf7409c8f6369599c114fb1878503acec210da1`, 11 446 130 B.
   - Archive: `3cfb4f12991b3588d6c9b1317e08ef9613bac349f1a60073a2d835cad326c335`, 6 861 390 B. Authenticated
     decryption and every member were verified.
   - Stored on the local workstation only; no provider copy.
   - Receipt: `outputs/decentralization-audit/storage-cold-recovery-refresh-20261022.json`.
   - The first attempt that day, `20261022T195452Z-a52fb773`, failed at export (exit 1). Its diagnostics are retained
     privately. The host-bound proxy version succeeded.
2. **"1487 → 1491 stale" compares two different counters.**
   - RECIPE.md was written at 19:53:27Z, three minutes before the refresh.
   - Its 1491 is the indexd **database `objects` table**: `outputs/storage-fresh-backup-20261022T075011Z-bee519f1.json`
     at 07:50Z and `outputs/storage-indexd-review/live-footprint.json`.
   - The export counts **resolved keys/objects reachable from the app's key index** (1488/1489).
   - The gap of 2 is therefore not shown to be staleness. Proving it needs both counts read at the same time (step 3.4).
3. **The fresh archive has exactly ONE copy, on the workstation.** The only other archive (10-19, `86fc3062…`, snapshot
   `7cc3e31a…`, 1487 objects) sits on the four DigitalOcean backup servers, which form one failure domain.
4. **The decryption passphrase and app seed exist only on this workstation**
   (`work/private/sia-direct-recovery/{backup.pass,app.seed}`, mode 0600, dir 0700).
   - `backup.json` records `decryptionPassphraseCopiedToProviders: false`.
   - **If this workstation is lost, every archive copy, the DO ones included, is undecryptable.** This is the largest
     single risk in the cold path.

## 1. Inventory (existing artifacts; hashes verified locally now)

| item | path | sha256 |
|---|---|---|
| refresh runner (root's, used 10-22) | `work/resume-after-checkpoint-20261022/production-run/refresh-cold-snapshot.py` | `4ce55e2177a5e99f179ee4df5a5f8048a16df6efeb2bfd08b604cb7c90009beb` |
| recovery binary (asserted by the runner) | `work/enclave-apps-sia-recovery/sia-s3/target/x86_64-unknown-linux-gnu/release/sia-s3` | `bcb2025e218fb99c8e98f1af1300627b223138f438b31e24f5cd989fb4ee70d1` |
| recovery source | enclave-apps `446ac5f4` "Recover sealed Sia objects directly from pinned metadata snapshots" (PR #4); README §"Indexer-free recovery reads". The worktree HEAD is now `54818ba6` with uncommitted edits; the runner pins the BINARY, not the tree | — |
| 10-22 archive | `work/private/sia-direct-recovery/20261022T195643Z-c16c22ef/sia-direct-recovery-20261022T195643Z-c16c22ef.tar.gpg` | `3cfb4f12…c335` |
| 10-22 snapshot (plaintext metadata, sealed objects; no seed) | `…/20261022T195643Z-c16c22ef/snapshot.json` | `0e5b28c9…10da1` |
| 10-19 archive (also on 4 DO servers `/var/backups/enclave-sia-recovery/`) | `work/private/sia-direct-recovery/sia-direct-recovery-20261019-complete.tar.gpg` | `86fc3062…841d` |
| 10-19 snapshot and its IP-pinned derivative (used by the 10-19 live read proof) | `…/snapshot.json`, `…/snapshot-ip-pinned.json` | `7cc3e31a…576d`, `35d4b6a4…39e9` |
| secrets (never printed or copied by this plan) | `…/app.seed`, `…/backup.pass` | present, 0600 |
| 10-19 tooling (reference only) | `work/sia-direct-recovery/{backup.py 183f54be, prepare-test.py 98be97de, run-live.py 8b5b0b30, resume-live.py 0fb60191, test-plan.json fc32bfc5}` | — |

**What an archive contains** (the 10-22 runner): `snapshot.json`, `app.seed`, `sia-s3-linux` (bcb2025e) and
`manifest.json`. It is GnuPG AES256 symmetric, keyed by `backup.pass`. The 10-19 archive also had the WASM and README.

**Confidentiality boundaries:**
- The seed travels only inside the encrypted archive and the private 0700 directory.
- The runner's proxy forwards only GETs for `http://sia.enclave.host`, logs nothing (signed URLs) and strips proxy
  environment variables.
- The passphrase was never sent to a provider.
- The snapshot holds sealed metadata, no seed. It still maps object-to-host and should stay 0600.

## 2. Does the snapshot enable recovery after indexer loss? Partly. Exactly this much:

**What works without the indexer** (proven 10-19 for 2 files, inside a cgroup that blocked the indexer, the DO fronts
and Nan):
- `sia-s3 recovery read SNAPSHOT SNAPSHOT_SHA256 BUCKET KEY OUT EXPECTED_SHA256 EXPECTED_BYTES`.
- It reads RHP4 directly from the snapshot's hosts with the app key, checks sector proofs and the whole-file hash.

**It needs, per file, inputs the snapshot does not provide:**
- **The key name, its SHA-256 and its exact size,** from a separately trusted record. The CLI has only
  `export` / `read`, with no list operation (`src/recovery.rs:373-383`). Key names are sealed in the snapshot.
  - For IPFS pins the key is `pins/<CID>`, but sha256 and bytes must still come from elsewhere: the 10-19 test took
    them from `outputs/runtime-file-adapter/upload.json` and a retained copy.
  - **Whole-bucket recovery is NOT supported** without new code; the 10-19 verification says so.
- **The snapshot hash from a trusted record:** the receipt in `outputs/`, which lives on the same workstation.

**Recovery also stops working when any of these change:**
- **Contracts and balances.** Sia hosts must still hold the sectors under unexpired contracts (78 contracts at 07:50Z)
  with prepaid account balance left. Renewal and refills are done ONLY by the live indexer and its funding. README:
  "cannot upload, renew contracts, refill host accounts or discover changed host addresses".
- **Host addresses.** The hosts must still be at the snapshot's addresses.
  - The export records announced addresses, some of them hostnames, so reads at recovery time also depend on DNS. The
    10-19 proof resolved them into an IP-pinned derivative first (prepare-test.py). That changes the snapshot hash,
    which must then be recorded separately.
  - (Inference: host address churn makes an old snapshot decay over time.)
- **Point in time.** Objects written after the export are not covered. The capture is not transactional.

**Centralized dependencies that remain:**
- **The indexer.** One live indexd on the minipc storage VM is needed to export or refresh, and for every write,
  renewal and refill.
- **Execution path.** A refresh needs the minipc SSH tunnel (`storageadmin@127.0.0.1:32422`, key `~/.ssh/minipc`) and
  this workstation.
- **The workstation** is the sole holder of `backup.pass`, `app.seed`, the 10-22 archive and the trusted hashes.
- **DNS** for hostname-addressed Sia hosts at read time.
- **DigitalOcean** holds the only other (older) archive copies, which conflicts with DO staying minimal transport.
- **Time.** Contract expiry and account balances bound how long any snapshot stays useful.

## 3. Root-run plan (existing code only; no new harness)

**Step 3.1. Read-only local inventory** (prints hashes, modes and archive member NAMES only):

```bash
cd /home/steven/Documents/Codex/2026-10-18/wo
sha256sum work/resume-after-checkpoint-20261022/production-run/refresh-cold-snapshot.py \
  work/enclave-apps-sia-recovery/sia-s3/target/x86_64-unknown-linux-gnu/release/sia-s3      # 4ce55e21… / bcb2025e…
P=work/private/sia-direct-recovery
stat -c '%a %n' $P $P/app.seed $P/backup.pass                                                # expect 700 / 600 / 600
(cd $P && sha256sum sia-direct-recovery-20261019-complete.tar.gpg 20261022T195643Z-c16c22ef/*.tar.gpg 20261022T195643Z-c16c22ef/snapshot.json)
gpg --no-options --batch --no-symkey-cache --pinentry-mode loopback --passphrase-file $P/backup.pass \
  --decrypt $P/20261022T195643Z-c16c22ef/sia-direct-recovery-20261022T195643Z-c16c22ef.tar.gpg | tar -tvf -
# expect exactly: snapshot.json  app.seed  sia-s3-linux  manifest.json (names/sizes only; nothing extracted)
```

**Step 3.2. Refresh, only when wanted** (a new point in time). This is the unchanged runner, the same way root ran it
(queue cap 256).
- The runner overwrites its fixed receipt path, so preserve today's receipt first:

```bash
cd /home/steven/Documents/Codex/2026-10-18/wo
cp -p outputs/decentralization-audit/storage-cold-recovery-refresh-20261022.json \
      outputs/decentralization-audit/storage-cold-recovery-refresh-20261022T195643Z-c16c22ef.json
cd work/resume-after-checkpoint-20261022/production-run
python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 256 --log cold-refresh-r3.guard.log \
  -- python3 refresh-cold-snapshot.py > cold-refresh-r3.out 2>&1; echo rc=$?     # rc 98 = not started: retry later
```

**Expected side effects:**
- One owned SSH local forward to the minipc storage VM indexer (127.0.0.1:9982 there). It is stopped at the end, and
  the receipt checks `ownedTunnelStopped`.
- Signed GET reads of the indexer through a loopback GET-only proxy.
- No uploads, writes, funding or provider copies.
- A new `work/private/sia-direct-recovery/<UTC>-<hex>/` (0700) holding `snapshot.json`, the `.tar.gpg` (0600),
  `export.stderr` and `tunnel.stderr`.
- The receipt `outputs/…/storage-cold-recovery-refresh-20261022.json` is rewritten. Today's date is hard-coded in that
  name; a later day still writes the same name.

**Validation:**
- `cold-refresh-r3.out` ends with a JSON receipt showing `readOnlyExport: true`,
  `authenticatedDecryptionAndAllMembersVerified: true`, `ownedTunnelStopped: true`, `liveWrites: false` and
  `providerCopiesCreated: 0`.
- `objects` ≥ 1489 unless deletions happened.
- The new `snapshotSha256` matches `sha256sum` of the new private `snapshot.json`.

**On failure:** the runner raises and keeps the private diagnostics (as for a52fb773). Nothing to undo.

**Step 3.3. Second copy on a different device.** Today there is one copy.
- **Same-site option** (warden's USB DAS, encrypted archive only):

  ```bash
  install -d -m 0700 /mnt/usb/enclave-cold-recovery
  install -m 0600 <archive>.tar.gpg /mnt/usb/enclave-cold-recovery/ && sha256sum /mnt/usb/enclave-cold-recovery/<archive>.tar.gpg
  ```

  - The ntfs3 mount uses `fmask=0022`, so modes may read 0644. Confidentiality then rests on GPG alone.
  - It is the same site as everything else, so it is NOT off-site.
  - **Never** put `backup.pass` or `app.seed` on that disk.
- **No authorized off-site non-DO target exists** (one-site hardware). Do not add new DO copies, given DO's
  transport-only role. Retaining or deleting the 10-19 DO copies is root's call.

**Step 3.4. Settle the count question** (read-only live, optional): read the indexd DB `objects` count and run the export
back-to-back. A difference that persists then reflects DB rows not reachable from the key index, not staleness.

**Step 3.5. Human action, highest value: an offline escrow of `backup.pass` and `app.seed`.**
- For example, a printed or hardware-held copy kept away from this workstation, and never sent over a network.
- Without it, the cold path dies with this machine.

**Cleanup:** none is required.
- Private run directories are intentionally retained (0700/0600).
- The failed `20261022T195452Z-a52fb773/` holds only stderr files; keep it or remove it as root prefers.
- Plaintext snapshots stay 0600 in the private directory and must not be copied to public paths.

## 4. Not done / limits

- No live read was made, so whether the live indexer has changed since 19:56Z is unknown.
- Contract expiry heights and account balances were not inspected; they bound how long the snapshot stays useful.
- No recovery read was re-run against the 10-22 snapshot. The read path was proven on 10-19 with an IP-pinned snapshot.
  A 10-22 read proof would reuse `run-live.py` and `prepare-test.py`, which overwrite fixed private and test-plan paths,
  so root should adapt the paths before any reuse.
- A per-file inventory of (bucket, key, sha256, bytes), which full recovery needs, does not exist as an artifact, and the
  CLI cannot list keys. Building one is new work and was not started.
