# Combined activation and rollback rehearsal

`combined_rehearsal.py` exercises the previously qualified retirement, code
transaction, runner transaction, and recovery helpers together on Windows.
It uses the fixed disposable directory
`C:\Users\claude\kvm-box-combined-v9-1025` and the scheduled-task folder
`\Enclave-Native-Combined-V9-1025\`. It refuses an existing fixture directory
or occupied task folder. Do not run it against a production directory.

The package requires the exact manifest, all 92 original runtime files, all
109 candidate runtime files, the captured public service runners, the public
release descriptors/environment, and the validated platform/runtime admission
description. No wallet key, owner password, service secret, or private base
configuration belongs in the fixture.

The fixture copies both runners, redirects their data/control directories,
and replaces the production Node and manager entrypoints with explicit test
workers. It retains their command-shell service loops. The three fixture tasks
run as SYSTEM. Base configuration files contain only cleared native settings;
the real private base configurations are neither copied nor executed. The
runner manifest is rebuilt for these deliberately relocated fixture bytes.
Production runner hashes and their isolated equivalents are recorded separately.

Each cycle stops fixture admissions and the fixture updater, retires the two
known fixture records through the original manager's HTTP server, stops the
manager, applies the exact 31-file candidate overlay and two runner hooks,
and starts the candidate manager before admissions. It then clears candidate
records while their owning manager is still alive, stops that manager, rolls
back both transactions, and restarts the original manager before admissions.
The updater's enabled state is restored last.

Three scenarios cover a healthy switch, a manager failure before it opens its
listener, and a partial launch whose VM handle remains private after failure.
The partial-launch scenario holds CPU, GPU, and physical-memory allocations;
cleanup must release them before rollback. Every transaction checks the actual
fixture task/process state. The workers use actual pinned Manager and HTTP
implementations, including their removal logic and epoch-bound observations.

## Evidence boundaries

Scheduled tasks, process identities, command-shell runner execution, exact code
transactions, HTTP responses, accounting, and rollback are real. Admissions,
readiness/preflight, Hyper-V inventory, and VM creation/removal are simulated.
The configuration files are hash checked, but this fixture does not load a
desktop image or contact a GPU worker. Its recovered "serving" records are test
records, not real restored applications.

This does not replace the separate production runner validation, the successful
hardware launch/removal canaries, or final hardware failure recovery and owner
desktop acceptance. It does not authorize a production interruption or prove
that wallet publication, storage pinning, or Moonlight setup is complete.

The result includes before/after read-only production task/process/VM snapshots.
Check `productionUnchanged` explicitly; it is separate from fixture success.
An automatically changing production lease must not be mistaken for a change
caused by this rehearsal. Cleanup removes only fixture tasks and processes.
Any forced cleanup or remaining process requires investigation before accepting
the rehearsal. Keep failed-run evidence and verify the namespace is empty
before archiving a failed fixture for a subsequent attempt.

## Results

The October 25 run passed from 19:09:45 to 19:21:01 UTC. A separate readback at
19:23:24 checked all 109 code paths, both runner hashes, and six rolled-back
transaction journals. All three cycles restored the baseline and restarted its
fixture records. Both candidate cleanup cycles released CPU, GPU and physical
memory allocations to zero, including the failed record with a private VM handle.
No fixture tasks or processes remained, and no forced cleanup was needed.
Production process/start times, task states and four VM identities/states matched
before and after. See [combined-v9.json](combined-v9.json).

The exact input archive is SHA256
`725ea6e07cd6cecd431a6bcbabccb883b095c86513a0e48a60aa781c027c9eb7`
(1,653,719 bytes); the result archive is SHA256
`571148af4a99f08009430be772d1f61f7a3f0fc250515c6e0202cf299f700dc1`
(1,536,463 bytes). Full archives, journals, and the independent export verifier
are in the task deliverable `evidence/native-combined-v9/`.

The authoritative run record is `result.json` in the fixture directory; progress
is written to `progress.json`. Transaction and removal journals are under
`journals/`. A complete review requires all three cycles, successful baseline
readback and fixture restart after each rollback, zero remaining fixture tasks
and processes, and the production comparison. Qualification results are recorded
alongside the exported evidence after the Windows run completes.
