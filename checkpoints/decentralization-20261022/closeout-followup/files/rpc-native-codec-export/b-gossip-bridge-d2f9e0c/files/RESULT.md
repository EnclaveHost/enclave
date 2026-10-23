# rpc-gossip-bridge — RESULT, revision 2 (written 2026-10-23 ~02:25Z, observed tool clock)

Revision 1 (committed 01:57:52Z, `5ec1be4`) wrongly labelled itself "~02:20Z". Every time below comes from job files
or git.

**Status: source plus offline tests only.** Nothing deployed, no live P2P probe, no production action, SSH,
transactions, keys or chain sync. Worker A's trees (`rpc-priority/repo`, `rpc-priority/helios-patched`) and the
frozen listener `f3159ea` are untouched.

## What changed in revision 2 (root review)

* **Handwritten codec removed from the trust path.** `network/snappy-raw.mjs` and its tests are deleted (`57e4fd8`).
  No JavaScript decodes objects any more. Revision 1's claims about a "self-written codec defended in depth" are
  withdrawn.
* **New native listener mode.** The isolated tree `rpc-gossip-bridge/listener`, branch `commitment-mode` (from
  `f3159ea`, at `5e17867`), adds `commitment`. It runs the maintained `verify_object` first and only then emits the
  exact signed commitment bytes (details below). The binary is
  `ebd045b428227530fac1c1b079f47c67ecb874637a1c7dcb4f021dd5929e8d3a`, built from `a0c7c4e`; `5e17867` only adds
  documentation.
* **Disk bound restated truthfully, and the paths that broke it are fixed.** Revision 1 said disk use was bounded by
  in-flight objects, which was **incorrect**: objects of records dropped on a full queue, or before the start record,
  were never deleted. Both paths now delete. Crashed-run leftovers are swept at start. The real bound is stated below.
* **Archive hook fully bounded:** count, bytes, per-call timeout and outstanding calls.

## Native `commitment` mode (listener `a0c7c4e`)

`enclave-base-head-listener commitment --signer <pin> --file <obj> [--max-data-bytes N]`. The default N is 4 MiB,
equal to A's relay `MAX_DATA`; the ceiling is 10 MiB − 65.

1. **Input bound before reading:** the file must be ≤ 10 MiB (base `MAX_GOSSIP_SIZE`) by size, and at most that
   many bytes are read (`read_object_bounded`).
2. **Decompressed bound before allocation:** `snap::raw::decompress_len` (maintained, parses only the preamble) must
   be within `97 ..= 65 + N`.
3. **Maintained verification:** `verify_object`, which is base/base's `decode_v4` plus signer recovery over the
   chain-8453 domain plus recomputed block hash. **Nothing is emitted unless this passes.**
4. **Exact bytes:** the same object is decompressed with the maintained `snap::raw::Decoder` into a buffer of exactly
   the declared length. `data` = bytes 65… (parentBeaconRoot ‖ SSZ payload), byte for byte as signed. Nothing is
   reconstructed or re-encoded.
5. **Binding:** keccak256(data) must equal the verified envelope's `payload_hash`, which is the hash the signature
   was checked over. The raw r and s must equal the verified signature. `yParity` comes from the verified signature.
6. **Output:** one JSON line (`enclave-base-signed-commitment/v1`, `ok:true`) carrying verified metadata (number,
   hash, parentHash, stateRoot, timestamp, chainId, signer, objectSha256 of the bytes read, dataKeccak256, dataBytes)
   and `commitment {data, signature{r, s, yParity}}`. stdout is at most 2N + about 1 KiB, accounting for hex
   expansion. On failure: `ok:false` and an error, exit 1, no commitment.

**Native tests** (`tests/commitment.rs`, job `listener/jobs/c1`, 2026-10-23T02:02:39–02:05:37Z, queue 1536, peak
743 MiB, **7/7 pass**). Only the new test target ran; the unchanged listener suites were not repeated.
* 3 real captured Base objects (52965074–52965076):
  * metadata equals the captured head records;
  * keccak(data) equals dataKeccak256;
  * the emitted r/s/parity recover `0xaf6e…9e8a` over Base's 8453 domain via maintained `PayloadHash`, and do not
    recover it over 84532;
  * data length = declared − 65.
* Wrong pin refused; Sepolia rollup config refused.
* Truncations at 6 cut points, a signature-byte flip and non-snappy input all refused.
* A 20 MiB declared preamble is refused as `DeclaredLength` before decoding; a real object one byte over a smaller
  cap is refused and passes at the exact cap.
* The middle-byte re-encoding of 52965076 yields an **identical** commitment (the revision-1 r3 finding, now proven
  natively).
