# RPC storage authority handoff

This package implements the monitor client and authenticated broker acquisition
components, over fixed root-controlled Unix sequenced packets, plus a one-shot
control broker command. Complete attachment/grant and accepted bootstrap are
not implemented or installed yet. No live storage
authority is established by these tests. Absence refuses launch; there is no
host-path, UUID-only, permission-boolean or direct-VM fallback.

The accepted bootstrap must include a broker that independently authenticates
the app owner's deployment and storage owner's volume grants, acquires exact
exclusive writer capabilities, and arms its original-deadline/monitor-death
watchdog before replying. It must retain the only authority to keep the exports
writable, revoke/fence them on loss, and keep ambiguous starts held without
regrant. These are implementation obligations, not facts proven by a reply or
by SO_PEERCRED. Root credentials identify the local measured TCB peer only.
The peer must not be an arbitrary host-injected root service.

Before connecting, the monitor exclusively writes/fsyncs and read-verifies a
0400 intent in the protected tmpfs authority directory, retains a read-only
handle and never unlinks it. A monitor restart cannot repeat that boot attempt;
the storage owner still needs its authoritative durable cross-boot writer journal.

The monitor sends one canonical JSON request, no retry, with a newly random
attempt nonce, actual AppID/deployment/profile/two logical-volume IDs, kernel
boot and unchanged original origin/deadline. SCM_RIGHTS carries the monitor's
own pidfd, not an input numeric PID. The packet contains no private key, remote
endpoint, executable, host path, cap override or renewed time allowance.

A response is exactly `ENCLAVE-RPC-STORAGE/1 <sha256 of request>\n`, with exactly
two SCM_RIGHTS directory descriptors in L1/Base order. Truncated/oversized,
wrong-binding, extra/missing descriptors, non-root peer or late replies refuse.
Received descriptors are CLOEXEC atomically at recvmsg. The composer subsequently
checks ext4 root and each role's held subtree identity; a successful client
handshake does not replace those checks. The handshake is bounded to 3 seconds
or the earlier original deadline. The connection stays held: EOF, any data,
error or that original deadline is loss. There are no heartbeats or renewals.

An Attempt is returned and retained even on ambiguous post-submission errors.
There is no Close/release/retry API; local process death alone is not proof that
all remote writer operations settled. Shutdown and recovery need the real
broker's durable one-shot writer protocol and conclusive storage fencing.
Inert tests use dummy directory capabilities and a socket-pair fixture; they
prove descriptor/clock/message behavior, not those authority obligations.

## Authenticated broker preparation (not an activated broker)

`BeginBrokerAttempt` now composes real owner authorization, both storage-owner
signatures, actual sealed original clock/boot checks, and persistent exclusive
volume records. It does not send a grant or launch an export. The broker daemon,
independent guardian, credential provisioning, actual owner-controlled journal
namespace and writer settlement are still unimplemented/unqualified.

The owner-committed startup package can explicitly select `rpcStorage`, with
schema `enclave-rpc-storage-authorities/1` and `l1`/`base` objects containing
`volumeId` and raw Ed25519 `publicKey` (lowercase 32-byte hex). Historical package
bytes remain valid but confer no RPC volume authority. SDK package verification
and the guest use the same strict policy fixtures. Selecting keys requires a new
owner commitment; a host cannot append this field to an existing commitment.

`bootstrap.Authorization.VerifyRPCStorage` checks actual V9 AppID, deployment,
profile and both logical volume IDs against that authenticated package. Both
storage authorities must sign the exact request, runtime, owner, chain, ledger,
commitment envelope, role and distinct writer epoch. The fixed binary payload is
returned by `RPCStorageSigningPayloads`; this API neither signs nor grants.
Keys come exclusively from the current owner-committed package. Returned consent
has private fields, expires with authorization and cannot be rebound to another
request. Existing bootstrap chain-quorum/legacy-lease assumptions remain; this
increment does not implement the event-driven replacement protocol.

The persistent journal requires a held root-owned 0700 writable ext4 directory
supplied by the actual storage authority. Each logical volume ID is an exclusive
filename, created before any possible export submission; both records bind the
same request and writer epochs. Writes, restrictive mode, file and directory
fsync, inode/bytes readback precede success. Names and acquired handles remain
held after a partial pair failure, restart, lost response or closed handle. No
code here deletes, resets, releases or retries them. All writers must share the
same authoritative journal; an arbitrary new directory is not a writer fence.
The original temporary monitor intent is still required separately.

