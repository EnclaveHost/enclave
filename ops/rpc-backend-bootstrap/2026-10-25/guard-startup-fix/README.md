# RPC VM capacity guard: bounded QEMU startup fix (launcher 38f8dc89)

## Status

| Item | State |
|---|---|
| **Guest boot** | **Verified at 17:55 UTC.** The first start failed at 17:40; the corrected launcher survived preallocation and booted the guest from NVMe. |
| **Installed fix** | Root installed the exact tested launcher `38f8dc891bfa9f5f74fcd8eb4ba50ea6f5f70342c49e3c7e2944a10c504436d7` with manifest `fd71831c7f54b79e22596ae566e21521b67979e81fa8decf886c61d90f199ca3`, from root's reviewed stage. QEMU argv, seed and guest disk config are unchanged (`root-installer/review.json`). |
| **Current run** | RPC VM and capacity guard are active with zero restarts; QMP contact is established. Ethereum EL/CL are active; the Base downloader reused 20 verified outputs and continues downloading on HDD. |
| **Readiness** | Startup is verified; chain synchronization, historical blob coverage, safe/finalized readiness and consumer cutover remain incomplete. See `live/`. |

## What changed in `../provision_vm.py` (8b1ece11 → 38f8dc89)

**`Qmp`**
- Any handshake failure (connect, greeting, `qmp_capabilities`) closes the makefile and the socket before re-raising. Leaked half-open connections are what filled QEMU's monitor accept queue (EAGAIN) during the 17:41 start.
- `handshake_timeout` is a **per-socket-operation** timeout, not one total deadline. One initial attempt can therefore take a few seconds: one connect plus a few reads and writes, each bounded at 1 s.
- After success, the runtime timeout is restored to 10 s.
- A malformed reply raises `OSError`.

**`guard_loop` before the FIRST successful monitor connection**
- One fresh attempt per poll, with `QMP_INITIAL_HANDSHAKE_S=1` per operation.
- Storage checks, status and `WATCHDOG=1` continue on every poll.
- **Fails closed** (exit 3, which stops the VM unit):
  - after `QMP_INITIAL_GRACE_S=300` s from the first failed attempt;
  - **immediately** if the capacity decision is not `ok` (`pause`, `shutdown`, or a failed identity/measurement check).

**Runtime after a successful connection: unchanged**
- Reconnects use the 10 s runtime timeout and `QMP_RECONNECT_GRACE_S=60`.
- `pause` while QEMU is unreachable exits 3 at once.
- A QMP command failure while QEMU is present exits 3 at once.
- QEMU gone after being seen exits 0.
- No socket yet means the guard waits, as before.
- Pause/shutdown thresholds and the watchdog are unchanged.

**`cmd_powerdown`**
- A greeting, capabilities or query-status failure prints `powerdown: QMP handshake failed (...)`, closes both handles and returns 1. Systemd then SIGTERMs QEMU.
- It stays bounded by the unchanged 10 s socket timeout.

**Root review notes, NOT changed in the installed 38f8dc89** (any later change is a new, unactivated artifact):
- `Qmp.close()` does not use try/finally: a failing `file.close()` would skip `socket.close()`.
- The handshake bound is per operation, as stated above, not one absolute 1 s deadline.

## Tests

All runs were offline, through `work/claude-test-queue.py` at 512 MiB with a 16 GiB floor. No full VM was started; real QEMU was used only as `-machine none`.

| Log | Launcher | Result |
|---|---|---|
| `logs/guard-startup.out` (`.guard`, `.rc`) | 38f8dc89 | **New startup suite `../nvme-migration/test_guard_startup.py`: 16/16 OK**, rc 0, including the real QEMU stalled-monitor case (`GUARD_REAL_QEMU=1`). This is the valid startup run. |
| `logs/first-aggregate-FAILED-afunix.out` | 38f8dc89 | **The aggregate FAILED (rc 1).** Its `test_guard_startup` section failed only because AF_UNIX paths under the deep `TEST_TMP` exceeded 107 bytes; that section is superseded by the run above. The other sections in this same run passed on 38f8dc89: `test_nvme_migration` **17/17**, `test_receipts` **19/19**, `test_real_qemu` **5/5**, `test_systemd_lifecycle` (nested `systemd --user`) **2/2**. |
| `logs/negative-control-old-8b1ece11.out` | old 8b1ece11 | **Expected failure:** 13/16 fail or error (7 failures, 6 errors). The 3 that pass are the deliberately unchanged behaviours: unsafe capacity after connect still pauses; no socket means waiting; a command failure while present exits 3. |
| `logs/invalid-not-counted/startup-try1-fdcount.*` | 38f8dc89 | Invalid fixture, **not counted.** The in-process fake server's own FDs skewed the FD-leak count; the server was moved to a child process. |

