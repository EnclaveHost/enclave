# RPC guardian serving transfer — finite qualification

Production RPC remains **OFFLINE**. The full decentralization objective remains
active and unachieved. This change integrates private guardian channels into the
maintained PID1/monitor/broker/native-entry path; it is not a production boot.

The original C PID1 keeps its worker gate as a private Unix seqpacket channel.
Dominit transfers the sealed clock and this channel without FD3/FD4 collisions,
keeping both CLOEXEC through helpers. Monitor transfers the channel only to the
original broker FD13. A distinct monitor-created pair connects broker FD14 to
native entry FD16, in addition to the existing FD15 readiness writer. Parent
copies close only after the exact Start settles. Original held monitor pidfd,
channel loss and independent absolute expiry remain active in every phase.

C and Go receivers implement the same fixed 88-byte protocol: PREPARE pins the
exact live owner preparation hash, original clock interval and initial private
health observation without changing originalD; one-shot COMMIT must be before
originalD and while that observation is less than four seconds old. Ordered
RENEW retains the same binding and requires exact next sequence and a strictly
advancing absolute expiry at most 30 seconds ahead. No expired state can revive.
Any malformed, changed, duplicate, missing or late message terminates. The C
process rearms the same absolute timer and checks the prior expiry both before
and after rearm. Go entry has an independent locked-thread watcher with no
signer, fsync, mount, client or cleanup locks. Guard clients cache nonblocking
FDs, submit once, require exact bounded acknowledgements and use shutdown,
never descriptor close/reuse during an in-flight transaction.

The actual broker now prepares BOTH guards after verifying both original owner
signatures and persisting their exact reply. Neither broker prepared publication
nor successful preparation returns before both acknowledgements. Failure shuts
both channels and retains the consumed attempt. **No production callsite emits
COMMIT/RENEW yet.** These private commands are trusted measured-broker decisions,
not public authentication or standalone storage/health proofs. Owner/exporter,
service supervisor, broker, operator/systemd/TLS and Windows guardians still
need the coordinated serving transaction. Their startup cutoffs remain intact.

## Executed checks

69 distinct tests/subtests/cases PASS across disjoint phases: 50 Go tests/subtests
(15 top-level) and 19 native C namespace cases (12 serving + 7 startup). No skipped
checks. One repeated normal commit-expiry case belongs to both pre- and
post-review C revisions and is counted once. Startup guardian-loss and committed
serving guardian-loss are distinct cases.

- R1 invocation `d5079db409694c2a9a6bab8bfcca1469`, terminal 1/MainPID0/empty
  cgroup, 2.962451741s. Go guardian and rpcdomain phases passed 38 tests/subtests.
  The following rpcbootstrap compile failed: the new fixture socketpair variable
  collided with a later TLS certificate named pair. Only the socket variable was
  renamed. The passing phases were retained, not replayed.
- R2 `b4167cb4deac44c3ab4ddb493447839e`, terminal 0/MainPID0/empty cgroup,
  14.137561629s. Remaining bootstrap, actual owner TLS/guard preparation and
  native monitor checks passed 12 Go tests/subtests. Three actual Go binaries
  compiled. Actual RPC/ordinary/desktop C boot stages and private namespace
  fixture compiled. All ten new serving cases and seven changed-startup
  regressions passed. One guard missing after owner preparation fails the
  actual broker path; the successful case acknowledges the same exact proof
  digest on both channels.
- R3 `121c07dab76b401cabb639be265754eb`, terminal 0/MainPID0/empty cgroup,
  4.522880708s. Source review added the second prior-expiry check after timer
  rearm. Only C stages/fixture were rebuilt. Two new cases stop the exact
  guardian, queue commit/renew and resume after the prior expiry: neither revives
  it. One normal commit expiry verified the changed rearm path. No Go replay.

Actual native C tests use disposable user/PID namespaces, explicitly refuse the
initial user namespace, and call real namespace poweroff (not a mocked reboot).
The external controller preholds exact guardian/worker/descendant pidfds. Normal
committed expiry occurs after originalD; channel loss and guardian death end the
whole tracked namespace promptly. Blocked worker cannot prevent permit expiry.
R3 queued-late commit/renew end all tracked processes about 21/23ms after prior
expiry, including the deliberate 20ms stop past expiry. This is not evidence of
termination while the guardian/kernel is unscheduled. Independent host fencing
is still necessary. C guardian has actual 32MiB address-space readback; prior
allocations/whole guest peak are not proved by that cap.

Go tests exercise real private sockets, original live-owner TLS1.3/Ed25519 and
durable filesystem receipts. The independent Go watcher uses a test termination
callback; its owner-loss event injection is not an OS process-death proof.
Chain, export, TPM and systemd authority remain fixtures/mocks. Full native
monitor-to-entry boot topology, accepted hardware attestation, power-loss
persistence and target SYSTEM behavior are not proven by these cases.

All phases retained 512MiB hard / 450MiB RSS, CPU1, no swap, 150s outer / 120s
composition / 5s stop. Fresh authenticated available/pending/installed floor:
R1 93663/0/18432MiB; R2 93626/0/18432; R3 93599/0/18432; unread=0. Retained floor
27648MiB plus actual pending plus 640MiB allowance. Observed peak tree RSS
147/200/128MiB; minimum available 93585/93540/93551MiB. No 1.5GiB exception,
production cap change, floor reduction, retry or deadline reset.

Each execution verified 828 frozen/current source pins unchanged. After R3 only
README documentation was updated (three files); executable sources stayed
unchanged. `FINAL-SOURCE-PINS.json` records the delivered changed sources/docs.
The initial private cache reflink-copy preparation failed with EOPNOTSUPP before
any test invocation; corrected to an ordinary independent private copy. Failure
record retained; no shared mutable cache or compiler retry was used.

Private binaries independently rehashed, never committed/deployed:
- native entry: 5396893B, `3b6eb04ec07429f0b4bfb8265e0c2b01a3fc4176e94ae6d002c0f840d8e9f0be`.
- broker: 11473517B, `498bc221e33f24471d9a221b333a0a8192f8eaa953e080205a9db96db44f9bd7`.
- native monitor: 9261325B, `240ed9dfa2c74e91e82676b18208582c79dc6c7ae749c5b2ec93a1be77fdfbe2`.
- final C init: 1034936B, `eefead5421114657117bc57a444bc4950bee5925e31e806f35d609196169b899`.
- final native fixture: 1029408B, `ab7e2b4032c166c56b9284b993d2932138f5d3b80db6bf9ad7c9b20a6a1337b1`.

Existing firmware/guest bundles are older and cannot be mixed with these new FD
contracts. No firmware recomposition, target task/VM/provider/export, payment,
wallet/catalog, route, Running claim, writer fence or reservation release occurred.
Original8091, live catalog and held Windows5a ambiguity remain preserved. Next:
wire coordinated serving authority/commit through the remaining original-live
owner, exporter, service supervisor and host boundaries before any activation.
