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
SSH identity; the current deployment keeps that key on Control. Supply pinned
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
Control user-unit support, live admission, cross-host clock agreement and
transport still need qualification before the complete startup transaction.
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
The native reader still needs protected staging and qualification against the
actual owned VM during the admitted startup. The full driver and cross-host
integration remain unfinished. No guest seed or staged lifecycle image changed.
