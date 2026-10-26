# base-launch-producer-stage/r2: one-shot M10 launch handshake (PREPARED; NOT run; source-only)

r1 (`../producer`, `../tests`, `../MANIFEST.sha256` `2263b031…`) is unchanged; root rejected its lifecycle. The wrapper candidate
`base-wrapper-integration-stage` (`fc5b0b05…`) is also unchanged. `LAUNCH_PRODUCER_REVIEWED` and `FINALITY_PROOF_REVIEWED`
both stay **False**.

## Layout
- `wrapper/chain_service.py` (`07276ec8…`): the r2 wrapper revision. `wrapper-r1-to-r2.patch` is its diff against r1.
- `wrapper/test_chain_service.py`: a byte-identical copy of the existing 34-test suite (`541342a4…`).
- `producer/base_launch.py` (`7e8d295d…`): the r2 producer. Its `produce` logic is r1's; `producer-r1-to-r2.patch` is its diff.
- `tests/test_r2_handshake.py` (`ca925a8c…`): the 15 new tests.
- `jobs/root-r2-tests.sh`: the local offline root job, with exact counts 34 + 34 + 15.
- `jobs/guest-handshake-canary.sh`: an optional bounded guest canary. It never starts Base.
- `systemd/50-base-launch-handshake.conf`: the exact proposed unit drop-in.
- `base/`: the r1 inputs, byte for byte.
- `inputs/consumed-inputs.sha256` and `MANIFEST.sha256`: the pins.

## Handshake (wrapper, release mode only; legacy mode unchanged)
1. Refuse unless euid 0 and `ENCLAVE_BASE_LAUNCH_HANDSHAKE=1` (the drop-in marker). Legacy mode refuses if the marker is set.
2. `launch_lock`: take a non-blocking exclusive `flock` on the pre-existing root-owned 0600 `journal.lock`. The open uses
   `O_NOFOLLOW|O_CLOEXEC`, and the fd/inode must match the path. If the lock is busy, refuse with nothing consumed.
3. Run every existing gate, in the existing order, while holding the lock: mount, profile, coverage, history, state, L1,
   origin, receipts, blobs.
4. `launch_record`: check the immutable `launch.json` against chain.json `baseBootstrap.anchorLaunch` = exactly
   `{launchSha256}`, plus the r1 qualification bindings.
5. `journal_entries`: verify `journal/NNNNNN.json`. Every entry must be root-owned, contain no symlink, carry contiguous
   seq numbers, belong to this launch, chain to its predecessor's sha256, and follow an allowed transition.
6. The state must be pending (`armed` or `rearmed`) and `now ≤ notAfter`. `LAUNCH_PRODUCER_REVIEWED` is checked here,
   before anything is consumed.
7. `journal_append('consumed')`: write the entry to a fully written, fsynced `.partial-<pid>`, `link` it into place (no
   clobber), fsync the directory and re-verify the journal.
8. `drop_privileges`: initgroups, then setresgid/setresuid to `rpcbase`, verified, with `setuid(0)` required to fail.
   Then `execve` in the same process with the anchor argv.

`consumed` means refuse until root runs `rearm`. `rolled-back` is terminal. There is no `bootstrapped` event.

## Root operations (all take the same lock and use the wrapper's own journal functions)
| command | transition | condition |
|---|---|---|
| `produce <a2a4-cfg> <new-dir>` | – | r1's logic. Pin the resulting `launchSha256` once. |
| `arm <dir> <a2a4-cfg>` | none → `armed` | Fresh, the stopped DB is unchanged at N, and no entry exists yet. |
| `rearm <dir> <a2a4-cfg>` | `consumed` → `rearmed` | Fresh, and the stopped DB is unchanged at N. |
| `rollback <dir> <reason>` | any → `rolled-back` | Terminal. |
| `record-bootstrapped` | HOLD | `FINALITY_PROOF_REVIEWED = False` |

"Stopped DB unchanged at N" means all of the following:
- the `mdbx.dat` dev/ino/size/mtime equal the launch record's binding, checked before and after the reads;
- the harness's own `gate_static` passes;
- every stage checkpoint equals N;
- no header exists above N;
- header N authenticates to the anchor hash.

## Root command (local, offline)
```
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-launch-producer-stage/r2
python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 256 --log $S/logs/root-r2-tests.guard -- unshare -rn bash $S/jobs/root-r2-tests.sh
```
A pass requires all of these: rc 0; `PASS baseline-existing Ran 34`, `PASS r2-existing Ran 34` and
`PASS r2-handshake Ran 15`; no skips; `aggregate rc=0`. Any other result is a failure. Exit 98 from the queue means the job
did not start.
