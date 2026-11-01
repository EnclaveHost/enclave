# RPC storage authority handoff

This package implements the monitor client of a **required measured storage
broker**, over fixed root-controlled Unix sequenced packets. The broker service
is not implemented or installed yet. No live storage authority or independent
guardian is established by these tests. Absence refuses launch; there is no
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
