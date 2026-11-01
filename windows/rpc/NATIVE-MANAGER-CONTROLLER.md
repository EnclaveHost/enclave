# Original native RPC manager controller

`NativeRpcControllerEntry` is an explicit candidate executable, not an installed
manager or a production RPC. It connects a durable original manager ledger to
`NativeRpcWorkerEntry`, which creates only an owned Off shell. There is no VM
start, device setup, adoption, deletion, reservation release, retry or payment.

The protected operator configuration has schema `native-rpc-manager-controller/1`
and exactly these other fields: ledgerRoot, attemptsRoot, workersRoot, runtimeId,
profileSha256, admissionSha256, firmwareSha256, initialStateSha256, workerSha256,
admissionPath, firmwarePath, initialStatePath, profilePath, workerPath. Roots must
already exist with qualified private local Windows ACLs. The ledger starts with
one protected empty `manager.lock`. Creation/installation is a separate admitted
operator action; the executable does not manufacture an empty replacement ledger.
The caller must pin this configuration and executable to the original manager.
All these local pins are operator inputs, not hardware attestation.

Commands, after the executable name:

- `begin CONFIG CONFIG_SHA MANAGER_EPOCH INSTANCE DEPLOYMENT` records the actual
  entry QPC origin and original origin+900000 deadline before returning. No child,
  provider or VM is created. It holds an exclusive ledger lock and fsyncs a unique
  attempt.json via pending then no-overwrite rename. It records the complete
  20480 MiB / 400000 CPU unit reservation and never authorizes release. Any prior
  attempt, unknown file, or partial pending record refuses another begin, including
  after manager restart. This intentionally holds unknown original work; it is
  not a cold-recovery adoption or capacity-release implementation.
- `define CONFIG CONFIG_SHA ORIGINAL_ATTEMPT_SHA LAUNCH LAUNCH_SHA BUNDLE RECORD`
  requires exact original epoch/instance/deployment/clock/reservation. LAUNCH is
  the manager-derived launch JSON, BUNDLE is its derived binary, RECORD is its
  exact canonical record JSON. All are protected private local files. It consumes
  launch.json before preparing assets or scheduling anything; lost replies cannot
  resubmit. Private firmware/initial VMGS/profile/bundle/record copies are streamed,
  hashed and flushed; the master VMGS is never handed to Hyper-V. Preparation is
  inside the original startup clock. A new short worker lease is clipped to that
  original deadline and the controller's original 30-second command deadline.
- `inventory CONFIG CONFIG_SHA` proves only an empty original ledger. Nonempty
  history is refused and held. It does not scan Hyper-V, reconstruct ownership
  from Notes, adopt old GUIDs, or return readiness.

Every command first arms an independent native 30-second termination watchdog
and enters a 128 MiB self job. This is a post-entry envelope, not a prior-allocation
bound. Target admission must include controller/registration/collector overhead
in addition to the existing owner/observer/startup reservations. Before scheduling
SYSTEM owner/observer tasks, define performs the existing complete current native
app admission (including retained seeds, exact consumed shared claim, all managers,
physical headroom and four-second freshness). The child repeats it before provider
mutation. Both tasks have exact one-shot definitions, no automatic trigger/restart,
closed gate and original bootstrap cutoff. dispatch.json is durable before the
first task registration or Run call. Unknown registration/Run remains consumed.

The controller holds exact owner/observer handles and creation times before opening
the gate. Successful collection requires their known exits plus the original
observer's empty-job and exact-owner-death receipt. It verifies the child result
against the original native system and ownership journals before saving result.json.
Task deletion/Stop is not process death. Failure cleanup never releases capacity;
the worker's independent original deadline still applies if the controller dies.

The manager's JavaScript producer/transport is still missing. In particular its
current synchronous begin contract must become asynchronous for this bounded
native command without creating a concurrent reservation race. It must consume
its own send intent before transport, persist full held inventory across restart,
prepare protected launch/bundle/record inputs, retain this exact configuration,
and never infer inventory from an absent in-memory record. Default main still has
no rpcController, and V9 remains unadvertised. Do not attach this executable to the
old launcher or treat returned Off ownership as permission to boot.

Qualification for this revision is a new disposable hosted harness exercising
actual administrator namespace/ledger/locking/pending/copy/refusal behavior. The
controller task producer is compiled only; SYSTEM tasks, current live app
admission, actual provider operations and full composition are not tested by that
harness. Production requires those proofs, accepted current image and hardware,
journaled device/start stages, original owner enrollment/offer delivery, real
TPM/AF_HYPERV/NBD/verity, whole-stack fit, sync/finality and consumer cutover.
