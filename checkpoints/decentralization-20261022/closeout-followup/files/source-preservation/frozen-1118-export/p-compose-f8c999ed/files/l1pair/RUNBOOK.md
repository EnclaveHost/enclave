# Enclave L1 pair runbook (root only; nothing here is authorized by this package)

This runbook is for a non-validating Ethereum mainnet pair:
- **Execution:** reth v2.8.0, `--full`, receipts kept for 140,000 blocks.
- **Consensus:** Lighthouse v8.3.2, `--semi-supernode`.

The pair feeds the Base holder's `l1.executionRpc` and `l1.beacon` on loopback.

**Ownership:**
- S owns the holder and its config.
- E owns L1 transaction and forced-inclusion semantics.
- B and A own consumers.

**Ground rules for every step:**
- Run only what is listed.
- Run every test through `work/claude-test-queue.py`.
- Never touch existing VMs, filesystems or services.

## 0. Decisions that must be made first (see RESULT.md §6)

D1. **Storage medium for durable L1 execution state.** HDD-only is the current human rule, but vendors recommend TLC NVMe or an SSD.
D2. **Memory.** The pair plus the holder needs 60 GiB of MemoryMax, against about 24 GiB MemAvailable now.
D3. **NVMe cache share.** The default is none. Any share is a fixed reservation in the one shared ledger, out of the same 250,000,000,000-byte total; the holder reserves 199,140,835,328 B, leaving 859,164,672 B under the 200 GB host share.
D4. **Anchor.** Who supplies the first checkpoint state and block, and which two or more independent observations confirm its root.
D5. **Lighthouse binary.** DONE 2026-10-23 under root authorization: downloaded, signature verified by the officially
    stated fingerprint, extracted and pinned (`11b7bca8…`). Root decides whether to re-download at install or copy the
    verified staging bytes.
D6. **L1 transaction broadcast** (`execution.txBroadcast`, for E). The default `disabled` keeps every tx on the node;
    `local-raw-propagate` is an explicit opt-in. See `HANDOFF-TO-E-L1-TX-BROADCAST.md`.

## 1. Install pinned binaries (root)

**reth** (already present, not re-downloaded):
- Source: `rpc-priority/vendor-inspect/reth-v2.8.0/reth-v2.8.0-x86_64-unknown-linux-gnu.tar.gz`.
- Run `sha256sum` and expect `809bfe0f071b509980d7f9178603edd2f7432356d50ae5af256cb62213c10ed8`.
- Extract `reth` to `/opt/enclave-l1-pair/bin/reth`, owned `root:root`, mode 0755.
- Run `sha256sum` and expect `8cdd1f35e00558a40ff19001752c4b4fa3ea885c88d1c704348ba88248f6d250`.

**Lighthouse** (downloaded and verified 2026-10-23 under root authorization into the task workspace only; see
`RESULT-BINARY-CLOSURE.md`):
- **Source of the bytes:** either copy the verified `bin-staging/lighthouse-v8.3.2/lighthouse`, or re-run the same recipe
  (`jobs/fetch-lighthouse.sh` + `jobs/verify-lighthouse.sh`):
  - download `https://github.com/sigp/lighthouse/releases/download/v8.3.2/lighthouse-v8.3.2-x86_64-unknown-linux-gnu.tar.gz`
    and its `.asc`;
  - check the tarball sha256 is `ea914e932462d6a93ad78c21377d70f995e05ac224248be0b58c2f4d6740439a` and the `.asc` is `4c4ce326…`.
- **Signature:** `gpg --verify` in a THROWAWAY keyring holding only primary key `15E66D941F697E28F49381F426416DC3F30674B0`.
  - That fingerprint is stated by `sigp/lighthouse` @ `a376defa` in `.github/workflows/release.yml:195` and
    `SECURITY.md:10`, and in the v8.3.2 release body.
  - Require `VALIDSIG … 15E66D94…` (primary).
- **Archive check:** it must hold exactly one regular file `lighthouse`. Extract it to
  `/opt/enclave-l1-pair/bin/lighthouse`, owned `root:root`, mode 0755.
- **Binary pin:** sha256 must be `11b7bca8df09b3f985a03a72f241ef9e011c99332fe86677b654947eaa1e9e96` (already in
  `PINS.json` and the example).
- Requires glibc 2.34 or later; preflight checks it (the workstation has 2.44).

**Package:** install `l1pair.py`, `PINS.json` and `vendor/` at `/opt/enclave-l1-pair/`, matching the reviewed commit.

## 2. Account and engine secret (root)

