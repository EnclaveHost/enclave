# Alchemy RPC gateway

`gateway.mjs` is a dependency-free loopback HTTP service. Publish only
`/rpc/base`, `/rpc/base-sepolia`, and (when enabled) `/rpc/ethereum` through
Enclave's existing TLS front. `/health` is loopback-only at the TLS layer.

The JSON config contains `upstreams: { base: [ALCHEMY_URL, PUBLIC_URL, ...] }`.
Never commit that file. The service unit uses systemd LoadCredential to read
`/etc/enclave-rpc/config.json` (root, mode 0600); it binds port 8190.

Every cache miss starts with the first upstream. Transient errors fall back in
order; deterministic errors are returned without public-provider retries.
Successful reads share a bounded 16 MiB / 4096-entry cache and concurrent
identical reads share one request. Current state expires after one second;
chain IDs after one hour. Pending state, nonce reads, gas estimation, errors,
null results and signed transaction submissions are never cached. Ambiguous
transaction submissions are never automatically retried. Requests and replies
are size-limited; upstream concurrency and request rate are bounded. No
credential-bearing URL is logged or returned to clients.

Clients use `https://api.enclave.host/rpc/base`; services on the gateway host
use `http://127.0.0.1:8190/rpc/base`. Set BASE_RPC, SESSIONS_RPC and
SESSIONS_PUBLIC_RPC accordingly. Session clients receive the public URL in
`/v1/sessions/config`. Public client pools remain emergency fallbacks.

Security readers that require independent provider agreement must retain
independent witnesses. Do not point multiple quorum slots at this gateway:
that would count one provider repeatedly and remove the security check.

Test with `node --test test/rpc-gateway.test.mjs`. Verify live primary/fallback
counts and cache hits via loopback `/health`, without reading credentials.
Rollback: restore the previous TLS/site root and remove the dedicated
`zz-alchemy-rpc.conf` service overrides, daemon-reload and restart those services.
# Windows transition sequencing

`windows_transition.execute(config)` submits the existing Windows controllers in
the fixed order `cut-seed`, `define`, `boot`, `start-once`. It uses a completed
`startup_clock` binding; it never creates or extends that original 900-second
window. Each phase samples Windows time over the same pinned SSH endpoint and
passes a fresh native worker lease, at most 30 seconds, clipped to the original
deadline. The native controller still enforces its own five-second bootstrap
cutoff, independent watchdog, namespace checks and current host admission.

The caller supplies `clock`, `transport`, `phase`, `nonce`, `binaries`,
`observation`, `input` and `previous`. Transport contains the explicit endpoint,
pinned known-host binding, host alias, SSH digest and qualified sampler path and
digest. Binary bindings contain protected Windows paths and reviewed digests.
Observation and input bindings each contain the Windows `path` and a pinned
private local `binding` with the exact bytes already staged there. The input is
`handoff.json` for the cut, then the same original `definition-plan.txt` for all
remaining phases. After definition its Windows path must be the exact owned VM
root. `previous` is null for the cut and otherwise the preceding returned result
binding from this original clock's journal.

This sender relies on independently qualified protected staging for executable
custody; an expected hash in a configuration is not a remote image measurement.
Native entry controllers verify their input hashes and perform their own
admission. The caller must account for local transport, sampler and controller
startup commitments before invoking this source. It does not substitute an SSH
exit for remote process death or silently invoke a reconciliation operation.

An exclusive fixed phase directory and fsynced request precede clock sampling;
a separate fsynced submission intent precedes the single mutating transport.
Lost replies, invalid results and timeouts remain consumed, without retry or
rollback. Later phases require the original predecessor request, submission and
response evidence. Definition requires the preceding actual cut/seed namespace
and pool binding; boot must retain the defined GUID. An unsettled definition
cannot advance. Final startup completion records only that the local worker
returned: its provider outcome stays explicit and may still be held. It does
not establish VM Running, RPC readiness, adoption, fencing or reservation release.

`windows_transition.prepare_definition(config)` consumes the preceding actual
cut result plus authenticated copies of its exact `contract.txt`,
`pool.activation` and `pool.complete` bytes. It checks the original request and
native result, reconstructs the exact expected contract, and checks the raw
activation digest against completion. It preserves the fresh observation and
adds the native cut, shared pool, boot network and 192 MiB cleanup bindings. The
resulting fixed Gen2 plan preserves the original attempt, boot, deadline, guest
memory and staged media hashes. The native definition worker independently
reopens and verifies the real protected cut namespace; local copies alone are
not proof of native custody. The producer creates only exclusive local files.

