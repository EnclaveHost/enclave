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
       -> witnessArchive (optional S3/Sia-S3; untrusted verified history; never contacted to start)  network/s3-witness-cache.mjs
  -> Helios enclave-base-evm  127.0.0.1:<verifier.port>  (owned child, started after the first verified head)
  -> consumers: chainAuthority 'verifier', chainVerifier http://127.0.0.1:<verifier.port>/   network/lease-reader.mjs
```

## Startup order (no race, no remote proof before a local verifier)

1. `stateDir` must be a private (0700) directory owned by the runtime user. The reviewed host tools are preflighted
   (util-linux `flock`; with an archive, a `curl` with `--aws-sigv4`).
2. A **kernel lock** (`network/runtime-lock.mjs`): the runtime opens `runtime.lock` (a persistent, empty file), and a
   short-lived `flock --exclusive --nonblock` acquires the lock on that open file description, which only the runtime
   process holds. It is released when the runtime closes it or dies; the file is never unlinked, so there is never a
   second inode or a second owner. Children never inherit the descriptor (an orphaned Helios does not hold it). A
   NONEMPTY `runtime.lock` is the earlier PID-file protocol: it is refused unchanged (stop the old runtime and review
   the migration; there is no PID-based reclaim). Then children left by an earlier run are reaped: the identities it
   recorded in `children.json`, and any process still executing a binary staged in an earlier run directory.
3. Each pinned binary is copied into a fresh 0700 run directory, hashed **there** and executed from there. A digest
   other than the config's pin, or a pin that is not a tested build (`PINNED_BUILDS`), is refused.
4. The witness-check helper answers `version` with the pinned chain id and signer. It needs no network.
5. The root store (pushed heads only), the relay, the optional archive client and the gateway start; the endpoints
   bind 127.0.0.1. No upstream and no archive is contacted.
6. The gossip head source starts the listener. Each head it verifies, natively and then in JavaScript, goes to
   `roots.offer` first and then to the relay. The relay never serves a head whose root is not bound.
7. **Only after the first fresh verified head**, Helios starts. The verifier port must be free beforehand. Readiness
   requires all three of:
   - the port's listening socket belongs to the owned Helios process (`/proc/<pid>/fd`);
   - `eth_chainId` is 8453;
   - Helios's head has reached the first verified head.
8. `ready.json` is written. `status.json` is rewritten every 2 s from step 6 on; it is present while the runtime is
   starting, ready or degraded.

The relay serves only the newest verified head, and Helios polls it, so Helios does not adopt every block as a head.
It answers a block it skipped through its EIP-2935 path: an untrusted header whose hash must equal the history
contract's slot, proven at its latest verified head. That covers the last 8191 blocks; the history contract has been on
Base since Isthmus. The gateway binds the roots of skipped blocks by authenticated ancestry (at most 256 links).

Any failure runs every registered cleanup in reverse order and the process exits 1. SIGTERM/SIGINT stops it in order
(Helios, listener, gateway, archive, relay, root store, helper, files, lock descriptor) and exits 0. A SIGKILLed runtime leaves an orphaned Helios
(its own process group); the next start reaps it (tested). Run it under a service manager with a memory limit and
`KillMode=control-group` so a crash also takes its children down.

## Configuration (`enclave-rpc-runtime/v2`)

```json
{
  "format": "enclave-rpc-runtime/v2",
  "chain": { "chainId": 8453, "unsafeSigner": "0xaf6e19be0f9ce7f8afd49a1824851023a8249e8a" },
  "binaries": {
    "listener":     { "path": "/opt/enclave/rpc-runtime/enclave-base-head-listener", "sha256": "ebd045b4…" },
    "helios":       { "path": "/opt/enclave/rpc-runtime/helios",                     "sha256": "8250f08a…" },
    "witnessCheck": { "path": "/opt/enclave/rpc-runtime/witness-check",              "sha256": "4fe0cd3b…" }
  },
  "proofSources": { "untrusted": ["https://<execution rpc 1>/", "https://<execution rpc 2>/"] },
  "verifier": { "port": 8545 },
  "stateDir": "/var/lib/enclave/rpc-runtime",
  "gossip": { "maxPeers": 20, "discovery": "bounded" },
  "witnessCache": null,
  "witnessArchive": null,
  "hostTools": { "flock": "/usr/bin/flock", "curl": "/usr/bin/curl" }
}
```

- `chain.unsafeSigner` is the administrator's pin of the sequencer key. A rotation is a config change and a restart.
  The status reports whether the pin equals Base's published default.
- `proofSources.untrusted` (1–16 entries) is required. Every entry is untrusted: the gateway verifies each pinned
  witness against a bound root and charges a source that fails. With every source down, reads of new blocks are
  refused. A URL with userinfo or a query string is refused (this config holds no credential).
- Every endpoint binds 127.0.0.1. There is no bind option. A proof source on the verifier's own port is refused.
- `witnessCache` must be `null`. A local (NVMe) witness cache would allocate disk, and every NVMe cache for this work
  must be a root-approved reservation in the ONE central budget (`enclave-rpc-nvme-cache-budget/v2` at
  `/etc/enclave-rpc-cache/nvme-cache-budget.json`: 250,000,000,000-byte hard aggregate including metadata, temporary
  and spill files; 200 GB target). Its v2 kinds reserve only preallocated fixed-size files; a growing directory cache
  has no reviewed kind, and a quota of this runtime's own would compete with the central one, so none is offered. The
  v1 config's unbudgeted `"dir"` cache is gone (v1 configs are refused).
- `witnessArchive` (optional): `{ "kind": "s3", "endpoint": "https://…", "bucket": "…", "region"?, "prefix"?,
  "accessFile": "/abs/path", "writes"?: false }`. It is the gateway's ARCHIVE tier: read only after every proof source
  failed, every candidate re-verified against a bound root, writes (verified answers only, background, bounded) off
  unless `writes: true`, since an archived proof names the state this node read. It answers history for its block, never
  a root and never freshness, and it is never contacted to start: a cold start with Sia down succeeds (tested). The
  `accessFile` is a 0600 regular file of the runtime user holding `{accessKeyId, secretAccessKey}`; the key reaches curl
  on its standard input, never argv. Local footprint: request bodies of in-flight writes only (≤ 2 × 4 MiB), in a 0700
  scratch under `<stateDir>/tmp`, removed on stop. Rollback: `null`.
- `hostTools`: reviewed absolute paths of util-linux `flock` (always) and `curl` (archive only); preflighted at start.
- `limits.firstHeadTimeoutMs` (default 180000) and `limits.heliosReadyTimeoutMs` (default 120000) bound startup.

## Build and run (Linux x86_64)

Binaries are built from `scripts/rpc-runtime/closure.json`, offline and from exact commits:

```
scripts/rpc-runtime/build-binaries.sh <new-work-dir> <helios repo with ef320298> <listener repo with 5e178676> \
    base-5476069f.tar.gz <CARGO_HOME with the locked crates> release
