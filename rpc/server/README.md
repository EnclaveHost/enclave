# Owned RPC state exports

## App control connection (implemented, not activated)

The maintained export preparer and CLI now accept an explicit `appControl`
contract. It is a one-shot TLS 1.3 control connection, checked by the actual
supervisor independently of the COW worker. It uses no Enclave-operated endpoint
or global signing key. The storage owner supplies a protected TLS directory,
explicit unicast address/port, exact client certificate DER SHA-256, and the
canonical authenticated broker request SHA-256. The control port must differ
from both NBD ports; `app_control.py` must be included in the reviewed runtime
pins. No listener or credential is provisioned just by preparing a contract.

The contract shape is `schema: enclave-rpc-export-control/1`, `host`, `port`,
`tls`, `clientCertificateSha256`, and `requestSha256`. The private `tls` directory
contains bounded owner-only `ca-cert.pem`, `server-cert.pem`, `server-key.pem`.
The client certificate must both verify against that CA and match the exact DER
digest. This distinguishes the selected client even from other certificates
issued by the same CA. **Transport authentication is not app-owner consent or a
writer lease.** The protected contract and dedicated credential must be supplied
by the authenticated, durably reserved storage-owner broker. Its Go connection
component now verifies both authorities' signed endpoint/certificate/contract
binding and connects this gate after durable pair consumption; see
[broker transport](../../isolation/m3/rpcstorage/README.md). Live storage-owner
service/credential provisioning and accepted bootstrap remain missing. Do not use arbitrary host JSON or
reuse an old production credential as authority.

The first TCP connection consumes the listener, including on failure. TLS and
the binding handshake are nonblocking, with a three-second limit clipped to the
unchanged original startup deadline. The client sends exactly ASCII
`ENCLAVE-RPC-EXPORT-CONTROL/1` plus newline, then the binary 32-byte request digest
and binary 32-byte export-contract digest. The reply is ASCII
`ENCLAVE-RPC-EXPORT-BOUND/1` plus newline, then SHA-256 of that complete request
frame. It acknowledges only the control binding, **not export or RPC readiness**.
Wrong identity, malformed/extra bytes, EOF, TLS error, or deadline expiry closes
the control attempt without reconnect or replacement. There are no on-chain
heartbeats or renewals. A silent network partition is bounded by the original
deadline; it is not claimed to produce immediate EOF.

The forked worker drops its inherited control sockets and cannot begin work
until both the authenticated control binding and fresh host admission pass.
Control loss stops the exact held worker group even when export preparation is
blocked. The existing independently enforced systemd watchdog covers a stalled
supervisor/TLS library/callback. `control-listening.json` is only a bound contract
marker, with `bound=false` and `rpcReady=false`; it is not permission to write.
Legacy adoption cannot extend an app-control attempt past the original deadline.
Persistent authenticated handover remains unimplemented. Legacy contracts remain
available for their existing workflow; they do not qualify native-app exports.
`writersFenced` and `reservationMayRelease` remain false on every path.

Actual qualification covers generated TLS certificates, incorrect peer/request/
contract refusal, fragmented input, extra data, stalled handshake, and original
deadline despite adoption. Preheld pidfds proved a blocked SIGTERM-ignoring
worker and descendant died after control loss. The full maintained 384MiB CLI
also negotiated both dummy NBD TLS exports, then control EOF stopped all four
preheld supervisor/worker/exporter identities in 0.119 seconds, with an empty
cgroup and unchanged dummy originals. See
[the composed result](../../ops/unified-funding-20261028/rpc-app-control-cli-r1/ROOT-RESULT.md).
This does not prove remote broker credentials, real storage ownership/fencing,
kernel NBD attachment, client sync/finality, persistent adoption, or production
RPC readiness. The RPC remains offline.

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

The owner can complete its existing begin binding with
`rpc/sample_windows_clock.py:sample(config)`. Configuration binds `begin`, the
explicit SSH `target` (host/port/user/identityFile), one private pinned `knownHosts`
file and `hostAlias`, `sshSha256`, protected `samplerPath`, `samplerSha256`, and the
reviewed `windowsBoot`. The remote image is `windows/rpc/ClockSample.cs`, staged
and qualified separately. This API creates no new original clock and performs no
VM or exporter launch. Ten sender tests use actual protected journals and mocked
transport; they are not proof of a live Windows handshake. Both host admission
and a complete startup workflow are required before consuming the live begin.


