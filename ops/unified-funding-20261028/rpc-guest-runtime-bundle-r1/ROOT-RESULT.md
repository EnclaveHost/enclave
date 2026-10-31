# Guest runtime package — actual preparation result

The maintained `rpc/guest` package contains the byte-identical installed chain
wrapper, explicit client units and an exclusive archive builder. This is an
installation input, not a running RPC service.

Actual isolated local test invocation 2c81f52bc9de4c09afed19943df1204d:
80 passed, no skips or failures, 0.340 seconds of tests. Includes the exact
cached 4,089,437-byte snapshot manifest and adversarial coverage fixtures.
Eleven frozen source pins unchanged; wrapper checks use synthetic RPC responses,
not production chain readiness. Bwrap private network, CPU1, 256MiB cgroup,
220MiB RSS guard, 27648MiB available floor, no swap. Peak inner RSS76MiB;
minimum host available32274MiB. MainPID0/terminal0.

Actual bundle invocation 6f8fd20b705c4ccbafb13d8390abedc3:
3.274 seconds, 10 input pins unchanged, exact cached binary digests verified,
all 11 tar members independently reread. Archive397926400B;
SHA256 3f0bb020ee6c8b67217c55b4bd0208dd1a6c83ed76df21dbfdf34c6daa718e6c.
Peak inner RSS43MiB/minimum host available32185MiB. Same bounded local lane,
network namespace, no client execution. MainPID0/terminal0. The archive stays
outside Git at U/rpc-guest-runtime-bundle-r1/output-parent/bundle/runtime.tar.
Three binary provenance pins are in maintained prepare_bundle.py and the
BUNDLE-RESULT receipt. No private keys/JWT/service enablement links included.

Units use EL5GiB/CL7GiB/Base5GiB under an aggregate17GiB slice, no swap and
Restart=no. Guest OS allowance2GiB plus host support1GiB gives20GiB total
(21,474,836,480B), still unmeasured. Filesystem UUIDs come from the existing
original volume manifest; they are not fresh attachment proof. Base coverage
approval stays false. Existing service wrapper still enforces it.

Control tool read 00d7ae159ea24432b6b11897d7227739 completed0: private qemu-img,
debugfs and e2fsck exist with hashes retained. At09:34UTC available7259086848B,
disk108911382528B, jobs empty; sysstat09:40 and later timers retained. Read-only,
no tool invocation against an image, no new filesystem mount or VM. This is
not admission for a later image job; fresh guards are required.

Next: inject the public runtime into a new exclusive boot-image candidate,
verify installed bytes and filesystem health, then qualify UID mapping/local
engine JWT and authenticated exclusive state attachment. Existing SSH-only
Windows media remains untouched. Do not cut the current allocator or consume
the900-second startup window with an incomplete guest. Production pairing,
Base coverage/sync/finality, consumer cutover and decentralization proofs remain
unachieved. No funding/refund/deactivation/native VM/export occurred.
