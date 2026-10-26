# Authenticated Base chain reader

This is the callable local derivation provider for the lifecycle bridge. It owns
an Ethereum light client, authenticates the Base bootstrap and upgrade schedule,
executes the pinned native derivation verifier, and publishes the exact executed
Base header only after durable acceptance. Optional complete lease-event coverage is described in [COVERAGE.md](COVERAGE.md).
The implementation is available;
**positive live Base derivation and accepted-enclave-image qualification remain
pending**. The ordinary sequencer-signed RPC service is not upgraded by importing
this module. Production services have not been switched.

## Run and integrate

Use Linux with Node >=20.3, `/usr/bin/flock`, and `/usr/bin/prlimit` inside the
accepted domain. Package this source, its locked Node dependencies, the reviewed
native/L1 binaries, checkpoint, and complete native library closure in the
measured image. Configuration cannot add arbitrary binary/checkpoint pins.
`config.example.json` contains example paths/ports, not an installed deployment.
The state directory must be private (0700), owned by the runtime user, and backed
by the domain's authenticated persistence and clock policy. Use a protected parent
and no shared untrusted writers. Set `initializeState: true` only for explicit new
enrollment, then return it to false; missing state after a crash requires recovery.

```sh
node network/derived-reader/main.mjs /absolute/path/reader-config.json
```

The ready event means the owned L1 client is ready to prepare proofs. It does not
mean a Base anchor has been derived. Signals terminate only owned children and
release the journal lock. Restart reaps saved child identities before removing
their run directories. PID reuse or a different executable is never killed.

Programmatic lifecycle composition:

```js
import { startDerivedLifecycleReader } from './network/derived-reader/lifecycle.mjs';
const service = await startDerivedLifecycleReader(config, {
  verifier: localProofExecutingBaseVerifier,
  journal: exclusivelyOwnedLifecycleJournal,
});
// An untrusted witness producer drives service.reader.prepare/submit first.
const result = await service.snapshot(client => client.getBalance({ address }));
await service.close();
```

The state verifier must prove/execute at the exact derived Base hash. Pass the
local reader capability directly within the accepted domain. Loopback HTTP JSON
is orchestration/diagnostics only; it cannot authenticate a remote reader or
replace the attested channel. No wallet keys or signing permissions are needed.

## Witness workflow

1. Supply `prepare({ blockNumber, rollupConfigTemplate })`, or POST the same two
   keys as JSON to `/prepare`. The template is untrusted Base rollup-config JSON
   with `l2_chain_id: 8453` and the native serde-required fields. The reader
   replaces all contract-backed upgrades using the authenticated L1 schedule;
   compiled Base parameters supply the static rules. The candidate header is
   untrusted until derivation succeeds.
2. Preparation returns a random one-shot `ticket`, expiry in milliseconds, the
   exact ten `trusted` native inputs, `agreedL2BlockNumber`, and the witness byte
   cap. The authoritative copies remain private. Give the witness builder these
   exact agreed/claimed blocks, L1 head and interval. Untrusted preimage keys may
   not override local boot inputs. The native verifier checks preimages, blobs,
   derivation and execution. Witness collection runs separately on its private
   backend; this service never exposes a debug RPC or trusts the builder's result.
3. Call `submit({ ticket, witness: Buffer })`, or POST raw witness bytes with
   `Content-Type: application/octet-stream` to `/witness/<ticket>`. Native rkyv
   witness bytes or supported JSON `{preimageStore, blobData}` are accepted by the
   pinned verifier. Native exit must be zero and stdout exactly one JSON result;
   resource termination, extra stdout, malformed data or any binding mismatch
   refuses publication. There is one active operation and one outstanding ticket.
4. A `verified` submission persists before publishing. During restart recovery,
   `recovering` means verified progress below the saved floor: it grants no read
   authority. Derive the exact floor before moving beyond it. Repeated jobs must
   advance contiguously from the previous accepted root and share the configured
   sampling interval. `/status` reports verified progress and block age, never
   proof authority. `/anchor` refuses until a successful fresh local derivation;
   in-domain consumers use `readAnchor({signal})` instead.

A bootstrapped ASR root can be days old. Catch-up may require many bounded jobs;
no bootstrap, witness transport, status response, or saved journal is relabelled
as a near-current Base anchor. `readAnchor` preserves the actual Base/L1 timestamps
and rechecks the owned L1 header. The maximum Base age defaults to 1800 seconds;
stricter application policy still applies. It cannot make Ethereum finality faster.

## Bounds and recovery

Default job bounds: 1800 Base blocks, interval 1, 64 MiB witness, 1536 MiB native
address space, 180-second ticket/native lifetime. Maximum configurable witness is
128 MiB, native memory 4096 MiB, timeout one hour. The ticket lifetime includes
witness collection. Real witness size/time benchmarks must qualify these limits;
the debug native binary has no production performance claim. HTTP bodies have a
30-second transfer deadline; native stdout and RPC replies are separately bounded.

The journal has a kernel lock, atomic fsync writes, hash-linked audit entries and
Base/L1 rollback floors. Saved JSON never seeds the agreed root. Each restart
freshly authenticates ASR and re-derives before publishing. This prevents a forged
saved root from becoming authority, but does not provide external disk rollback
protection: accepted-domain recovery must retain a protected floor. Never delete
the journal or silently initialize it to bypass a contradiction.

The journal binding includes native/L1 builds, optional library builds, checkpoint
record, ASR policy and interval. Changing them requires a reviewed state migration
that preserves the floor. The pinned weak-subjectivity checkpoint expires after
seven days, including for an already-running process. Rotation requires reviewed
checkpoint bytes plus a source-pin update; no provider can select a replacement.

Optional `runtime` under `native` or `l1` is `{ "dir": "/measured/glibc", "build":
"<exact name from PINNED_GLIBC_RUNTIMES in network/rpc-runtime.mjs>" }`. All four
files are copied and digest-verified into private storage; execution uses the
pinned loader with `--inhibit-cache --library-path`. Inherited loader environment
is removed. Omission uses the image's measured system loader/libraries. Either
mode requires accepted-image dependency qualification; a host canary is not
attestation evidence.

## Validation and provenance

Run through the shared resource guard:

```sh
node --test --test-concurrency=1 test/derived-reader.test.mjs test/lifecycle-finality-bridge.test.mjs
```
 The 29 reader tests and four bridge tests cover ownership,
shutdown, expiry, replay, false results, durable restart, bounded native output,
API cancellation and direct hash-pinned lifecycle composition. Transport/native
fixtures in those tests are explicitly not consensus proofs.

`qualification.json` records the live owned-L1/schedule check and native negative
invocations. Native build/config test receipts are owned by the coordinated RPC
work. `vendor/provenance.json` records exact source digests; the only adaptation
is an import path. The frozen schedule source's config-hash label says candidate;
the native config test subsequently confirmed that same hash. Its old v1 result
validator is unused: `proof.mjs` validates the combined native v2 executed header.

Remaining integration: real positive Base witness through prepare/submit,
1/30/1800-block resource/performance runs, accepted-image closure/measurement and
restart/recovery qualification, then production lifecycle service wiring. No
unsafe-head fallback or live deployment is enabled here.
