# Direct native RPC bootstrap (not activated)

The first deployment may use a single explicitly configured host with an operator coordinating startup. Automatic app-manager bootstrap orchestration, multi-host recovery and full refusal/failure demonstrations remain outstanding. This does not complete decentralized production RPC.

The compiled controller command is:

```
bootstrap-controller.exe bootstrap-staged <manager-config> <manager-config-sha256> <original-attempt-sha256> <bootstrap-config> <bootstrap-config-sha256>
```

The original v2 manager must already hold owned VM definition and completed native start receipts. The bootstrap configuration has the exact fields in `NativeBootstrapContract.ConfigurationKeys`; it pins this controller, the separate SYSTEM bootstrap worker, existing Node/TPM executables, protected host key, fixed JavaScript closure, original expected app identity and EK chain. Configuration and keys stay in the protected target namespace, never Git. Operator key pins do not replace independent storage-owner authorization or attestation.

The controller consumes its original bootstrap subtree before preparation. It schedules independent SYSTEM owner/observer processes, verifies original live lifecycle keepers and current admission, then opens the one-shot work gate. It emits a four-byte big-endian length followed by a UTF-8 JSON `native-rpc-bootstrap-enrollment/1` frame. Only public enrollment material is emitted. The operator transport must return one framed `native-rpc-bootstrap-offer/1` object with the exact enrollment SHA256 and the original owner's signed offer, then close stdin. A second output frame reports acquisition requested only after exact bootstrap process cleanup. All frames are bounded to 131072 bytes. Unknown or interrupted outcomes remain consumed; do not repeat the command.

The original 900-second attempt clock is unchanged. Controller lifetime is at most 30 seconds; bootstrap phase at most 25 seconds and must start with at least 125 seconds left on the original clock. Owner entry version 3 derives its prepared request, certificate, contract, policy and relay from the actual enrollment and a pinned operator template, retaining the original durable writer journal. The maintained operator transport and owner exchange now connect those commands; actual service timing and cross-host execution remain unqualified. They preserve the native frame's `enrollmentSha256` when returning the offer; a Python reserialization digest is not interchangeable with that correlation digest. See `rpc/server/README.md` for the owner configuration.

## One operator command (implemented, not activated)

`rpc/server/operator_bootstrap_transport.py <protected-config>` runs on the storage
owner host, only inside `enclave-rpc-operator-bootstrap-ATTEMPT.service`: Type=exec,
RuntimeMaxSec=40, TimeoutStopSec=1, MemoryMax=128M, MemorySwapMax=0, CPUQuota=100%,
TasksMax=32, KillMode=control-group, Restart=no, SendSIGKILL=yes,
FinalKillSignal=SIGKILL, NoNewPrivileges=yes, LimitCORE=0 and UMask=0077. Invoke it
once using the original startup clock and actual already-started native attempt;
do not create a replacement clock to make it fit. Its entry must begin within
5 seconds of that unit's start, with more than 170 seconds of original time left.

The exact `enclave-rpc-operator-bootstrap/1` configuration contains `schema`,
`exchange` (protected path/SHA256 binding), and `native`. The latter contains
`host`, `user`, `port`, `key`, `knownHosts`, `controller`, `manager`,
`managerSha256`, `original`, `bootstrap`, `bootstrapSha256`, and `sshSha256`.
Key/known-hosts bindings refer to existing private owner files. The three remote
paths must be absolute Windows paths with the restricted encoding in the source.
Only the fixed `bootstrap-staged` command can be constructed. SSH uses the pinned
installed executable, strict host-key checking, no ambient SSH config or
forwarding, and explicit identity/known-host files. Their inodes remain held in
the operator process; no private bytes are copied or logged. OpenSSH closes
inherited descriptors, so it opens `/proc/<operator-pid>/fd/N`, not its own fd
namespace. This access was checked with installed `ssh -G`; actual authentication
and target execution remain unqualified.

The operator consumes `bootstrap-transport/` before one SSH submission. It reads
exactly the first native enrollment frame and submits the fixed local
`owner_bootstrap_exchange.py` service once, forwarding that frame then EOF. The
exchange consumes its own ingress and owner-submission intents, starts the
independent owner bootstrap service, and returns its complete published offer.
The operator persists the offer before writing it to the still-running native
controller and closing that controller's stdin. It accepts exactly one subsequent
native result with the original attempt/plan/enrollment and all readiness/fence/
release flags false. Only local transport children are reaped on failure; that
does not prove native/owner death or cancel their independently bounded work.

Storage-host admission includes 1792 MiB for the whole owner/exchange/operator
composition and startup allowances, plus actual pending commitments and the
retained 27648 MiB or higher floor. Native host admission remains separate and
unchanged. This is reservation arithmetic, not measured prior-allocation or
whole-stack fit. The owner exchange has a 20-second service lifetime and the
owner endpoint retains its original 120-second independent lifetime; all must
fit the unchanged original startup window. Missing/partial/ambiguous output
remains consumed, without retry or a replacement attempt suffix.

Eight owner-exchange cases, three actual inert subprocess/pipe bridge cases and
one installed SSH configuration check passed in separate bounded runs. The
bridge's native and owner peers were inert Python actors, not the Windows or
TPM/owner services. See
`ops/unified-funding-20261028/rpc-operator-bootstrap-transport-tests-r2/ROOT-RESULT.md`.

Bootstrap admission retains native floors, prospective commitments and both possible cleanup groups, adds a 512 MiB bootstrap-group allowance, and credits only the exact original running guest's verified 19 GiB allocation at both observation endpoints. This avoids counting already-resident guest memory twice. Current SYSTEM/provider observations and total host fit remain unqualified. Registration, controller and collection overheads require separate accounting.

Acquisition is not RPC readiness. The real SYSTEM launch, TPM/AF_HYPERV exchange, storage-owner settlement, NBD/verity mounts, client resource fit, sync/finality, serving adoption and consumer cutover remain unproven. Independent keepers still enforce the original deadline; this command does not make serving persistent.

Qualification: seven actual protected administrator preparation cases passed in hosted launch run41346414827. Compile-only run41346667644 built all five affected production entries; controller260096 bytes, host bootstrap251904 bytes and SYSTEM worker261632 bytes were independently hashed. Neither qualification ran the target SYSTEM/provider/TPM/storage path. See `ops/unified-funding-20261028/rpc-native-bootstrap-runtime-ci-r1/ROOT-RESULT.md` for complete failures, provenance and remaining integration.
