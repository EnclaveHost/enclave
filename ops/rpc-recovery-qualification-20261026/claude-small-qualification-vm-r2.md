# Small qualification VM r2: rpc-qualification-vm-stage/r2 (PREPARED; NOT run by Claude, 2026-10-26)

**Status:**
- Source only. I ran no tests, builds, mounts, live actions or queue jobs, and edited no existing config.
- **Checks I made:** `ast` parse (`qualvm.py` against the 3.12 grammar), `bash -n`, `sha256sum -c`.
- **r1 is frozen** (sums verified, and the r2 job re-checks them).
- **Input:** root 1473, `rpc-qualification-vm-stage/r1/runs/20261026T165348Z-2058226/tests.out` (3 PASS, 1 FAIL).

## Stage
`rpc-qualification-vm-stage/r2/`, `SHA256SUMS` = **`485c527dee7fd83771269469534b4ddc88d668dc98f30218e2533877b1bd753c`** (read-only)

| file | sha256 |
|---|---|
| `qualvm.py` | `ba29d858178bb58ff175a9191e1bf0c4abb31ac19ea8eec03be8bdddc9de4067` |
| `test/test_qualvm.py` (6) | `a21a29cf8320242b17d061a81647942dcd81fd921f1086a2e03eee0b67fdfaf2` |
| `jobs/root-qualvm-r2-tests.sh` | `59ad2c09c1a49e840617b0dcdb687d3562f58268be40787c5909a660be7948d3` |
| `README.md` | `32d29ba30064517ae22dbcb811e6183b78ad2db3ebff266373a9d4931dec478b` |

## The 1473 failure and the fix
**Cause:**
- `re.findall(r'…initrd…\s+(\S+)\s*$')` has one group, so it returns a list of **strings**.
- r1's `li[0][0]` was therefore the first **character** of the initrd path: `/`.
- `prepare` would then have tried to extract `/` as the initrd and failed closed (debugfs dump of a directory gives an empty file, refused). So it was a real defect, but not a silent one.

**r2 `parse_grub(text, grubenv)`** takes the default entry literally, or refuses. It requires:
1. exactly one `linux` and exactly one `initrd` line in the first menuentry;
2. the `initrd` line has **exactly one** token. Microcode-first multi-file initrd lines are refused, as are any ambiguous initrd forms;
3. kernel and initrd are literal absolute paths (`[A-Za-z0-9._+/-]`), with no `..` and no variables;
4. the args are literal (`[A-Za-z0-9._+=:,/@-]`; no quotes and no `$` except the dropped `$vt_handoff`), with exactly one `root=`;
5. `set default` is only `"0"`/`0` or the stock `"${next_entry}"` branch, and `grubenv` (read by `prepare` from the same partition) has empty `next_entry` and `saved_entry`;
6. the first top-level entry is a `menuentry`, not a `submenu`. `linux16`-only entries are refused, because the `linux` line count is 0.

**Tests (6):**
- **Accepted:** an Ubuntu-shaped LABELLED fixture (stock `next_entry` block, `recordfail`/`insmod`/`search`/`echo` lines, `$vt_handoff`, an advanced submenu after it). It yields exactly `/vmlinuz-6.8.0-1-generic`, `/initrd.img-6.8.0-1-generic` and `[root=LABEL=cloudimg-rootfs, ro, console=tty1, console=ttyS0]`.
- **Refused, 17 adversarial fixtures:** two initrd lines; two initrd files; an initrd variable; a relative initrd; `..`; no initrd; two linux lines; a kernel variable; an arg variable; a quoted arg; no `root=`; two `root=`; `linux16` only; default 1; default `${saved_entry}`; a submenu first; no menuentry.
- **grubenv:** `next_entry`/`saved_entry` set is refused; empty is accepted.
- **Argv:** the exact diff, now always `restrict=on`.
- **Launch:** unit caps; refusals below 26 GiB and with the production VM, guard or qualification VM active.
- **Prepare record:** a changed kernel or an auto data mount is refused.

The real `grub.cfg` is still read only by root's `prepare`, and is refused if it does not meet these rules.

## Compatibility of the qualification steps with this VM (source review)
**The VM's posture is unchanged:** always `restrict=on`; data disks read-only; data mounts and every chain unit runtime-masked; the 16 GiB floor; launch ≥ 26 GiB. No config is edited.

