# Handoff: contracts for the durable-HDD transport

This repo owns ONLY the transport: export, attach, PKI and their checks. It edits nothing in P, B, F or S trees.
Root executes; nothing here is installed, activated or allocated.

## Interface every consumer relies on

| Item | L1 | Base |
|---|---|---|
| Export name | `enclave-rpc-l1` | `enclave-rpc-base` |
| Desktop image | `/mnt/usb/enclave-rpc/l1-origin.img`, 4,000,000,000,000 B | `/mnt/usb/enclave-rpc/base-origin.img`, 3,100,000,000,000 B |
| Port (template) | 10809 | 10810 |
| Private CA | its own | its own |
| Client DN | `O=Enclave RPC HDD,CN=enclave-rpc-l1-client` | `O=Enclave RPC HDD,CN=enclave-rpc-base-client` |
| Guest device | `/dev/nbd0` | `/dev/nbd1` |
| Filesystem | ext4, label `enc-rpc-l1` | ext4, label `enc-rpc-base` |
| Mount point | `/srv/rpc-hdd/l1` | `/srv/rpc-hdd/base` |

The two roles can never share an image, CA, client identity, export, device or mount point. The tools refuse each of
these crossings, and tests show it.

**Gate a consumer on this command:**
`hddattach.py verify-mounted /etc/enclave-rpc-hdd/attach-<role>.json`
- It exits 0 only when the configured filesystem UUID is mounted, as ext4, from the nbd device that this tool's own
  recorded qemu-nbd connected.
- It exits 2 otherwise: not attached, not mounted, a different source or UUID, or a dead or foreign daemon.

## P (storage and cache templates, final composition)

1. **Placement check on an nbd origin.**
   - Inside the guest, the nbd device's `queue/rotational` reflects what the export advertised, not the physical media.
     The KVM test records the actual value; see RESULT. Do NOT accept "any network disk", and do NOT override the flag
     with udev.
   - Instead, accept an nbd origin only when ALL of these hold:
     1. `verify-mounted` exits 0 for the role.
     2. The attach config's `placement` block equals the export host's `placement.json`. That file is written by
        `hddexport.py check` and carries `exportName`, `imageBytes`, `mount.target`, `mount.fstype`,
        `disks.rotational`, `disks.requireRotational: true`, `caCertSha256` and `serverCertSha256`.
     3. The TLS connection that is actually live was authenticated with that per-role CA, the configured server name
        and the per-role client certificate.
   - **This is an operator-configured, authenticated statement by the export host, made from its own mount table and
     sysfs. It is NOT cryptographic proof of physical media.** Label it that way wherever it is reported.
2. **Origin path.** On the guest, the "origin" is the already-mounted ext4 at `/srv/rpc-hdd/<role>`.
   - There is no loop image, and nothing is created on the VM's own disk. Data directories live under the mount, for
     example `/srv/rpc-hdd/l1/data`. TMPDIR is a directory there, too.
3. **Cache (opt-in, default none).**
   - Any dm-cache over the nbd device needs the ONE canonical ledger. The aggregate is at most 250,000,000,000 B
     including metadata and spill, with a target of 200,000,000,000 B, summed across hosts.
   - The cache must be writethrough so that losing it loses nothing.
   - Nothing here allocates a cache.
4. **H6** (the cache harness in the real VM) stays yours.

## B (Linux runtime entry)

- Put `BindsTo=` / `After=enclave-rpc-hdd-attach@<role>.service` on the role's units.
- Add `RequiresMountsFor=/srv/rpc-hdd/<role>` and `ExecStartPre=…/hddattach.py verify-mounted …`.
- Use `ReadWritePaths=` only for subdirectories that exist on the mounted filesystem.
- **The real VM needs:**
  - `modprobe nbd` (root, kernel module);
  - the `qemu-nbd` and `qemu-img` binaries;
  - `blkid`, `mkfs.ext4` and `python3`.

  The test used qemu 11.1.2. An Ubuntu noble `qemu-utils` is a different qemu version (and a download that root must
  approve), so re-run the guest test against that build first.
- **Untested:** the systemd unit templates, and how systemd behaves on stop or shutdown. Nothing in the test ran systemd.

## F (Windows baseline)

There is no Windows code change. The VM is created by the ops path, the same way as enclave-storage. Its outbound route
to the desktop LAN is the Hyper-V Default Switch NAT, so the desktop sees NucBox's LAN address as the source.
- Root reads that address and puts it in the desktop nft template.
- If the NAT ever presents a different source, the firewall refuses the connection; it never opens up.

## S (public RPC role)

The transport adds no public endpoint. The export binds one desktop LAN address. The role's public exposure stays on
the existing host-service transport.
