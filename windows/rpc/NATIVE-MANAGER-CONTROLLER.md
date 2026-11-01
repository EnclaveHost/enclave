# Original native RPC manager controller

NativeRpcControllerEntry is an explicit candidate executable connected to the
optional app-manager transport. It is not installed or production-qualified.
NativeRpcWorkerEntry can currently create only an owned Off shell. There is no
VM start/device setup/adoption/deletion/reservation release/retry/payment API.

The protected operator configuration retains schema native-rpc-manager-controller/1
with exactly these other fields: ledgerRoot, attemptsRoot, workersRoot, runtimeId,
profileSha256, admissionSha256, firmwareSha256, initialStateSha256, workerSha256,
admissionPath, firmwarePath, initialStatePath, profilePath, workerPath. Configured
roots must already exist with qualified private local Windows ACLs. Ledger setup
requires a protected empty manager.lock plus private transport directory. Setup is
a separate admitted operator action; the controller never creates a replacement
empty ledger. The JS caller pins this exact configuration and executable. Local
pins are not hardware attestation or target admission.

Commands after the executable name:

- begin CONFIG CONFIG_SHA EPOCH INSTANCE DEPLOYMENT: records actual entry QPC
  origin and origin+900000 before acknowledgment. No VM/child/provider. A protected
  exclusive lock serializes writers. Durable attempt.json stores original identity,
  config, boot and 20480 MiB/400000 CPU reservation intent; it does not acquire the
  shared pool. Existing history or partial pending records refuse another begin.
- stage CONFIG CONFIG_SHA ORIGINAL_SHA: consumes stage.json before reading stdin.
  Input is uint32 little-endian header length (2..196608), strict UTF-8 JSON with
  exactly launch/record strings (each <=65536 encoded bytes) and integer bundleBytes
  (1..9MiB), then exactly that many binary bytes and EOF. After original binding it
  consumes launch.json, writes private inputs, validates hashes and fsyncs before
  stage-ready. Truncated/changed/trailing/blocked input cannot produce stage-ready
  or authorize a retry. No deployment-controlled filesystem paths are accepted.
- define-staged CONFIG CONFIG_SHA ORIGINAL_SHA: consumes define-request.json and
  uses only the original complete staged inputs. It copies/hash-pins private
  runtime/initial VMGS/profile/bundle/record under the original plan, performs full
  current native admission, consumes dispatch.json before task registration/Run,
  and schedules exact SYSTEM roles. Old arbitrary input-path define CLI is removed.
- inspect CONFIG CONFIG_SHA: validates protected ledger/transport and returns empty
  or original held history, including across deadline expiry/reboot. Unknown/partial
  inventory refuses. It does not scan Hyper-V or grant mutation/adoption/release.
- current CONFIG CONFIG_SHA ORIGINAL_SHA: reads only the original current boot/window.
- hold CONFIG CONFIG_SHA ORIGINAL_SHA: closes the original local gate even after
  expiry, without provider stop/cancellation/fencing/release. Subsequent mutation
  checks refuse. It is itself one-shot.
- inventory CONFIG CONFIG_SHA: retains the explicit empty-ledger-only check.

Replies use native-rpc-manager-controller-result/2. Begin returns both original
and originalSha256 computed from exact durable native bytes; callers must not
recompute it from reordered JSON response fields. All replies retain false
rpcReady/providerOperationFenced/reservationMayRelease.

Each command arms a native 30-second independent termination watchdog and enters
its 128 MiB self envelope before blocking files/COM/WMI/stdin. This is not a
prior-allocation bound. Actual startup/controller/registration/collector overhead
must be admitted separately. Definition's worker phase is <=20 seconds, clipped
to the original 900-second deadline and controller deadline-1 second. Preparation
never resets the original clock. Existing owner256/observer128/child128 job limits
and five-second bootstrap cutoff remain. Node transport collection limits are
additional controls, not native process-tree death evidence.

Complete current admission precedes task scheduling and repeats in the child
before provider mutation. Exact held owner/observer process handles/creation/image
are required before opening the work gate. Success requires known exits plus
original observer empty-job/exact-owner-death receipts and verification against
the original system/ownership journals. Task stop/delete is never proof of death.
Unknown response/cleanup remains held; no original VM capability is reconstructed
from a supplied GUID or a Notes scan.

Qualification covers new administrator-owned actual ledger/input files and a
separate JS client/manager fixture suite. The production task producer, actual
Windows Node-to-controller-to-SYSTEM composition, provider and target hardware are
not qualified by those component tests. Conditional main integration remains off
without explicit pins, and V9 health remains unadvertised. Complete target
qualification, accepted current image, device/start stages, original owner offer,
TPM/AF_HYPERV/NBD/verity/whole-fit/sync/finality/consumer cutover before production.
