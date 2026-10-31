# Owned RPC state exports

`volume_export.py` is the maintained data-path component for a host selected by the
wallet owner. It has no Enclave discovery or control endpoint. It creates a new
exclusive COW for an explicit original chain, holds QEMU-compatible read-only
permission locks, validates the complete backing chain, and launches a pinned
foreground qemu-nbd with mandatory TLS and an attempt/role-specific client DN.
Backing nodes are explicitly read-only; only the new overlay is writable. One
connection is served at a time. The original images and failed/partial overlay
are retained. The component consumes an attempt once and provides no retry.

This is a library, not a production launcher or resource admission. Its caller
must run in a separately admitted cgroup with an independent original deadline,
continuous host/pending/disk monitoring, protected source/credential namespace,
and exact-child cleanup. A returned Popen is not a listening/readiness receipt.
`check()` enforces the supplied monotonic deadline only when called; it cannot
interrupt a hung caller. The caller must therefore have an independent guardian.
`close()` waits for its exact child but never claims clean guest filesystem state,
global writer fencing, or releases a production reservation. No READY or adoption
receipt is fabricated here. Credential generation/delivery and the protected
operator path that binds the guest to this export remain separate integration.

The finite native fixture uses private network/PID/mount namespaces and disposable
1MiB data. It tests real authenticated NBD writes, FUA/FLUSH, explicit reconnection,
authentication/name/export refusal, QEMU writer-lock refusal, original preservation
and persisted overlay readback. It does not qualify Linux kernel attachment,
production data, cross-host failures, durable cleanup, or sustained performance.