Its configuration fields are `clock`, `cutResult`, `cutEvidence`, `observation`,
`media`, `providerSha256`, `cleanupSha256` and `network`. `cutEvidence` contains
pinned local `contract`, `activation` and `complete` files. `observation` and
`media` are pinned local files, with the latter using the existing
`rpc-staged-client-media-binding/1` schema. `network` uses the native
`owned-rpc-boot-network/1` schema. The returned result pins the admission and
definition plan ready for protected staging and the subsequent sender call.

`windows_files` supplies three owner adapters for the maintained native
`TransitionFiles.cs` helper: `collect_cut`, `stage_inputs` and `copy_media`.
All receive `clock`, `transport`, `helper` (protected path and digest) and a fresh
`nonce`. They preserve the original clock and use the same qualified sampler and
explicit pinned SSH endpoint. Each operation has an exclusive fixed journal,
fsynced intent before its sole transport, and an unresolved outcome on loss or
invalid readback. Changing nonce cannot retry a consumed operation. Run them
inside a separately admitted, independently bounded owner process.

`collect_cut` additionally receives the actual `cutResult`. It validates the
preceding sender evidence and collects the exact protected contract, activation
and completion bytes. Its result's `cutEvidence` feeds `prepare_definition`.
`stage_inputs` receives `phase` and a `files` mapping of local pinned bindings:
`observation.json`, plus `definition-plan.txt` for definition. The returned
`result.files` supplies the remote path/local binding pairs consumed by the
phase sender. It cannot stage arbitrary filenames or private credentials.

`copy_media` receives the actual `definitionResult` and `preparedDefinition`
binding. The prepared media metadata must also include its protected Windows
`root`. The helper copies the already staged private boot and seed locally into
the exact defined VM directory, checks the original hashes and destination
readback, and never sends media contents through this owner transport. Existing
files or a previous copy intent refuse another copy; partial files remain held.
The receipt binds the durable definition journal, **not current VM state**.
The native boot worker must still independently verify original-owned Off/zero
before attachment. No adapter claims remote death, RPC readiness or release.

The 13 file-adapter tests, 20 transition/producer tests and 10 clock transport
tests pass using real exclusive owner journals and simulated SSH/native replies.
They compose collection into the actual definition producer, staged inputs into
the sender, and defined-media lineage into copy requests. No production phase
has been submitted through these adapters. Hosted native helper qualification is
separate from target custody and full original-clock composition. Complete
operational integration still requires target qualification and the coordinated
exporter/guest activation/runtime path. Do not cut the allocator or consume the
production clock until that complete workflow is ready.

Actual NucBox qualification now exercised `begin` -> authenticated `sample` ->
`finish` -> `stage_inputs` with the maintained sender over pinned SSH. The
independent nonproduction attempt completed in1.834seconds and retained the
original900000ms window. The native helper staged and read back17702bytes of
public observation; a separate read verified its exact process was absent and
the four existing manager incarnations and VM states were unchanged. This is
admin-context clock/staging evidence, not a production cut, definition, copy,
SYSTEM lifecycle, guest startup or RPC serving result.

The first transport attempt failed before staging because Windows OpenSSH uses
PowerShell here. Quoting a whitespace-free executable path made it a string
expression; the installed parser reported `UnexpectedToken`. All three clock
callers now use their already validated bare canonical paths. Whitespace and
shell metacharacters remain refused. The original attempt stays consumed; the
corrected qualification used a separate nonproduction attempt after confirming
no sampler/helper remained. No deadline or capacity limit was relaxed. See
`ops/unified-funding-20261028/rpc-files-target-qualification-r2/ROOT-RESULT.md`.

`observe_guest.py` obtains the initial guest boot ID needed by
`prepare_attachment.py`. Run it on the owner host that already holds the guest
SSH identity; the verified current key owner is Warden. Supply pinned
`serverContract` and `seedReceipt`, explicit `target`, optional pinned `jump`,
`sshSha256`, and a protected `journalRoot`. Transfer the public inputs through
the authenticated owner channel. Their hashes do not establish provenance.
The prepared server contract carries the original startup window and clock
binding; this observer never begins or extends a startup clock.

