# Shield pad storage

Pad spill files are disposable **encrypted scratch**, not recovery artifacts.
`shielded-spill.inc` seals the pad products with ChaCha20-Poly1305 using an
ephemeral guest-process key. Masks are regenerated from another in-memory key.
The expected write IDs also live in guest memory. Host confidentiality depends
on running that process in an attested confidential guest; ordinary KVM alone
does not hide its memory from the host. The host still observes file sizes and
I/O and can deny service. Disk encryption is an additional layer, not the TEE
boundary. This host storage helper does not change any measured guest code.

After the guest/process dies, its old spill is useless. Do not copy, hardlink,
snapshot or back up `.padbank` files or `pad.target` links as rollback material.
Keep release manifests and diagnostics; regenerate pads in the new guest.

## Limits

All Shield launchers on a host must share **one** `SHIELDED_PAD_BANK_DIR` and
the same policy. The defaults are:

| Setting | Default | Meaning |
|---|---:|---|
| `SHIELDED_PAD_BANK_MAX_GIB` | 704 | Sum of full logical sizes of managed pads |
| `SHIELDED_PAD_BANK_RESERVE_GIB` | 100 | Filesystem headroom required after all pad commitments |
| `SHIELDED_PAD_BANK_GIB` | Existing launch setting | Chat pad size (production uses 512) |
| `SHIELDED_PAD_BANK_GIB_SD` | 192 | Image pad size |

Admission is serialized with `flock`. It counts full sparse-file sizes and
their future growth, leaves another 64 MiB for filesystem metadata, and calls
Linux `fallocate` before starting QEMU. There is **no sparse or zero-writing
emulation fallback**. If space
cannot be reserved or headroom falls during allocation, the new pad is removed
and the launch fails. QEMU discard is disabled so reserved extents remain
allocated. An already allocated 512 GiB pad appearing in `df` is expected:
future minting overwrites those reserved blocks instead of unexpectedly growing
disk consumption. `Type=notify` delays the QMP deadline until reservation ends.

The headroom is a pad admission rule, not a filesystem quota on unrelated
programs: Docker, downloads, manual archives and other writers can still use
remaining disk space. Moving the pad directory or raising its cap requires
accounting for the previous directory, its active guests and its cleanup timer.
Do not run independent pad directories to bypass the shared budget.

## Lifetime and recovery

`pad-bank.py run` runs as the VM service's main process, writes durable ownership
metadata, allocates, then execs QEMU. `ExecStopPost` removes its pad after exit.
An independent reaper handles interrupted cleanup and host reboots, normally
within 30 seconds after it can obtain the allocation lock. Install it as the
guestd user from the deployed launcher directory:

```sh
sh isolation/m2/install-pad-reaper.sh /absolute/shared/pad-directory
```

Cleanup requires successful systemd enumeration. Active/starting VM units are
protected; unknown legacy files without ownership metadata are counted but
never automatically deleted. Unexpected links, ownership changes, bad records
or changed inodes fail closed and appear in the service journal. These are
operator errors to investigate, not reasons to delete arbitrary files.

To upgrade an already running legacy guest without a restart, `adopt` verifies
that its unit's main process holds the exact file inode open, records ownership,
then reserves existing holes without changing written data:

```sh
python3 isolation/m2/pad-bank.py adopt --directory /absolute/shared/pad-directory \
  --tag GUEST_TAG --unit m2-GUEST_TAG-LAUNCH_PID.service
```

It applies the same cap/headroom checks. Failed adoption never deletes a live
pad. Legacy services lack `ExecStopPost`, so their registered pads are reclaimed
by the timer or the next explicit stop/reap. Unrelated old archives outside the
managed directory require separate confirmed retirement; this tool deliberately
does not recursively search and delete files from the host.

Inspect without allocating pad data:

```sh
python3 isolation/m2/pad-bank.py status --directory /absolute/shared/pad-directory
systemctl --user status enclave-pad-bank-reaper.timer
journalctl --user -u enclave-pad-bank-reaper.service
python3 isolation/m2/test-pad-bank.py
```

Opt-in integration fixtures exercise real user systemd units, a maximum of
1 GiB of scratch allocation, and launcher argument construction with QEMU
substituted by a sleeping process. They require more than 2 GiB free and never
start a VM or use a GPU:

```sh
python3 isolation/m2/test-pad-bank-systemd.py --run
python3 isolation/m2/test-pad-bank-launcher.py --run
```

Deploy `run-domain.sh`, `pad-bank.py`, and the reaper together. No guestd restart,
firmware change, memory-floor change, new admission entry or signing action is
needed. Do not replace the rest of a live isolation tree with an older checkout.