Protocol references: [QEMU NBD](https://www.qemu.org/docs/master/tools/qemu-nbd.html)
and [NBD specification](https://github.com/NetworkBlockDevice/nbd/blob/master/doc/proto.md).

Actual isolated qualification passed all13 native checks in0.534s; see
[the result](../../ops/unified-funding-20261028/rpc-volume-export-native-fixture-r1/ROOT-RESULT.md).
The earlier storage-host headroom failure was cleared after an authorized Warden
application close and a new authenticated observation. Production export still
requires current admission and the actual guest startup transaction.

## Guarded lifecycle candidate

`guarded_export.py` now composes the COW worker with an independent guardian
process. The worker waits on a closed socket gate until the guardian has a fresh,
authenticated resource observation. The guardian owns the original monotonic
startup deadline, polls exact child pidfds, and continues resource checks while
the worker performs disk/network operations. A stalled observer, expired resource
reading, changed authority, low reserve, dead worker or missed startup deadline
stops the owned process group. Group leaders remain unreaped until signals have
been sent, preventing PID-reuse cleanup errors.

The CLI additionally requires an exact user-systemd unit named
`enclave-rpc-export-ATTEMPT.service` with these properties before creating children:
Type=notify, NotifyAccess=main, KillMode=control-group, Restart=no,
WatchdogSec=2, WatchdogSignal=SIGKILL, TimeoutStartSec=3, TimeoutStopSec=1,
SendSIGKILL=yes, FinalKillSignal=SIGKILL, MemoryMax=384M, MemorySwapMax=0,
CPUQuota=100%, TasksMax=32 and LimitCORE=0. The caller must hold the separate
128MiB bootstrap/collector allowance (512MiB total) and reviewed host admission.
The CLI rechecks main PID, invocation, cgroup and kernel memory limits, then waits
for an acknowledged active watchdog before forking. This is a required backstop
for a guardian that itself stalls; Python time checks alone are insufficient.
The unit and config are not installed or started by importing this module.

The protected0600 contract binds attempt, guest instance, host boot, original created/deadline
UTC nanoseconds separated by exactly900seconds, role-specific original chains,
TLS locations and endpoint names, state directory, runtime source hashes and the
maintained resource reader command. Runtime pins include both Python components,
`observe_resources.mjs`, its protected configuration, the shared `../storage_protocol.py`,
and the Node executable.
The resource reader verifies the installed local control client hash and performs
two authenticated GET /health requests. It never invokes VM operations. Pending
RAM includes growth still reserved for **running guests**; it is not a queue that
can simply be waited out. The explicit startup floor remains27648MiB and the
installed host floor is also honored if higher.

Before publishing export readiness, the worker performs exact-binary TLS
negotiation and checks the export name, size and writable/FLUSH/FUA flags.
`ready.json` explicitly says rpcReady=false. The operator can adopt only after the
separate RPC workload/readiness review, by delivering a protected receipt bound
to attempt, boot, contract hash and readiness hash. Adoption must be observed
before the original deadline; a delayed callback cannot extend it. The worker
also rejects late adoption. Once adopted, resource monitoring continues, and
removing or modifying the receipt stops the export. No receipt producer or
implicit RPC approval is included. Startup failure never deletes or reuses a COW.

Qualification so far:10 finite real-process guardian tests,14 native dummy COW/TLS
checks including the actual supervisor probe, and one authenticated invocation of
the maintained resource reader. The original probe-format failure is preserved.
The final CLI adds stricter unit timeout/escalation and acknowledged-watchdog
checks; the tested guard/probe/owner functions remain byte-equivalent as ASTs.
The final CLI as a whole has **not** run in production or passed composed native
activation. Two real target user-systemd dummy tests separately froze the main
process and verified exact main/child pidfd exits, watchdog termination and empty
cgroups in about2.2seconds, including a child configured to ignore SIGTERM. Those
used128MiB actor units; they do not qualify the production384MiB supervisor or
whole-stack admission. Guest credential delivery, full composed lifecycle,
kernel attachment, sustained workload and actual production cutover remain open.

The full maintained CLI subsequently passed its first composed native fixture:
both loopback TLS exports reached the bound READY receipt using real authenticated
local-manager resource observations, then freezing the actual384MiB supervisor
caused watchdog termination of all four preheld process identities in2.045seconds.
The cgroup emptied and original dummy image hashes remained unchanged. See
[the composed result](../../ops/unified-funding-20261028/rpc-full-export-cli-qualification-r1/ROOT-RESULT.md).
The fixture used sparse dummy disks with protocol geometry, no blockchain data.
Its total harness commitment was1024MiB (queue wrapper128, controller scope512,
supervisor384); the result explicitly corrects an initial512MiB harness accounting
statement. This does not change the production supervisor384MiB plus128MiB
bootstrap allowance. Guest attachment, workload fit and production readiness are
still unproven.

The existing guest's TLS credentials have now been staged privately on Warden
over the authenticated Control SSH path. Both role-specific server credentials
and matching client credentials for the supervisor's probe were transferred;
issuer keys and the guest SSH private key stayed on Control. All13 files passed
private-permission/readback checks, and all four certificate/key pairs matched
the original pinned identity receipt. No keys were regenerated. Public evidence
is in
[the staging result](../../ops/unified-funding-20261028/rpc-storage-credential-stage-r2/ROOT-RESULT.md);
the credential directory and captured transport are excluded from Git.
The first collector's transient-unit metadata failure is retained separately.
This completes credential placement only. The original common startup deadline,
production export contract, Windows definition/boot/start and authenticated guest
activation remain to be executed together; no production export is listening.


## Original startup clock and contract preparation

The current CLI requires `startupClock: {path, sha256}` and a reviewed source pin
for `rpc/startup_clock.py`. Unbound historical contracts are refused. The original
fixture and its qualified source remain preserved; their success does not qualify
this changed path.

The operator calls `startup_clock.begin(parent, attempt, instance, vm_attempt)`
once, before acquiring the Windows clock sample or making startup mutations.
This creates an exclusive private attempt directory and fsyncs the original host
boot, UTC and monotonic origins. Preparation and transport time then consume the
same900seconds. An incomplete attempt cannot be replaced with a new clock.

The authenticated Windows sample has the exact fields `schema` (equal to
`owned-rpc-windows-clock/1`), `attempt`, `vmAttempt`, `windowsBoot` (native boot GUID
as32 lowercase hex characters), and `monotonicMilliseconds` from
`BoundedWorker.MonotonicMilliseconds()`. Acquire it between begin and finish,
through the owner's pinned channel. A hash alone cannot establish its origin or
sampling time. `finish(begin_binding, sample_binding)` takes two `{path, sha256}`
records and consumes completion before publishing the bound clock. The handshake
must finish within10seconds on the same storage-host boot, with at most2seconds
of wall/monotonic discrepancy. Failure preserves the consumed attempt.

The Windows origin subtracts the entire measured handshake interval, rounded up
to milliseconds, plus1millisecond of sample quantization. With the authenticated
sample bracketed by begin/finish and the OS monotonic clocks advancing at their
specified rates, this chooses an origin no later than begin. Native Windows
controllers must still verify the actual boot and use those exact original
origin/deadline values; this Python module does not authorize a Windows operation.
The exporter also clips its deadline to the recorded storage-host monotonic
deadline. Even a permitted wall-clock offset cannot add startup time.

`prepare_export.prepare(config)` creates only an exclusive `contract.json` and
preparation receipt. Required configuration fields are:

- `clock`, `credentialReceipt`, and `resourceConfig`: protected pinned inputs.
- `runtimePins`: exact expected hashes for guarded_export, volume_export,
  observe_resources, storage_protocol, startup_clock, the resource configuration,
  `/usr/bin/node`, and the two maintained QEMU tools. Paths identify the actual
  installed source closure; the preparer checks expected pins rather than granting
  authority to whatever code happens to be present.
- `roles`: exactly `l1` and `base`, each with `parent`, `originals`, `tls`,
  `clientTls`, `host`, and `port`. Original entries are `[canonical_path,
  [device, inode, size, mtime_ns, ctime_ns]]`. Both roles retain the fixed4TB virtual
  geometry and original credential identities. Ports must differ.
- `stateParent`, `output`, `floorMiB`, `reserveMiB`: existing private parents,
  a new attempt-named output directory, and floors no lower than27648/512MiB.

The preparer checks source pins, public certificates, credential file permissions,
and original image metadata before and after publication. It never reads private
key bytes, creates COWs, starts processes, claims current capacity, or adopts an
RPC. Certificate/key matching is a separate credential-staging check, and the
exporter still negotiates real TLS before publishing metadata. Its runtime source
and the new clock module must be deployed together. Guest seed contents are
unchanged. The complete Windows/export/guest transaction and real workload
qualification remain outstanding.

The changed implementation passed26 clock/export cases,10 existing actual-process
guardian cases and8 protocol/guest-parser regressions. The first regression
wrapper omitted a frozen dependency; its replacement then encountered a private
mount setup error before test execution. Both failures remain preserved, and the
corrected isolated protocol run passed all8 cases without repeating the26+10.
The changed full CLI also ran with real authenticated host admission and dummy
TLS/COW exports. Freezing the384MiB supervisor caused exact observed process death
and an empty cgroup in2.200seconds; both dummy originals were unchanged. That
fixture uses a deliberately synthetic Windows sample and does not qualify the
actual Windows clock channel, a production export or RPC startup. See
[clock/export tests](../../ops/unified-funding-20261028/rpc-startup-clock-export-tests-r1/ROOT-RESULT.md)
and [the composed CLI result](../../ops/unified-funding-20261028/rpc-clock-bound-export-cli-r2/ROOT-RESULT.md).

## Guest receipt binding

`storage_protocol.py` is shared by the server emitter, owner-side
`prepare_attachment.py`, and guest attachment helper. The server emits
`owned-rpc-server-ready/1` only after both real TLS probes return the expected
export, size and writable/FLUSH/FUA metadata. The receipt binds guest instance,
server boot, exact server contract hash, supervisor invocation, and the original
900-second window. It deliberately does not assert a filesystem UUID, global
writer fence, or RPC readiness that the probe has not established.

The owner-side preparer reads protected, explicitly hash-pinned server contract,
server receipt and credential receipt files. It creates an exclusive directory
containing `attachment.json` (schema2), the byte-identical `server-ready.json`, and
a public result. It never creates a later deadline, invents an export receipt,
starts services, copies private keys, or performs network calls. The expected guest
boot/instance must come from the owner's authenticated SSH channel using the pinned
host key. File hashes check bindings; they do not authenticate an arbitrary file's
origin. Source/namespace admission and the actual exporter process remain the
operator's responsibility.

The guest checks those same identities and times, then verifies live TLS,
filesystem UUID and directory ownership before READY. The old per-role flat
receipt with `exclusiveCow`/`originalsReadOnly` boolean assertions is no longer
accepted; it was never production-qualified. Existing schema1 seed artifacts
must not be combined with these schema2 contracts.
