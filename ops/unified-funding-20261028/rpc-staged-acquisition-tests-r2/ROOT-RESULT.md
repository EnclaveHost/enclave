# Staged RPC storage acquisition; production RPC remains offline

The actual monitor and one-shot broker now share a two-stage protocol. The
broker acknowledges the exact request SHA256 once, with no descriptors, only
after ReceiveBrokerSession binds both actual monitor pidfds and arms its local
loss watcher. The monitor requires this acceptance within the existing three
seconds. It then waits for one final grant within the ORIGINAL guest deadline;
no retry, keepalive, time reset, writable capability or authorization is implied
by acceptance. Missing/wrong/repeated/truncated/descriptor-bearing acceptance
and a final grant before acceptance all refuse. A repeated broker Acknowledge
closes the session instead of permitting another attempt.

The monitor obtains and retains SO_PEERPIDFD before submission, checks its actual
proc identity against SO_PEERCRED, and watches it during ingress, grant wait and
granted lifetime. Broker death closes the monitor gate even when another process
keeps a duplicate socket alive. Failed acquisition closes its connection and loss
gate, retaining the original consumed attempt. Closing the transport does not
certify remote exporter death, writer fencing or reservation release.

This resolves the prior three-second FINAL-grant requirement that conflicted
with slow owner authorization/export startup. The original900 startup deadline
is unchanged. The accepted bootstrap must establish the socket in the process
that execs the broker; a socket passed from an unrelated long-lived process would
bind the wrong peer. That bootstrap topology, independent guardian, authenticated
credential provisioning and actual owner relay remain unimplemented. The broker
still grants NO writable roots and cannot start RPC clients. No deployed peer,
accepted image, VM, storage writer, funds, catalog or production route changed.

## Actual evidence

R1 c16b7bba557648389c7422a2c2d2dac4 terminal1/Main0,8.296947289s,577pins unchanged.
33 test/subtest PASS events. One new test failed its flags==0 assertion after
valid acceptance receipt: Linux Go UnixConn.ReadMsgUnix uses MSG_CMSG_CLOEXEC.
Read /usr/lib/go/src/net/unixsock_readmsg_cmsg_cloexec.go confirms that flag.
Corrected only assertion to reject MSG_TRUNC|MSG_CTRUNC while preserving exact
payload and zero-rights checks. Failed source/output preserved. Runtime unchanged.

Actual positive waited3200ms before final synthetic root grant, exceeding the
old final-grant3s cap without extending original900. Original-expiry case retained
only250ms and refused before delayed400ms grant. Missing acceptance refused at3s.
Wrong hash, rights, truncation, duplicate acceptance and grant-first refused.
Affected actual peer/owner/clock/substitution and granted-descriptor/loss regression
cases passed. Disposable directories stand in for granted roots; this is NOT NBD
attachment, owner permission, mount safety or writer settlement qualification.

New exact-process fixture used a real child broker/listener/ReceiveBrokerSession/
Acknowledge and real monitor acquire. External controller retained a duplicate
of the accepted broker socket before killing that exact child. Acquisition
refused208.798 microseconds after kill while the duplicate stayed held, before
its original5s expiry, with no root grant. SO_PEERPIDFD supplies death evidence;
EOF alone could not satisfy this case. This is isolated local process behavior,
not independent remote-owner death or target guest bootstrap qualification.

R2 6647fc64447143d8b7ec14b40ab8bf14 terminal0/Main0/collected,2.532424223s,
577pins unchanged. Only corrected acceptance-only test PASS (and package PASS),
then previously unexecuted actual broker and monitor compiles PASS. No successful
test or build replay. Total34successful test/subtest events including parents,
plus one package-pass event. No runtime source changed after either qualification.

Actual local broker7512188B SHA1991731e2e70c7500def11a749b54539e2f4047e62d01ce89e8371f6acd5a5f2;
monitor8345866B SHAc22824326a3c2a88c1258663afa9d1e0f5d9e0ee8422c9d266df7f21d68a090b.
Hashes independently recomputed. Not installed/Git/embedded in prior7e48 candidate.
Full command execution/provisioning/target boot not qualified by compilation.

Both runs: authenticated available94672/94678MiB,pending0 actuallyreported,
installedfloor18432,unread0; retained27648+640 pending-aware admission.
512hard450RSS CPU1/noSwap120suite150outer, private user/PID/network/mount
namespace, readonly frozen source, loopbackonly. Peaks114/192MiB,minimum94617/94620.
No cap/floor/startup relaxation or Windows39388 prospective-zero assumption.
All controllers/helpers terminal. Completed helpers never rerun.

## Next required work

Concrete accepted bootstrap FD/credential provisioning and real relay to the
independently supervised owner dispatcher, followed by qualified attachment and
root grant under the unchanged original window. The staged protocol now exists;
do not substitute further unchanged ingress/clock/owner primitive trials.
Actual guest identity/attestation, realHTTPS owner authorization and authoritative
volume namespace/previous writer settlement precede writable grants. Native NBD,
verity/optical/TPM lifecycle, network/role filters, Base coverage, full stack fit,
sync/finality/readiness, event-driven authorization, persistent adoption and
consumer deployment remain. Full censorship-resistance/cold recovery/new user/
storage failure/independent hosting under Enclave refusal are not proved.
Original8091 preserved, Windows5a ambiguity held, catalog already confirmed.
No further signing, publication or spend. Full goal active/unachieved.
