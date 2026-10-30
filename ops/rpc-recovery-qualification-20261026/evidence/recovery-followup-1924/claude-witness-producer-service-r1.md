# Witness producer service r1: inventory, gaps, design and the FROZEN stage (source only; nothing built, tested, run or contacted) - 2026-10-26

**Scope:** producer only.
- reclaim r3 stays frozen and inactive;
- the history-cache defect (1571, `2 << 30`) belongs to integration 50 and is not touched;
- no other stage, `/tmp/w5`, or the r14 archive was edited.

## 1. Inventory: what actually exists (read from bytes and receipts, not old READMEs)
| item | where | state (evidence) |
|---|---|---|
| **native witness fetcher** `witness_fetch.rs` | `derivation-witness-stage/overlay/zk-witness/examples/` = `derivation-client-stage/combined-r1/src/zk-witness/examples/`, sha **`69812507…08`** (identical) | upstream `base-proof-zk-witness` host capture (`OPSuccinctDataFetcher` → `SuccinctHost::fetch(start, end, Some(l1Head), …, interval)` → `run`). Loopback-only URLs, refuses an existing output, writes serde JSON `{preimageStore, blobData}` atomically (`.partial` → rename) |
| **built fetcher ELF** | `derivation-client-stage/combined-r1/build/deps-43698236e9186750/target/debug/examples/witness_fetch` | **built by root** (combined-r1 run `20261026T095816Z`, Cargo.lock `f122da76` unchanged). sha **`36604b9c2c5bfd4e5633506ba5e97c78a3b81e53a052d913498135c0cae13f0c`** (`binaries.sha256`, `root-combined-elf-1035.json`); **debug** profile, 75,278,112 B, dynamically linked against glibc ≤ 2.38 |
| **native consumer** `derivation_harness_combined` | the same build, sha `f1a6bb0e…` | 9/9 tests PASS. It accepts a JSON or rkyv witness, strips the recorded Local keys and binds only the caller's trusted input. The provider runs it as `<exe> trusted.json witness`. |
| **measurement runner** | `combined-r1/runner/runner.py` `fc3ee2de…` | the **only existing caller** of `witness_fetch`. It maps `trusted` → argv as `start = agreed block, end = claimedL2BlockNumber, l1Head = trusted.l1Head, interval = trusted.intermediateBlockInterval`. Host measurement tool, not a service. `measure`/`negatives` **never run** (nodes off). |
| **private RPC bridge (transport only)** | `source/ops/rpc-witness-r14-20261026/witness-r2/bridge/witness_rpc_bridge.py` `cb976541…`, candidate SUMS `1ba2d51a…`, receipt `cd64992f…` | qualified, **not installed**. Profiles: `base-el` 127.0.0.1:**18547** → `eth_*` read + `eth_getProof`, `debug_executePayload`, `debug_getRawHeader`, `debug_dbGet`; `l1-el` 127.0.0.1:**18647** → `eth_*` read + `debug_getRawHeader`, `debug_getRawReceipts`. ≤ 2 connections, absolute deadlines, streamed ≤ 256 MiB. The L1 EL IPC needs a root-coordinated restart. |
| **other "producers"** | `base-launch-producer-stage`, r14 `candidate/producer/base_launch.py` | **not** witness producers: the M10 bootstrap launch-record producer. Nothing reusable for witnesses. |
| **driver side (consumer)** | `/tmp/w5` (composed `177184a6`; integration 50's scratch, not frozen) | `relay/derived-reader-driver-wiring.mjs` `createWitnessTransport`, detailed below |

**Request schema actually used by the integrated driver** (`/tmp/w5/relay/derived-reader-driver-wiring.mjs` lines 17, 46-73; read only):
- **The call:** `POST <policy.witness.url>` (must be `http://127.0.0.1:<port>/<path>`), `content-type: application/json`.
- **The body:** exactly `{"format":"enclave-derived-witness-request/v1","track":"final"|"provisional","trusted":{…},"agreedL2BlockNumber":<int>,"maximumWitnessBytes":<cap>}`, where `cap = min(ticket cap, policy maxBytes)`. **The one-shot ticket is never sent.**
- **The answer:** must be HTTP **200**, `content-type: application/octet-stream`, `content-length` (if present) ≤ cap, at most cap bytes, more than 0 bytes, within `timeoutMs`. Anything else is a refusal.
- **`trusted`:** the provider's frozen `buildTrustedInput` key order `chainId, l1Head, l1HeadNumber, agreedL2OutputRoot, claimedL2OutputRoot, claimedL2BlockNumber, rollupConfig, expectedRollupConfigHash, expectedScheduleId, intermediateBlockInterval`.
- **The bytes:** written verbatim to `witness` and given to the pinned native. `invokeDerivation` refuses more than `maxWitnessBytes` (default 64 MiB).

## 2. What is missing for production (the gaps)
- **G1. No producer service exists anywhere.** Only the one-shot CLI `witness_fetch` and the host measurement runner exist. **This stage adds it** (§3).
- **G2. Bridge coverage of the fetcher is unproven:**
  - **Missing endpoints:** `witness_fetch` needs four loopback endpoints, while the bridge provides two (L1 EL, Base EL). The **L1 beacon** (blob sidecars) and the **Base node** (`optimism_outputAtBlock`, `optimism_rollupConfig`, `optimism_syncStatus`, …) must be reached at their own loopback HTTP ports. Those are configured explicitly here and pinned to 127.0.0.1.
  - **Unverified method set:** nobody has verified that the upstream fetcher's method set fits the two allowlists (e.g. `debug_executePayload` vs other `debug_*`, `eth_getBlockReceipts`). A refused method makes the fetch fail closed. This is a **measured test remaining**.
- **G3. Artifact provenance for production:**
  - **Debug build:** the only built ELF is a host **debug** build (`36604b9c…`, 75 MB). r1 pins exactly it, reusing the existing artifact.
  - **Image:** a release build plus measured-image inclusion (path, sha, owner root:root 0755) is root's decision. **The guest image does not ship it today.**
- **G4. Size feasibility unmeasured:**
  - the witness size for 1 / 30 / 1800 blocks vs `invokeDerivation`'s 64 MiB default and the driver's policy cap;
  - the fetch duration vs the driver's `timeoutMs` and the 120 s provisional budget.

  Nodes are off, so **no runtime feasibility is claimed**.
- **G5. Wiring:** the driver's `policy.witness.url` must point at this service's loopback port. That is the signed driver policy (integration 50), not edited here.

## 3. Design of `witness-producer-service-stage/r1` (adapter only; no new primitives)
- **Process:** one unprivileged loopback-only process `producer/witness_producer.py` (stdlib). It reuses, **by sha-pinned compile + exec**, the r14 bridge's bounded HTTP framing (`read_request`, `reply`, `LOOPBACK`, `Refused`): admission ≤ 1 connection before reading, absolute header/body deadline, one exact Content-Length ≤ 1 MiB, POST only.
- **Request:** exact keys and format as in §1:
  - `track ∈ {final, provisional}`;
  - `trusted` with **exactly** the frozen key order, chain 8453, 0x-hex shapes, integer bounds;
  - `agreedL2BlockNumber < claimedL2BlockNumber`, `(claimed − agreed) % interval == 0`, and the range ≤ the configured `maxBlocks`;
  - `maximumWitnessBytes` ≤ the configured `maxWitnessBytes`.

  The producer **trusts nothing in it**: the native consumer re-binds every field. It is only the job description for the pinned fetcher.
- **Run:** one at a time (single flight), with a MemAvailable floor before each run (config, required), then **exactly** the existing argv mapping:
  - `witness_fetch <l1Rpc> <l1Beacon> <l2Rpc> <l2Node> <agreed> <claimed> <trusted.l1Head> <interval> <private tmp>/witness.json`;
  - under `/usr/bin/prlimit --as --cpu`, in a new session, with a hard deadline;
  - SIGKILL of the process group on timeout or client disconnect;
  - no environment except `PATH`.
- **Answer:** only after **rc 0**, with a regular output file of size `0 < n ≤ cap`. It streams those exact bytes as `application/octet-stream` with `content-length`, then deletes the file. There is **no cache and no fallback**: any failure is a non-200 status with a short reason, and **never bytes**.
- **No public RPC:**
  - the endpoints must be `http://127.0.0.1:<port>`, and the fetcher enforces this again;
  - the unit adds `IPAddressDeny=any` + `IPAddressAllow=localhost`, so even a misconfiguration cannot reach a public RPC;
  - the service never forwards RPC itself.
- **Provenance:**
  - **at startup:** the fetcher ELF sha (`36604b9c…`), the bridge module sha (`cb976541…`) and the config are checked;
  - **per run:** the ELF identity (dev/ino/size/mtime) is re-checked;
  - **per answer:** an audit line on stderr carries the request digest, witness sha256, bytes and duration (no witness content).
- **Admin controls:** an opt-in unit (not enabled), its own user, `MemoryMax`/`MemorySwapMax=0`, `NoNewPrivileges`, `ProtectSystem=strict`, `PrivateTmp`. Nothing in the existing units changes. The host **16 GiB floor** is the queue's for all root tests.

**Measured tests remaining** (root, with own nodes on; nothing here claims them):
1. the bridge allowlists vs the fetcher's actual methods (G2);
2. the beacon and node loopback reachability in the guest;
3. witness sizes and durations at 1 / 30 / 1800 blocks vs the caps;
4. end-to-end driver → producer → native harness acceptance at a real block;
5. the release build plus image pin (G3).

## 4. Frozen stage
`witness-producer-service-stage/r1/`, `SHA256SUMS` = **`1efa5c8557fad0cd409f4106cbbbb7505c3e43564b3ac9c12d711d5bf43e81c2`** (all files `a-w`).

**Checks I made:** `ast` parse (3.12 grammar), `bash -n`, `json` parse, `sha256sum -c`.
- combined-r1, derivation-witness-stage and the r14 archive still verify;
- `/tmp/w5`, reclaim r3 and every other stage are untouched.

| file | sha256 |
|---|---|
| `producer/witness_producer.py` (331 lines) | `b61a981d4cd959670ed3fc374b75c5e2ab9a1f5b539d990b313680ae906b5233` |
| `tests/test_witness_producer.py` (12 tests) | `0b6fccf2ffeb66549af2046b06e4b38d82f6ae8797bb64420f3b414b27d3b07a` |
| `jobs/tests.sh` | `a185da3bd30dc71a7c2de11c452a22afafa50fd1c3854ea6ce70da40c04a7951` |
| `systemd/enclave-witness-producer.service.template` | `fb5862d4ca3e541addb0501d42040e58ee6f027f38642aac71799b3f28c58bac` |
| `config/witness-producer.template.json` | `b6285f0384fcde10c824f485ead4c7bbe580ee0dfc7d9fe4439dc963bae9d109` |
| `README.md` | `a35b7536fdd626c554b52e2a81a01e5b5d0ee90f9edbd1a599f103c45da84483` |

**Provenance pins (code constants, not configurable):**
- fetcher ELF `36604b9c…`, from receipt `combined-r1/logs/run-20261026T095816Z-1438579/binaries.sha256` and `root-combined-elf-1035.json`;
- fetcher source `69812507…`;
- bridge module `cb976541…`, listed in r14 `witness-r2/SHA256SUMS`.

## 5. Offline tests (12; root runs; NOT run by me; no node, no network, no witness produced)
- **Fixtures:** the REAL r14 bridge module supplies the framing, and the REAL `/usr/bin/prlimit` the launcher.
- **Fetcher:** a FAKE one records its argv and env, with modes rc / oversize / empty / none / sleep. Its sha is pinned for the test only.
- **The real ELF:** it is executed offline only for its argument refusals.

1. **Bytes and argv:** served bytes are exactly the fetcher's output, as 200 `application/octet-stream` with `content-length`.
   - The argv is exactly `l1Rpc l1Beacon l2Rpc l2Node agreed claimed l1Head interval <work>/w-*/witness.json`, the existing runner mapping.
   - The env is only `PATH`; nothing is left in `workDir` (no cache).
   - The audit line carries the request sha, witness sha and bytes; a provisional request is also served.
2. **Malformed requests never reach the fetcher:** 19 body mutations each give 400, including key order, chain, hex case, bool and negative ints, range, interval alignment, the cap, invalid UTF-8 and non-objects. GET/405, no length/411, too large/413 and chunked/411 come from the bridge framing.
3. **Failed or out-of-bounds output is never served:** rc 1 with bytes, more than the cap, empty, or no output after rc 0 each give 502 with no witness bytes.
4. **Deadline:** the fetcher's process group is SIGKILLed; 504 comes back in < 10 s; no fake process survives.
5. **Client disconnect** during the fetch kills it; the log shows `served: false` and a negative rc.
6. **Single flight:** a second connection gets 503 within 2 s without being read; then a request succeeds.
7. **Memory floor:** below the floor, or MemAvailable unreadable, gives 503 and no fetch.
8. **A replaced fetcher** (same bytes, another inode) gives 500 and no fetch.
9. **Config refusals:** a public/https/path/duplicate/`localhost` endpoint, a `0.0.0.0` listen, either sha, an extra or missing key, out-of-range caps, a symlinked config (`O_NOFOLLOW`), a fake ELF under the real pin, a modified bridge module, and a 0755 `workDir`.
10. **The real pinned ELF** (`36604b9c…`, verified by sha) refuses each of these offline before any connection: usage, a public endpoint, end ≤ start, a non-multiple interval, an existing output.
11. **The pins** equal the existing receipts and source files.
12. **The unit template:** opt-in (no `WantedBy`), `User=rpcwitness`, `IPAddressDeny=any` + `IPAddressAllow=localhost`, `MemorySwapMax=0`, `NoNewPrivileges`, `ProtectSystem=strict`, `PrivateTmp`, `MemoryMax=@MEMORY_MAX@` required. The shipped config template **refuses** as is.

**Root command:**
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh witness-producer-r1 512 unshare -Urn bash witness-producer-service-stage/r1/jobs/tests.sh     # PASS: Ran 12, OK
```

## 6. Production handoff (only after the measured tests below; nothing enabled by this stage)
**Install into the measured guest image** (root, as part of the image build):
- `/opt/enclave-rpc/witness/witness_producer.py` (`b61a981d…`);
- `witness_fetch` (`36604b9c…`, or a reviewed release build, which needs a new pin and a new stage);
- `witness_rpc_bridge.py` (r14, `cb976541…`);

all root:root 0755/0644. Then:
- the user `rpcwitness`;
- the filled config `/etc/enclave-rpc/witness-producer.json` (root 0644);
- the unit with `MemoryMax` set from the measured peak.

**Wiring (integration 50):** the signed driver policy's `witness.url` = `http://127.0.0.1:<listen.port>/witness`, with `witness.maxBytes` ≤ the producer's `maxWitnessBytes` ≤ the provider's `maxWitnessBytes`/native cap.

**Order:**
1. the r14 bridges (the L1 EL IPC restart is root-coordinated);
2. the producer;
3. the driver.

## 7. Measured tests remaining (explicit; real own nodes are off, so none is claimed)
1. **Method coverage (G2):** the upstream fetcher's actual RPC methods through the two r14 bridges plus the direct beacon and node ports. Run `runner.py gate`/`measure` against the bridge ports and record every refused method.
2. **Sizes and durations** at 1 / 30 / 1800 blocks (finalized) and 1 block (provisional, interval 1), against the driver `timeoutMs`, the provisional 120 s budget, `maxWitnessBytes` and the native 64 MiB default. Set `fetchTimeoutSec`, `fetchMemoryMiB` and `MemoryMax` from the peaks.
3. **The native accepts a served witness:** `derivation_harness_combined trusted.json witness`, for a real request built by the provider; plus the existing negatives (`runner.py negatives`).
4. **End to end in the guest:** driver → producer → provider `submit`, for one finalized and one provisional run, with the journal floor advancing only from accepted results.
5. **Release build and image measurement:** pin a release ELF if adopted, check its glibc compatibility with the guest, and include it in the SNP measurement.
6. **Guest unit behaviour:** `IPAddressDeny` really blocks non-loopback; the cleanup of `StateDirectory` after kills.

## 8. Not done / limits (stated)
- **Path:** the HTTP path is not checked, because the bridge's `read_request` does not expose it. Every POST is treated as a witness request; the port is private loopback.
- **Single flight** is per process. The driver already single-flights; extra connections are refused unread.
- **Leftovers:** if the fetcher leaves unexpected files in its run dir, that dir stays (it is only `rmdir`'d when empty). No recursive delete.
- **Trust:** the producer trusts no field it receives. A wrong or hostile request can at most waste one bounded fetch; it cannot make a wrong witness accepted, because the native re-binds everything.