The sender validates the seeded instance, attempt, Ed25519 host key and
fingerprint, then consumes an exclusive fsynced intent before one SSH call.
A separately supervised root unit has64MiB, one CPU, no swap, a10-second runtime
and one-second stop limit. It verifies its actual loaded limits and cgroup,
reads the guest boot and cloud instance IDs, and validates four public seeded
files before calling the existing read-only identity validator. It neither
initializes accounts/JWTs nor starts activation or clients. The return value's
`guestBootId` feeds attachment preparation; the pinned public receipt records
the observation. It explicitly does not prove hardware attestation, exclusive
VM association, storage readiness, writer fencing or remote process death.
The complete driver must still bind the network endpoint to its actual owned
VM and use the unchanged guest-side boot checks during activation.

The source integration passed14 new checks plus43 delivery/launch/observation
regressions. The tests execute the exact transported bootstrap with actual
protected files and the seeded identity validator, then feed its boot ID into
the actual attachment preparer. SSH and systemd are mocked: a live guest boot
and the remote unit remain unqualified. No guest file or private seed changed.
See `ops/unified-funding-20261028/rpc-guest-observation-tests-r1/ROOT-RESULT.md`.


### Public export metadata transfer (source integration only)

`transfer_export.py` runs on the original storage-clock owner and transfers only
its pinned server contract and server readiness receipt to the separately
admitted guest-key owner. Configuration requires `clock`, `serverContract`,
`serverReady`, explicit `target`, pinned `knownHosts` and `hostAlias`,
`sshSha256`, and independently verified `recipientRoot`, `recipientUid`,
`recipientBootId`. The destination must already be a private owned directory.
The receiver checks its exact boot, UID and actual user-unit envelope before
reading input. Its fixed limits are64MiB, CPU1, no swap,10s runtime and1s stop.
Bootstrap, transport and registration overhead require separate admission.

Both sides retain the original900-second window and consume exclusive fsynced
intents before submission/import. The sender makes one pinned SSH call and
requires18s remaining. Lost replies or partial imports stay consumed; there
is no overwrite, retry, new clock, credential transfer or guest submission.
`recipientFiles` supplies exact local bindings for the existing guest observer
and attachment preparer. Hashes bind content; authenticated channels and
protected source custody establish provenance. The imported readiness receipt
records storage negotiation and does not mean the RPC is ready.

Actual14 new tests plus28 relevant regressions passed. Tests execute the exact
receiver bootstrap and protected filesystem writes and feed the imported
metadata into actual downstream producers; SSH and systemd remain mocked.
The initial frozen-closure omission and corrected42PASS results are preserved
in `ops/unified-funding-20261028/rpc-export-transfer-tests-r1` and `-r2`.
The local Warden path is now selected; its actual unit and normal pinned jump
are qualified below. Full startup admission and guest execution remain required.
No guest files or private seed changed.


### Owned Windows endpoint adapter (source integration only)

`windows_endpoint.observe(config)` accepts the original `clock`, pinned
`transport`, staged `helper`, separate `nonce`, exact `startResult`, and
`requiredFreeBytes`. It reopens all four consumed transition phases and derives
the original permit bytes from the definition and returned VM GUID. The exact
switch, MAC, provider image and original deadline remain bound throughout.
The native reader independently checks the actual protected permit and boot graph.

An exclusive observation journal and fsynced intents precede each of the single
clock and endpoint calls. The worker lease is at most30 seconds within the
original900-second window. Accepted observations must be fresh within two
seconds, match the native128 MiB envelope and retain the host floor plus all
prospective commitments. Caller and transport overhead need separate admission.
A missing address is pending; lost replies and consumed observations cannot be
retried by changing the nonce. The returned endpoint is not guest authentication,
provider settlement, RPC readiness, remote death or reservation release.

15 new tests plus43 relevant regressions passed with real protected journals
and mocked SSH/native responses. Evidence is in
`ops/unified-funding-20261028/rpc-windows-endpoint-tests-r1/ROOT-RESULT.md`.
The native reader is staged with target hash/custody verification below. Its
query against the actual owned VM still needs qualification during admitted startup. The driver is implemented below;
its live production integration remains unqualified. No guest seed or staged lifecycle image changed.