## One-shot storage-owner dispatcher (implemented, not installed)

`dispatch_owner.py` now connects the actual owner signing command to the existing
`run_startup.start_export` launcher. It requires an independently capped user unit
`enclave-rpc-owner-dispatch-ATTEMPT.service`: Type=exec, RuntimeMaxSec=60,
TimeoutStopSec=1, MemoryMax=256M, MemorySwapMax=0, CPUQuota=100%, TasksMax=32,
KillMode=control-group, Restart=no, SendSIGKILL=yes, FinalKillSignal=SIGKILL,
NoNewPrivileges=yes, LimitCORE=0 and UMask=0077. The unit's original cutoff must
fit inside the original startup deadline before any submission. Fresh local
resource admission reserves1024MiB for dispatcher, signer, exporter and setup;
it retains the27648MiB floor, pending commitments and any higher installed floor.

A protected `enclave-rpc-owner-dispatch/1` configuration contains `entry`,
`request` (path/SHA256 bindings), `outputParent` and the complete maintained RPC
Python/runtime `pins`. Its output directory is exclusively named by the original
attempt. The request is the bounded canonical input to `rpc-storage-owner`.
`signer-submit.intent` is fsynced before the one systemd signer call; the complete
response must equal the signer's already-persisted owner journal response.
`export-submit.intent` is then fsynced before the one real export submission.
The exact returned invocation/PID/creation-time/cgroup identity is persisted
before acknowledgment. A transport timeout or partial response holds the attempt;
there is no cancellation assumption, resubmission, unit replacement or cleanup
that would release a writer.

The dispatcher waits for the exact guarded export's control-listening receipt
before returning consent, avoiding a one-shot connect before TLS bind. That
receipt acknowledges only the listener; export data and RPC readiness are still
false. Response persistence precedes stdout. The existing exporter independently
requires authenticated app control before opening its work gate. No readiness,
persistent adoption, settlement or writable-root descriptor is granted here.