```

- The script exports each tree with `git archive` and checks the tree hash.
- It extracts base/base from the verified tarball into the relative path Helios names
  (`<work>/vendor-inspect/base-v1.5.1`). No unrecorded local tree is read.
- It builds `--locked --offline` with remapped paths and checks that neither Cargo.lock changed.
- A new build digest is not accepted by the runtime until it is added to `PINNED_BUILDS` together with its test
  evidence.
- Release status (`closure.json` `release`):
  - the listener release build (`9ca75047…`) exists and is tested;
  - witness-check: the accepted helper is the DEBUG build `4fe0cd3b…` of `ef320298` (it adds the `block` op the final
    gateway needs). The earlier release build `a33770482…` was of `aca81764` and is no longer accepted; no release of
    `ef320298` was built;
  - the Helios release build (fat LTO) exceeded the 1536 MiB build allocation and was stopped. Until a larger, reviewed
    allocation builds it, the tested Helios is the debug build `8250f08a…`: enclave-base-evm `eeffcc9` plus
    canonical-block.patch `41667ec9` (exact-hash and canonical-ancestry block checks), built once offline with the recorded
    debug recipe. It replaces `cc962e2b…` (`eeffcc9` without the patch), which the runtime no longer accepts. Debug builds
    are slower; no optimized, independently reproduced or reproducible-release claim is made.

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
StateDirectoryMode=0700
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

## Inside the Linux metal guest (relay mode and direct control)

A host operator opts in with a `chainVerifier` member in the host controller's `config.json`.
`metal/guest/chain-verifier.mjs` is the one checker: the launcher checks the member, then the guest checks it again.

```json
"chainVerifier": { "format": "enclave-chain-verifier/v1", "unsafeSigner": "0x<the administrator's sequencer pin>",
                   "proofSources": ["https://<explicit state holder>/"], "port": 50546,
                   "txBackend": "http://10.0.2.2:8545/" }