```
useradd --system --no-create-home --shell /usr/sbin/nologin enclave-l1
install -d -m 0750 -o root -g enclave-l1 /etc/enclave-l1-pair
umask 027; python3 -c 'import secrets; print(secrets.token_hex(32))' > /etc/enclave-l1-pair/jwt.hex
chown root:enclave-l1 /etc/enclave-l1-pair/jwt.hex; chmod 0640 /etc/enclave-l1-pair/jwt.hex
```

The engine secret is generated locally and never copied, committed or shared. Only reth and Lighthouse read it, over
loopback.

## 3. Config, render, review

1. Copy `l1pair.example.json` to `/etc/enclave-l1-pair/l1pair.json`, then fill in:
   - `consensus.binary.sha256` (already pinned: `11b7bca8…`);
   - `execution.txBroadcast` (default `disabled`; opt-in `local-raw-propagate` only for E, root decision D6);
   - the checkpoint fields (§5);
   - `p2p.listenIp` and `nat`;
   - the co-resident ports and paths.
2. Run `l1pair.py validate`, then `l1pair.py render CONFIG /root/l1pair-render`, and review every file.
3. Check the render, especially:
   - `el.argv.json`: `--nat none`, `--prune.receipts.distance 140000`, 127.0.0.1 binds, and in the default mode
     `--disable-tx-gossip --txpool.no-local-transactions-propagation` (absent only when `txBroadcast` is
     `local-raw-propagate`);
   - `cl.argv.json`: `--disable-upnp`, `--semi-supernode`, `--wss-checkpoint`, and no checkpoint URL unless url mode was chosen
     explicitly;
   - the units.

## 4. Storage (root, after D1/D3)

`l1pair-storage.sh` is S's reviewed `holder-storage.sh.in`, byte-identical, rendered with `NAME=enclave-l1-pair`.

**Origin:** a new ext4 filesystem inside a new image file under `/mnt/usb/enclave-l1-pair/` (HDD).