`owner_entry.py` is the fixed signer bootstrap. Its protected
`enclave-rpc-owner-entry/1` configuration contains `attempt`, `clock`, `contract`,
`policy`, `binary`, and `ownerProvision` bindings,
`receipt` (the dispatcher's signer-started.json) and exact bootstrap `pins`.
The binary must be a private700 file and inputs private600. The required
ownerProvision descriptor supplies the fixed private700 journal and two private600
seed files together; independent per-attempt journal/seed paths are refused.
The signer unit has128MiB/noSwap/CPU1/Tasks32, Type=exec, RuntimeMaxSec=20,
TimeoutStopSec=1 and the same kill/no-restart/no-new-privileges settings.
It verifies the actual unit PID/invocation/cgroup before opening keys. A private
user namespace maps the existing storage owner's UID to0 without chown or host
root. Read-only system mounts supply the runtime; held policy/keys/contract/clock
inodes become fixed private paths and then exactly FDs3..8. Only the held journal
mount is writable. This namespace is not a claim of complete hostile-code
sandboxing; the issuer and source are pinned trusted components.

Actual qualification: six dispatcher file/order/error tests with explicitly
mocked systemd/signing/resource calls; actual Warden entry units with an inert
stub checked namespace identity, all six read-only FDs,128MiB/noSwap/Tasks32 and
journal writes, and rejected a changed executable. An external fixture held
three exact pidfds, stopped all three processes, then observed the original20s
service deadline terminate the entire tree in21.52s including startup/stop grace,
with an empty cgroup. The first namespace-layout failure is preserved. These
are bootstrap checks; the composed qualification below supplies separate evidence.

No production service is installed. The local owner provisioner described below
is implemented; production volume selection and owner commitment, accepted remote
identity/client credentials, real HTTPS chain authority, writer settlement
and native RPC bootstrap remain required. Existing owner policy
is a permission to use a runtime, not remote attestation. Source merging does not
activate any unit or authorize a fake grant. Production RPC remains offline.

The maintained `qualify_owner_composition.py` now exercised one complete positive
signer-command → dispatcher → guarded-export composition on Warden. The unchanged
Go command `main/run` ran inside the actual128MiB signer unit, using the opt-in
`rpc_owner_composition` **test binary** whose HTTP RoundTripper supplied controlled
chain responses. This does not qualify real HTTPS quorum, the release binary as a
whole, genuine authority provisioning or guest attestation. No test transport is
compiled into a release build, and the host trust store was not changed.

With private ephemeral Ed25519 authorities, the actual command persisted both
volume records and the signed response. The real256MiB dispatcher verified that
response, submitted the real384MiB guarded exporter and persisted its exact
invocation/process identity before acknowledgment. The fixture connected once
using the signed endpoint/certificate/request/contract binding. Both disposable
TLS NBD exports reached metadata readiness; this was **not RPC readiness**.
An external controller preheld four exact process handles; closing control
terminated all four in84ms, left the cgroup empty and left the original dummy
image hashes unchanged. Consent/reservation records remained held afterward.

Build invocation `ae67fc37c0e9435e8de0fc113b591f5b` completed;
composition invocation `d3aee620c9c34de8ae044037e8507cfb` passed in2.13s.
The initial fixture variable-name failure occurred before any service submission
and is preserved. The successful run consumed one fresh attempt, with the original
900-second clock starting before preparation, synthetic Windows observations,
and fresh authenticated1536MiB whole-fixture admission above the retained floor
and pending commitments. No production volume, VM, client, chain transaction or
route changed. Do not replay these completed attempts or install the test binary.

## One-time local storage-owner provisioning

`owner_state.py` implements `enclave-rpc-owner-provision/1`. Its protected input
contains `attempt`, the original `clock` binding, `parent` (canonical private700
path plus `[device,inode]`), `roles` (L1/Base logical volume IDs and exact original
chain paths/metadata), `resourceConfig` and the exact source/tool `pins`.
It must run in `enclave-rpc-owner-provision-ATTEMPT.service` with the same independent
128MiB/CPU1/noSwap/20-second plus1-second-stop envelope as the signer. It verifies
that actual unit, the original clock and fresh authenticated capacity before work.

The fixed `parent/authority` directory is created exclusively and fsynced. This
is the consumed setup gate: an existing or partially created directory refuses
all subsequent setup, even if it lacks a descriptor. The owner never deletes it
or chooses a new suffix automatically. Within this ext4 directory, the provisioner
writes an intent, a journal, two random Ed25519 seeds, and finally `authority.json`,
with file/directory fsync. OpenSSL derives only the public keys using a fixed
command with configuration loading disabled; private seed bytes never enter argv,
logs or output. Originals are opened read-only and checked, never modified.

The descriptor binds parent/root/journal device and inode, both key file identities,
public keys, logical volumes and exact original chains. The dispatcher validates
this binding, and the signer retains the corresponding journal/key descriptors.
An empty replacement journal, changed key, spliced original chain, alias or mismatched
logical volume is refused. Consumed journal contents are retained and need not be
empty. Setup returns the existing `rpcStorage` public-policy format for a subsequent
owner commitment, with `ownerCommitmentVerified=false`; no on-chain operation runs.
The actual signer still verifies both private keys against the authenticated
owner-committed policy before issuing consent.

This establishes a local namespace binding. The actual owner must consistently
select this authority and authorize its original volumes; another parent or copied
keys do not settle old writers. It does not qualify existing writer cleanup,
remote guest identity, accepted root attachment or continuous serving authority.
There is no migration, reset, release or reprovisioning API. Historical signer
configs with independent `journal`/`seeds` fields are incompatible and must not be
replayed. The old standalone stub fixture is retired; its frozen evidence remains.

Qualification: five new ext4/key/state tests and six affected dispatcher tests
passed (unit/resource observations mocked there). The actual new provisioner,
signer, dispatcher and guarded exporter then completed one native composition
using disposable images and controlled chain replies. Its public keys independently
matched the Go-prepared manifest, all four held export processes exited85ms after
control loss, original hashes stayed unchanged, and consumed records remained.
Wrong volume, wrong original chain and a replaced key were rejected by the actual
state validator. That fixture's key was intentionally replaced after termination;
its private state is poisoned and must never be reused. No production state was
provisioned and no chain client or production RPC started.

## Framed owner relay entrypoint (implemented, not installed)

`relay_owner.py` supplies the owner end of the guest broker's one-request wire.
It runs **inside the existing** independently bounded
`enclave-rpc-owner-dispatch-ATTEMPT.service`: Type=exec,256MiB,noSwap,CPU1,Tasks32,
RuntimeMaxSec=60,TimeoutStopSec=1,KillMode=control-group and no restart. It calls
the maintained dispatcher in that same process; it does not introduce another
signer, exporter, deadline or subprocess launcher. The actual envelope is checked
before reading the wire and again by the dispatcher before native submissions.

Its one protected0600 configuration has only `schema` (exact
`enclave-rpc-owner-relay/1`) and `dispatcher` (path/SHA256 of the prepared owner
configuration). The bundle, manifest and exact monitor request must already be
bound to that original owner attempt. No wire field selects paths, executable,
keys, endpoint or a replacement request. The owner policy/signatures remain the
authority; a successful transport does not authenticate a guest or grant roots.

Input/output are inherited pipes, suitable for an authenticated bootstrap
transport, not a listening network service. Each message is a big-endian uint32
length followed by JSON. Input is at most4MiB and must exactly match the canonical
prepared request; response is at most64KiB. `decode_owner_request` now handles
real bundle-bearing requests separately from the small64KiB public contract
parser, checking exact outer fields, duplicate/canonical encodings, bundle2MiB,
manifest64KiB and inner request2KiB limits. The unchanged Go actor performs the
actual manifest/request validation and independent owner authorization.

An exclusive `relay` directory in the original clock namespace consumes ingress
before any bytes are read. Its fsynced intent binds the original unit identity
and request digest. The ingress cutoff is three seconds from unit entry, clipped
to the original deadline; setup does not reset it. A second durable intent
precedes dispatch. The exact dispatcher response must already be persisted and
is also fsynced in the relay before its framed acknowledgment. Partial input,
changed request, timeout, failed dispatch or lost response stays consumed. There
is no automatic retry, cancellation assumption or reservation release. Exiting
this transport does not prove separately supervised signer/exporter death.

This is the concrete owner-side transport endpoint. Guest bootstrap credentials,
accepted peer identity and the actual cross-host pipe bridge remain unimplemented
and unqualified; no listener, service or production authority was installed.
Existing prepared dispatcher files can be used only for their exact original
attempt. Do not reconstruct or replay a consumed request. Component tests use
real private files and fragmented pipes with mocked systemd/dispatcher actions;
they do not prove the full native command, real chain or app startup.

A subsequent native qualification ran this full framed command inside the actual
256MiB/60s dispatcher unit, using the prior pinned test-only Go issuer (only its
chain HTTP transport is mocked). Actual one-time disposable owner provisioning,
signed durable pair/proof records, both dummy TLS exports and framed response
persistence passed. The1309-byte response matched both owner records exactly;
all four preheld exporter processes exited89ms after control loss, originals
unchanged and reservations retained. See
[the exact result](../../ops/unified-funding-20261028/rpc-owner-relay-native-r1/ROOT-RESULT.md).
This was a local pipe composition, not a cross-host accepted guest connection,
real chain authority, kernel attachment or RPC readiness. No service was installed.

## Enrollment-driven owner offer (implemented, not activated)

`owner_bootstrap_entry.py` also accepts `enclave-rpc-owner-bootstrap-entry/2`.
Its exact fields are `schema`, `clock`, `listen`, `relay`, `pins`, `enrollment`
and `bootstrapPolicy`. The last two are protected path/SHA256 bindings. It runs
in the same independently bounded owner bootstrap unit and uses the same full
pending-aware admission, source closure, original clock, and original provisioned
owner keys as version 1. It does not select a replacement journal or keys.

`owner_bootstrap_inputs.py` consumes the native `enrollment.json` candidate and
compares its original Windows clock, guest request and client certificate with
the original prepared dispatcher/export inputs. It derives the guest broker's
chain settings from the issuer policy and its bundle/manifest from the prepared
request. The export certificate comes from that contract's actual protected TLS
namespace and must match the issuer's DER pin. The candidate cannot supply those
paths, chain authorities, keys, or a new deadline.

The Node actor verifies runtime identity, exact request and self-signed guest
certificate/SPKI before minting the owner challenge. After the existing listener
signs its endpoint offer with both provisioned keys, it durably publishes
`bootstrap/host-offer.json`: exactly `proof`, `ownerServerDer`, `exportServerDer`
and `policy`, bounded to the native worker's control-frame limit. This is the
input required by `host/bootstrap.mjs.finish`; no copying of private keys occurs.
The adjacent enrollment receipt explicitly says `guestAuthenticated:false`.
Only the subsequent TPM/guest evidence and real TLS client verification can
produce `accepted.json`; the existing issuer must still verify current chain
permission and settle previous writers before granting storage.

The native token, VM GUID and ownership receipt hash remain correlation data,
not proof of VM ownership. Original app-controller integration, authenticated
cross-host collection/delivery of the public records, actual hardware/full-image
qualification and production activation remain unfinished. Version 1's manually
assembled session remains available for the historical qualified composition;
version 2 is explicit and is not installed or made a live default.

Version 3 (`enclave-rpc-owner-bootstrap-entry/3`) replaces `relay` with a pinned
`preparation` template, retaining all other version 2 fields. Within the same
independent unit, `prepare_owner_enrollment.py` constructs the original request,
export contract, issuer policy, signer, dispatcher and relay from the actual
guest enrollment. The operator template fixes app/deployment/profile/volume
scope, native VM/ownership-receipt correlation, bundle, manifest, export
preparation, control endpoint and TLS files, original owner policy, original
`authority.json`, and issuer executable. Enrollment cannot select those inputs.
The original owner journal and keys are retained; no replacement authority is
provisioned. The guest remains unauthenticated until the unchanged Node verifier
and hardware/TLS exchange succeed, followed by issuer chain and writer checks.

Preparation repeats pending-aware whole-owner admission before opening private
TLS bytes or consuming the fixed `owner-enrollment/` directory under the original
clock. It copies existing control TLS credentials only within that private owner
namespace and binds the client CA to the actual guest certificate. Public results
contain digests, never private keys. Partial preparation stays consumed, without
alternate suffix or retry. The original 5-second entry cutoff, 122-second minimum
remaining window, service envelope and 900-second clock are unchanged. Real
target timing and cross-host collection/submission are still unqualified.

Six focused preparation checks passed, including actual protected export/relay
configuration, original owner-state binding, changed inputs and pending-capacity
refusal, consumed partial output, and version 3's real sealed-FD handoff. The
resource/service observations and final Node execution were mocked; no signer,
hardware attestation, TLS listener or production export ran. See
[the preparation result](../../ops/unified-funding-20261028/rpc-owner-enrollment-preparation-tests-r1/ROOT-RESULT.md).

`owner_bootstrap_exchange.py` now supplies the one-time service submission and
atomic offer collection. Its protected `enclave-rpc-owner-exchange/1` input has
exactly `schema`, `native` (`original` manager attempt digest and `plan` digest),
and `owner` (the version 3 entry fields except `enrollment`, which comes from the
actual framed native input). It runs only inside the fixed
`enclave-rpc-owner-exchange-ATTEMPT.service`, Type=exec, 128MiB, CPU1, no swap,
TasksMax32, RuntimeMaxSec20/stop1, no restart, control-group kill, NoNewPrivileges
and core0. Entry must be within5s and the unit start plus143s must precede the
original deadline. Its separate whole-owner admission allowance is1600MiB,
including the128MiB exchange and64MiB startup allowance; pending and higher
floors remain. The outer operator reserves1792MiB for its additional overlap.

The exchange consumes `bootstrap-exchange/` before bounded FIFO input, requires
one complete native frame and EOF, matches the operator-pinned original attempt,
plan, VM and original clock, and installs the actual enrollment and v3 config.
`submit.intent` is fsynced before one fixed `systemd-run` invocation for the
existing256MiB/120s owner service. It then collects only the fully published
single-link `bootstrap/host-offer.json`, matching the enrollment receipt, actual
request/certificate, prepared owner result and original owner service identity.
Response bytes are persisted before acknowledgment. It forwards the native
correlation digest unchanged; it does not treat that digest as a signature.
Neither exchange timeout nor local systemd-run termination proves owner death
or grants retry, writer release or serving authority.

`operator_bootstrap_transport.py` performs the actual bidirectional pipe sequence
around the fixed SSH native command and this independently scheduled exchange.
Configuration and exact service requirements are documented in
[the operator guide](../../windows/rpc/BOOTSTRAP-OPERATOR.md). Source integration
is complete for this transport; real SSH/SYSTEM/owner timing, hardware evidence,
storage access, persistent serving and production activation are unqualified.
