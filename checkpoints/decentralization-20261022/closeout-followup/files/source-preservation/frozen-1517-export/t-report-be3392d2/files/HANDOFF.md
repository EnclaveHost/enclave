# Handoff: network-HDD storage composition (transport + S/P storage + supervision)

Exact commits and test receipts: `RESULT.md` and `PROVENANCE.json`. Nothing is installed or activated. Root owns
activation.

## What each owner receives

| Owner | Source | Contract |
|---|---|---|
| D (checkpoint) | `t/` (transport `a9f0155c` + composition commits), `s/` (S `92b71784` + 1), `p/` (P `f8c999ed` + 1), and this workspace repo (harness, receipts, RESULT) | Preserve all four. `a9f0155c` itself stays immutable; the composition is new commits on top |
| P (bundler, storage/cache templates) | `p/` commit after `f8c999ed`; vendored `holder/storage_nbd.py`, `holder/holder.py` (pins in `vendor/VENDOR.json`) | See "P" below |
| B (Linux RPC consumer integration) | the generated unit TEXT (`enclave-l1-el/cl.service`, `enclave-base-holder.service`) and the supervisor contract | See "B" below |
| F (Windows) | none | No Windows change. The VM is created by the ops path (enclave-storage pattern) |
| S (public RPC role) | none | No new endpoint. Exposure stays on the existing host-service transport |

## The layering (network layout only; the local loop layout is byte-identical to before)

```
enclave-rpc-hdd-attach@<role>.service    raw attach: qemu-nbd -c over mutual TLS; owned record; never mounts
  └─ <name>-storage.service              storage_nbd.py: pin + verify-attached, [dm-cache on the RAW nbd], ONE mount
       └─ <name>-watch.service           hddwatch.py (Type=notify): attach/mapping/mount/ext4-errors/O_DIRECT origin read
            └─ node units                BindsTo= + Requires= + After= the watch; ReadWritePaths only on the mounted fs
```

| Name | Role | Device | Mount point | Cache |
|---|---|---|---|---|
| `enclave-l1-pair` | l1 | `/dev/nbd0` | `/srv/enclave-l1-pair` | default none |
| `enclave-base-holder` | base | `/dev/nbd1` | `/srv/enclave-base-holder` | optional writethrough, through the ONE ledger |

## P

1. **Production config shape.** Use `storage.layout: network-hdd-nbd` with this `storage.origin`:
   `{transport: enclave-rpc-hdd-nbd/v1, role, attachConfig, device, placement, bytes, filesystemUuid}`.
   - `placement` is the attach config's placement block, copied from the export host's `placement.json` and reviewed.
   - The renderer pins it by sha256 of the canonical JSON.
   - It REFUSES:
     - `requireRotational` other than true;
     - a non-HDD filesystem type;
     - a wrong export name or size;
     - a wrong image path;
     - a malformed fingerprint;
     - the wrong role (L1 vs Base).
2. **Placement in a VM.** `preflight` does NOT use the guest's rotational flag for the network layout. The guest
   reports `0` for nbd, measured. Instead it requires all three of:
   - the datadir resolves to exactly the configured nbd origin (plus only non-rotational cache leaves);
   - the pinned placement statement;
   - a passing `hddwatch.py check`.

   This is an authenticated, operator-configured statement by the export host, **not cryptographic proof of media**.
   There is no udev override and no "any network disk" mode.
3. **Cache.** `dm-cache` sits on the RAW nbd device and is created only before the one mount. Over the composed path:
   - The origin is never mounted while it is mapped. The kernel refuses `Can't open blockdev` (measured), and the tool
     refuses too.
   - Reuse needs a marker whose O_DIRECT superblock fingerprint still matches. Markers come from:
     - `create`, for the empty cache;
     - a clean `disassemble`, with no supervisor failure recorded and no new ext4 errors;
     - `cache-loss`, which zeroes the metadata first.
   - Any uncached mount or write in between is refused until `cache-loss` (measured).
   - **Known limit:** raw block writes that bypass a mount do not change the superblock; after any doubt, run
     `cache-loss`.

   The budget is unchanged: the ONE canonical ledger, an aggregate of 250,000,000,000 B including metadata/temp/spill,
   a 200 GB target, summed across hosts.
4. **Install paths the units name:**
   - `/opt/enclave-rpc-hdd/transport/{hddattach,hddwatch,common}.py`;
   - `/opt/enclave-base-holder/{storage_nbd,budget}.py`;
   - `/opt/enclave-l1-pair/vendor/holder/{storage_nbd,budget}.py`;
   - `/etc/enclave-base-holder/holder-{storage-nbd,watch}.json`;
   - `/etc/enclave-l1-pair/l1pair-{storage-nbd,watch}.json`;
   - `/var/lib/enclave-rpc-storage/` (markers, supervisor failure records).

## B

- **Keep the generated dependency lines on every node unit:**

  ```
  Requires=<name>-watch.service
  BindsTo=<name>-watch.service
  After=network-online.target <name>-watch.service
  ReadWritePaths=<datadirs on the mounted fs only>
  ```

  Do not depend on the storage or attach unit directly.
- **Measured in the guest under real systemd 262:**
  - a lost export makes the watch exit;
  - systemd then stops every node unit, even though the stand-in process itself keeps running on EIO;
  - nothing restarts automatically.

  Whether real reth/Lighthouse/Base exit on EIO by themselves was NOT tested. Do not rely on it.
- **Operator recovery order** (no automatic resync or reformat):
  1. `systemctl stop <name>-storage` (unmount; unmap);
  2. `systemctl stop enclave-rpc-hdd-attach@<role>`;
  3. restore the export;
  4. `storage_nbd.py cache-loss` (cached layout);
  5. start the node unit.
- **Existing S/P unit defect, found by real systemd** (not fixed here, outside this scope): systemd logs
  `Unknown key 'StartLimitIntervalSec' in section [Service], ignoring` for the node units. The intended restart rate
  limit is not applied as written. It belongs in `[Unit]`.
