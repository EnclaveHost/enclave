# RPC durable-HDD transport: mutual-TLS NBD from the desktop HDD to the NucBox Linux VM

**Status:**
- Source tooling, templates and a real local integration test are committed.
- Nothing is installed, deployed, allocated or activated. Nothing was written to `/mnt/usb`, and there was no SSH and no
  production change.
- The overall RPC goal is **not** achieved by this work alone. Hardware capacity, the full-chain sync and the gates in
  `HANDOFF.md` remain separate.

## What is here

| Path | Role |
|---|---|
| `transport/hddexport.py` | Desktop side: `check`, `create --first-creation`, `serve` (exec for systemd), `start`/`stop`/`status` (recorded, owned process) |
| `transport/hddattach.py` | VM side: `check`, `attach`, `first-format --i-am-formatting-a-new-export`, `mount`, `verify-mounted`, `detach` |
| `transport/pki.py` | One private CA per role; server and client certificates with narrow EKU. Keys are generated where they live (client key inside the VM). Nothing is overwritten. |
| `transport/common.py` | Config validation, mount-table and sysfs checks, owned-process records (pid + start time + exe + launched argv) |
| `templates/` | Production export/attach configs for l1 and base (exact disk identity), systemd units, desktop nft fragment |
| `test/` | `run.sh` (queued), `host_test.py`, `guest/` (KVM guest: init, initramfs builder, `guest.py`), `fwd_relay.py` |
| `test-receipts/` | Receipts of the passing run, the mutation controls, the nft check, and the failures of runs 1–3 |
| `DEPENDENCIES.md` | Exact installed versions and hashes, documentation consulted, observed qemu behaviour |
| `HANDOFF.md` | Contracts for P, B, F and S |

## Properties enforced, and the evidence for each

All of these come from `test-receipts/run4`: the host side passed 55/55 and the guest side 27/27. That run was job
`itest-4`, which exited 0 at a peak of 360 MiB RSS under the 1024 MiB lane. The run directory allocated 360,448 B
against the 512 MiB cap, and every key file was removed afterwards.

**Fail closed on the HDD mount, using real mounts and sysfs.** The export refuses to start when:
- the mount point is a bare, unmounted directory;
- the filesystem type is not the configured one;
- the mount source is not the configured `/dev/disk/by-uuid` / `by-id` device;
- the backing disk is not rotational, as `sysfs` reports it;
- `requireRotational: false` is set but the bind address is not loopback (that waiver is for test fixtures only);
- the image's directory sits on another filesystem (a tmpfs mounted inside the HDD mount);
- any path component is a symlink;
- the size does not match;
- the key permissions are too open;
- the image is missing (it is never created implicitly);
- a role is crossed (an L1 config naming the base image or base identity);
- the bind address is a wildcard.

The production template pins:
- the ntfs3 volume serial `489ED12D9ED11472`;
- `usb-QNAP_TR-004_DISK00_51555939333133303432-0:0-part2`;
- `requireRotational: true`.

**No overwrite and no implicit format.**
- `create` needs `--first-creation` and uses `O_EXCL`. A second `create` refuses, and the data written through NBD
  beforehand is still read back intact.
- Inside the guest, `first-format` needs its flag. It refuses an export that holds data (the pattern the host wrote to
  L1), and it refuses a second format of the base export because a signature is now present.
- `mount` needs the configured filesystem UUID. It refuses a mount point that contains a file written while nothing
  was mounted.
- `verify-mounted` refuses after a detach.

**Identity: real qemu-nbd 11.1.2 with mutual TLS and authz.** Each refusal is asserted at the side that should refuse
it, with that side's own reason:

| Case | Refused by | Reason given |
|---|---|---|
| Client without TLS | server | "not permitted before TLS" |
| Client certificate from a rogue CA | server | "hasn't got a known issuer" |
| Same-CA certificate with the wrong DN | server | "authz check … intruder is denied" |
| No client certificate | server | "No certificate was found" |
| Base client to the L1 export, and the reverse | client | "hasn't got a known issuer" |
| Rogue server presenting the L1 name | client | "hasn't got a known issuer" |
| Wrong server name | client | "does not match the hostname" |
| Wrong export name | server | "not present" |
| Second concurrent client (`--shared=1`) | server | not served |

The legitimate client is still served after all of these refusals.

**Real kernel NBD and ext4, in a throwaway KVM guest.**
- The guest is root only inside itself; the host has no root.
- The kernel is linux 7.2.11. Its only network path is a guestfwd relay to the loopback export.
- What ran: `qemu-nbd -c` attached `/dev/nbd0` and `/dev/nbd1` over TLS; the first format; an exact-UUID mount; a
  16 MiB fsync'd write; detach, reattach and a data hash check.

