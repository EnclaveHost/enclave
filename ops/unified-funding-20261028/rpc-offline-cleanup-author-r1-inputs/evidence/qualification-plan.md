# Remaining native admission checks — preparation only

No source changes, tests, author, process probe, image operation or privileged helper were run here. Root's r2 native fixture reached READY with real copy/OFD/export/fsck/debugfs/verification and exact eight public unit bytes. Its two explicit mocks were `vm_stopped` and `scan_holders`; it is not production admission proof. Preserve r1's mode-setup failure and r2's intentional synthetic 0644 normalization. Actual retention mode must be captured and supported without normalizing the production unit silently.

The next bounded package should test the existing repaired writer and its precise missing guarantees. Use fresh fixture copies only, no production paths, no port listeners beyond private UNIX sockets, no VM, no chain disk, no automatic repeated attempt. Root chooses the actual shared resource allocation; 512 MiB hard / 450 MiB RSS / 27648 MiB host floor / CPU1 / no swap is the previously used envelope, not an independently measured concurrent capacity grant. Pin any newly used executable, including qemu-storage-daemon, before the test.

## Contention matrix

Use the existing writer's `OsEffects.hold_qemu_locks` and `release` unchanged for the first qualification. Keep each OFD on its original open file description. Each case uses a newly copied synthetic qcow2 with private 0700 parent; make fixture files writable by the test owner so permission errors cannot masquerade as lock success. Capture initial/final byte hash, inode, size, native stderr and terminal PID identities. Every lock refusal needs a lock-conflict diagnostic, not an arbitrary nonzero exit. A negative control after releasing locks must prove the same operation otherwise reaches the intended native path.

1. **Pre-existing writable QEMU:** start foreground `qemu-nbd --persistent --socket=<private.sock> -f qcow2 <fixture>` with no `-r`, no `--fork`, no TCP. Confirm it holds the fixture using exact process/FD identity. Calling writer `hold_qemu_locks` must refuse. Stop the owned qemu-nbd, prove it exited, then the same acquisition must succeed. No client write is needed. Acquire/release alone must not modify bytes.
2. **Future writable QEMU:** acquire writer locks first, then start the same qemu-nbd command on that fixture. It must exit with a permission/lock conflict before serving; hash must remain unchanged. Release the locks and repeat on a fresh fixture to demonstrate it can start. Record both results and cleanup.
3. **Resize:** hold writer locks, run `qemu-img resize -f qcow2 <fixture> <old-virtual-size-plus-1048576>` under a short timeout. It must refuse specifically for the lock and leave size/hash unchanged. The same command after release on a separate disposable control must succeed and report the expected new virtual size. Never test shrink or use `--force-share`.
4. **Second OFD and read-only behavior:** a separate process/open description must observe contention on each claimed protected byte. This proves the kernel-lock mechanics, not the QEMU permission mapping. Also record whether a pinned `qemu-img info --output=json -f qcow2 <fixture>` and read-only qemu-nbd can coexist with writer-held locks. Success must preserve bytes; a documented conservative refusal is acceptable. Do not reinterpret a reader conflict as a required weakening of the lock.
5. **WRITE_UNCHANGED:** use the native permission graph described below. A plain writable open or resize failure does not cover this distinct right.

Add one deterministic interleaving to the same matrix: current code queries GETLK before acquiring its deny locks, with no final conflicting-permission check. A fixture-only synchronization hook around the initial fcntl query can let an actual writable qemu-nbd acquire rights before the writer continues its SETLK sequence. Both must not be accepted concurrently. Native permission and deny-sharing byte ranges differ, so success of the later read locks alone may not detect this race. If confirmed, retain deny locks while checking for conflicting granted permissions, or use a qualified native lock owner. Record the exact hook and do not claim the uninstrumented scheduler happened to exercise the window.

## Native WRITE_UNCHANGED probe

Installed primary QEMU documentation defines `write-unchanged` as permitting writes that preserve visible block contents. It can still matter to byte-identical backing-file preservation. The same documentation exposes actual graph edge `perm`/`shared-perm` through `x-debug-query-block-graph`; this avoids inferring rights from a utility's name.

On a fresh synthetic copy, start pinned `qemu-storage-daemon` in the foreground with:

```
--chardev socket,id=mon,path=<private-qmp.sock>,server=on,wait=off
--monitor chardev=mon
```

Use bounded, ID-correlated QMP with a single absolute deadline per command and maximum frame/output sizes. No daemonize, no TCP. After greeting and qmp_capabilities, candidate requests are:

```json
{"execute":"blockdev-add","arguments":{"driver":"file","node-name":"fixture-file","filename":"<fresh-synthetic-copy>","read-only":false,"locking":"on"},"id":"file"}
{"execute":"blockdev-add","arguments":{"driver":"copy-on-read","node-name":"fixture-cor","file":"fixture-file","read-only":false},"id":"cor"}
{"execute":"x-debug-query-block-graph","id":"permissions"}
```

This deliberately treats the disposable file as a file-protocol node, with no format autodetection or guest I/O. The copy-on-read filter is a documented candidate for requesting write-unchanged. **The graph must actually show `write-unchanged` without `write` on the edge operating on the file node before this is a valid isolating probe.** If that graph is not produced, mark the case INCONCLUSIVE and inspect the returned graph; do not claim WRITE_UNCHANGED qualification merely because QSD started or failed. No data read/write command is necessary to test permission acquisition.

