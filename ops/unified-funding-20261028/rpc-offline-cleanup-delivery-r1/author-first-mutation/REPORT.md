# offline_mask.py focused repair: SOURCE ONLY, nothing executed

Nothing was run: no tests, imports, native tools, images, shells or network. Every statement below describes code that
was written, not observed behaviour. Root still has to run the original 33 tests, the new targeted tests, the native
qualification and do a semantic review.

## Files
- Modified: `candidate/offline_mask.py` (the only existing file touched).
- New: `candidate/test_exporter_cleanup.py`, `candidate/test_offline_revalidation.py`, `candidate/REPORT.md`,
  `candidate/CLOSURE.json`.
- Unchanged: `test_offline_mask.py`, `inspect_*.py`, `guest_mask.py`, `fixture_reference.py`, `UNIT-PINS.json`, and
  everything outside `candidate/`.

## Preserved qualified paths (not edited)
- `OsEffects.hold_qemu_locks`, `OsEffects.sparse_copy`, `OsEffects.scan_holders` and `Writer.holders` are byte-for-byte
  unchanged. Their line numbers moved because code was added above them, so root should re-compare them by AST source
  segment against PROTECTED-SOURCE.json. That means OFD 201/202/203 denies before the final scan, WRITE_UNCHANGED, and
  the holder behaviour are all as qualified.
- `OsEffects.run`, `bounded_collect` and `_kill_own` are untouched. The systemctl `--user` XDG_RUNTIME_DIR /
  DBUS_SESSION_BUS_ADDRESS handling is untouched, and so are ordinary command bounds.
- Copy identity schema, eight UNITS pins, read-only source/backup, exclusive creation, GPT/ext4/fsck/qcow2 checks,
  capacity, `vm_stopped` and holders: no change.

## Changes
1. **Exporter ownership and cleanup** (`OsEffects.export_start/export_stop/export_force_cleanup`, new `_owned_scan`,
   `_await_gone`, `_signal_owned`, `_drain`, `export_fault`; module `_proc_table`, `_mounted`).
   - Cancel signals are blocked while the exporter is spawned. The handle is registered through a callback
     (`Writer.handles.append`) right after `popen`, before any wait, so a startup timeout or a wrong exposed size still
     goes through cleanup with the pinned `fusermount3`.
   - An exposed size that differs from the expected one is refused at once instead of waiting.
   - The leader is never reaped (only `waitid WNOWAIT`) until teardown has checked that every owned process is gone.
     While the leader is unreaped its pid, pgid and sid stay reserved.
   - Owned processes are tracked as (pid, starttime) from three sources: the session, the process group, and ppid
     descendants. They are recorded when the export appears and again at each teardown poll.
   - Members other than the leader are signalled only through `pidfd_open`, followed by a start-time recheck and
     `pidfd_send_signal`. The leader group is signalled with `killpg` only while it is unreaped, under the handle lock.
   - Escalation is bounded: TERM, wait 5s, KILL, wait 5s. If anything owned survives, the code refuses and lists the
     survivors.
   - Mount presence is read from `/proc/self/mountinfo`, not `os.path.ismount`, because a dead FUSE mount answers lstat
     with ENOTCONN and would look absent. Unmount uses at most 2 bounded `fusermount3 -u` calls, with no lazy unmount.
     If the mount is still present, the code refuses.
   - Only after that is the leader reaped and the drainer joined. A drainer that doesn't join is a refusal.
   - The normal stop path reuses the same verified teardown. Cancellation goes through `Writer.cleanup` to the same code.
     A second signal during cleanup is deferred, not raised (`_CANCEL`), and turns the result into FAILED.
   - A start-time mismatch or an unreadable start time refuses without sending any signal. The existing
     `CleanupTests` behaviour is kept.
2. **Bounded stderr** (`_drain`).
   - stderr is a pipe drained by one owned thread per exporter, so draining continues while the parent hashes or runs
     other commands. At most one exporter runs at a time.
   - At most `maxOutputBytes` is retained. Going over the limit sets a fault and the drainer TERMs the exporter group
     itself (under the same no-reap lock); it does not just truncate.
   - `Deadline.left` now calls `Writer.check_exporters` (fault, or a leader that exited unexpectedly). Every hash chunk,
     debugfs request and command observes it.
   - `Writer.assert_quiesced` blocks READY unless no exporter is registered and every teardown is `complete`, joined
     and fault-free.
   - Evidence holds the stderr byte count, its sha256 and a 2048-byte head. Exporter stdout is still `/dev/null`. The
     old `exporter-N.stderr` file is no longer written.
