# RPC storage authority handoff

This package implements the monitor client and authenticated broker acquisition
components, over fixed root-controlled Unix sequenced packets. The broker daemon
and accepted bootstrap are not implemented or installed yet. No live storage
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
the broker still needs a durable cross-boot writer journal.

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
broker daemon. The protected listener, independently supervised provider,
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

**The storage-owner service, credential provisioning and accepted bootstrap are
still missing.** In particular, Warden must own its authoritative writer journal
and back its signed epochs with actual COW/export state. A journal in the NucBox
guest is not that authority, and this local-record API must not be deployed as a
substitute for the remote owner's persistence and fencing. The cross-host service
must integrate that ownership boundary before any writable descriptor grant.
There is still no grant/release method or complete broker executable. The monitor
compatibility build is not an installed broker. Signature and transport success
do not establish volume ownership, settlement, persistent adoption, kernel
attachment, sync/finality, or a working RPC app.
