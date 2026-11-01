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