### Guest-key-owner workflow (source integration qualified)

`run_guest_workflow.py` connects the existing guest observer, attachment
preparer, delivery, activation launch, activation observer, and L1/Base runtime
preparation and submission. Run it on the host that already owns the normal
guest SSH identity. Configuration requires pinned public `serverContract`,
`serverReady`, `endpointReceipt`, `seedReceipt`, `imageReceipt`, and
`credentialReceipt`, plus `target`, optional pinned `jump`, `sshSha256`, private
`journalRoot`, the admitted key-owner `ownerBootId`, and original `vmAttempt`.
The endpoint receipt must arrive through the authenticated original owner's
channel and match the original startup clock, VM namespace and target address.
A hash alone is not authentication; an endpoint snapshot is not a continuing
freshness or guest attestation claim. Foreign owner paths in that receipt are
provenance references and are never opened on the key-owner host.

The fixed user unit is `enclave-rpc-guest-workflow-ATTEMPT.service`: Type=exec,
MemoryMax=256M, MemorySwapMax=0, CPUQuota=100%, TasksMax=16,
RuntimeMaxSec=240, TimeoutStopSec=1, KillMode=control-group, SendSIGKILL=yes,
FinalKillSignal=SIGKILL, Restart=no, NoNewPrivileges=yes, UMask=0077 and
LimitCORE=0. The runner verifies actual PID, cgroup, invocation, limits and
monotonic process origin. Its independent cutoff including stop grace and a
2-second clock allowance must fit before the original startup deadline.
Preparation/transport/bootstrap memory and live capacity admission remain
separate; the unit does not establish a prior-allocation hard bound.

All public inputs and runtime closure are checked before guest contact and
rechecked between phases. Exclusive fsynced workflow and phase intents prevent
automatic replay. Every phase retains the original window and observed guest
boot. Lost replies stop the sequence, preserving HELD and consumed subphase
journals. The same activation owner must remain present through L1 and Base.
There is no automatic cleanup, clock reset, start retry or reservation release.
The final result reports client processes observed, not RPC readiness, adoption,
provider settlement, writer fencing or remote death.

18 new integration checks plus28 activation/runtime regressions passed. The
new tests execute actual preparers and all six senders with protected files;
SSH, systemd and guest responses are mocked. See
`ops/unified-funding-20261028/rpc-guest-workflow-tests-r1/ROOT-RESULT.md`.
The authenticated handoff and original Warden/Windows composition are now
implemented below. Warden is the verified guest-key owner; the earlier Control
key-owner assumption was incorrect. The real local unit and source staging
are qualified below, while the owned RPC guest and production startup remain
unqualified. No private guest seed or staged lifecycle executable changed.


### Authenticated guest workflow handoff (source integration qualified)

`deliver_guest_workflow.send(config)` connects the original Warden owner to
`run_guest_workflow.py` on the independently admitted guest-key owner. It
requires the original `clock`, public `serverContract`/`serverReady`, completed
`exportReceipt`, original `endpointReceipt`, pinned SSH `target`/`knownHosts`/
`hostAlias`/`sshSha256`, admitted `recipientRoot`/`recipientUid`/
`recipientBootId`, and already staged private `sourceRoot`/`sourcePins` plus
an existing pinned local `profile`. All14 source files must match maintained
source. The source directories must contain exactly the expected files;
additional files, including a shadow guest storage protocol, are refused.

The recipient profile contains public `seedReceipt`, `imageReceipt`,
`credentialReceipt`, local `guestIdentityFile`, optional pinned `jump`,
`sshSha256`, private `journalRoot`, `ownerBootId` and original `vmAttempt`.
The profile stays on the actual key-owner host. The sender transfers public endpoint bytes and
the prior two-file import's path/hash bindings; it does not transfer keys, code,
seed media or blockchain data. Endpoint provenance is rechecked against the
original four-phase journals. This transports the previously accepted endpoint
snapshot without asserting renewed native freshness.

