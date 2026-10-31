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

The 20 transition/producer tests use real exclusive owner journals and simulated
SSH/native replies; the 10 clock transport regressions also pass. No production
phase has been submitted through this sender. Complete operational integration
still needs authenticated collection/staging of the actual cut evidence and
produced definition inputs, protected media copy into the defined VM root, and
the coordinated exporter/guest activation/runtime path. Do not cut the allocator
or consume the production clock until that complete workflow is ready. Existing
NucBox clock qualification is separate from these simulated transport tests.