A valid signature is storage consent, not evidence of clean databases, measured
storage identity, unique live export, armed watchdog, completed flush, or final
settlement. Signed epochs must be backed by the storage owner's real durable
writer state and independent export guard before the service may pass writable
roots. The next implementation must provide that service and accepted bootstrap;
there is no stub grant fallback. Qualification uses generated test keys, mocked
chain peers and disposable filesystem records; no production key or volume is
used and no power-loss/reboot durability qualification is claimed.

## Broker request and process binding

`ReceiveBrokerSession` now implements the actual Unix sequenced-packet ingress
used by the monitor client. It requires an already protected listener/connection
and the original sealed clock. It obtains a **kernel SO_PEERPIDFD** reference to
the connecting process independently of the transferred SCM_RIGHTS pidfd, and
requires both live references to identify the same root monitor. Numeric
SO_PEERCRED PID matching alone is insufficient; kernels without SO_PEERPIDFD
refuse with no PID-only fallback. This capability needs target-kernel admission.

One canonical, bounded request and exactly one atomically CLOEXEC pidfd are
accepted within three seconds or the earlier original deadline. Duplicate and
case-alias fields, extra bytes/FDs, truncation, unrelated processes, regular FDs,
wrong boot or shifted origin refuse. The bound request is returned by value.
A separate watcher observes both exact process references, connection loss,
additional packets and the original deadline. It is armed before the session
returns. Authentication and journal work do not run in that watcher.

`BrokerSession.AuthenticateAndReserve` consumes the session once, calls the real
owner/signature/sealed-clock and persistent-reservation path, retains any partial
intent, and checks connection/process/deadline again afterward. A failed
operation cannot be retried on that session. Intent records are never released
by losing the connection. Error cleanup waits for the watcher to stop before
closing its process descriptors, avoiding a close/reuse race.

This watcher supplies **cancellation and refusal**, not independent OS-enforced
termination of a blocked operation, remote exporter fencing or a release
certificate. There is still no writable-descriptor grant method or installed
broker daemon. The independently supervised provider,
storage-owner credentials/fence, and accepted boot composition are the next
required integration. Do not activate a responder that just echoes a request
hash and passes directories. Tests use inert subprocesses and socket messages;
they do not launch a provider or prove production storage ownership.

## Signed transport and actual exporter connection

`BrokerSession.ConnectExportControl` now connects the actual one-shot mTLS gate
in the maintained Python exporter; see [its wire/lifetime contract](../../../rpc/server/README.md).
The same broker session must first complete `AuthenticateAndReserve`. Its two
fsynced, read-verified volume records include the exact authenticated transport
binding before any possible network submission. Partial/failed reservation,
expired authorization, historical consent, wrong certificate bytes, or a second
call refuses without a new dial. All records stay consumed on error or loss.

Both storage authorities selected in the owner-committed package must sign
`enclave-rpc-storage-consent/2`. Its `export` object contains `host` (canonical
literal unicast IP), `port`, `serverName`, `serverCertificateSha256`,
`clientCertificateSha256`, and `contractSha256`. All digests are lowercase SHA-256;
certificate pins hash DER, not PEM. `RPCExportSigningPayloads` retains every
original request/runtime/owner/chain/ledger/envelope/role/epoch binding and adds
the SHA-256 of the canonical export object under a new domain separator. No
host-supplied endpoint or TLS configuration can replace that signed object.
Schema 1 retains its old bytes and cannot open a transport or add even a null
`export` field. The SDK owner package format and its selected public keys are
unchanged; this is an explicit new storage-authority response.

The caller supplies the private client key and public server certificate. The
connector verifies both certificate pins against consent, then uses the exact
server leaf as its explicit X.509 trust anchor, with standard name, validity,
usage, and TLS 1.3 verification still enabled. It does not use system/Enclave CA
roots, `InsecureSkipVerify`, DNS lookup, a proxy, rotation or retry. The socket
is owned before TLS starts. The binding handshake is limited to three seconds
or the earlier original deadline. BOUND acknowledges only the request and
contract hashes, never export/RPC readiness or writable-root permission.