* A sparse 10 MiB + 1 file is refused unread.
* CLI checks through the real built binary:
  * exactly one line, within 2 × dataBytes + 1 KiB;
  * wrong pin gives exit 1 and no `commitment` field;
  * a cap that is too small gives exit 1;
  * a `--max-data-bytes` above the ceiling gives exit 1;
  * a missing file gives exit 1.

**Lock:** one added line (`"snap"` in this crate's dependency list). `tools/lock-diff.py` still reports all 625
packages identical to base/base `5476069f`'s lock. Lock sha256 `5ad182d7…`. No new toolchain: rust 1.96.0 and the
existing registry cache were reused; this new tree built its own target directory.

## Bridge `network/gossip-head-source.mjs` (bridge `d767f80`, file sha256 `150a06f8…`)

Each head must pass every check below, or it is dropped and counted:
1. The start record has the pinned chain, admin-pinned signer, schema, base/base commit and encoding.
2. The head record has unsafe/none labels, pinned chain and signer, v4, well-formed hashes, `objectBytes` ≤ 10 MiB,
   and was stamped after this session started.
3. The object file exists with the recorded size.
4. **Native `commitment`** (above), run with a 10 s timeout and `maxBuffer` 2 × maxDataBytes + 64 KiB. Every metadata
   field, including the native sha256 of the bytes it read, must equal the record.
5. **A's `verifyCommitment`** (viem `recoverAddress`) independently recovers the pinned signer over the exact emitted
   data for the pinned chain, and the payload head fields must equal the record. A test forges one byte of the real
   native output, and this check refuses it.
6. Freshness from the signed block timestamp (≤ `maxHeadAgeMs`, ≤ 5 s ahead), checked before and after the native
   call.
7. Only then `onCommitment` is called (typically `relay.offer`, which runs its own signature, freshness, equivocation
   and transaction-type checks).

### Exact restart and stale-head behaviour

* **This source:**
  * A new session gets a new empty object directory and refuses any record stamped before it started, so nothing
    from an earlier session is re-read or re-delivered.
  * `status().head` keeps the last delivered head. `status().fresh` is true only while that head's signed timestamp
    is within `maxHeadAgeMs` **and** it was delivered less than `staleAfterMs` ago.
  * A restart never extends either window.
* **The relay** (A's `op-head-relay.mjs`, unchanged):
  * It keeps its highest verified head across source restarts. `latest()` serves it only while its signed timestamp
    is within the relay's `maxAgeMs` and not more than 5 s ahead, and only if that height is not equivocated.
  * A head delivered just before a restart can therefore still be served until it ages out, at most `maxAgeMs` after
    its block timestamp.
  * After that, the relay serves `null` until a newer verified head arrives (fail closed).

### Bounds

* **Owned child:** detached process group, with pid, pgid and start time recorded. The binary's sha256 is checked
  before **every** spawn. Only identity-matching processes are signalled. Stop is SIGTERM, then SIGKILL after 5 s,
  then a sweep of the group.
* **Buffers:** stdout line ≤ 16 KiB, stderr tail 16 KiB, at most 32 queued heads.
* **Disk (truthful):**
  * Everything is under `workDir/sessions/<session>/`, and only one session exists at a time.
  * Its object files are written by the listener under its own `--max-output-bytes` budget (default 64 MiB; it covers
    objects and records).
  * Objects are deleted after processing **and** when their record is dropped (queue full, before the start record,
    or any validation failure).
  * Files whose record line never arrived or could not be parsed (for example, the listener died between writing and
    printing) remain until
    the session ends, when the whole directory is removed.
  * Session directories marked `OWNER` that a crashed earlier run left behind are removed at start; unmarked
    directories are left alone.
  * **Upper bound: one session's `maxOutputBytes` plus a few KiB.** `workDir` must be dedicated to one source
    instance.
* **Archive (optional):**
  * at most 16 entries and 32 MiB queued;
  * each call is abandoned after `archiveTimeoutMs` (default 60 s);
  * once 2 abandoned calls are still pending, new entries are dropped;
  * worst-case retained memory is about 32 MiB plus 2 entries (each ≤ one object plus its commitment data);
  * never awaited by the serving path;
  * the archive copy is re-read bounded and must match the natively verified sha256, otherwise it is skipped.

## Bridge tests (terminal results)

All bridge runs went through `jobs/run-q.sh`: `claude-test-queue.py --mib 768` with the 16 GiB floor, inside
`unshare -r -n` with `lo` up. External network is asserted unreachable, and the pinned binary's sha256 is checked
first.

| Run | Finished (UTC) | Result | Peak | Note |
|---|---|---|---|---|
| r1–r6 | 01:52:34–01:56:45 | revision 1 (JS decoder); r6 29/29 | 285 MiB | superseded |
| r7 | 02:14:50 | 19/28, rc 1 | 336 MiB | Test stand-in bug: it delegated the ~218 KB native output and then called `process.exit()`, truncating the pipe after 64 KiB. Fail-closed as `native-output`. Diagnosed with a queued 256 MiB check. |
| **r8** | **02:24:09** | **28/28, rc 0, 12.5 s** | **357 MiB** | final |

The 28 tests:
* offline guard; pinned-binary digest;
* 3 real Base heads through native mode, verifier and relay (newest served, unsafe/none labels, objects deleted after
  processing);
* stale and later-stale heads;
* 5 start-record mismatches; 8 record mismatches (including stateRoot disagreeing with native → `native-mismatch`);
* corrupt (signature flip), truncated, missing, size-mismatched and digest-mismatched objects;
* content-identical re-encoding equals the real native reference output;
* genuine object under a wrong pin (native refusal);
* restart replay cannot refresh a head;
* SIGKILL with restart;
* group kill including a grandchild;
* identity-mismatch refusal; line flood; silent-listener restart; binary digest mismatch;
* stuck archive never delays serving;
* **forged native output caught by the relay verifier**;
* **oversized commitment refused natively** (`maxDataBytes` 1024);
* **dropped-record objects deleted** (pre-start head; a 40-record flood with queue overflow; the objects directory
  ends empty);
* **crashed-run session sweep** (marked directory removed, foreign directory kept);
* **hung archive bounded** (≤ 2 calls, the rest dropped);
* real listener offline lifecycle (start record accepted, 0 heads, exit 3, restart scheduled).

## Merge and integration instructions (for root and A, after A's current work is terminal)

1. **Listener:** take `rpc-gossip-bridge/listener` branch `commitment-mode` (`5e17867`; code `a0c7c4e`) as the
   listener source. Build with `tools/prepare-upstream.py <base-5476069f tarball, sha256 9784e20a…>` and then
   `build-commitment.sh` (queue 1536). Require binary sha256 `ebd045b4…` (`TESTED_LISTENER_SHA256` in the adapter).
   `listen` behaviour is unchanged from the live-run build `f3159ea` (`8ef3d51d…`).
2. **Into `rpc-priority/repo`** (new files only):
   * `network/gossip-head-source.mjs`
   * `test/gossip-head-source.test.mjs`
   * `test/fixtures/fake-listener.mjs` (executable)
   * `test/fixtures/listener-start-record.json`
   * `test/fixtures/base-mainnet-5296507{4,5,6}.{head.json,v4.snappy.hex}`

   Do **not** copy `network/op-head-relay.mjs` or `network/rpc-identity.mjs`: they are byte-identical references of
   A's `97785a40c` (sha256 `ed71c069…` and `74cb965e…`). `snappy-raw.mjs` no longer exists. There is no new npm
   dependency; viem 2.53.1 is reached only through A's relay.
3. Point `REAL` in the test at the in-repo binary path. Run the tests as `jobs/bridge-tests.sh` does: `unshare -r -n`,
   `lo` up, `node --test --test-force-exit --test-concurrency=1 --test-timeout=300000 test/gossip-head-source.test.mjs`.
   Queue at 768.
4. **Wiring** (no hosted URL; administrator-pinned signer from config, never from peers):
   ```js
   const relay = createHeadRelay({ sources: [], chainId: 8453, signer: adminPinnedSigner, maxAgeMs: 60000 });
   const consensusRpc = await relay.listen(0);   // 127.0.0.1 only -> Helios --consensus-rpc
   const gossip = createGossipHeadSource({ listenerPath, listenerSha256: TESTED_LISTENER_SHA256, chainId: 8453,
     signer: adminPinnedSigner, workDir /* dedicated, allowed storage */, onCommitment: (c) => relay.offer(c, 'native-gossip') });
   await gossip.start();
   ```

## Limits and uncertainty

* **Availability:** availability is the listener's. One 120 s live run gave a v4 mesh of at most 1 peer, and all 5
  published bootnodes failed from this site. Longer-term availability is unmeasured.
* **Restart gap:** each restart is a new ephemeral identity and needs about 10–20 s to rediscover peers; the relay
  then serves nothing once the last head ages out. Repeated-restart behaviour is unmeasured.
* **Denim (2026-11-05, 200 ms blocks) is unproven:**
  * one native spawn per head;
  * a full queue drops the newest heads (their objects are deleted);
  * the listener's 64 MiB `--max-output-bytes` would end a session after about 200 s at about 325 KB/s (an estimate),
    which triggers a restart.
* **Archive keying:** the compressed object's sha256 is not a unique block id (identical commitments come from
  different encodings), so archives should key by block hash or `dataKeccak256`.
* **Scope:** unsafe tier only, so no finality and no state. The signer is an admin pin; L1 rotation tracking is not
  implemented.