**What `test_guard_startup.py` covers:**
- **Exact boundary:** still waiting at 300 s elapsed, exit 3 one poll later. One attempt per poll, with the watchdog fed throughout.
- **Immediate refusal** on `shutdown`, `pause` or a failed check during startup.
- **Delayed greeting** followed by the unchanged runtime failure policy.
- **Reconnect after seen** keeps 60 s, not 300 s.
- **Unchanged paths:** gone-after-seen exits 0; waiting without a socket; pause after connect.
- **Real AF_UNIX server in a child process:**
  - a backlog that never accepts gives no FD growth over 40 attempts;
  - a server that accepts but never greets times out, and the server observes EOF;
  - a malformed reply becomes `OSError`, with no leak;
  - a successful handshake restores the runtime timeout.
- **Real guard loop** against a monitor that greets only after 2.5 s.
- **Real QEMU** whose monitor is stalled by SIGSTOP for 4 s.
- **Powerdown** against a monitor that never greets: controlled rc 1 within about 10 s, no traceback.

**Test file changed:** `../nvme-migration/test_nvme_migration.py`. Its old 60 s pre-connect test now asserts the 300 s initial grace, and `FakeIO.qmp` accepts `handshake_timeout`.

**Job scripts:** `jobs/test-all.sh` (`SUITES=` selects suites; set `TEST_TMP` to a private directory) and `jobs/negative-control.sh`. Both reference the private staging paths they were run from.

## Root installer (the one executed)

`root-installer/install-root-reviewed.sh`, `review.json` and `SHA256SUMS` are root's reviewed stage. Image, keys and the whole manifest are not published.

The installer:
1. checks that both units are inactive/failed with MainPID 0;
2. checks the stage and the old shas (manifest `74db2e44…`, launcher `8b1ece11…`, vm unit `70d3d4d8…`, guard unit `3f6747af…`);
3. backs those files up to `~/.local/state/enclave-rpc-production/backup-guard-start-38f8dc89/`;
4. installs launcher, manifest and both units (vm `e496975f…`, guard `713d6e54…`);
5. runs daemon-reload and `verify`. It starts nothing.

`untested-unused/repin_stage.py` is an **UNTESTED and UNUSED** alternative staging helper. It was compiled only, never run, and was **not** used for the install. Do not prefer it over the executed root installer above.

## Rollback

Run everything as uid 1000. **Stop first; never start in between.** Never attach the HDD originals and the NVMe copies together; neither manifest does, so do not hand-edit them. Never delete, mount or open the NVMe copies or the HDD originals for this.

```
systemctl --user stop enclave-rpc-production-vm.service        # ExecStop = powerdown; the guard stops with it
systemctl --user show -p ActiveState -p MainPID enclave-rpc-production-vm.service enclave-rpc-production-guard.service
# both must be inactive|failed with MainPID=0 before going on
```

### A. Back to the previous v2 (launcher 8b1ece11, manifest 74db2e44)

**This restores the 17:41 startup defect.** Its 60 s grace will fail again during the 64 GiB prealloc. Use it only as a file-level restore, and do not start it.

```
state=~/.local/state/enclave-rpc-production; units=~/.config/systemd/user; B=$state/backup-guard-start-38f8dc89
(cd "$B" && sha256sum -c SHA256SUMS)                           # expect manifest 74db2e44, provision_vm.py 8b1ece11,
                                                               # vm unit 70d3d4d8, guard unit 3f6747af
printf '%s\n' "fd71831c7f54b79e22596ae566e21521b67979e81fa8decf886c61d90f199ca3  $state/manifest.json" \
  "38f8dc891bfa9f5f74fcd8eb4ba50ea6f5f70342c49e3c7e2944a10c504436d7  $state/provision_vm.py" \
  "e496975f40f1176d05a2e769f101e391309855538246d337f50886559d702ad7  $units/enclave-rpc-production-vm.service" \
  "713d6e544e322b007d7bd05773e0a49d3d3bea90ccd8c31e15ce9478b80acaf6  $units/enclave-rpc-production-guard.service" \
  | sha256sum -c -                                             # what is installed now
install -m 0500 "$B/provision_vm.py" "$state/provision_vm.py"
install -m 0600 "$B/manifest.json" "$state/manifest.json"
install -m 0644 "$B/enclave-rpc-production-vm.service" "$units/enclave-rpc-production-vm.service"
install -m 0644 "$B/enclave-rpc-production-guard.service" "$units/enclave-rpc-production-guard.service"
systemctl --user daemon-reload
python3 -I "$state/provision_vm.py" verify
```

### B. Back to the original v1 (HDD images, launcher 184e816c, manifest ecbe7b65, no guard)

1. Do **A** first. The v1 rollback script removes the v2 guard unit only when it equals the 8b1ece11-era guard unit `3f6747af…`; with the 38f guard unit still installed, it would leave that unit behind.
2. Run the reviewed `nvme-migration-stage/staged-final/rollback.sh` (sha `c99a4df7…`). It:
   - restores `~/.local/state/enclave-rpc-production/backup-c1b3d9e63fc0/` (manifest `ecbe7b65…`, `provision_vm.py` `184e816c…`, vm unit `abe7744c…`);
   - removes the v2 guard unit and the guard state files;
   - runs daemon-reload and `verify`.

v1 points the VM back at the HDD `os` and `l1` originals. **Chain progress made on the NVMe copies is not on them.** The NVMe copies are left in place, unattached.
