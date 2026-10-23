# rpc-runtime-final-integration: RESULT

(2026-10-23, 09:40Z; times come from job logs and `date -u`.)

**Status:** composed **source**, committed, with offline process tests. This is a candidate integration for D and
root.
- Not deployed, not pushed, not merged.
- No SSH, live RPC, wallet, Wine, new toolchain, full sync, large download, or cache/storage allocation.
- Other workers' trees (A, P, S, E, F, D, root) were read only: Git objects via `format-patch`, `show` and `fetch`
  into this repo's `refs/provenance/*`, plus copies of their already-built pinned binaries.
- The baseline package `rpc-runtime-composition` (`8c8fa957`, RESULT-COMPOSE.md) is preserved unchanged.
- **This is not RPC independence:** fresh state still needs a configured, reachable proof source (§6).

## 1. Source pin (for D's Linux guest launch integration)

`rpc-runtime-final-integration/repo`, branch `runtime-final`, origin removed. Every commit is authored and committed
by SteveDeFacto.

- **HEAD `c31e975a44ef3114d4eadddb27e75956b33ccf2c`**, tree `6fbe601d8659ab12c2a649ae8c8e89cb7e497db2`.
- Base: A's final **`df8fbafae081321f3c9a9c774e41007200913f32`**.

| Commits on df8fbafa | From | What |
|---|---|---|
| `daf9e10d` … `dc8adb8e` (11) | P `witness-cache-deadline-compose/repo` `9fdc1418c..9e838ba758b96f96eb9858e35f4898a95fc5cba7` (`lineage/p/*.patch`) | proof-before-use gateway and cache, Helios E2Es through it, authenticated ancestry, real-history recording, verified block-by-hash, whole-operation deadlines and terminal close, E's S3 backend / archive tier / archived ancestry headers, and P's composition (per-request abort into S3, aggregate cacheOps, bounded background puts, cache byte budget) |
| `e6b9bf27` `a1fd9dfc` `88bdbbb9` `564cc8ae` `fb1c410b` | B `rpc-runtime-composition/repo` `1ad7c4a3e..8c8fa957` (`lineage/b/*.patch`) | bridge import (d2f9e0c blobs), the runtime, the build closure, the deadline-test race fix, A-test composition (lease-reader-verifier / helios-base-head E2Es) |
| `5296cdeb` | root `root-rpc-kernel-lock` export `336ea56a` `source-only.patch` (= `794d2ff3`'s 3 source files; root README and .gitignore excluded as instructed) | `network/runtime-lock.mjs`, `test/runtime-lock.test.mjs`, `test/lock-child.mjs` |
| `69b966f7` | new | integrate the kernel lock, final helper and optional S3 archive into the runtime (§2) |
| `c31e975a` | new | compose A's policy-verifier and windows-verifier E2Es with the proof-aware gateway (test-only, §5 F1) |

**Already in A's `df8fbafa`, so not re-applied:**
- my deadline commits: `b56a4699` / `f3443e53` = `8d110101`;
- root's verified-snapshot lifecycle `fd6a1762`, integrated by A as `25c051a9`;
- A's `e820e240` (closed client metadata methods), `71448f63`, `2efc4a83`, `437d6ced`, and the Windows consumer wiring
  `df8fbafa`.

**Lineage check** (`jobs/lineage.sh`, rc 0). Every file touched by each source range equals that source's head blob:
- P: all equal `9e838ba7`;
- B: all equal `8c8fa957`;
- lock: the 3 files equal `794d2ff3`;
- A: all equal `df8fbafa`, except `test/lease-reader-verifier-deadline.test.mjs` and
  `test/lease-reader-verifier.e2e.test.mjs`, which carry my intentional test-only commits `564cc8ae` and `fb1c410b`.

There are no source conflicts: A∩P = ∅, P∩B = ∅, and A∩B covers only those two tests.

## 2. Integration changes (`69b966f7`; runtime `network/rpc-runtime.mjs` sha256 `104532f4…`)

**1. Kernel lock (root `794d2ff3`)**
- `await takeRuntimeLock(<stateDir>/runtime.lock, { flockPath: hostTools.flock, signal })`. The release is pushed onto
  the cleanup stack immediately, before any other await.
- The unsafe PID-file `takeLock` is **deleted**, so the two protocols never run in parallel.
- `runtime.lock` is a persistent empty file and is never unlinked. A nonempty (legacy) lock is refused unchanged, with
  no PID reclaim.
- `stateDir` must be a 0700 directory owned by the runtime user.
- Tested in real processes:
  - children never inherit the descriptor: only the runtime pid holds it, and after a SIGKILL nobody does even while
    the orphaned Helios lives;
  - a second runtime on a live stateDir is refused;
  - two simultaneous cold starts give one owner;
  - a legacy lock is refused unchanged;
  - the lock file is reacquirable after shutdown.

**2. Final helper**
- `PINNED_BUILDS.witnessCheck` accepts only **`4fe0cd3b…`** (Helios `ef320298`, debug). It adds the `block` op the
  final gateway needs.
- The `aca81764` helpers `fab2f1ce` (debug) and `a3377048` (release) are no longer accepted.
- `ef320298` changes only the helper relative to `aca81764`, and the lock is unchanged. The tested Helios CLI therefore
  stays `cc962e2b` (debug).
- The listener keeps `ebd045b4` (debug) and `9ca75047` (release, tested here: §4).

**3. Config `enclave-rpc-runtime/v2`** (v1 refused)
- `witnessCache` must be `null` (§3).
- New optional `witnessArchive: {kind:'s3', endpoint, bucket, region?, prefix?, accessFile, writes?:false}`. It is
  P/E's archive tier, wired exactly as P's RESULT §4 says: `createWitnessGateway({…, archive, proofs})`.
  - It is read only after every proof source has failed, and every candidate is re-verified.
  - Writes are opt-in (privacy).
  - It is **never contacted to start**.
  - `accessFile` must be a 0600 regular file owned by the runtime user. The key reaches curl on stdin.
  - Scratch lives in `<stateDir>/tmp` (`TMPDIR` is set only while the archive client is created), at most 2 × 4 MiB,
    removed on stop.
- New `hostTools {flock, curl}`: absolute reviewed paths, preflighted (util-linux; curl with `--aws-sigv4`, only when
  an archive is configured).

**4. Close order:** gateway → archive → relay → root store (`close()`, P's terminal close) → helper. The lock
descriptor is closed last.

**5. Wording** (ROOT-PROOF-AVAILABILITY-WORDING), in status labels, the header and the doc: "no usable maintained
peer-proof source is established for this runtime (reviewed Base clients ship snap/2 serving off with no Base flag;
peer availability unknown); fresh state requires a configured, reachable proof source". P's gateway comment already
said this ("custom peers … not ruled out") and is unchanged.

**6. `rpc-runtime-main.mjs check`** now also runs the tool preflight and shows the archive, without secrets.

**7. Closure** (`scripts/rpc-runtime/closure.json` `92ff59d1…`, `build-binaries.sh` `d5bb17e8…`)
- Helios is pinned at `ef320298`, tree `eec339e1`.
- A new no-compile `check` mode.
- The `release` section records the superseded helper release.

## 3. Cache-budget binding

- **No local (NVMe) cache is enabled or allocatable by this runtime.**
- Every NVMe cache for this work must be a root-approved reservation in the ONE central budget: S's
  `enclave-rpc-nvme-cache-budget/v2` (`959e56fd`, `budget.py` `529e155f…`, report `bcd3d9ca`).
  - Ledger: `/etc/enclave-rpc-cache/nvme-cache-budget.json`.
  - Cap: 250,000,000,000 bytes aggregate, including metadata, temporary, journal and spill bytes; target
    200,000,000,000.
  - v2 reserves only **preallocated fixed-size files**. P's `dirWitnessCache(maxBytes)` is a configured share, not a
    reservation: it grows file by file and has no reviewed kind there.
- So `witnessCache` must be `null`. I did not invent a competing quota and did not touch budget v1.
- **The remote archive (S3/Sia) allocates no NVMe.**
  - Its only local bytes are request-body scratch for in-flight writes: at most 2 × 4 MiB, 0 when writes are off.
  - It lives under `<stateDir>/tmp`, which must be on the HDD durable-state disk with the rest of `stateDir`.
- Nothing was allocated in this task (actual work cache allocation: 0).
- **If root later wants a local cache:** S/root must first define and review a budget kind for it. This runtime would
  then need a reviewed change binding `witnessCache` to a named reservation and accounting its temp/spill bytes inside
  it. That is not built here.

## 4. Tests

All runs went through `claude-test-queue.py` (16 GiB floor; one large lane plus small 256) inside `unshare -r -n` with
lo up and external network asserted unreachable. Every binary was checked against its pin, and every run used this
tree.

| Job | Set | Result | Peak @cap |
|---|---|---|---|
| `u1` (08:26Z) | runtime unit 7, REAL-Base heads with helper 4fe0cd3b 1, root kernel-lock 6, bridge gossip-head-source 28 | **42/42** | 351 @512 |
| `closure-check` | `build-binaries.sh check`: Rust 1.96.0, base tarball `9784e20a`, Helios `ef320298` tree `eec339e1`, listener `5e178676` tree `00e3a61d`, listener's generated manifest, both locks unchanged, both workspaces resolve `--locked --offline` (979 / 625 packages) from the lock-derived cargo homes | **OK** | 184 @256 |
| `p-small2` | P/E composed path: witness-archive-deadline (incl. negative control on E's exact `afc443e0`), witness-deadline (incl. negative control on P's exact `7b4e8c68`), witness-blocks, ancestry, failover, gateway | **48/48** | 192 @256 |
| `a-unit` | A: lease-reader-verifier-deadline (incl. my race fix), lease-reader-verifier, lease-reader-terminal-snapshot (fd6), verified-chain; op-head-relay | **40/40** | 219 @256 |
| `e2e-2` (09:03Z, debug listener) | composed runtime E2E, 14 cases (below) | **14/14** | 914 @1408 |
| `a-e2e` (HEAD `c31e975a`) | A: lease-reader-verifier.e2e, policy-verifier.e2e (admin ban), windows-verifier.e2e, helios-base-head.e2e, on A's own Reth genesis | **23 pass, 0 fail, 1 skip** (anvil-only case on Reth) | 777 @1024 |
| `e2e-release2` (09:25Z, HEAD `c31e975a`) | the same composed E2E + REAL-Base heads with the **release** listener `9ca75047` | **15/15** | 1131 @1408 |
| `pe-e2e` (09:30Z, HEAD `c31e975a`) | E: s3-witness-cache / archive / history (real MinIO); P/E E2Es: helios-s3-replay, helios-block-failover, helios-witness-failover, helios-base-replay, helios-witness (anvil), helios-real-history | **46 pass, 0 fail, 2 skipped**: P's known skips (no recorded real proofs at the recovered real root; no stock Helios 0.12.0 binary) | 417 @1024 |
| `scan` (HEAD `c31e975a`) | `.githooks/scan-crypto-keys.py` + gitleaks 8.30.1 (repo config) over `df8fbafa..HEAD` (19 commits) | **rc 0, no leaks** | 41 @256 |

**Which bytes each run used:**
- `u1`, `p-small2`, `a-unit` and `e2e-2` ran on the working tree just before commit `69b966f7`. Nothing they
  exercised (`network/`, the runtime tests) changed between those runs and the commit; only docs, the closure manifest
  and the build script changed afterwards, and the closure check covered the build script.
- `a-e2e`, `e2e-release2`, `pe-e2e` and `scan` ran on the clean committed HEAD `c31e975a`; `e2e-release2` re-ran the
  whole composed E2E there.

**Failed or stopped runs, kept in `jobs/` and disclosed:**
- `lineage` attempts 1–2 failed:
  - the root commit has no parent;
  - root's own README and .gitignore conflicted.

  Attempt 3 used the exported `source-only.patch` as root instructed.
- `p-small`: 46/48. Both negative controls failed only because they `git show` the exact old commits, which this
  rebuilt lineage did not contain. I fetched those exact commits read-only into `refs/provenance/` (at `d0775541` and
  `afc443e0`); after that, 48/48. The test meaning is unchanged.
- `e2e-1` and `e2e-release` were **stopped by the memory guard** (exit 99), not passes:
  - `e2e-1` stopped at 1130 MiB > 1024 in the simultaneous-start case. I moved that case after the main runtime's
    shutdown and reran at 1408.
  - `e2e-release` stopped at 1036 MiB > 1024 in startup (Reth 542 MiB). I reran at 1408.

**Composed runtime E2E** (real processes: launcher = `rpc-runtime-main run` plus test options; real listener
`commitment`, helper 4fe0cd3b, Helios cc962e2b; Reth v2.8.0 with the cli-independent rig's REAL contracts; a REAL MinIO
as the Sia-S3 stand-in; the real `/usr/bin/flock`):

1. **Startup order:**
   - with every proof source down and the archive configured but **down**, there is no Helios before a verified head;
   - the order is locked → staged → head-source-started → first-head → ready;
   - the lock is held only by the runtime pid, and a second kernel owner is refused.
2. **Governance:** a block-pinned lease snapshot; host admission (owner decline/clear); catalog yank and delist; the
   admin AddressBook migration followed, and an outsider refused.
3. **Admin platform-policy ban through the runtime:**
   - an admin-signed, book-anchored denylist bans the operator;
   - an outsider cannot anchor;
   - the decision is read with `chainVerifier` = the runtime.
4. **A lying or down first source:** the second source serves, and the first is charged `failed` or `invalid`.
5. **All sources tampered or down:** fresh reads are refused, and the last verified lease stands. The state changes
   first, so new witnesses are really needed.
6. **Missed heads:**
   - authenticated ancestry binds a skipped block's root;
   - Helios's EIP-2935 path answers at a never-delivered block (on the derived 2935 genesis).
7. **Stale head:** a refusal, then status `degraded`, then recovery.
8. **Whole-operation deadline, and retained clients:**
   - a retained client is closed after success and after the deadline, for data and metadata calls;
   - a never-settling callback, and a SIGSTOPped Helios, are each bounded to under 4 s.
9. **Archive:**
   - MinIO starts after the runtime;
   - a verified witness is archived;
   - with every source down, the archive serves that block's witness, re-verified (`archiveHits`);
   - a **fresh** read is still refused;
   - with MinIO stopped too, the archived witness is refused;
   - the runtime keeps running.
10. **A second runtime on a live stateDir:** refused ("in use"); the live runtime is untouched.
11. **Crash:**
    - SIGKILL the runtime; Helios survives;
    - **no process holds the lock**;
    - a relaunch reaps the orphans and is ready on the same port.
12. **Shutdown:** SIGTERM gives exit 0, every child is gone, the port is released, the state files are removed, the
    lock file persists empty, is unheld, and is reacquired by the test.
13. **Two simultaneous cold starts:** exactly one owner reaches ready, the other is refused. A legacy JSON lock is
    refused and left byte-identical.
14. **Failed startups:** with no head in time, or the port taken, exit is 1 and the lock is released.

**Real versus synthetic:**
- The REAL-Base heads test uses recorded mainnet gossip with the real signer, with its clock pinned to the recording;
  it proves verification, not live availability.
- The composed E2E uses a **test-signed** Reth chain; it proves composition, not Base.
- P's and E's labels stand: real ancestry headers; synthetic-authority proof fixtures.

## 5. Findings

- **F1. Two more of A's E2Es conflicted with P's proof-only gateway:** `policy-verifier.e2e` and
  `windows-verifier.e2e`. They are adapted test-only exactly like `fb1c410b` (helper plus root store; the feed signs
  the real parent beacon root and pushes the head before serving it). All 23 of A's E2E cases pass.
- **F2. The runtime's own gateway is the only non-test caller.** No production code constructs a proof-less gateway.
- **F3. systemd's `StateDirectory=` defaults to 0755,** which the runtime now refuses. The doc unit sketch adds
  `StateDirectoryMode=0700`.
- **F4. The composed E2E needs about 0.9–1.1 GiB of process tree, Reth included** (Reth varied 354–542 MiB between
  runs), so it runs at 1408 MiB.

## 6. Support, tiers and gaps (honest)

**Linux x86_64 (supported as source + tested debug binaries)**
- Node ≥ 22 (tested 22.23.3), util-linux `flock` (tested 2.42.4), and `/proc`.
- With an archive, curl with `--aws-sigv4`.
- The runtime refuses non-Linux.

**Windows native: still missing**
- The flock and `/proc` supervision are Linux-only.
- No Windows builds of the listener, helper or Helios exist: the pinned 1.96.0 toolchain has only the Linux target and
  no Windows linker/SDK is installed. No Wine.
- A's `df8fbafa` wires Windows *consumers* to an explicit local verifier URL. That is a consumer side; it does not
  provide a Windows verifier.

**Tier:** heads are the sequencer-signed **UNSAFE** head. There is **no safe or finalized (L1-derived) tier**, and no
signer-rotation discovery (the pin is config).

**Resources and performance**
- The binaries are **debug builds**: Helios `cc962e2b` and helper `4fe0cd3b`; the listener is also available as
  release `9ca75047`.
- The Helios release build exceeded the 1536 MiB build allocation earlier and was not retried. No optimized-release,
  throughput or reproducibility claim is made: each release build ran once, and debug builds are not path-remapped.
- Measured runtime processes in tests: runtime node ~100–130 MiB, listener 50–90 MiB, Helios 50–60 MiB, helper
  6–12 MiB. That was on a test chain, not live Base load.

**Live availability**
- Fresh state needs a **configured, reachable proof source** (an explicit state holder); S's holder is the only
  established plan.
- The gossip head path rests on one earlier 120 s live run.
- The archive (Sia-S3) is history only, and is untested against live Sia.
- No transaction-inclusion, receipts/logs, or live Base run was done here.

**Not composed here (owned elsewhere, not blockers to this source range):**
- A's next CLI/MCP parity and S's browser RPC closure;
- F's `ROOT-RPC-CONSUMER-GATE`: directory-replica and policy-mirror roles cannot consume a single loopback verifier
  yet;
- P's L1 source package.

## 7. Minimum startup / config interface (for D)

```
node network/rpc-runtime-main.mjs check /etc/enclave/rpc-runtime.json   # validates, hashes binaries, preflights tools; exit 0/2
node network/rpc-runtime-main.mjs run   /etc/enclave/rpc-runtime.json   # JSON-line events; SIGTERM -> exit 0; failure -> exit 1
```

```json
{ "format": "enclave-rpc-runtime/v2",
  "chain": { "chainId": 8453, "unsafeSigner": "0xaf6e19be0f9ce7f8afd49a1824851023a8249e8a" },
  "binaries": { "listener": { "path": "/opt/enclave/rpc-runtime/enclave-base-head-listener", "sha256": "9ca75047ab9ee4f2c44a211b237aa5a8171af1661b17047aafaf2e9b63d10ba3" },
                "helios": { "path": "/opt/enclave/rpc-runtime/helios", "sha256": "cc962e2b97d545930a3c2051aa6e1c5b08a6c43a4b6b8021eead462ac02c07f0" },
                "witnessCheck": { "path": "/opt/enclave/rpc-runtime/witness-check", "sha256": "4fe0cd3b1a9fd28fc324cd4d58079fea3bc41836dab86cddbcf83fe9c3023411" } },
  "proofSources": { "untrusted": ["https://<state holder 1>/", "https://<state holder 2>/"] },
  "verifier": { "port": 8545 }, "stateDir": "/var/lib/enclave/rpc-runtime",
  "witnessCache": null, "witnessArchive": null,
  "hostTools": { "flock": "/usr/bin/flock", "curl": "/usr/bin/curl" } }
```

**The guest needs:**
- Node ≥ 22, `/usr/bin/flock` (util-linux), and the three pinned binaries at those digests.
- `stateDir` 0700, owned by the runtime user, on durable HDD-backed storage (not an NVMe cache).
- Outbound access to the configured proof sources and to Base gossip peers. The listener binds only 127.0.0.1 and runs
  bounded discovery.
- No inbound access.
- The verifier on `127.0.0.1:<port>`.
- A service manager with `KillMode=control-group`, `StateDirectoryMode=0700` and a `MemoryMax`. Tests measured about
  350 MiB for the runtime tree without Reth and MinIO; a 1 GiB `MemoryMax` leaves margin. Live Base load was not
  measured.
- Readiness: `ready.json`, plus `status.json` with `phase: "ready"` and `head.fresh: true`.

**Consumers:** `chainAuthority: "verifier"`, `chainVerifier: "http://127.0.0.1:<port>/"` (or
`ENCLAVE_CHAIN_AUTHORITY`/`ENCLAVE_CHAIN_VERIFIER`).

## 8. Activation and rollback (root owns them; bounded)

1. **Preconditions:**
   - Stop and retire any baseline `26fbc`/`8c8fa957` runtime first (v1 config, PID-file lock): never run both
     protocols on one stateDir.
   - A leftover nonempty `runtime.lock` is refused. Review it, then remove it with the old runtime stopped.
   - Stage the binaries and config, then run `check`.
2. **Start** under systemd. Wait for `ready.json` and a fresh `status.json` (bounded by `limits`: first head
   ≤ 180 s, Helios ready ≤ 120 s by default).
3. **Switch one consumer** to `chainAuthority: "verifier"`, restart it, and watch its reads and
   `status.json` `witnesses.gateway` / `roots`. Then the next consumer.
4. **Optional archive:** only after the central budget question is settled for any local bytes (§3), and with
   `writes: false` unless privacy-reviewed. Rollback: `witnessArchive: null` and restart.
5. **Rollback:** unset `chainAuthority` on the consumer and restart it (legacy provider quorum, unchanged), then
   SIGTERM the runtime. The lock file may remain (empty, unheld). There are no chain, wallet or admin-control effects
   either way.

## 9. Inventory

See `INVENTORY.json`: commit and tree, lineage patches with sha256, file sha256, binaries with pins, fixtures, closure
inputs, and job evidence. `refs/provenance/{p-witness-failover,e-sia-history-compose}` are read-only fetches used only
by P/E negative controls.