The session's existing process/socket watcher closes the **underlying TCP
connection**, without waiting for TLS shutdown, on monitor loss or expiry.
EOF, error, or any extra server byte cancels the session. The original consent's
lease/freshness cutoff is captured once and anchored to monotonic time; a legacy
authorization refresh cannot silently extend this consumed connection. This
does not add renewals, implement event-driven authorization, or observe fresh
chain revocation by itself. The eventual service must close the session on its
own authenticated revocation observation. A frozen broker or silent partition
still needs the independently owned original deadline; Go cancellation is not
OS-enforced fencing. Persistent adoption is not implemented.

Actual interoperability used Reader.Authorize with **mocked chain quorum**, real
generated Ed25519 authority signatures, real disposable ext4 journal records,
actual monitor kernel pidfds, and real TLS to the maintained Python guardian.
Killing that exact monitor closed the transport and killed both preheld blocked
worker/descendant identities in 563 ms. Additional tests cover pre-dial refusal,
standard certificate name validation, altered acknowledgements, extra bytes,
and an unanswered acknowledgement bounded by the original 800 ms remaining
window. No production keys, volumes or provider operations were involved.

**Production storage-owner provisioning, credential delivery and accepted
bootstrap are still missing.** Maintained owner actors now exist below; their
disposable qualification is not production provisioning. In particular, Warden must own its authoritative writer journal
and back its signed epochs with actual COW/export state. A journal in the NucBox
guest is not that authority, and this local-record API must not be deployed as a
substitute for the remote owner's persistence and fencing. The cross-host service
must integrate that ownership boundary before any writable descriptor grant.
There is still no grant/release method or complete serving broker. The control
broker command described below is not installed or accepted bootstrap. Signature and transport success
do not establish volume ownership, settlement, persistent adoption, kernel
attachment, sync/finality, or a working RPC app.


### Storage-owner signing actor

`cmd/rpc-storage-owner` is now the finite owner-side consent producer. It reads
exactly one bounded canonical JSON request (`bundle` and `manifest` base64 bytes,
plus the existing `request`), independently calls `bootstrap.Reader.Authorize`,
and invokes `OwnerIssuer`. The owner selects chain/quorum/runtime policy and
both volume keys; neither guest pathnames nor an Enclave signing key are used.
The runtime policy identifies the runtime the owner is willing to authorize;
it is **not remote attestation of the requester**.

The dedicated root service must supply fixed inherited descriptors:

| FD | Owner-provisioned capability |
| --- | --- |
| 3 | Private canonical `enclave-rpc-storage-owner/1` policy |
| 4 | The authoritative persistent ext4 writer journal, shared by all writers |
| 5, 6 | Private 32-byte Ed25519 seeds for L1 and Base |
| 7 | Exact protected prepared export contract |
| 8 | Original protected startup clock pinned by that contract |

Policy fields are `schema`, `runtime`, `l1Volume`, `baseVolume`, `chainId`,
`ledger`, `rpcs`, `confirmations`, `maxAgeSeconds`, and `export` (the existing
signed transport binding). JSON keys are sorted, complete and canonical. Input
files must be held root-owned single-link 0600 regular files opened read-only.
The actor compares the request hash, client certificate pin and endpoint to the
actual contract, and verifies its original same-owner-boot wall/monotonic clock.
It never compares a remote guest's monotonic origin to Warden's clock.

The actor requires a dedicated kernel cgroup capped at 128 MiB, no swap, CPU1
and at most 32 tasks. Its service manager must independently enforce a 20-second
actor limit and the original owner deadline. The supplemental process timer is
not a death certificate for a blocked kernel operation. The service envelope and command composition have the bounded fixture evidence
described below; production credential provisioning and installation remain unfinished.
Do not run it as an unbounded shell helper.

`OwnerIssuer` verifies local public keys against both actual owner-committed
storage authorities before journal changes. It generates distinct random writer
epochs, records both volume identities with the exact signed payload hashes via
O_EXCL/fsync/readback, then signs and verifies schema2 consent. It separately
persists the full response before stdout. All failure/partial/lost-response
records remain held, even after process restart. There is no repeat, restore,
release, or response-replay API. The retained records contain public consent,
never signing seeds. Signing material is cleared after the one-shot operation.