A fixed consumed owner journal and fsynced intent precede one pinned SSH call.
At least255 seconds of the original window must remain; the transport allows
at most250 seconds. The remote bootstrap runs inside the workflow's fixed
256MiB/240s user unit, checking UID/boot/PID/cgroup/invocation/limits and cutoff
before stdin or importing source. It verifies the14-file private closure and
profile, consumes an exclusive remote attempt, installs only public endpoint
and workflow request files, rechecks source/profile and invokes the maintained
runner. Any uncertain outcome remains consumed on both hosts. No replay,
clock extension, automatic cleanup or reservation release is supplied.

15 new checks plus33 relevant regressions passed. The integration executes
actual owner journals, the exact transported bootstrap, protected source
imports, actual runner, preparers and all six senders. Windows, SSH, PID1 and
guest replies are mocked. Evidence is in
`ops/unified-funding-20261028/rpc-guest-workflow-delivery-tests-r1/ROOT-RESULT.md`.
The selected local Warden staging and unit have actual evidence below. The
optional remote-owner path requires its own admission. The sender provides the
workflow execution handoff missing from the two-file export transfer, while
the Warden/Windows composition below still requires live qualification before a
production attempt. No private seed or staged lifecycle executable changed.


## Original Warden startup composition

`run_startup.py` connects the original clock to guarded storage export,
Windows cut/collection/definition inputs/staging/definition/private copy/boot/
one-shot start, endpoint observation, two-file owner import and authenticated
guest workflow submission. It accepts an existing authenticated clock; it cannot
begin a replacement clock. Preparation remains inside the original900-second
window. An exclusive whole-attempt journal and fsynced phase intents precede
work; partial or ambiguous outcomes stay consumed without automatic retry.

The owner must run in the exact `enclave-rpc-startup-ATTEMPT.service` user unit:
Typeexec,256MiB,CPU1,noSwap,16tasks,NoNewPrivileges,600-second runtime and
one-second stop. Its monotonic cutoff plus3-second allowance must precede the
original deadline. Admission subtracts authenticated pending commitments and
an explicit Warden allowance of at least1280MiB for the selected local guest
owner, or1024MiB for an independently admitted remote owner, retaining27648MiB
floor. This is a per-host minimum, not whole-stack fit or a bootstrap peak bound.
The proposed19GiB guest plus1GiB support remains unmeasured; independent owners
on Warden, Windows, Control and inside the guest must all be accounted for.

Before changing Windows state, the driver validates fixed staged image names,
media pair/bounds/custody/namespace, bare observation, network and guest-owner
source/profile/connection pins. The unchanged export preparer validates original files,
credentials and runtime hashes. The driver submits one independent384MiB
export guardian with a two-second watchdog, holds its exact pidfd, and checks
PID/start/cgroup/invocation/limits and fresh watchdog acknowledgments between
phases. The guardian retains its own original deadline during blocking owner
transports. Closing the observation handle neither stops nor adopts exports.

The original definition and collected native cut evidence feed subsequent
phases directly. A pending endpoint stops before guest workflow submission. Returned
client process observations keep RPC readiness, adoption, provider settlement,
writer fencing, remote death and reservation release false. Serving checks and
explicit adoption are not implemented by this driver.

17 new cases and28 relevant regressions passed; see
`ops/unified-funding-20261028/rpc-startup-composition-tests-r1/ROOT-RESULT.md`.
Windows/native/SSH and export/Control boundaries are simulated as described
there. Those fixtures do not establish production startup. Actual local staging and
unit/route qualification are recorded below; fresh full capacity admission,
the actual owned-VM query remains required.


### Local Warden guest-key owner

The live Control read found only `authorized_keys` in its normal `.ssh`
directory. That is not a search of every possible key location. Independent
comparison found Warden's existing public login key matches the guest seed;
the private key was checked by file metadata and used normally by SSH, never
exported. The selected workflow runs beside that existing key on Warden.
No guest seed, boot image or credential rotation is needed.

`transfer_export.transfer_local(config)` accepts `clock`, `serverContract`,
`serverReady`, and `recipientRoot`. `deliver_guest_workflow.send_local(config)`
adds `exportReceipt`, `endpointReceipt`, `sourceRoot`, `sourcePins` and `profile`.
Both derive recipient UID/boot from the actual local process and original
clock; supplied recipient identities or SSH transport fields are refused.
They invoke the identical receiver bootstraps in independent local user units,
retaining all source, namespace, original-deadline and consumed-journal checks.
Local and remote modes share the same phase journal, so switching modes cannot
retry an ambiguous import or submission. Import remains64MiB/10s/1sstop;
workflow remains256MiB/240s/1sstop. Guest connections retain normal pinned SSH.

