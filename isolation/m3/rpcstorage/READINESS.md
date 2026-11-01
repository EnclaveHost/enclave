# Native readiness handoff status

The native monitor creates one private pipe when it starts the storage broker.
The broker inherits read-only FD12; its sole writer is transferred once to the
exact service entry at FD15. The entry makes it CLOEXEC before starting roles.
After verifying its front's private FD5 response against its full nonce binding,
it forwards the exact original frame with one nonblocking write and EOF. The
monitor closes its own copy only after Start has settled. Missing or invalid
entry FD15 refuses startup; do not mix older monitor images with this entry.

The broker checks app/deployment and the immutable runtime identity covered by
both storage-owner signatures, the original boot/startup interval, four-second
freshness including pipe and persistence time, current authorization and export
binding. It durably records a consumed full-request intent and unchanged frame
in the original boot journal. Invalid/repeated input closes that session and
retains all writer reservations. The front nonce is authenticated through this
private topology; the frame is not a public attestation or bearer capability.

This is historical local readiness evidence, **not serving adoption**. All
original startup deadlines still apply. The actual owner/guest/storage/host
one-shot serving transfer must use fresh evidence and current authority before
originalD, preserve independent expiry/loss controls, and wake immediately on
readiness rather than wait for the ten-second startup continuation interval.
No timer may be disabled based solely on this record. Native target activation,
chain synchronization/finality and consumer cutover remain unqualified.

Component qualification and failed-attempt provenance:
[53 passing checks and three builds](../../../ops/rpc-ready-delivery-r1/ROOT-RESULT.md).

## Original-owner preparation (source only)

On the first private readiness observation, the actual owner loop wakes before
its next periodic startup refresh and sends `enclave-rpc-serving-prepare/1` on
the same authenticated TLS connection. The canonical request carries the current
accepted startup sequence/link and the unchanged152-byte frame. Both original
volume owners sign a separate `enclave-rpc-serving-prepared/1` response bound to
the exact request hash and original export proof. The dispatcher verifies that
those exact response bytes already exist in the original owner's journal.

This preparation is one-shot and does not advance the startup chain or extend
any permission/deadline. Its signatures are domain-separated from continuation
permits. The broker independently enforces the remaining four-second freshness
budget, prior authority and three-second transaction bound. The owner does not
compare unrelated host/guest kernel clocks; it relies on the authenticated
measured broker's freshness checks, independently verifying scope and current
owner authorization. This is not a new remote health attestation.

The original live actors retain short-lived prepared capabilities. A later
coordinated guardian commit must use those actors while the actual observation
is still fresh and before originalD. Receipts cannot rehydrate them. Preparation itself performs no serving commit or deadline transfer. See
[actual TLS/crypto and dispatcher qualification](../../../ops/rpc-serving-prepare-r1/ROOT-RESULT.md).

The measured native path now retains two private Unix seqpacket lifecycle
capabilities: PID1's original worker gate becomes monitor FD4 and broker FD13;
a distinct monitor-created pair becomes broker FD14 and native service entry
FD16. Both are CLOEXEC through helpers/roles. The monitor closes each copy only
after the corresponding Start has settled. Broker session loss shuts down both
sockets without closing/recycling descriptors under in-flight operations.

After the original live owner has signed and persisted serving preparation, the
broker sends PREPARE to both guardians and requires exact acknowledgements before
publishing its prepared record. PREPARE pins the exact owner's proof hash, original
origin/deadline and actual readiness observation. It never extends originalD.
The C PID1 and independent Go entry watcher implement one-shot COMMIT and ordered
RENEW, with <=30s absolute monotonic permits, strict prior-expiry checks, and
unchanged exact monitor-death/channel-loss termination. COMMIT must arrive before
originalD while the initial observation is still less than four seconds old.
Malformed/replayed/mismatched/late messages terminate; there is no reconnect.
These private messages are trusted broker decisions, not independently signed
storage permits or public health evidence.

The native entry now privately connects its independent watcher to the fixed-role
service supervisor. It requires the exact raw private observation and fresh local
readiness before accepting the first commit; a pending supervisor decision does
not extend the watcher's previous cutoff. Client exit, channel/monitor loss and
short permit expiry remain active.

The original owner also accepts an explicit `enclave-rpc-serving-commit/1` through
its existing framed stream and dispatcher. It requires its live prepared proof,
original observation digest, CURRENT permit sequence/link and refreshed original
authority. It consumes the commit intent before signing and persists the exact
dual-signed permit before replying. This changes only the same owner's atomic
phase/cutoff record, watched independently of signing/persistence. Renewals retain
the same original binding and strictly advance the short absolute expiry.

**The production broker does not yet emit serving requests or COMMIT/RENEW.**
Exporter, broker, operator/systemd/TLS and Windows guardian transfer still need
one coordinated transaction with these owner/service components. This receiver integration does not make the RPC live or
remove any startup cutoff in the currently reachable path. Native entry requires
FD16 as well as FD15; do not combine older monitor/broker/entry binaries. C header
changes are included in boot-stage source pins. Existing firmware is obsolete for
this composition and must not be booted as evidence of the new protocol.
