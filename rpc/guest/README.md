# Owned RPC guest runtime

This package prepares the actual Ethereum execution, Ethereum consensus and
Base client binaries for the ordinary Ubuntu guest. `chain_service.py` is the
byte-identical installed wrapper previously preserved under
`ops/rpc-backend-bootstrap/2026-10-25`; maintained guest work belongs here.
Its binary, filesystem UUID, checkpoint, history retention, proof-window and
Base origin-coverage checks remain intact. It uses owned local L1 endpoints
for Base verification; the optional Base sequencer URL is submission-only.

`prepare_bundle.py` creates an exclusive, uncompressed archive from the three
exact cached binaries and reviewed public manifest/chain/disk configurations.
It verifies input hashes and rereads every archived member. It never downloads,
extracts, installs, creates users, exports storage or starts a client. A failed
attempt remains on disk and cannot be resumed or overwritten. Engine JWTs,
private keys and service enablement links are not included.

The units cap EL at 5 GiB, CL at 7 GiB and Base at 5 GiB beneath a 17 GiB aggregate
slice, with swap disabled and no automatic retries. The proposed 19 GiB guest
retains 2 GiB for its OS and supporting processes; another 1 GiB is budgeted on the
host. Total: 21,474,836,480 bytes. This is a configured budget, not measured fit.
The original independently owned 900-second startup deadline still applies.
Stopping a client does not prove that its database shut down cleanly.

Before installation/start: qualify the new guest's exact UID/GID mapping,
generate its local engine JWT with access limited to EL/CL, attach verified
exclusive state volumes through the authenticated storage path, and bind those
mounts to the reviewed UUIDs. Do not recursively change ownership of original
state or mount the original databases writable. The archive should be injected
into a new boot-image candidate before the startup clock begins; do not leave
an additional ~400 MiB runtime archive on Windows C: outside its reviewed artifact
budget. The existing SSH-only boot image remains a separate artifact.

The present Base configuration has no accepted coverage receipt. Keep that
gate closed until the existing coverage checks succeed with actual evidence.
A running Linux VM, an installed bundle or a listening client is not synchronized
RPC readiness, production consumer cutover or decentralization completion.