`run_startup.py` requires exactly one of `localGuestOwner` or legacy `control`.
The selected local object has `recipientRoot`, `sourceRoot`, `sourcePins`,
`profile`; the profile must match the original Warden boot and VM attempt.
It is rechecked between phases. Local admission includes an additional256MiB
workflow allowance, raising the minimum owner reserve to1280MiB. This does not
establish the proposed whole-stack memory fit.

Actual57 tests passed:19 startup,9 local handoff,15 remote handoff and14 export
transfer cases, with57 frozen pins unchanged. Real protected journals and exact
receiver code are exercised; PID1, guest and SSH responses are mocked there.
The private14-file source/profile staging was separately verified on Warden.
A real256MiB user unit then validated the staged workflow's exact envelope,
all22 runtime pins and a normal pinned SSH jump through NucBox to the existing
Control VM. Round trip was617ms, conservative clock relation bound570ms.
The exact prior Control reader was absent and its unit terminal0. The local
qualification unit also ended0/MainPID0. The workflow itself was not called;
no production clock was created. This proves neither the new RPC guest route
nor VM startup, storage attachment, client fit, sync/finality or RPC readiness.
See the public `rpc-local-workflow-tests-r1`, `rpc-local-owner-stage-r1` and
`rpc-local-owner-unit-route-r1` evidence packages under
`ops/unified-funding-20261028`.


### Actual guarded-export composition qualification

The unchanged export preparer, startup launch/lease/readiness functions and
`guarded_export.main` have now run together on Warden with the actual
authenticated resource observer and real user systemd/QEMU processes. Both
roles used temporary private credentials and sparse dummy QCOW2 originals.
Each had the required4 TB virtual geometry while only4096 application bytes
were written; no production chain volume was opened.

Both authenticated TLS exports passed reads, FUA writes, FLUSH, readback and
explicit reconnect readback. The controller preheld exact pidfds for the
384MiB guardian, its owner and both QEMU children, then froze the guardian.
The independent2-second watchdog killed all four in2.199seconds, with
`Result=watchdog`, status9, MainPID0 and an empty/removed cgroup. No fallback
kill was used. Original dummy image hashes and44 reviewed pins were unchanged.
The resource authority reported90669MiB available,718MiB pending; subtracting
1280MiB retained88671MiB, above27648MiB. This was fixture admission only.

The qualification's owner clock retained900seconds; its Windows sample was
explicitly synthetic. It did not test actual startup-deadline expiry or adopt
exports. The actual unit has no systemd runtime cutoff; the guardian owns the
original deadline and the independent watchdog handles a blocked guardian.
An abrupt watchdog stop does not prove clean guest filesystems or release
reservations. Production volumes, kernel attachment, full-size copy, VM
startup, client memory fit, sync/finality and RPC serving remain unqualified.
See `ops/unified-funding-20261028/rpc-guarded-export-composition-r1/ROOT-RESULT.md`.


The compiled Windows endpoint reader is now staged at
`C:\EnclaveRpcEndpoint-a276e5f51ff24e52bbd703015b1a98f9\a276e5f51ff24e52bbd703015b1a98f9\vm-endpoint.exe`,
84992bytes, SHA256
`8633b27be0db92b1512370e6ee533a6828678c85c6669ecb52fe8316ec4806bf`.
Fresh narrow staging admission retained the18GiB host floor,39388MiB
prospective app growth and1984MiB preparation allowance. A subsequent read
verified the exact file hash, protected administrator/SYSTEM permissions,
absence of the identified staging processes, and unchanged four existing VM
states and manager incarnations. The endpoint binary was not executed. Its
actual owned-VM query remains part of the admitted startup; staging is not VM
association, RPC readiness or production memory admission. Evidence is in
`ops/unified-funding-20261028/rpc-endpoint-target-stage-r1` and
`rpc-endpoint-target-exit-read-r1`.


The first production startup consumed its original 900-second clock, brought
both storage exports up, and completed legacy allocation fencing/pool seeding.
It stopped at VM definition before the `definition.native` journal gate. The
three exact SYSTEM workers subsequently exited; the original four VMs and
original8091 remained. No copy, boot, start or guest workflow was submitted.
The exporter was then stopped with all four preheld pidfds signalled and its
cgroup empty. Retained overlays, the consumed cut/pool and private journals
must not be replayed or discarded. This is not RPC readiness or reservation
release. See `ops/unified-funding-20261028/rpc-production-attempt-held-r1`.

