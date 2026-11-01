# One-shot RPC storage control broker

This command joins the existing monitor process binding, real owner authorization,
storage-owner signed reservation and authenticated export control. It does not
attach NBD, mount a filesystem, send a root descriptor grant, announce readiness,
release a reservation or adopt a persistent service. It is not installed or part
of an accepted platform yet. Its one-shot ingress acknowledgment lets the monitor
wait within the original startup window; absence of a final root grant still
prevents client startup with this control-only command.

Accepted bootstrap must launch it once, with no arguments, in a dedicated
128 MiB/no-swap/CPU1/32-task cgroup and an independently enforced original guest
cutoff. The command checks the actual kernel resource limits, but its own timer
is supplementary, not an independent watchdog. The original sealed guest clock
covers all preparation; the storage owner retains its separate original clock.
No clock is translated across kernel boots or extended.

Fixed inherited descriptors:

| FD | Capability |
| --- | --- |
| 3 | Existing ERPCONE4 original sealed guest clock |
| 4 | Connected monitor Unix sequenced-packet socket; exact peer and transferred monitor pidfds verified |
| 5 | Private read-only canonical broker policy |
| 6 | Private read-only exact app bundle |
| 7 | Connected Unix byte-stream relay to the bootstrap's owner dispatcher bridge |
| 8 | Private read-only DER export server certificate |
| 9 | Private read-only PEM client certificate chain |
| 10 | Private read-only PEM client key |
| 11 | Held root0700 writable guest tmpfs receipt directory |

Regular inputs require root ownership, mode0600, one link, read-only FD and
stable file metadata. The exact `enclave-rpc-broker-policy/1` fields are `schema`,
`runtime`, `bundleSha256`, `manifest` (base64 bytes), `chainId`, `ledger`, `rpcs`,
`confirmations`, `maxAgeSeconds`. The runtime and source inputs are accepted
bootstrap capabilities, not remote attestation claims. The command independently
uses `bootstrap.Reader.Authorize` and validates the owner's committed storage
volume identities before asking the relay for any work.

FD7 carries one big-endian uint32 length followed by canonical JSON, bounded to
4 MiB. Request fields are the actual bundle, manifest and exact monitor request.
An exclusive, fsynced `owner-submit` receipt precedes sending any byte. The relay
must forward that request once to the maintained, independently supervised owner
dispatcher; it cannot retry an ambiguous submission. Its response has the same
length framing, bounded to64 KiB, and is the exact canonical
`enclave-rpc-owner-dispatched/1` result. Unexpected ancillary descriptors, EOF,
truncation, oversized frames, monitor death and deadlines refuse and retain the
intent. The relay gets no private key or filesystem capability. It carries
untrusted public bytes; its identity or JSON cannot authorize a grant.

The broker verifies both owner-committed Ed25519 signatures, the exact request,
volume identities, writer epochs, original clock, runtime and export binding.
The existing OwnerIssuer persists both writer records and complete signed proof
on the storage owner's authoritative filesystem before returning. The guest
creates only `owner-relay-response` and `owner-response` audit/replay records;
it does not create a replacement writer journal. The claimed exporter identity
in the relay result is retained as untrusted evidence, not proof of remote death,
writer settlement or an armed watchdog.

Only then may the broker dial the signed literal export endpoint once using the
exact signed TLS1.3 server/client certificate pins. Monitor loss closes the raw
control connection. The output reports control binding with `rootsGranted`,
`rpcReady`, `writersFenced` and `reservationMayRelease` all false. On control loss
it exits with failure and leaves every owner and guest receipt consumed.

The accepted bootstrap/FD provisioning and owner relay bridge still require
implementation and target qualification. Independent guardian integration,
actual attachment and root grant, accepted guest identity, owner namespace and
previous-writer settlement remain prerequisites to activation. This command
must not be installed as a working RPC backend or used to bypass those gates.

The command acknowledges the exact request after ReceiveBrokerSession has armed
its local loss watcher, before slow authorization or owner work. The monitor
requires this descriptor-free acknowledgment within three seconds, then waits
for precisely one final grant under the original guest deadline. This adds no
renewal or new time budget. Acceptance conveys no storage permission. Repeated
acknowledgments and grants sent before acceptance are refused.

The monitor retains SO_PEERPIDFD and checks it during both acquisition and the
granted lifetime, so a surviving socket duplicate cannot conceal that exact
peer's death. Bootstrap must establish the listener/connection in the process
that becomes the broker (exec preserves identity); passing a connection owned
by an unrelated long-lived process would monitor that process, not this command,
and is not a qualified bootstrap topology. This change does not implement that
bootstrap or supply an independently scheduled guardian.

The owner-side framed endpoint is now maintained in
[`rpc/server/relay_owner.py`](../../../../rpc/server/relay_owner.py). It matches
this command's length framing and invokes the actual owner dispatcher inside its
existing independently bounded unit. The guest/bootstrap cross-host bridge and
credential delivery are still required; merely opening FD7 is not acceptance.