**Q1, b3sum (the network is needed by apt, but this VM has no outbound): use an explicit offline package route.** r1's `--network apt` was removed: no outbound mode exists.
1. **Host (root; host network, a separate root decision):** download `dists/noble/InRelease`, and the `Packages.xz` of the component and architecture whose stanza lists b3sum (read the `Filename:` and `SHA256:` from it; do not guess the pool path). Then download that `.deb`.
2. **Copy** the three files into the qualification VM over the SSH forward (`scp` via the production `ssh_config`/`known_hosts`). This is inbound to the overlay only.
3. **Verify in the guest, offline:**
   1. `gpgv --keyring /usr/share/keyrings/ubuntu-archive-keyring.gpg InRelease`. The trust anchor is the installed OS's own keyring. `gpgv` does not check `Valid-Until`; record the dates.
   2. The `Packages.xz` sha256 equals its line in the verified `InRelease`.
   3. The `b3sum` stanza (`Version: 1.2.0-1`) `SHA256` equals the `.deb`.
   4. `dpkg-deb -x` into overlay scratch (not installed).
   5. The sha256 of `usr/bin/b3sum`.
   6. KAT: `b3sum --no-names` of an empty file equals `af1349b9…3262`.
4. **Copy** the binary and records out (sha256) before `discard`.

This qualifies the tool's provenance and its execution on this OS. It does **not** cover:
- the production mount's exec permission. The fstab record shows `noauto,noatime,errors=remount-ro`, so no `noexec`, but it must be confirmed with `findmnt` on the production-sized boot;
- the 1.14 TB real-data result, which is install's own qualification (Q4).

**Q2, extract confinement: scratch is OS-overlay scratch, NOT the production base disk.**
- The base mount is masked and its disk is read-only, so every Q2 path (stage/x-home/extract-state, the decoy, the hostile `.tar.zst`) must live in **overlay scratch**, e.g. `/var/tmp/gsi-q2/…`. Label every record "OS overlay scratch".
- Use a scratch copy of the gsi r2 extract unit with scratch paths, run with the identical `[Service]` sandbox properties.
- **This qualifies:** systemd's sandbox semantics, the real base binary (verify its sha256 `9c44836d…` in the overlay) and tar-rs's behaviour on this kernel.
- **It does not qualify:** anything specific to the production base filesystem.

**Q3, guard ordering: an overlay-installed drop-in does NOT qualify the original OS installation, and the masked unit cannot show it.**
- **Masked unit:** `enclave-base-retention.service` is runtime-masked in this boot. A masked unit loads as `/dev/null`, so `systemctl show -p ExecStartPre` on it shows nothing of its file or drop-ins.
- **Use a scratch unit** (labelled):
  1. copy the OS disk's retention unit bytes (check sha256 `f0238826…`) to `/run/systemd/system/gsi-q3-scratch.service`;
  2. copy the gsi r2 drop-in to `/run/systemd/system/gsi-q3-scratch.service.d/`;
  3. `systemctl daemon-reload`, then `systemctl show gsi-q3-scratch.service -p ExecStartPre`; the guard must be last, after `retention_guard.py pre`;
  4. run the guard command by hand, which must give rc 2 (nothing installed);
  5. **never start the scratch unit**, then remove it.
- **This qualifies** systemd's merge order for these exact bytes on this systemd.
- **Not qualified until done on the production OS** (a separate, reviewed step on the production-sized VM): the real drop-in installation, the real `systemctl show`, and the guard rc on the real paths.

## Unchanged from r1 (see `logs/claude-small-qualification-vm-plan.md`)
- The design: overlay boot of the same OS; read-only data disks; runtime masks for 8 units plus 2 mounts via the OS disk's own kernel, initrd and literal args; transient unit `MemoryMax=10 GiB`, `MemorySwapMax=0`; refusals; `prove`; `stop`; `discard`, with production files re-checked byte-exact.
- **Why 8 GiB:** it is enough for tiny fixtures only, not for any chain backend.
- **Still open:** capacity coordination (host MemAvailable ≥ 26 GiB at launch and the 16 GiB floor throughout, alongside production Qwen); the L1 fstab line (prepare refuses an auto data mount); NVMe free space; and what `prove` must confirm (masks honoured, host key unchanged, root found).

## Root command (not run)
```
bash jobs/q-exit-status.sh qualvm-r2 256 bash rpc-qualification-vm-stage/r2/jobs/root-qualvm-r2-tests.sh
```
PASS = `Ran 6 tests` + `OK`, with the r2 and r1 sums intact. It runs outside `unshare -U`, does not set HOME, and uses discover with an absolute test dir.