This implements reservation/consent production, not the complete cross-host
storage service: authoritative journal provisioning, remote attestation/client-key provisioning
and eventual writer settlement remain required. The dispatcher and independently
supervised export path are implemented and fixture-qualified below.
A local guest journal cannot substitute for the owner journal. The new actor
starts no export and returns no root FD or readiness claim. Existing legacy
bootstrap authorization and its finite freshness cutoff remain; event-driven
serving authorization/persistent adoption are still unfinished.


The maintained [owner dispatcher](../../../rpc/server/README.md#one-shot-storage-owner-dispatcher-implemented-not-installed)
now supplies a concrete signer bootstrap and export-submission path. The bootstrap
maps the actual storage owner's UID to0 in a private user namespace, preserving
host file ownership while supplying the fixed descriptors. Actual Warden units
qualified that bootstrap with a pinned inert stub, including the independent20s
kill of a fully stopped three-process tree. A later complete fixture exercised the unchanged Go command main/run, real
persistent consent, actual dispatcher and both disposable TLS exports together.
The opt-in `rpc_owner_composition` test binary substitutes only the HTTP transport
with controlled chain replies; it is not a production release artifact. Four
preheld export processes exited84ms after control loss, original dummy hashes
were unchanged, and reservation records remained held. Real HTTPS chain authority,
remote identity and production provisioning/installation remain unqualified.
No writable-root grant, client sync, RPC readiness or persistent adoption was
proved by that fixture.

The dispatcher now requires the local `owner_state.py` provisioner descriptor.
It no longer accepts unrelated per-attempt key and journal paths. A single
exclusive ext4 authority directory binds original volume identities, generated
public keys and the persistent journal; partial setup is permanently consumed.
The command's fixed FDs remain unchanged, but they now come from that checked
namespace. This prevents an ordinary configuration from replacing a consumed
journal with an empty directory while retaining the signing keys.

The provisioner is implemented and native fixture-qualified, not installed for
production volumes. Its public-policy output is not an owner commitment or remote
attestation. The signer still uses actual Reader authorization and checks the
corresponding keys before consent; tests use controlled chain replies. Writable
root grants, existing writer settlement, accepted guest bootstrap and persistent
serving remain required. See the owner dispatcher documentation for exact state
format, service bounds, partial-failure behavior and qualification limits.

## Remote-owner proof and one-shot broker command

`AuthenticateRemoteReservation` keeps the authoritative volume journal on the
storage owner's machine. It independently verifies the OwnerIssuer's signed
schema2 proof against the guest's real bootstrap authorization and original
clock, then retains a root-owned tmpfs audit receipt before allowing export
control. This receipt is explicitly not global writer exclusivity or settlement.
The older `AuthenticateAndReserve` remains the same-host owner-journal path;
a guest must not use it with a fresh local persistent directory as a substitute
for the remote owner. Both paths now publish the same verified consent object
for `ConnectExportControl`.

`ExchangeOwner` consumes and fsyncs one guest `owner-submit` intent before sending
a bounded public request over the accepted bootstrap's Unix stream relay. The
relay is untrusted transport: signatures and actual Reader authorization supply
authority. A four-byte big-endian length frame supports real app bundles larger
than Unix sequenced-packet limits. Unexpected rights, ambiguous output, EOF,
monitor loss and the unchanged original deadline close the gate without retry.
No keys cross this relay. The owner dispatcher independently bounds its own work.

The concrete [rpc-storage-broker command](../cmd/rpc-storage-broker/README.md)
composes ingress, owner authorization, one-shot relay, remote proof verification
and export control under fixed inherited capabilities. It emits a control-bound
receipt and watches loss, but never sends the monitor writable descriptors.
Accepted bootstrap/relay provisioning, the independent guardian, attachment and
writer-settlement integration remain missing. No complete serving broker or
production deployment is claimed by this source.

## Two-stage acquisition

The monitor now requires exactly one `ENCLAVE-RPC-STORAGE-ACCEPTED/1` packet
containing the original request SHA256 and no descriptors, within the existing
three-second ingress window. BrokerSession.Acknowledge emits it after checking
the exact monitor identities and arming the local session watcher. The concrete
broker invokes it before chain authorization or owner relay work. It neither
reserves volumes nor sends roots. One final `ENCLAVE-RPC-STORAGE/1` grant with
two root descriptors may follow, bounded by the original kernel boot deadline;
no timer restarts, repeated progress packets or implicit grant are accepted.

The monitor retains the exact socket peer pidfd before submission and checks it
while waiting and after a grant. Broker death closes the monitor gate even when
a third process retains a socket duplicate. This is local liveness evidence,
not remote exporter death or writer settlement. The accepted bootstrap must
launch the broker that creates its own protected listener and independently
enforce the original deadline before work. Actual bootstrap provisioning, attachment/root issuance
and production qualification remain outstanding. Older direct-grant peers must
be updated together with the monitor; no deployed peer was changed.


## Broker-owned bootstrap ingress

`AcceptBroker` creates the fixed private per-boot tmpfs namespace and listener in
its own process, so SO_PEERPIDFD identifies the actor doing broker work. It writes
an exclusive fsynced `broker-started` receipt before binding, verifies socket and
namespace identity, then emits one nonblocking listening record on an inherited
root write pipe. Only one connection can consume ingress; malformed peers, full
readiness pipes, original-deadline expiry and broker death leave the namespace
consumed. A later process cannot silently create a fresh attempt in the same boot.
The caller must already be bounded by the accepted bootstrap's independent
watchdog. Listening does not authenticate credentials or authorize storage.

The concrete broker validates its fixed policy/bundle/key inputs before calling
this entrypoint. It creates the guest receipt directory itself; FD4 is now the
readiness pipe, and the former FD11 receipt-directory input is removed. This is
an undeployed protocol change to be composed with the accepted bootstrap, not a
compatible change for an existing running peer. See the command README for the
exact signal and required bootstrap behavior.

The monitor's bootstrap path now creates its request before acquisition and
attests that exact nonce/request with a guest-generated credential. `AcquireRequest`
rechecks every loaded bundle identity, actual boot and original window before
touching the protected broker namespace. `Acquire` remains a convenience wrapper
that creates its own request; the dedicated monitor uses the pre-attested request.
Bootstrap evidence and owner verification are described in
`../rpcbootstrap/README.md`; neither bypasses owner authorization or grants roots.


## Explicit off-chain continuation (source integration only)

`bootstrap.RPCContinuationChain` verifies canonical, at-most-2048-byte permits
signed by both existing owner-selected volume authorities. Each permit lasts at
most 30 seconds, binds the exact original export proof and all its request,
owner, runtime, chain, ledger, envelope, endpoint, certificate and writer-epoch
bindings, and advances one sequence linked to the preceding signed proof.
Serving requires a pinned observation digest and cannot return to startup or
substitute another adoption digest. A digest alone does not prove readiness.

Each accepted expiry uses one initial wall-to-monotonic mapping. Re-reading a
frozen clock cannot extend the same expiry. Clock rollback, expired prior consent,
replay, signature failure or authority loss permanently closes the chain. The
original acquisition consent is immutable. The caller must serialize authority
revalidation and retain the original journal; a new object is not restart or
replay authority. Existing legacy authorization still limits these permits;
this does not renew a lease or implement the replacement event-driven ledger.

`BrokerSession.ApplyStartupContinuation` consumes and fsyncs a deterministic
sequence intent in the same protected boot journal before verification, then
persists the exact accepted proof before changing its authorization expiry.
Failures retain intent and close the session. Its independent watcher continues
through persistence and the original startup deadline remains unchanged. Even
a correctly signed serving permit is refused at this broker API: complete
persistent-serving handoff is not implemented. No writable grant, export dial,
client start, reconnect or reservation release occurs here.

The explicitly selected continuous owner actor below can now produce these
permits. The deployed bootstrap relay still uses the historical one-shot path;
the guest now negotiates /2 and runs the continuation loop described below,
while the owner operator dispatch remains /1 and no production loop is active.
The original one-shot owner issuer still clears its own signing-key copies.
Neither snapshot refresh nor a healthy HTTP response can manufacture a permit.
No periodic on-chain transaction is introduced. Guest C/Go entry, service,
storage and Windows keepers still require a coordinated serving transition
before the immutable original 900-second deadline. The RPC remains offline.


## Same-process owner continuation producer

`OwnerIssuer.BeginStartupContinuations` attaches once to the **same successful,
still-live** issuer before its original local deadline and acquisition consent
expire. A private process capability published only after original proof
persistence is required. Disk records alone cannot recreate it. Local provisioning
explicitly supplies the two seeds again; the producer checks both against current
owner-selected volume keys. It never acquires new writers, starts an export or
releases a claim. No constructor accepts an old proof as restart authority.

The independent session watcher observes the original deadline, prior permit
expiry and context loss without acquiring the signing/persistence lock. Loss
cancels immediately; key erasure follows completion of any in-flight operation.
The actual command arms process termination on that cancellation before sending
its initial proof, so blocked input, output or fsync cannot keep that process
serving. Kernel-stall death and resource enforcement still require the independently
admitted native service envelope; context cancellation alone is insufficient.

Each request revalidates the same committed deployment under the prior permit's
deadline. Exact sequential intent is fsynced before signing; the signed response
is fsynced before return. Any failure, replay, lost/short response, malformed
frame or disconnect terminates the session. A healthy chain snapshot alone never
extends consent. Only startup permits are issued. Serving-phase requests refuse;
full persistent adoption and storage-export continuity remain unimplemented.

The actual `rpc-storage-owner` entry point supports an explicit **held owner
policy** schema `enclave-rpc-storage-owner/2` with the same fields as `/1`.
`/1` retains its one-request raw JSON/20-second behavior. `/2` selects a continuous
framed stdin/stdout stream: uint32 big-endian length plus initial canonical JSON
request (maximum4MiB), initial proof (maximum64KiB), then canonical
`bootstrap.RPCContinuation` requests (maximum1024B) and signed replies. The caller
must retain the original authenticated owner connection and cannot reconnect.
Initial preparation/proof still must complete within20seconds; the continuous
session is bounded by the already-started original owner clock and each permit.
It needs a separately admitted service lifetime, never automatic reuse or widening
of the old20-second unit. Memory remains128MiB, no swap, CPU1, at most32tasks.
No operator policy, unit, relay or production namespace is changed by this source.

Qualification covers actual private Unix peer handles, framed pipes, Ed25519,
ext4 journal writes, producer-to-broker application, deadline during blocked input,
restart refusal and key erasure. Chain responses are fixtures. Command framing
and clock checks plus compilation do not prove a live owner/2 service or target
process-death behavior. Deployment, TLS relay integration and coordinated serving
handoff are still required before production RPC.


## Authenticated continuous guest connection

Both authority signatures now bind the explicit offer schema `/2`; editing it
to `/1` invalidates the signatures. An authenticated `/2` offer requires an
exact `/2` bootstrap acknowledgement. No fallback/reconnect is attempted. The
Node listener can explicitly mint `/2` when supplied that owner protocol; its
historical caller still supplies `/1`. `/2` listener lifetime is the original
owner deadline, requiring separate admission of its containing service.

The guest retains the same authenticated TLS socket after the initial response.
One bounded reader remains active between permits: EOF, extra responses or
unsolicited bytes close the broker and its export control connection without
waiting for the ten-second request interval. Exact monitor loss and original
startup expiry independently close both raw sockets. No TLS shutdown wait is
required. The historical `/1` exchange still closes after its single response.

`rpc-storage-broker` accepts `/2` initial response proofs as base64 bytes, not
nested JSON objects. This preserves the exact original signed proof hash even
when the outer response is canonically re-encoded. `/1` and `/2` response schemas
cannot be interchanged. Exporter metadata still does not prove readiness or
writer settlement. After original reservation and successful export-control
binding, the actual command invokes `RunOwnerContinuations` only for negotiated
`/2`. That loop owns authorization refresh; no caller may concurrently reuse
that Authorization. It serializes revalidation with proof application and
consumes a distinct transport intent before each request. Three seconds bound
chain/network/application work, with the prior permit and original deadline
remaining independent earlier cutoffs. Every failure ends the session.

The loop requests a signed startup permit immediately and then every ten seconds,
with each permit lasting at most30seconds. These are off-chain requests; they do
not renew a chain lease or change the legacy authorization ceiling. A signed
permit never grants serving mode. Both consumer and producer continue to refuse
serving adoption until the complete lifecycle handoff is implemented.

**Operator integration remains incomplete.** The installed/prepared Python
bootstrap, dispatcher and signer units still use the historical `/1` protocol and
finite20/60/120-second envelopes. They do not retain the live `/2` signer or relay
its frames. This source does not widen those units, select `/2` for them, publish
new offers or activate a guest. A new admitted continuous dispatcher must retain
the same live owner actor and byte-preserved initial proof, then forward frames
without reconnect/restart. Real TLS/crypto fixtures qualify the guest exchange;
they are not production attestation or live storage proof. The RPC is offline.
