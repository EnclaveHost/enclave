# Dedicated RPC app-manager integration

V9 has an explicit path in Manager.spawn and its own exact Go-compatible mapper.
The wire names a deployment and measured record, never a VM GUID, owner receipt,
command, path, credential or replacement clock. The manager captures those inputs
before asynchronous component fetch. Default managers still reject V9; health
still omits it from serviceable derivations. No production driver is installed.

The optional trusted local rpcController has runtimeId/profileSha256 pins,
assertInventory(), and begin(identity). These methods are captured at construction;
caller-supplied readiness flags, VM handles and ownership hashes are not accepted.
assertInventory must synchronously check the controller's original durable ledger
and refuse unresolved ownership from a prior manager, rather than adopting a VM
from Notes or treating absent in-memory state as proof. It must account for its own
current held attempts. begin captures an original native monotonic clock BEFORE
component fetch; it MUST NOT create children, allocate a VM or submit provider
work. It returns originalClock {originMs,deadlineMs} decimal strings exactly
900000 apart and private bound assertCurrent(), start(launch,bundle), stop().
The native deadline includes all preparation. assertCurrent must check that exact
clock and independent supervisor; JavaScript elapsed checks are not a backstop.

Manager reserves the exact purchased 19456 MiB and 400000 CPU units plus 1024 MiB
support, then acquires and consumes a 21474836480-byte shared app-native claim.
This is the existing 20 GiB PROPOSAL, not measured fit or admission. Native driver
must additionally admit all bootstrap/observer/task/collector overheads, host
floor, pending commitments, namespace, actual accepted image and original owners.
Resource changes and deadline loss are checked before each next operation. Shared
claim failure and ambiguous starts retain the same reservation and deployment.
Failed RPC records also block an ordinary request for the same deployment.

Only attempt.start receives the manager-derived immutable launch identity and an
owned bundle copy. It must persist consumed intent BEFORE native submission and
exact returned provider references BEFORE acknowledgment, originate the VM under
that same attempt, and bind HostBootstrapEntry to its actual ownership capability.
It must persist the full reservation/identity for restart recovery. This interface
is NOT an implementation or qualification of those native responsibilities.
Do not implement it with the old launcher, HCS development backend, a manual VM
GUID or the ambiguous historical Windows 5a attempt. No installed main entrypoint
supplies a controller yet. Actual driver/ownership-journal integration is next.

A returned start value does not establish Running, hardware exclusion, storage
grants, sync, finality, serving, provider fencing or reservation release. Generic
readiness and legacy backend start/stop/survey adoption do not operate on these
records. Stop is one-shot through the original private closure and always retains
capacity; provider settlement, all previous writers and original-owned Off/zero
memory need a separately implemented qualified release protocol. Recover refuses
to overwrite held RPC records. Durable cold recovery remains the native owner's
responsibility and is not proven by these in-process records or stub tests.

Before enabling health advertisement or production, complete the actual owning
native driver, accepted full image, authenticated enrollment/offer delivery,
real Node/TPM/AF_HYPERV and broker/root attachment, measured whole-stack fit,
sync/finality/readiness and consumer cutover. Catalog preview is already published
and is not this production runtime; no publication/signature/payment is repeated.

The native worker implementation now exists at `windows/rpc/NativeRpcWorkerEntry.cs`.
It runs only an explicit native-definition lease, verifies the original manager's
live RPC record and consumed shared `app-native` claim, pins private assets, then
invokes the durable native DefineSystem transaction. It creates only an Off shell.
The manager-side original controller/ledger and bounded task request producer are
still missing; do not supply a controller that fabricates a plan from an existing
VM or treats an output receipt as a new ownership capability. Default main stays
unactivated until that connection and target qualification exist.