**Export disconnect.** Measured, not assumed. With base stopped by its owned process record while mounted:
- `fsync` of a new write returned **EIO within 0.1 s**.
- An `O_DIRECT` read returned **EIO**.
- dmesg recorded the I/O errors and "EXT4-fs … failed to convert unwritten extents … potential data loss" for that
  in-flight file.
- The mount was **still listed `rw`** when observed.

Cleanup, recovery and data, also measured:
- **Cleanup:** `detach` (umount, then `qemu-nbd -d`) finished in 0.32 s, with the device and the daemon gone.
- **Recovery:** after an owned restart, a fresh attach and a read-only `e2fsck -n -f` returned 0. The mount replayed the
  journal ("recovery complete").
- **Data:** data fsync'd before the disconnect was intact; the failed in-flight file was absent.
- **Placement flag:** the guest reports `queue/rotational = 0` for the nbd device.

**Process ownership.**
- Stop and detach signal only a process whose pid, start time, exe AND launched argv still match the record.
- A forged record that points at an unrelated live process is refused, and that process survives.
- `--clear-stale` drops only the record.
- Teardown left no qemu-nbd or qemu-system process (`run.out` shows 0 and 0).

**Mutation controls** (`test-receipts/mutation/summary.txt`, job `mutate-2`): the control passed, and **8 of 8 mutants
were killed** at their intended steps:

| Mutant | What it removes |
|---|---|
| M1 | authz |
| M2 | client-certificate verification |
| M3 | fstype check |
| M4 | device-identity check |
| M5 | ownership by pid only |
| M6 | overwrite on create |
| M7 | format without the blank check |
| M8 | mount over a non-empty directory |

**Other checks:** the nft fragment passes `nft -c` inside an unprivileged namespace (`test-receipts/nft-check.txt`).

## Honest history (runs 1–3, receipts kept)

- **Run 1.**
  - The legitimate client was denied, because qemu compares the DN in certificate order (see `DEPENDENCIES.md`). So the
    run-1 negatives proved nothing.
  - The owned record captured an empty cmdline mid-exec, so `stop` refused the run's own base server. I terminated that
    leftover by hand, after verifying it was this run's process (its cmdline named the run's own directory and its start
    time matched).
  - The guest initramfs lacked `cp`.
- **Run 2.**
  - `qemu-nbd -c` defaults its control socket to `/var/lock`. It now lives in the tool's own 0700 state dir.
  - The rogue-client case was refused by the client itself, before the server could judge it.
- **Run 3.**
  - Over 9p, the host's setuid `mount` ran as the host user (a fixture artifact). The guest test now uses root-owned
    copies.
  - The test wrote into a bare mount point after the failed mount, and the guard then caught it. The test now writes only
    after `verify-mounted` passes.

## Corrections to the placement plan (d429ef2d)

- "Export loss → ext4 remounts read-only → units stop" is **not proven**.
  - Observed: immediate EIO to the application, with the mount still listed `rw`.
  - Not observed: any read-only remount. systemd stop or restart behaviour was not exercised at all, and the unit
    templates are untested.
- The plan's guest client changes:
  - It is not `nbd-client`; it is `qemu-nbd -c` with `--socket` in its state dir.
  - The plan's "30 s I/O timeout" is not implemented. With the default reconnect-delay of 0, errors came back
    immediately.
- External DH parameters are removed (deprecated in qemu 11.1.2).

## Privilege gates and limits (not hidden)

- **Not exercised here:** ntfs3, the USB RAID5 behind it, 1 GbE throughput, Hyper-V, the Ubuntu VM's own qemu version,
  systemd, and power-loss durability across the chain (guest FLUSH → qemu-nbd → ntfs3 → USB BOT with no FUA).
- **The guest needs root:** `modprobe nbd`, `qemu-nbd -c` and `mount` all require it. `hddattach.py check` reports a
  missing nbd module as a privilege gate.
- **The desktop needs root once:**
  - `/etc/enclave-rpc-hdd`, `/var/lib/enclave-rpc-hdd/<role>` (0700, owned by the ntfs3 mount's uid);
  - unit and nft installation;
  - running the export as uid 1000, because ntfs3 maps every file to that uid.
- **No CRL.** Revoke by re-issuing the per-role CA, or by changing the authz DN and restarting the export.
- One client per export.
- A write that is in flight at the moment of a disconnect is lost (it gets EIO). Node software must treat EIO as fatal.
- No cache was allocated. The cache contract (aggregate cap 250,000,000,000 B, target 200 GB, opt-in, writethrough) is
  P's; see `HANDOFF.md`.

## Rollback

There is nothing installed, so nothing to roll back. After a future activation, roll back in this order:
1. Stop consumers.
2. `hddattach.py detach` for each role. It never detaches a device it did not attach.
3. `hddexport.py stop`, or `systemctl stop enclave-rpc-hdd-export@<role>`.
4. Remove the nft fragment.

The image files stay on the HDD until root decides otherwise. Nothing in this tooling deletes them.
