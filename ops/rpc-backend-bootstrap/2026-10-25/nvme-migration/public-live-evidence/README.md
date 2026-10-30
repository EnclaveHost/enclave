# Public live evidence: RPC VM NVMe migration (2026-10-25)

Everything here is public metadata: sizes, hashes, inodes, times, unit state, rendered units and scripts, and the v2
manifest. The manifest contains the SSH **public** key and its fingerprint.

There are no disk image payloads, no private keys, no JWTs and no guest config. Every JSON file was scanned for
private-key, JWT and secret patterns before publishing: none were found.

The receipts are verbatim. Their sha256 values equal the `receiptSha256` pinned in the installed v2 manifest.

## Executed migration (root)

| Step | Time (UTC) | Evidence |
| --- | --- | --- |
| VM cleanly stopped after recovery | 16:42 | (in `../../nvme-copy/`) |
| OS copy (frozen helper `e48a7cb8…`, byte-for-byte, re-read verified) | 16:52:44-16:53:10 | `copy-os.plan.json`, `copy-os.receipt.json` |
| L1 copy (same helper) | 16:55:25-17:38:36 | `copy-l1.plan.json`, `copy-l1.receipt.json` |
| `finalize-receipts` (adapter `65df7225…`, plan `c1b3d9e6…`, launcher re-pin `8b1ece11…`) | 17:38 | `finalize.out` |
| `install.sh` (old shas checked, v1 backed up, v2 installed, daemon-reload, verify) | 17:38 | `install.out`, `backup-v1-SHA256SUMS` |
| `systemctl --user start enclave-rpc-production-vm` (pulls the guard) | 17:39:05 | root |
| Guest SSH probe: banner timeout (guest not ready) | 17:39 | `guest-after-start.txt` |

### Copies

| Disk | Source (HDD, unchanged) | Destination (`/vm/enclave-volumes/rpc-production`) | sha256 (source = copy) |
| --- | --- | --- | --- |
| os | `os.qcow2` ino 3219, 3,110,666,240 B | `os.qcow2` ino 147981797 | `9a71081601d2a9820e422d6347736c93b98526d74a715a4a48074bdb79f33b2f` |
| l1 | `l1-origin.qcow2` ino 3220, 495,572,353,024 B | `l1-origin.qcow2` ino 147981798 | `93b7d677d405a80b44feb18947ea8f3120b396c76dfe5bcb335dd2e2fe2f3b0d` |

Base stays on the HDD: `base-origin.qcow2`, backing `hdd`.

`/vm` free space at finalize was 528,600,571,904 B. The guard's start threshold is 488,719,476,736 B. Its other
thresholds are pause at 368.7 GB and the operator-policy floor at 300 GB.

### Installed state (hashes equal `installed-v2/STAGED-SHA256SUMS`)

| File | sha256 |
| --- | --- |
| `~/.local/state/enclave-rpc-production/manifest.json` (v2) | `74db2e44b784ad1bf9bd8eddc533cde5790da7377c35ed0937749316a4ad159c` |
| `~/.local/state/enclave-rpc-production/provision_vm.py` | `8b1ece11201b0f6fe157c2dbf053e46846572741663dfc772ca29a0e0bfa463c` (= `../../provision_vm.py` at source `0e273b912`) |
| `enclave-rpc-production-vm.service` | `70d3d4d81b100269396843d723190a53b7d5c76837c58d78f4268d4aab947982` |
| `enclave-rpc-production-guard.service` | `3f6747af5f76135115329d798d1c01bd9c5a482c30fcf5c9a53dfac2bd9000e2` |

The v2 QEMU argv sha256 is `a6da118b…`. Every disk keeps its serial and guest ext4 UUID.

### v1 backup (`~/.local/state/enclave-rpc-production/backup-c1b3d9e63fc0/`)

| File | sha256 |
| --- | --- |
| manifest | `ecbe7b65…` |
| launcher | `184e816c…` |
| VM unit | `abe7744c…` |

See `backup-v1-SHA256SUMS`. The HDD originals of all three disks are preserved and unmodified: each copy receipt has
`sourceBefore == sourceAfter`.

## State at publication (17:41:48 UTC): NOT READY, and the VM is no longer running

| Observation | Value |
| --- | --- |
| `guard-status-at-publication.json` | last written 17:40:05, `state: armed`, `qemuSeen: false` |
| Guard status updates | none after 17:40:05 |
| QEMU PID 3681215 (read-only `ps`) | gone |
| `/run/user/1000/enclave-rpc-production/` | absent |

**Probable cause, not confirmed from the journal:**
- The guard fails closed (exit 3) when QEMU's guard monitor socket exists but QMP has not answered for more than 60 s.
  See `provision_vm.py` `guard_loop`, `now - absent_since > 60`.
- QEMU does not service QMP while it preallocates the 64 GiB `memory-backend-ram,prealloc=on`.
- At 17:39 QEMU was still preallocating 64 GiB, so the guard most likely exited, and `BindsTo` stopped the VM unit.
- The VM's ExecStop `powerdown` would then meet the same unanswered monitor.

The guest had not answered SSH, and vCPUs do not run before preallocation completes. Guest filesystem impact is therefore
unlikely, but **unverified**.

**Root to confirm (read-only):**

```sh
journalctl --user -u enclave-rpc-production-guard -u enclave-rpc-production-vm --since 17:39
```

**Required source fix before the next start** (owner of `provision_vm.py`, needs review and tests):
1. Before the guard's first successful QMP contact, while QEMU is preallocating and no guest code runs, allow a bounded
   pre-contact grace of several minutes, sized to the measured preallocation time.
2. Keep the 60 s rule only after first contact.
3. Make `cmd_powerdown`'s greeting read tolerate a busy monitor.

Restarting with the current launcher is likely to repeat the stop.

## Not done or not claimed

- Guest boot, Ethereum catch-up and chain readiness are **not** confirmed. Nothing here is an RPC replacement.
- No `fstrim` has run. The NVMe policy has `discard: unmap`, but the stale clusters of the L1 qcow2 are still allocated.
- Base remains on the HDD and is not synced.
- The host user-manager shutdown timeout is still 2 min. The 45-min drop-in awaits local sudo. Stop the RPC VM before
  any desktop reboot.

## Rollback (not an exact-state rollback)

With the VM and guard stopped, run as uid 1000:
`~/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/nvme-migration-stage/staged-final/rollback.sh`.
A public copy is `installed-v2/rollback.sh`; it expects the staged directory.

What the rollback does:
1. Verifies the backup `SHA256SUMS`.
2. Restores the v1 manifest, launcher and unit.
3. Removes the guard unit, but only if it equals the staged one, and removes the guard status and mode files.
4. Runs daemon-reload and the v1 `verify`.

Effects:
- The VM returns to the HDD OS and L1 originals. Those are stale but clean, as of the 16:42 guest poweroff.
- Base, on the HDD in both layouts, may have advanced.
- Recovery is **forward**: L1 resyncs, and Base waits for L1. Any post-migration guest OS changes must be re-applied.
- Never attach the NVMe and HDD copies to one guest: they have the same serials and ext4 UUIDs.
- The NVMe copies are left in place for root's decision.
