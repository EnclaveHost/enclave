# Dedicated RPC app-manager integration

V9 has a separate Manager.spawn path with exact Go-compatible mapping. The
request names a deployment and measured record, never an existing VM GUID,
ownership receipt, path, command, credential or replacement clock. No ordinary
backend launch/readiness/survey-adoption path handles the native RPC request.

The manager reserves 19456 MiB / 400000 CPU units plus 1024 MiB support
synchronously before awaiting native begin or component fetch. A lost begin
reply, failed fetch or later ambiguous phase retains that same reservation and
deployment. There is no await between final capacity check and reservation.
Native begin captures the actual QPC origin before component fetch, persists the
original attempt, and returns its original 900000-ms window and the hash of the
actual native journal bytes. JS never invents a native epoch or computes this
receipt by reserializing a returned JSON object. The independent native phase
watchdogs remain the termination backstop; local elapsed checks only refuse late
collection or another phase. At least 35 seconds of conservative local original
time must remain before each next native stage/define command.

`rpc-native-controller.mjs` is the concrete transport behind the captured
controller methods. It verifies fixed executable/configuration hashes, invokes
native inspect before construction, and fsyncs exclusive send-intent files before
one begin, stage, define-staged or hold invocation. No shell or payload in argv/env.
The stage input is a four-byte little-endian header length, bounded JSON header
containing launch JSON/record JSON/bundle length, followed by exact bundle bytes
and EOF. Native staging creates private protected files, validates their hashes,
and publishes stage-ready only after complete durable input. Native helper
responses use `native-rpc-manager-controller-result/2`. The client observes a
bounded child process response; Node timeout/kill requests are not independent
native worker-tree death proof. Native original journals, guarded tasks and
cleanup receipts remain authoritative.

Lost/malformed/oversized replies, partial client writes, original-clock expiry or
changed pins/history remain held. No phase is retried. Stop closes the local gate
and writes native hold; it does not claim provider cancellation, writer fencing or
capacity release. Shared physical acquisition and start consumption still happen
in the original manager before staging/definition. The 20 GiB total is a proposed
allocation, not measured fit. Native current admission still includes all original
seed claims, the exact consumed native claim, 39388 MiB prospective growth,
18 GiB floor, variation and all controller/observer/bootstrap overheads.

Startup inspects the original native ledger even after its deadline or a host
reboot. It also accounts for a client begin intent with no native reply. A held
record is imported after ordinary inventory recovery with the original manager
epoch preserved separately, status starting, recovered=true, no VM handle and no
readiness. This is accounting for unresolved work, not adoption or resumed
execution. Its unknown live allocation closes new-work admission. Remove cannot
acquire a replacement attempt capability or free it. A new begin is refused.
Partial or malformed inventory is an error, never empty. Actual original provider
references remain in the native protected journal for later bounded reconciliation.

`main.mjs` has an explicit opt-in constructor using all four operator settings:
ENCLAVE_RPC_CONTROLLER_EXE, ENCLAVE_RPC_CONTROLLER_SHA256,
ENCLAVE_RPC_CONTROLLER_CONFIG and ENCLAVE_RPC_CONTROLLER_CONFIG_SHA256.
Partial configuration or overlap with enrolled/native-router scopes refuses.
Without those settings the default remains disabled. V9 serviceability is still
NOT advertised, and no installation or target activation has occurred. These
operator pins do not prove accepted image/hardware identity or current capacity.

Before any target activation qualify the actual Windows process/namespace/stdio/
job composition, including initial allocations and controller/task/collector
commitments. Complete journaled native device/TPM/optical/network configuration
and start, the current accepted image, original HostBootstrapEntry ownership and
storage-owner enrollment/signed-offer delivery, real TPM/AF_HYPERV/NBD/verity,
whole-stack fit, sync/finality/readiness, persistent serving and consumer cutover.
Catalog preview is already published and is not the production runtime. No
publication, signature or payment is repeated by this integration.

Hosted run41328193864 subsequently exercised the actual Windows Manager/client/
native CLI process path with the same compiled controller (no rebuild). Five
composed checks passed, including actual binary staging, original QPC receipts,
held recovery and native hold. Deliberately absent inert firmware refused definition
before provider admission/task dispatch. A separate native process blocked on
stdin exited125 through its own30-second watchdog after30066.3821ms; an external
fixture held its exact process handle before expiry and verified death. CI used
Node22.23.4 (SHA256 dccc52de28d8df2ee22d2062424f8c563070d95d8ad70c54c4bf01d590dec14f),
not targetNode24.16.0. Host inventory/shared pool were fixtures. Full target SYSTEM
scheduling/admission, device setup/start, accepted current image and actual RPC
serving remain unqualified. See
`../../../ops/unified-funding-20261028/rpc-native-manager-process-ci-r1/ROOT-RESULT.md`.