```

- **Fields:**
  - 1..16 https proof sources;
  - optional `gossip` / `limits`;
  - `port` in **50000..57999**. That is above every tenant-declarable port and below the ephemeral range init pins, so
    no tenant can hold it;
  - optional `txBackend`: the operator's OWN Base node, at a loopback or private address literal (never a name). It is
    used only for submission and pool/fee hints, after being bound to the verifier's chain (`ENCLAVE_CHAIN_TX_BACKEND`).
    Without it, nothing is submitted.
- **Refused fields:**
  - `witnessArchive` (the base has no curl with `--aws-sigv4`);
  - `witnessCache`;
  - anything unknown.
- **Direct control guests** take the member only inside their HOST_DATA-bound direct config (a host-level setting is
  refused). gsup's direct branch starts it before the direct supervisor, and a boot whose image lacks the runtime is
  refused.
- **The launcher** passes the checked member through fw_cfg.
- **gsup** builds the runtime config from the image's pin record (`/opt/rpc-runtime/IMAGE.json` =
  `metal/chain-verifier-image.json`). It starts the runtime as its supervised child `chain-verifier` before the
  supervisor, restarting it with backoff, and gives the supervisor exactly `ENCLAVE_CHAIN_AUTHORITY=verifier` and
  `ENCLAVE_CHAIN_VERIFIER=http://127.0.0.1:<port>/`. No other channel may supply those names.
- **Consumers:** EVERY chain read of the supervisor, and of the lease-gas and owner-nomination readers, goes through
  the verifier (`network/chain-authority.mjs`). That covers claims, leases, receipts, nonces, admission and policy, the
  admin AddressBook, settlement and prices. They refuse until the runtime is ready, and whenever no proof source can
  supply a fresh witness. Logs prove inclusion only. Path by path, with the remaining gate (payment-event completeness):
  `docs/network/supervisor-chain-authority.md`.
- **Failure states:**
  - Present but invalid, or an image without the runtime (`metal/overlay-control-image.py` without
    `--chain-verifier-dir`): the supervisor gets the verifier authority at a URL nothing serves, so verified reads
    refuse. They never fall back to the provider quorum.
  - Absent: nothing changes.
- **Staging is `copy`:** the base image is owned by uid 1000, so verify-in-place cannot hold. Helios and the helper run
  through the pinned glibc runtime, because the base has glibc 2.36.
- **RAM:** an image with the runtime carries ~234 MB of native files in its ramfs, and a running verifier holds a second
  ~234 MB copy on the `/mnt/ramdisk` tmpfs.

Rollback: remove `chainVerifier` and relaunch the guest.

## What it does not do

- **Finality:** heads are the sequencer-signed **unsafe** head. There is no L1-derived safe or finalized tier.
- **Provider independence:** fresh reads need at least one configured, reachable proof source (an explicit state
  holder). No usable maintained peer-proof source is established for this runtime: the reviewed Base clients implement
  snap/2 serving but ship it off with no Base flag, and whether any peer serves proofs is unknown (not ruled out).
  Failover among sources is not independence from them.
- **Live availability from the archive:** archived witnesses and ancestor roots answer history for their block only.
- **Public serving:** nothing is advertised, granted or exposed. It is not a host-service role. Those roles are
  public, and they are gated by the platform host policy, whose own chain reads may come to depend on this verifier.
- **Windows:** the supervision uses `/proc` (Linux) and the runtime refuses to start elsewhere. The Windows reader
  needs Windows builds of the three binaries plus Job-object supervision. The Windows host's supervisor
  (`network/host-services/windows-supervisor`) is the existing place for that. Neither has been built or tested.