That failure exposed discarded nonzero transport output. `ExchangeFailure`
now retains up to 8192 bytes per captured stream without including them in
exception text. Windows transitions save failed sampler/controller output as
base64 in exclusive, fsynced 0600 private phase journals. Failure still raises,
consumes the phase, and cannot authorize a retry or imply remote death.
Oversized output remains refused. These diagnostics must never be published;
only reviewed sanitized evidence belongs in Git. Three inert local process
cases plus 32 transition/clock cases passed. Native child stderr persistence
and the original admission failure cause remain unresolved; no native retry
was performed and no new Windows binaries were built for this change.


## Successor after a consumed pre-native definition

The October 31 original attempt completed the allocation cut and storage export,
then stopped at definition. Its clock and cut remain consumed. Export processes
were subsequently observed dead and their data/journals retained. The RPC has
not been observed serving. A successful later SYSTEM admission-only check did
not grant definition or start authority.

`run_startup.py` now accepts exactly one of `handoff` (first attempt) or
`retainedCut` (explicit successor). The retained object has three pinned owner
bindings: `clock`, `cutResult`, and `collectedCut`, referring to the original
`clock.json`, `windows-cut-seed/RESULT.json`, and
`windows-files-collect-cut/RESULT.json`. The successor has a distinct attempt,
instance and VM namespace, the same owner and Windows boots, and a new original
900-second window beginning after all three old deadlines (UTC, owner monotonic
and Windows monotonic). `startup_clock.inspect_historical` verifies immutable
begin/sample/finish lineage without authorizing work; `validate` still requires
an unexpired current clock.

The retained path rechecks original consumed requests, transport identity,
response hashes, actual collected contract/activation/completion bytes, and the
old definition command and plan. It publishes an exclusive local
`retained-cut/RESULT.json` with schema `owned-rpc-retained-cut/1`. This is a
separate evidence-adoption record, not a new native cut result. `stage-cut`,
`cut-seed` and `collect` are skipped. Original source records are rechecked
between phases, including endpoint lineage verification. Changed evidence,
boot, channel, overlapping clocks, reused identities/nonces or later original
boot/definition state remain held. Optional `successors` is a chronological,
nonempty list of pinned consumed successor clocks, with at most seven entries
after the original attempt. Every intermediate adoption request, intent, receipt
and consumed definition is verified against its exact preceding ancestry.
Missing ancestry, duplicate identities, changed commands or later phases refuse
before export. The newest guard replaces the previous guard only after these
checks; every prior worker nonce remains excluded from the new attempt.

The newly prepared admission must include the derived
`unsubmittedPredecessor` worker contract path/hash and producer hash. The
Windows definition worker recursively follows each prior plan’s hash-pinned
admission observation, holding its protected files read-only under the current
short reader deadline. It checks exact process deaths and absence of native
provider markers at every node before provider invocation, alongside its fresh completed-cut,
capacity and namespace checks. Local receipt absence does not establish remote
settlement. Adoption claims neither native predecessor verification nor capacity,
provider settlement, readiness or reservation release. Lost successor replies
remain consumed with no automatic retry.

The owner integration is tested with actual local journals, two immutable clocks,
producers and endpoint lineage. SSH/native, export, PID1 and guest boundaries are
mocked. See `ops/unified-funding-20261028/rpc-retained-cut-tests-r2/ROOT-RESULT.md`;
the first failed endpoint-integration run is also preserved. The later actual
successor 25eecdee was consumed at admission freshness, with no native definition
marker; its exact roles were observed dead and exporter cleaned. The changed
native reader subsequently passed read-only SYSTEM admission. Multiple-predecessor
composition has 116 local passing cases (native boundaries mocked). Hosted
Windows source83f6793f passed68startup and111definition checks; the full two
expired900s native chain is not proved by those fixtures. Before another production attempt,
prepare new instance-bound seed/media and owner profile/source closure, stage
qualified current binaries, and obtain fresh full admission. The old seed and
profile are tied to the consumed attempt and cannot be silently reused.