3. **Content checks and RO-to-RW revalidation.**
   - `inventory` hashes every regular file in the scanned unit-tree scope. Contents are never logged, because `log`
     records only the stdout sha.
   - `semantic_delta` also flags files that only got a hash after the mutation and any regular file without a hash.
     Same-size changes are caught by the hash.
   - `Writer.revalidate` runs on the writable export before the first write and compares, against the RO capture: the
     usr-merge directory set, the full stat of the ancestors and `/lib` (plus KEEP if it exists), the complete
     inventory (entries, hashes, directives), the full fragment stats and ea_list, the full link stats and ea_list, the
     name-to-inode maps of every parent directory that is mutated, and the absence of the rollback parent and stamp.
   - `Writer.guard` runs right before each write:
     - The parent's listing must equal the expected model.
     - mkdir, ln and symlink require no occupant.
     - ln and unlink require that the source path still maps to the original inode and has the full original stat.
     - unlink also requires that the archive entry references that inode with identical stat, and that ea_list is
       still empty.
     - rm requires that the recorded link inode and full stat are still at that path.
   - `Writer.settle` runs after each write. It requires that the parent changed by exactly our own step (a fresh inode
     for mkdir/symlink) and updates the model, so the valid sequence is not rejected.
4. **Rollback records and the no-xattrs path.**
   - New `Debugfs.ea_list`: rc 0, no non-banner stderr, and stdout exactly `b''`. Anything else refuses.
   - `check_record` requires the type, links==1, all four timestamps (atime/crtime/ctime/mtime) and no stat-reported
     xattrs.
   - `link_records` captures the full native stat and ea_list for every enablement link.
   - These checks run on the eight fragments and every link before ROLLBACK.json is written. The links are persisted
     with full stat and xattr result, before any removal.
   - ea_list is rechecked at revalidation, before each unlink, and on the eight archived inodes during postverification.
     Archive stats must still equal the original full stats.
   - Actual modes and timestamps are not normalised or altered, and there is no xattr restoration feature.

## Proposed test commands (for root, in a bounded copy)
```
cd candidate && /usr/bin/python3 -I -m unittest -v test_offline_mask        # original 33, must be unchanged
cd candidate && /usr/bin/python3 -I -m unittest -v test_exporter_cleanup test_offline_revalidation
```
Dependencies: CPython 3.9+ on Linux (`os.pidfd_open`, `signal.pidfd_send_signal`, `signal.pthread_sigmask`,
`threading`), all from the standard library. The tests use `os.pipe` and one `tempfile.TemporaryDirectory` file and
nothing else from the host.

## Tests authored, not run
- `test_exporter_cleanup.py`: normal termination; mounted wrong-size startup; leader-exited/child-alive escalation
  with reap after child exit; cancellation through cleanup with a deferred second signal; leader identity mismatch and
  member pid recycled after pidfd_open; unrelated recycled member not owned; stderr overflow during parent work; no
  READY with a faulted, unjoined or still-registered exporter.
- `test_offline_revalidation.py`: positive full sequence (all mutations succeed, delta and archive empty); every regular
  file hashed and same-size drift caught; RO-to-RW drift of link, ancestor, fragment, rollback name, usr-merge and
  ea_list; unlink replacement right before the write; archive drift before unlink; unexpected archive occupant; rm
  replacement (new inode or same inode with new metadata); an extra directory change during our own step; incomplete
  link or fragment timestamps; native ea_list nonempty, newline-only, rc0 stderr error and rc1.

## Remaining limits and risks
- **Holder visibility is out of scope and still unqualified.** `scan_holders`/`holders` are unchanged. The synthetic
  READY fixture's `vm_stopped`/holder mocks are still mocks and support no production-readiness claim.
- **Natively unqualified:** debugfs `ea_list` output on the target e2fsprogs, the nbdfuse/qemu-nbd process tree
  (session vs setsid'd children), pidfd signalling, mountinfo matching, the drainer under real FUSE load, and
  revalidation timing. Root's actual evidence (an empty ea_list hashes to the empty sha256) matches the `b''` rule, but
  that is not a native run.
- Every regular file is hashed with one debugfs `cat` each, over 3 inventories. Runtime grows with unit-tree size
  (bounded by `maxInventoryEntries` and `totalSeconds`); a large unit tree can time out, which fails closed.
- Descendants that call setsid after the start-time scan and before the leader exits are only caught through the ppid
  chain while the leader is alive. Session and group members are always caught.
- If the leader's start time cannot be read, or a teardown is incomplete, the exporter is left alone and reported as
  FAILED/nonpublishable. It is not killed.
- There is a residual window of one bytecode between entering `operate`'s `finally` and `cleanup` setting `deferred`.
- `settle` runs after the journal's `done` record. A settle refusal still makes the result FAILED, and the journal
  shows the step executed.
