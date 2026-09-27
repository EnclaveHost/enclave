# Protected app ports

`enclave-catalog-bundle/3` extends V2 with a sorted, unique list of TCP/UDP
ports. One HTTP port is still required. Existing V1/V2 bundle identities do
not change. The full list becomes part of AppID and the measured image.
Independent Go and Python derivation implementations share test vectors.

The guest front accepts HTTP/1.1 upgrades on
`/.well-known/enclave-tunnel/{tcp|udp}/{port}` over its attested TLS endpoint.
It connects only to declared ports on its own loopback. Host, supervisor,
and relay never receive the TLS key or decrypted application bytes.
The old plaintext raw-port bridges remain disabled for isolated apps;
network metadata advertises `protectedTunnel` instead of an unusable IPv6.
Public-app admission remains required; this does not implement private-app
authorization or WAF rules inside the guest.

After upgrade (`enclave-port/1`), each frame has a two-byte big-endian size,
then that many bytes, bounded to 65507. UDP preserves datagram boundaries,
including empty datagrams. Each association owns a connected UDP socket.
TCP uses zero-length frames as half-close signals *inside TLS*, because
opaque transport hops can tear down on an outer TCP EOF. There are 128
tunnels per guest, 32 per destination, and a 180-second idle limit.

The local connector adapts ordinary SSH and GameStream clients, binding
only loopback. Start the existing attestation client with its normal trusted
measurement, app ID, runtime, TCB, AMD chain and deployment ID pins, plus:

```
--forward tcp:2222,tcp:47984,tcp:47989,tcp:48010,udp:47998,udp:47999,udp:48000
```

`tcp:2222=19222` overrides the local port. No listeners open until trusted
attestation succeeds. Every reconnection checks the attested TLS key before
sending a tunnel request. A changed key requires running verification again.
Connect SSH to localhost port 2222 and Moonlight to localhost. The app still
owns SSH authentication and GameStream pairing. This transport carries UDP
inside TLS/TCP: loss can cause head-of-line delay. It does not supply GPU
hardware encode or prove acceptable video latency; test those with the app.

## Validation and rollout

The hardware canary executes seven real socket workers as a SET Wasm app
inside an SNP guest. All four RISC Box TCP ports passed 64 KiB echo with
half-close; all three UDP ports passed 0, 1, 1400, and 16000-byte datagrams.
An undeclared destination was refused. The test used a trusted AMD chain,
TCB floor, independently predicted measurement, and pinned the verified key.
No customer secrets or production app state were used.

Guestd supports explicit `-adopt-runtimes release=runtime.json` historical
pins. It verifies existing guests against their own release's runtime and
retains that runtime in their persisted record and data-plane identity.
Ambiguous pins fail. `-adopt-check` verifies adoption without sweeping or
stopping guests; run it against a copy of instance records before rollout.
All seven existing production guests passed this preflight on 2026-09-26.
The supervisor preserves an already verified guest when its old runtime is
the only derivation difference. New instances use the new runtime.

Production deployment additionally needs the new domain release admitted by
the relay's predictor and certificate service, matching guestd/supervisor,
and the owner's RISC Box isolation opt-in and attested secret/config release.
The hardware canary is not a test of the customer's OS boot or GameStream
pairing. Do not describe those as complete until tested in the deployment.
