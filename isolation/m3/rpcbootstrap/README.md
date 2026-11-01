# RPC storage bootstrap identity

The dedicated monitor now creates one Ed25519 client credential inside the guest
for its actual loaded V9 RPC bundle. Its private key is never accepted from or
returned to host control. The public self-signed certificate is a transport
container, not a CA or storage authority. Local measured code may take the same
credential once for a future bounded broker launch; that handoff is not yet wired
to the broker command. No private key is written by this package.

Before storage acquisition, the monitor creates the exact request once, including
its random nonce, actual kernel boot, loaded app/deployment/profile/volume IDs and
original sealed deadline. It reads runtime identity from the fixed immutable
`/plat/rt/runtime.json`. It waits under the existing PID1 supervisor and original
900-second deadline. No clients, writable mounts or app children start here.

The existing control transport exposes three operations:

- `rpc-bootstrap-info`: public request, request hash, runtime, SPKI and certificate.
- `rpc-bootstrap-attest`: exact kernel `boot`, `requestSha256`, and lowercase
  32-byte hex `challenge` from the owner verifier. The monitor calls its actual
  guest TPM reporter directly, once. There is no launcher JSON or ordinary report
  fallback. A failed, oversized, late or lost hardware response stays consumed.
- `rpc-bootstrap-acquire`: exact boot/hash, after the report and actual broker
  listening receipt. One signal permits contacting the protected local broker;
  it is not owner permission, an export request, a writable grant or RPC readiness.

The host can forward a challenge or deny service. It cannot choose the guest key,
loaded app or request fields. The owner must use a fresh challenge that it consumes
under an independent deadline; receiving a public info record is not trust.
A report binds SHA256 of the canonical request, SPKI and exact DER certificate,
the owner's challenge and the fixed runtime digest under the domain
`enclave-rpc-storage-bootstrap/1\n`; the second 32 report bytes are the loaded AppID.
This differs from ordinary app Bind2 and secrets-release purposes.

`rpc/server/verify_bootstrap.mjs` verifies the full independently challenged host
TPM boot and the guest VBS report under that boot's authenticated IDKS. Its caller
supplies the actual TLS client certificate, expected request/runtime and explicit
owner policy `enclave-rpc-bootstrap-policy/1`. Accepted image entries bind
`rpcBootstrap: true`, measurement, runtimeId, profileSha256 and signer/product/
module identity together. No registry lookup, Enclave verifier or default image
is required. The owner still must establish current deployment authority, exact
volume ownership, durable previous-writer settlement and the export's independent
watchdog. The verifier is not a challenge/replay store or authorization server.

The result always states rootsGranted=false and rpcReady=false, with hostExcluded
false for this T0-hv path. It cannot substitute for full running role/seccomp/W^X
attestation. The JS request codec refuses integers not exactly representable in
JavaScript rather than round a clock value.

Qualification covers a real local TLS handshake with the generated guest key,
one-shot/expiry/refusal state, Go/JS binding interoperability and cryptographically
signed synthetic TPM/VBS fixtures. Hardware reporting is stubbed in Go tests;
Windows hardware, a full provisioned broker, accepted measured image, authenticated
cross-host service, NBD attachment and production RPC remain unqualified/offline.
The historical candidate image does not contain this integration.
