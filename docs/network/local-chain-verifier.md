# Local chain verifier runtime (Base)

`network/rpc-runtime.mjs` is one supervised process that gives a host a **local, verifying Base endpoint** for its
chain readers. It replaces trust in provider answers with proofs, for the readers that opt in. It does **not** remove
the need for an upstream source of fresh state witnesses (see [What it does not do](#what-it-does-not-do)).

```
gossip listener (native, owned child)
  -> native `commitment` mode + op-head-relay verifyCommitment          network/gossip-head-source.mjs
  -> root store .offer(head)   (witness-check helper, owned child)      network/witness-verify.mjs
  -> head relay       127.0.0.1:ephemeral   (Helios --consensus-rpc)    network/op-head-relay.mjs
  -> witness gateway  127.0.0.1:ephemeral   (Helios --execution-rpc)    network/witness-gateway.mjs
       -> proofSources.untrusted[]  (explicit config; every pinned witness verified before use)
  -> Helios enclave-base-evm  127.0.0.1:<verifier.port>  (owned child, started after the first verified head)
  -> consumers: chainAuthority 'verifier', chainVerifier http://127.0.0.1:<verifier.port>/   network/lease-reader.mjs
```

## Startup order (no race, no remote proof before a local verifier)

1. A lock on `stateDir` (bound to pid and `/proc` start time). Then children left by an earlier run are reaped: the
   identities it recorded in `children.json`, and any process still executing a binary staged in an earlier run
   directory.
2. Each pinned binary is copied into a fresh 0700 run directory, hashed **there** and executed from there. A digest
   other than the config's pin, or a pin that is not a tested build (`PINNED_BUILDS`), is refused.
3. The witness-check helper answers `version` with the pinned chain id and signer. It needs no network.
4. The root store (pushed heads only), the relay and the gateway start on 127.0.0.1. No upstream is contacted.
5. The gossip head source starts the listener. Each head it verifies, natively and then in JavaScript, goes to
   `roots.offer` first and then to the relay. The relay never serves a head whose root is not bound.
6. **Only after the first fresh verified head**, Helios starts. The verifier port must be free beforehand. Readiness
   requires all three of:
   - the port's listening socket belongs to the owned Helios process (`/proc/<pid>/fd`);
   - `eth_chainId` is 8453;
   - Helios's head has reached the first verified head.
7. `ready.json` is written. `status.json` is rewritten every 2 s from step 5 on; it is present while the runtime is
   starting, ready or degraded.

The relay serves only the newest verified head, and Helios polls it, so Helios does not adopt every block as a head.
It answers a block it skipped through its EIP-2935 path: an untrusted header whose hash must equal the history
contract's slot, proven at its latest verified head. That covers the last 8191 blocks; the history contract has been on
Base since Isthmus. The gateway binds the roots of skipped blocks by authenticated ancestry (at most 256 links).

Any failure runs every registered cleanup in reverse order and the process exits 1. SIGTERM/SIGINT stops it in order
(Helios, listener, gateway, relay, helper, files, lock) and exits 0. A SIGKILLed runtime leaves an orphaned Helios
(its own process group); the next start reaps it (tested). Run it under a service manager with a memory limit and
`KillMode=control-group` so a crash also takes its children down.

## Configuration (`enclave-rpc-runtime/v1`)

```json
{
  "format": "enclave-rpc-runtime/v1",
  "chain": { "chainId": 8453, "unsafeSigner": "0xaf6e19be0f9ce7f8afd49a1824851023a8249e8a" },
  "binaries": {
    "listener":     { "path": "/opt/enclave/rpc-runtime/enclave-base-head-listener", "sha256": "ebd045b4…" },
    "helios":       { "path": "/opt/enclave/rpc-runtime/helios",                     "sha256": "cc962e2b…" },
    "witnessCheck": { "path": "/opt/enclave/rpc-runtime/witness-check",              "sha256": "fab2f1ce…" }
  },
  "proofSources": { "untrusted": ["https://<execution rpc 1>/", "https://<execution rpc 2>/"] },
  "verifier": { "port": 8545 },
  "stateDir": "/var/lib/enclave/rpc-runtime",
  "gossip": { "maxPeers": 20, "discovery": "bounded" },
  "witnessCache": null
}
```

- `chain.unsafeSigner` is the administrator's pin of the sequencer key. A rotation is a config change and a restart.
  The status reports whether the pin equals Base's published default.
- `proofSources.untrusted` (1–16 entries) is required. Every entry is untrusted: the gateway verifies each pinned
  witness against a bound root and charges a source that fails. With every source down, reads of new blocks are
  refused. A URL with userinfo or a query string is refused (this config holds no credential).
- Every endpoint binds 127.0.0.1. There is no bind option. A proof source on the verifier's own port is refused.
- `witnessCache`: `null` (default) or `{ "kind": "dir", "path": "/abs" }` outside `stateDir`. The cache holds history
  for its own block only; it is not live availability. Other caches (the Sia/S3 archive) are not part of this
  composition yet. They would plug into the same `{put, candidates}` interface without becoming a startup dependency.
  Setting `null` again is the rollback.
- `limits.firstHeadTimeoutMs` (default 180000) and `limits.heliosReadyTimeoutMs` (default 120000) bound startup.

## Build and run (Linux x86_64)

Binaries are built from `scripts/rpc-runtime/closure.json`, offline and from exact commits:

```
scripts/rpc-runtime/build-binaries.sh <new-work-dir> <helios repo with aca81764> <listener repo with 5e178676> \
    base-5476069f.tar.gz <CARGO_HOME with the locked crates> release
```

- The script exports each tree with `git archive` and checks the tree hash.
- It extracts base/base from the verified tarball into the relative path Helios names
  (`<work>/vendor-inspect/base-v1.5.1`). No unrecorded local tree is read.
- It builds `--locked --offline` with remapped paths and checks that neither Cargo.lock changed.
- A new build digest is not accepted by the runtime until it is added to `PINNED_BUILDS` together with its test
  evidence.
- Release status (`closure.json` `release`):
  - the listener (`9ca75047…`) and witness-check (`a33770482…`) release builds exist;
  - the Helios release build (fat LTO) exceeded the 1536 MiB build allocation and was stopped. Until a larger, reviewed
    allocation builds it, the tested Helios is the debug build `cc962e2b…`.

```
node network/rpc-runtime-main.mjs check /etc/enclave/rpc-runtime.json   # validate + hash every binary, print the plan
node network/rpc-runtime-main.mjs run   /etc/enclave/rpc-runtime.json   # JSON-line events on stdout
```

A systemd unit sketch (the host's own manager bounds memory and reaps the whole cgroup):

```
[Service]
ExecStart=/usr/bin/node /opt/enclave/network/rpc-runtime-main.mjs run /etc/enclave/rpc-runtime.json
Restart=on-failure
RestartSec=5
KillMode=control-group
TimeoutStopSec=30
MemoryMax=1536M
StateDirectory=enclave/rpc-runtime
```

Consumers opt in per process with `chainAuthority: "verifier"` and `chainVerifier: "http://127.0.0.1:8545/"`, or
with `ENCLAVE_CHAIN_AUTHORITY=verifier` and `ENCLAVE_CHAIN_VERIFIER=...`. The consumers are directory-server,
host-admission-runtime, management-host and wg-provider (`chainAuthorityOptions`).

## Activation and rollback

1. Stage the binaries and config. Run `check`.
2. Start the runtime. Wait for `ready.json`, and for `status.json` `phase: "ready"` with `head.fresh: true`.
3. Switch one consumer at a time to `chainAuthority: "verifier"`, then restart it.
4. Watch that consumer's reads, and the runtime's status `witnesses.gateway` (sources charged, refused requests) and
   `roots`.

To roll back, unset `chainAuthority` (or `ENCLAVE_CHAIN_AUTHORITY`) on the consumer and restart it. That returns it to
the legacy provider quorum, unchanged. Then stop the runtime. The runtime never falls back to provider agreement by
itself.

## What it does not do

- **Finality:** heads are the sequencer-signed **unsafe** head. There is no L1-derived safe or finalized tier.
- **Provider independence:** fresh reads need at least one available upstream proof source. Base has no P2P witness
  transport today. Failover among sources is not independence from them.
- **Live availability from cache:** cached witnesses and ancestor roots answer history for their block only.
- **Public serving:** nothing is advertised, granted or exposed. It is not a host-service role. Those roles are
  public, and they are gated by the platform host policy, whose own chain reads may come to depend on this verifier.
- **Windows:** the supervision uses `/proc` (Linux) and the runtime refuses to start elsewhere. The Windows reader
  needs Windows builds of the three binaries plus Job-object supervision. The Windows host's supervisor
  (`network/host-services/windows-supervisor`) is the existing place for that. Neither has been built or tested.