Repeat the graph construction in a fresh QSD while the writer's current 201/203 locks are held on the new test inode. A lock-conflict refusal at the matching permission acquisition is the required result. If the graph succeeds with that right, current locking fails this qualification even if the file hash happens not to change. Record the observed native edge and associated OFD ranges; root can then make the narrow byte-set repair in a separate candidate and rerun only affected cases. Do not assume adding 202 is correct solely from the Python constants. Quit/close the owned daemon and verify all descendants gone for every outcome.

QSD is a qualification instrument, not a new production runtime dependency. The graph command is documented as unstable: pin executable/schema and reject an unrecognized response rather than guessing.

## Cleanup qualification

The r2 fixture demonstrated normal teardown. Add these finite failure cases with exact owned synthetic mounts/processes and an outer cgroup that can reclaim only the test allocation:

| Case | Trigger | Required result |
| --- | --- | --- |
| Mounted but invalid export | Real nbdfuse/qemu-nbd exports a tiny fixture, while the caller deliberately expects the wrong size; short start deadline | FAILED; mount gone; both exporter processes gone, including when `Writer.export` never registered its handle |
| Parent exits before child | A dedicated fake exporter leader starts one owned child that ignores TERM, then exits; no production process | The writer's forced cleanup must prove all owned descendants gone; parent exit alone cannot pass |
| Cancellation during real export | Signal only the test writer after its synthetic writable export is established and before a planned operation | FAILED/nonpublishable; original+backup unchanged; bounded shutdown, no FUSE mount or exporter left |
| Stderr overflow | Dedicated fake exporter emits a finite amount just over the configured cap | Overflow detected while running; child stopped; output storage stays bounded; no READY |
| Identity mismatch | Fake process identity changes before a cleanup signal attempt | Refuse to signal the unrelated identity and report incomplete cleanup; never convert this to success |

The current source has known start-failure and leader-only cleanup gaps. These are expected to expose failures; record them honestly, make only the necessary separate root repair, then repeat affected cases. Existing fixture teardown may clean its own leaked resources after recording product failure, but that cleanup must not be counted as a product pass. Do not require a broad new author or rerun unrelated successful filesystem tests without a relevant change.

## Holder visibility: smallest bounded path

The all-PID ordinary-user scan cannot honestly call unrelated PermissionError cases complete. The smallest stronger path is a one-shot privileged **read-only descriptor inventory helper**, with an immutable, root-reviewed implementation and a fixed schema. This plan grants no sudoers changes, setuid installation, persistent capabilities, daemon or general privileged command executor.

The helper accepts only up to three reviewed `(device,inode)` pairs and an operation nonce, not arbitrary filenames, shell commands or code. It reads only `/proc` process identity and descriptor metadata needed to compare those pairs. It never opens descriptor contents, reads command lines/environments/credentials, attaches a debugger, signals processes, writes images, or changes configuration. It returns bounded JSON: target pair, matching PID/start-time/FD/access-mode records, per-scan count, visibility errors, timestamp/nonce and `complete` status. A PID disappearing during a bounded scan is distinct from an unreadable live process; unknown/error cases remain visible. Use stable proc-directory/pid identity checks to prevent PID reuse from validating the wrong process.

Run it through an **existing root-authorized execution route**, with a pinned root-owned helper and scrubbed environment; do not execute user-writable Python source as privileged code or invent a broad sudo exemption. Root must first determine that this route exists. If unavailable, report that actual limitation and choose an explicitly reviewed cooperative-QEMU/access-control trust boundary; do not silently drop unknown processes from evidence.

Qualification uses only new fixture inodes: an ordinary process holds a known fixture FD, another permitted test process makes its descriptor directory unreadable to the unprivileged scanner, and the helper must detect both with full visibility. Include a process exiting during enumeration. Inject a residual PermissionError and require `complete=false`; the caller must refuse that evidence. Any test process with altered dumpability is owned and stopped explicitly after the case.

Integration sequence for the actual operation: hold the existing workflow lock, verify stopped VM/guard, acquire the now-qualified QEMU locks, then invoke the helper while those locks remain held. Recheck exact source/backup identity. During final verification repeat the helper for source, backup and derivative after all exporters are closed. Parent's own expected read-only lock FDs are reported, not globally hidden; accept only their exact FD/PID/start-time/target/access-mode records. An unexpected writable FD in the parent is not exempt.

This proves descriptor-holder visibility at the observation time under a cooperative native-lock and operator-ownership model. It is not an adversarial guarantee against future arbitrary root/raw writers or descriptor-less mappings; state that scope explicitly. Neither a privileged snapshot nor two repeated snapshots is an atomic future-access reservation. Keep the private derivative path, native locks, workflow exclusion and identity/hash checks throughout the operation.

## Final admission evidence

Preserve one result per case, exact input/tool hashes, positive controls, native permission graph/lock records, bounded stderr, source/backup hashes, owned process/start-time records and terminal mount/process cleanup. Only after the contention/cleanup and real holder path are qualified should root construct and admit one production-derived copy operation. Its publication and the full RPC runtime remain separate.
