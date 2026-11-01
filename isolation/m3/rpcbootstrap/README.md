# RPC storage bootstrap identity

The dedicated monitor now creates one Ed25519 client credential inside the guest
for its actual loaded V9 RPC bundle. Its private key is never accepted from or
returned to host control. The public self-signed certificate is a transport
container, not a CA or storage authority. The monitor takes the same credential once for the actual bounded broker launch.
It writes private root0600 credential inputs only in a new guest tmpfs directory,
never through host control or onto the storage owner's durable journal.

Before storage acquisition, the monitor creates the exact request once, including
its random nonce, actual kernel boot, loaded app/deployment/profile/volume IDs and
original sealed deadline. It reads runtime identity from the fixed immutable
`/plat/rt/runtime.json`. It waits under the existing PID1 supervisor and original
900-second deadline. No clients, writable mounts or app children start here.

The existing control transport exposes four operations:

- `rpc-bootstrap-info`: public request, request hash, runtime, SPKI and certificate.
- `rpc-bootstrap-attest`: exact kernel `boot`, `requestSha256`, and lowercase
  32-byte hex `challenge` from the owner verifier. The monitor calls its actual
  guest TPM reporter directly, once. There is no launcher JSON or ordinary report
  fallback. A failed, oversized, late or lost hardware response stays consumed.
- `rpc-bootstrap-owner`: bounded binary public owner inputs, installed once after the report.
- `rpc-bootstrap-acquire`: exact boot/hash after the report and owner-input installation. The monitor consumes
  the launch gate, launches the actual broker, verifies its exact listening
  receipt and only then signals acquisition. It is not owner permission, an
  export request, a writable grant or RPC readiness.

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

## Actual broker launch

`StartBroker` requires the loaded request and sealed original clock. It opens only
fixed protected `/run/native-rpc-owner/policy.json`, `server.der`, and
`owner-bootstrap.json`. These carry public policy, export-server DER and the
monitor-produced bootstrap record. Policy binds the loaded bundle and runtime;
the broker authenticates the signed endpoint against current owner commitments.
Root ownership alone is not remote owner authentication. No
host-controlled private-key field or executable selector is accepted. The broker
retains its independent deployment/owner/signature verification before any export.

Launch exclusively creates `/run/native-rpc-broker-inputs` on writable tmpfs and
fsyncs a permanent intent before credential files or the first child. Failed or
ambiguous setup closes the identity and wakes the waiting load with refusal. It
never removes an intent, adopts an existing directory or retries within the boot.
The current broker still grants no writable roots.

The fixed executable `/plat/native-rpc/rpc-storage-broker` is held on its immutable
mount and executed through fd11. FDs3–10 preserve the command's existing contract;
fd10 comes only from the guest key. The image builder now embeds this executable.
The historical image predates this change; no complete new image was built or
installed by this qualification.

A new real cgroup2 group has 128MiB memory.max, swap0, CPU1, memory.oom.group1 and
32 tasks before `CLONE_INTO_CGROUP`. No post-start membership move or fallback.
Atomic pidfd and held group/kill handles remain retained. The creating OS thread
stays alive through Wait for Pdeathsig; that is only defense in depth. Existing
independent guest PID1 original deadline still covers setup and blocking calls;
external original host supervision remains necessary for kernel stalls.

One canonical listening line must match exact child PID, actual boot and original
origin/deadline, with rootsGranted/rpcReady false. Launch verifies the live pidfd,
actual group membership and limits before acquisition. The three-second readiness
cutoff is clipped to the original window, not a renewal. Stop requests group kill;
only pidfd plus populated0 confirms local death. Neither releases storage or proves
previous-writer settlement. All ambiguous capabilities and namespaces remain held.

Qualification executes the actual compiled broker under a real disposable systemd
delegation with private user/PID/mount/network namespaces. It verifies generated
credential continuity, creation-time limits/readback, exact listening identity,
one-shot reuse refusal, explicit kill/exact death, and original500ms self-expiry.
The fixture supplies the held real delegated parent; production uses the fixed
guest cgroup root. Hardware reporting and owner policy are synthetic. This is not
target boot, production owner configuration, cross-host bridge, independent PID1
composition, NBD attachment, running attestation or RPC readiness evidence.

`rpc-bootstrap-owner` now accepts a bounded binary public-input body after its
control header. It consumes a separate one-shot gate and writes four root0600
files into an exclusive guest tmpfs namespace. The host supplies policy, two-owner
signed endpoint offer, owner/export public certificates and host TPM evidence;
the producer inserts the monitor's retained report itself. No host-provided guest
report, key, executable, path or replacement clock is accepted. A malformed
consumed setup closes the identity. Completed setup is required before StartBroker.
FD7 now carries a readonly bootstrap record instead of a Unix relay socket.

The broker independently obtains current deployment authorization, verifies both
committed storage keys' purpose-separated endpoint signatures, and dials the
signed literal IP once using normal TLS1.3 name/validity/usage checks and exact
server DER. Evidence and the unchanged prepared storage request use that same
connection. Its intent survives loss; it never retries or grants roots. Neither
file ownership nor endpoint signatures replace owner writer settlement or the
subsequent storage-consent proof. This path is source integration, not installed
production RPC; actual hardware and the complete owner/guest composition remain
to be qualified.

The measured RPC monitor inherits PID1's retained private lifecycle channel at
FD4 and transfers it only to the original broker (FD13). `StartBroker` now
requires that capability alongside the sealed original clock. A separate
seqpacket pair created before broker Start becomes broker FD14 and native entry
FD16. `TakeServingReader` consumes the exact live-broker transfer once; the
monitor closes its copies only after Start settles. Helpers and service roles
inherit neither channel. Socket identity checks do not establish provenance by
themselves: only this measured inherited topology does. The currently wired
broker emits PREPARE after live owner preparation, never COMMIT/RENEW yet.