`inject_image.py` installs the reviewed archive into a fresh copy of the pinned
Ubuntu cloud image. It operates on ordinary private files with qemu-img and
[e2fsprogs debugfs](https://man7.org/linux/man-pages/man8/debugfs.8.html), without
host filesystem mounts or guest execution. It checks the GPT checksums and root
filesystem identity, refuses existing destination files, dumps every installed
file for hash/mode/owner verification, runs read-only filesystem checks, and
compares the resulting VHDX with the edited raw disk. Original inputs and failed
attempts are retained. The caller must supply an independently bounded process
unit; the image tool also checks its 600-second artifact deadline, 2 GiB build
host memory floor, 16 GiB disk floor and 4 GiB output bound. This preparation
happens before the separate 900-second RPC startup attempt.

Image installation deliberately does not create service accounts, generate an
engine JWT, attach state storage or enable services. Those need the exact state
volume ownership and authenticated attachment configuration. An installed image
is not boot qualification or evidence that the 20 GiB workload budget fits.

`read_owners.py` reads only selected directory metadata through a private read-only
NBD/FUSE file view. `debugfs -c` avoids scanning allocation bitmaps and forces
read-only access. The caller owns the finite resource unit and independent
unmount cleanup. Actual state identities were observed as EL 997:987,
CL 995:986 and Base 994:985, with distinct identities available in the new image.
This is directory ownership evidence, not proof of every database file or readiness.

`prepare_storage_client.py` packages the pinned NBD client and thirteen exact
libraries without replacing host libraries or downloading packages. Its loader
check requires every dependency, including the interpreter, to resolve to its
exact private file. It creates no connections and mounts no devices. The resulting
9,574,400-byte archive has been independently reread; target guest TLS, kernel
attachment, write/FLUSH/reconnect and exclusive-writer qualification remain pending.
The engine JWT and account setup still belong in the guest-specific seed.

`identity.py` binds setup to the explicit NoCloud instance and installed runtime
pins, refuses account/group collisions, and creates the three nologin service
identities without changing data ownership. The local engine secret is root-owned
0640 with GID50002; only EL and CL receive that supplementary group through their
units. Existing malformed/partial/incorrectly protected secrets are refused rather
than replaced. No secret is embedded in a seed or reported in output.

`prepare_seed.py` creates a new <=64MiB NoCloud ISO containing the verified public
NBD closure and guest initialization sources. `install_storage_client.py` checks
the private closure before the identity unit runs. The 13,148,160-byte corrected candidate
passed ISO readback, independent25-file decoding and installed cloud-init schema
validation. The ten identity tests use an isolated user namespace and GID0 for
real temporary file operations; targetGID50002 access and actual first boot remain
unqualified. Cloud-init's documented [base64 write_files support](https://docs.cloud-init.io/en/25.3/reference/yaml_examples/write_files.html)
is used, with root ownership and explicit modes.

That earlier public seed initializes identities and storage-client dependencies only. It does not
attach state, supply TLS private credentials or start chain clients. Authenticated
exclusive state attachment, runtime readiness and the independently enforced
startup deadline must be integrated before target activation.

`attach_storage.py` and the two attachment/mount unit pairs implement guest-side
authenticated attachment. A protected operator-delivered contract binds the original
900-second window, guest boot/instance, attempt-specific export names, TLS credentials
and exact L1/Base filesystem identities. Endpoint selection is explicit and supports
independently hosted unicast addresses; there is no required Enclave discovery path.
The helper consumes one attempt, verifies the reserved block device is idle,
connects the pinned client, checks a read-only preflight mount and publishes READY
only while the exact owner and original deadline remain valid. Separate static
mount units provide the writable private-COW filesystems to the existing clients.

The helper never automatically reconnects, starts chain clients, declares RPC
readiness or produces operator adoption. Adoption must be observed before the
original deadline. Ambiguous ownership or mounted devices prevent forced cleanup;
cleanup receipts always leave writer fencing unproven. The server receipt must come
from the authenticated operator workflow after actual exclusive-COW qualification.
Schema2 now consumes the shared server metadata receipt and original contract hash;
it no longer accepts the earlier flat boolean assertions as a receipt format.

Actual exact-closure TLS negotiation passed six isolated dummy-export cases, and
the prepared image contains its NBD kernel module and required tools. Ten attachment
source fixtures passed. Kernel attachment, native mount-unit behavior, write/FLUSH,
reconnect, server/guest death cleanup and production readiness remain unqualified.
Attachment code was absent from that earlier public seed; the later private
candidates below include it. The server export/credential/deadline workflow
still needs native qualification before starting the guest. NBD process
and TLS options follow the [upstream-packaged client manual](https://manpages.debian.org/bookworm/nbd-client/nbd-client.8.en.html).

`credentials.py` prepares independent, owner-controlled certificate authorities
for each storage role, server/client leaf certificates, and an Ed25519 SSH host
key. No Enclave CA, discovery service or online identity service participates.
Creation uses an exclusive attempt directory; failed attempts and existing keys
are never silently replaced. Tool hashes, certificate/private-key pairs, receipt,
guest instance, file ownership and permissions are checked before seed rendering.
Certificates expire after 365 days; replacement remains an explicit owner operation.

The optional `credentials` input to `prepare_seed.py` contains `bundle`,
`publicReceiptSha256` and pinned `tools` (`openssl` and `ssh-keygen`). It changes the
output classification: **the entire output directory and ISO are private**.
Only client credentials and the guest SSH key enter this media; CA signing keys
and storage-server private keys remain in the operator bundle. Do not publish the
bundle, user-data, extraction/readback directory or ISO, and do not commit them.
Transfer and retain them only through an authenticated owner-controlled channel.
The public result records the SSH host public key/fingerprint for strict initial
host-key checking and omits private key contents and individual private key hashes.

Cloud-init's documented [SSH host-key input](https://docs.cloud-init.io/en/latest/reference/modules.html#ssh)
is used with host-key publication disabled. A boot command makes only the storage
credential subtree private (0700); `/etc/enclave-rpc` remains traversable for the
separate EL/CL JWT group. Files and local private media are 0600. This candidate
still does not supply the live attachment contract/server receipt or enable
attachment/client startup. The earlier public seed artifacts remain unchanged;
credential-capable source and isolated tests are not target first-boot proof.

The first full private seed candidate was rejected by the installed cloud-init
schema because `ssh_genkeytypes: []` violates its minimum list length. The corrected
renderer omits that setting: inspection of the installed SSH module confirms that
explicit `ssh_keys` takes the supplied-key branch instead of automatic generation.
The failed artifact and its credentials are retained; the repaired seed reuses the
same identity in a separate output directory.

The corrected 13,185,024-byte private candidate includes 36 files, including the
attachment helper and both attachment/mount unit pairs. Actual ISO readback,
independent file/mode/key-pair verification, installed cloud-init CLI validation,
and validation against the schema read from the prepared guest's ext4 image passed.
All 15 disposable credential/TLS tests also passed after the renderer correction.
These are offline checks, not execution of cloud-init modules or kernel mounts.
The private candidate is retained on the operator's Control VM and must never be
published. It still requires the fresh original-deadline attachment contract and
actual server readiness receipts before any attachment or client start.


The schema2 attachment helper requires `/opt/enclave-rpc/storage_protocol.py`.
The operator uses `rpc/prepare_attachment.py` with protected hash-pinned public
inputs to produce `/etc/enclave-rpc/attachment.json` and the byte-identical
`/etc/enclave-rpc/server-ready.json` (both root0600). These are delivered only
through the authenticated owner channel after the actual guest boot and export
receipt are known. They are intentionally absent from pre-boot seed media.
The original deadline is copied from the reviewed server contract, never reset
when the guest connects. Actual TLS, UUID and owner checks still precede mounting.

Attachment startup should be sequenced L1 then Base by the owner controller;
the module-load lock deliberately refuses a concurrent competing preparation.
Starting services, kernel attachment/cleanup, timely operator adoption and sustained
RPC validation remain separate native qualification. No contract bundle itself
is evidence that a guest is running or that a storage reservation may be released.

A separate schema2 candidate now contains 37 files, including the shared validator,
with 13,193,216-byte ISO readback and independent file/key/mode verification.
The prepared guest's own schema reports no errors, and all five seeded Python
modules compile under the installed guest-family Python interpreter. The earlier
36-file schema1 candidate is retained but is not compatible with schema2 activation.
No guest first boot, live contract installation, attachment or client startup was
performed by these artifact checks.

### One-shot storage activation

`activate_storage.py` and `enclave-rpc-storage-activation.service` now install the
owner's schema2 bundle and sequence L1 readiness before submitting Base startup.
This is maintained source and an offline-qualified private seed candidate; it is
not an activated guest capability yet.

Deliver the immutable owner bundle to `/run/enclave-rpc-import/<attempt>` through
an authenticated owner channel. That directory and its parent are root0700;
`attachment.json`, `server-ready.json` and `RESULT.json` are root0600. The separate
root0600 `/etc/enclave-rpc/activation-request.json` contains exactly `bundle`,
`resultSha256` and `runtimePins`. The runtime pins cover the four scripts returned
by `required_pins()` and the activation/two attachment units. Executable scripts
are 0755, the shared protocol is 0644, and units are 0644. The bundle's original
900-second deadline, guest boot/instance, server receipt and seeded certificate
pins must match. No new deadline is created by installation.

The activation owner durably consumes the attempt before installing files and
records each start intent before its single systemd submission. Partial installs,
existing attempts, already-active or queued attachment units, missing bindings and
ambiguous start responses fail without replay. Both attachment units have
`BindsTo` plus `After` on the activation owner. The owner acknowledges its systemd
watchdog before starting attachments, then checks the exact unit invocation,
ready receipt, kernel device/PID/size and process incarnation. It starts no mounts
or chain clients and never claims RPC readiness or writer fencing.

After both attachments are ready, `/var/lib/enclave-rpc-activation/<attempt>/ready.json`
records their bindings. Continued service beyond the original deadline requires a
separate protected `adoption.json`, observed before that deadline, with exactly
`attempt`, `bootId`, `activationRequestSha256`, `activationReadySha256` and
`adoptedUtcNs`. This controller does not create adoption. It does not replace the
server and attachment adoption receipts or the independently owned VM deadline.
External cleanup must still establish storage/provider fencing before releasing
reservations. A local watchdog timeout alone cannot establish that fact.

Qualification: 13 disposable root-namespace activation tests and 10 attachment
regressions pass. Orchestration tests mock systemd; process identity tests use a
synthetic kernel-device view. A separate actual user-systemd dummy fixture freezes
its owner and observes exact owner/L1/Base process exits and empty cgroups in
3.26 seconds, including SIGTERM-resistant children. A late dependent never executes
because the owner's consumed attempt refuses replay. That fixture uses 32MiB dummy
actors with one-second stop bounds, not the guest's 128MiB attachment units and
30-second attachment cleanup. It proves the dependency mechanism, not the native
guest composition, NBD cleanup or production storage readiness.

The new 13,215,744-byte private seed contains 39 files, including activation and its
unit. Independent whole-image hash, file/mode/key-pair checks, six Python compile
checks and the prepared guest's actual cloud-init schema pass. The seed retains
the existing identity and contains no live activation request, attachment contract,
server receipt or automatic activation. Previous 36/37-file seeds remain historical
candidates and must not be mixed with the new lifetime dependencies. Fresh host
admission and actual guest/kernel/storage/client validation remain outstanding.

### Authenticated bundle delivery

`rpc/deliver_activation.py` is the owner's one-shot sender. Its configuration has
exactly `bundleReceipt`, `seedReceipt`, `guestBootId`, `target`, `jump`, `sshSha256`
and `journalRoot`. Both receipt inputs use protected `{path, sha256}` records.
`bundleReceipt` points to the operator preparer's `RESULT.json`; `seedReceipt`
points to the private seed builder's own `output/RESULT.json` (not the enclosing
transport observation). The latter binds the installed source/unit pins and the
seeded SSH host public key. Neither receipt is an attestation; their hashes must
come from the owner's verified artifact and admission workflow.

`target` contains an explicit IP, port, `rpcadmin` user and canonical private local
`identityFile`. An optional `jump` contains its own endpoint, alias and hash-pinned
known-hosts file. The sender disables ambient SSH configuration, connection reuse,
password prompts, host-key updates and global/DNS host-key fallback. Guest host-key
checking uses the exact Ed25519 key and fingerprint from the private seed receipt.
The local SSH client binary is pinned. The sender never reads or copies the local
SSH private key; the normal SSH client uses it locally.

The sender creates an exclusive private journal for the attempt and fsyncs its
intent before one submission. Its public wire bundle contains only the three
prepared JSON files and the activation request; it never transports issuer,
server, client or SSH private keys. The receiver runs as a separately bounded
root systemd unit (64MiB, no swap, CPU1, five-second runtime, one-second stop,
no restart). It validates its exact process/unit envelope, the original contract
window, guest identity, installed source and seeded credentials. It consumes a
persistent delivery intent, installs the private bundle, and publishes the
root0600 activation request last. Partial results are retained, never overwritten.
It does not start activation or any mount/client service.

The sender accepts only the exact fresh installed receipt. Timeout, dropped reply,
changed receipt or any other uncertain result leaves the local journal consumed
and unresolved, even when the receiver already installed the request. Do not
resubmit or erase either journal. Reconcile the exact guest boot, delivery unit
and durable receipt through the authenticated owner channel. Transport exit is
not proof of remote death, storage fencing or permission to release reservations.
A subsequent activation start is a separate owner operation under the unchanged
external startup deadline; this sender does not perform it.

The sender still requires an independently admitted owner resource/deadline
envelope. Target SSH and the root receiver unit have not been executed in the new
guest. Qualification currently covers 14 delivery tests plus the 13 activation
and 10 attachment regressions. Actual protected files pass through packaging,
receiver installation and the activation parser in a disposable root namespace.
SSH/systemd orchestration is mocked there; real inert child processes test local
transport success, output limits and timeout cleanup. Lost-acknowledgement tests
prove no automatic second submission. These checks do not establish actual SSH
authentication, guest boot, kernel NBD, chain startup or RPC readiness.

The delivery-capable private seed is a new 39-file candidate (13,219,840 bytes).
Its independent whole-image/file/mode/key-pair checks, six Python compile checks,
and actual prepared guest cloud-init schema all pass. It reuses the existing
credentials and instance. Earlier activation-only media do not contain the
receiver entrypoint and must not be used for this delivery workflow. No live
request, contract or service start is embedded in the new seed.

### Owner-requested mount and client startup

`start_runtime.py` supplies the next step after storage activation. It has two
explicit phases: `l1` mounts the authenticated L1 volume, then submits EL and CL;
`base` requires those same L1 process incarnations and mount, then mounts and
submits Base. It never restarts a failed phase, approves coverage, adopts the
guest, or labels a running process as synchronized RPC. Base still executes the
unchanged wrapper's coverage, history, proof and owned-L1 checks. Obtain actual
L1 readiness and reviewed Base coverage before requesting the Base phase.

The owner uses `rpc/prepare_runtime.py` with `phase`, `output`, and five protected
`{path, sha256}` inputs: `activationRequest`, `activationReady`,
`attachmentReceipt`, `imageReceipt`, and `seedReceipt`. These are the exact guest
activation request/ready record, original attachment preparer's result, offline
image builder's result, and private seed builder's result. Use the actual results,
not enclosing SSH transport wrappers. Receipt hashes require the authenticated
owner workflow; they are not self-authenticating attestations. The producer binds
the original attempt, guest boot/instance and unchanged 900-second window. It
combines exact file modes/digests from the image and seed, with seed overrides
taking precedence, and refuses media missing the startup helper.

Preparation creates a new private directory containing
`runtime-start-<phase>.json` and `RESULT.json`. Through the authenticated owner
channel, install the request once as root0600 at
`/etc/enclave-rpc/runtime-start-<phase>.json`; retain partial or ambiguous delivery
for reconciliation rather than overwrite it. This producer does not deliver or
execute the request. No private credentials enter the request.

Invoke `/usr/bin/python3 -I /opt/enclave-rpc/start_runtime.py <phase>` only in the
independently admitted root transient unit `enclave-rpc-runtime-<phase>.service`:
64MiB memory, zero swap, one CPU quota, 20-second RuntimeMaxSec, one-second stop,
KillMode=control-group, Restart=no, SendSIGKILL=yes, FinalKillSignal=SIGKILL and
UMask=0077. It must share PID1's mount namespace; do not enable private-mount
features for this observer. The helper checks its exact main PID, invocation,
cgroup and limits before reading the request. The external original VM deadline
and active storage owner's lifetime remain required; this transient unit cannot
replace either.

Before each submission the helper verifies the original active activation owner,
both exact attachment receipts and kernel-owner identities, loaded unit settings,
runtime/config pins and the aggregate17GiB client slice. Mount units do not expose
MainPID: ControlPID and pending jobs are checked instead. Each phase and each
submission receives a durable exclusive intent before systemd is called once.
Mount identity/flags are checked through mountinfo before client submission.
The resulting `runtime-<phase>-started.json` binds exact process incarnations but
keeps `rpcReady`, `adopted` and `writersFenced` false. Lost acknowledgements and
late or failed starts remain consumed; original deadline cleanup still applies.

Qualification currently covers17 new disposable protected-file tests, including
producer-to-consumer integration, deadline expiry during observation, owner loss,
lost acknowledgement, replacement of an L1 process, loaded-budget overrides and
mount-device/flag refusal. The existing37 delivery/activation/attachment cases
also pass. Systemd submission and mount observations are mocked; one test reads
an actual local process incarnation. These results do not prove guest-native
mounting, client startup, cleanup or RPC readiness. The former39-file seed predates
this helper and remains historical. The new40-file private seed is13,236,224 bytes;
independent image/file/mode/key-pair checks, seven Python compilation checks and the
prepared guest's cloud-init schema pass. It reuses the same identity and is staged
with the client boot disk in a new protected NucBox directory; exact source and
target evidence is in `ops/unified-funding-20261028/rpc-private-media-stage-r2`.
No automatic service start or live runtime request is added to cloud-init.
## Owner runtime submission

After authenticated storage activation, `../prepare_runtime.py` produces a
protected request for the explicit `l1` or `base` phase. `../deliver_runtime.py`
installs and submits that request once over the seeded, pinned SSH host key.
Its configuration supplies hash-pinned `runtimeReceipt`, `attachmentReceipt`
and `seedReceipt`, the observed `guestBootId`, explicit `target` and optional
`jump` SSH endpoints, `sshSha256`, and a private `journalRoot`. These are the
actual producer receipts, not transport wrappers. The SSH identity remains local.

The sender reuses the activation delivery transport's strict host-key policy and
bounded local process-group cleanup. It writes and flushes an exclusive
attempt/phase journal before one transport call. Input changes, a lost reply or
an invalid receipt leave the phase consumed. There is no automatic retry, journal
reset, alternate RPC authority, or implicit adoption.

The fixed owner bootstrap runs in the exact root `enclave-rpc-runtime-PHASE`
transient unit:64MiB, one CPU, no swap,20seconds, one-second stop escalation.
It retains PID1's mount namespace, verifies the guest boot and original deadline,
and checks the five seeded Python import files before loading the runtime helper.
The helper verifies its actual unit before the bootstrap reads stdin. Installation
uses an exclusive root0600 request file and directory fsync; an existing request
is never overwritten. The unchanged seeded helper then performs its owner,
attachment, source, unit, mount and client checks. The original900-second startup
window remains authoritative; the sender refuses less than28seconds remaining.

This owner-side command does not require a new guest seed or change its helpers.
The result records observed client processes, not RPC readiness, synchronization,
writer fencing, reservation release or operator adoption. A20-second transient
unit does not replace the original VM deadline or the live storage activation
owner. Local SSH exit also does not prove remote process death.

Qualification covers14 new request/transport/bootstrap cases plus54 existing
runtime, delivery and attachment cases. Real bootstrap subprocesses use a pinned
stub runtime in a disposable root namespace; SSH, systemd and kernel orchestration
remain mocked. Actual guest delivery and chain readiness are still unqualified.