**Cache:** none by default, and with none the pair reserves NOTHING in the shared ledger. If D3 grants a share:
1. Root adds the pair's OWN fixed reservation to the ONE canonical ledger,
   `/etc/enclave-rpc-cache/nvme-cache-budget.json` (S's `budget.py`, format v2). The rendered
   `nvme-budget-reservation.json` is that entry.
2. The host's reservations, including the holder's 199,140,835,328 B, must fit its share, the 200 GB target and the
   250,000,000,000-byte cap.
3. Set `storage.nvmeBudget {ledgerPath, reservationId}` in the pair config.
4. `create` admits and allocates only through `budget.py`; `assemble` and `verify-cap` re-verify against the ledger.

**Steps:**
1. `l1pair-storage.sh create`, then `verify-cap`, then `assemble` (or install `enclave-l1-pair-storage.service`).
2. Confirm `/srv/enclave-l1-pair` is its own mount: `findmnt`, then `preflight`.

## 5. Weak-subjectivity anchor (root, D4)

**Provider-independent path** (`checkpoint.mode: file`):
1. Obtain ONE finalized, epoch-boundary `state.ssz` + `block.ssz` pair from any beacon API or from a peer operator.
   This is a one-time input:
   ```
   curl -H 'Accept: application/octet-stream' <bn>/eth/v2/debug/beacon/states/finalized > state.ssz
   curl -H 'Accept: application/octet-stream' <bn>/eth/v2/beacon/blocks/<slot> > block.ssz
   ```
2. Put both files in `/srv/enclave-l1-pair/anchor/`, owned `root:enclave-l1`, mode 0640.
3. Run `l1pair.py checkpoint-inspect state.ssz block.ssz` to get the slot and epoch.
4. Record:
   - the sha256 of both files;
   - `wss` = `<finalized block root>:<epoch>`;
   - at least 2 DISTINCT observations of that root, with source and time. Examples: a friend's node, a second operator, a
     block explorer, our own earlier export.
5. The launcher refuses a state that:
   - is not mainnet (genesis validators root `0x4b363db9…`);
   - is not at an epoch boundary;
   - is older than 14 days, or from the future;
   - fails its sha256 pin.

   Lighthouse itself verifies the block/state pair and `--wss-checkpoint`.

**Explicit one-time URL** (`checkpoint.mode: url`):
- It needs `oneTimeBootstrapUrlAcknowledged: true`, `wss` and provenance.
- It is never a default.
- Switch to `resume` after the first start.

**Refused:** genesis sync (`--allow-insecure-genesis-sync`, which Lighthouse marks "DO NOT use on mainnet").

**After the first successful start:** set `checkpoint.mode: resume` so restarts read neither the files nor any URL.

**Future cold starts without any provider:** export our own finalized state and block every few days into
`/srv/enclave-l1-pair/anchor/` (same `curl`, against `http://127.0.0.1:15052`). An optional second copy can go to
durable storage elsewhere. Restoring it is a manual root import; nothing on the start path reads Sia or Enclave services.

**What a checkpoint, especially a stale one, CANNOT prove:**
- the current head or finality;
- the absence of a long-range fork created after it, beyond the weak-subjectivity period;
- blob availability at any time;
- anything about execution state. The execution client proves that itself, by executing every block from genesis over P2P.

**Limits on how old it can be:** Lighthouse backfills only to the weak-subjectivity point, about 5 months
(`advanced_checkpoint_sync.md`), and data columns are requestable only for 4096 epochs (about 18 days; mainnet
`config.yaml`). An older anchor may be unsyncable or unservable, not merely untrusted.

## 6. Preflight and start (root)

1. Run `l1pair.py preflight /etc/enclave-l1-pair/l1pair.json`. It checks:
   - pins, `--version` and every rendered flag against each binary's own help;
   - glibc;
   - that the mount is dedicated, not on `/`, and not shared with the holder;
   - HDD placement via sysfs;
   - the JWT secret's shape and mode;
   - the checkpoint;
   - MemAvailable ≥ the pair's MemoryMax + the co-resident reservation;
   - that the ports are free.

   It must pass.
2. Run `systemctl start enclave-l1-pair-storage enclave-l1-el`, then `enclave-l1-cl`. Each unit reports READY when its own
   loopback API answers mainnet. That is process readiness only.
3. Expect:
   - **Execution:** reth staged sync from genesis over P2P. **Duration on this HDD array is unknown.** Vendors assume NVMe;
     see RESULT.md.
   - **Consensus:** checkpoint sync, then forward sync, then rate-limited backfill.

## 7. Data-readiness gate (root, repeatable, read-only)

**Basic gate:** `l1pair.py ready CONFIG` exits 0 only if ALL 13 checks pass:
- EL: chain 1, mainnet genesis hash, not syncing, head lag ≤ 120 s, finalized present and lag ≤ 1 h;
- CL: mainnet genesis validators root, spec (deposit chain 1, 12 s slots, Fulu 411392), version v8.3.2, not syncing,
  not optimistic, EL online;
- custody groups ≥ 64;
- the CL head payload equals the EL block at that height;
- a recent blob-carrying slot serves all of its blobs at `/eth/v1/beacon/blobs/{slot}`.

**Before pointing the holder at the pair:**
```
l1pair.py ready CONFIG --need-from-block <holder safe-head L1 origin − 3600> --need-blobs-from-slot <that block's slot>
```

The pair serves blobs only for blocks received since it started (Lighthouse book: "since using the flag", for at most
18 days). So start the pair FIRST, and restore or choose the Base snapshot only after the pair has covered its L1 origin
minus the sequencing window.

## 8. Hand-off to the holder (S owns that config)

Apply `holder-l1-fragment.json` (`l1.executionRpc`/`l1.beacon` = loopback, `trustRpc: false`) to S's holder config, then
follow S's RESULT-HOLDER §7.

## 8a. NVMe cache operations (only if root granted a cache, D3)

Follow `vendor/holder/RUNBOOK-CACHE.md` (S's composed runbook, pinned in `VENDOR.json`).

**Power loss with a healthy cache:** the boot `assemble` is fine. Check `dmsetup status enclave-l1-pair` shows
`writethrough`, 0 dirty, no `needs_check`, and mode `rw`.

**A suspect or corrupted cache device, or any status deviation:**
1. **stop `enclave-l1-cl` and `enclave-l1-el` first**;
2. `l1pair-storage.sh disassemble`;
3. `l1pair-storage.sh cache-loss`;
4. `l1pair-storage.sh assemble`.

dm-cache serves corrupted cache content unchecked (measured), so never assemble a suspect cache.

**Interrupted `create`:** a signal now unwinds. After a SIGKILL or power loss: detach the loop on the unmarked origin,
remove that origin, and re-run `create`. It adopts the owned cache files.

## 9. Rollback

1. In S's config, revert `l1` to the previous endpoints. S owns this step and the holder restart.
2. Run `systemctl stop enclave-l1-cl enclave-l1-el`, then `enclave-l1-pair-storage`. `disassemble` refuses foreign
   mappings and mounts, and stops at the first failure.
3. If a cache was granted: run `l1pair-storage.sh cache-loss`, delete the two cache images (and their
   `.enclave-budget-owner` markers), and have root remove the pair's ledger reservation.
4. Full removal: delete `/mnt/usb/enclave-l1-pair/origin.img`, `/etc/enclave-l1-pair` (including the JWT), the units and
   `/opt/enclave-l1-pair`.

No existing filesystem, VM, app, wallet or admin control is touched at any step.
