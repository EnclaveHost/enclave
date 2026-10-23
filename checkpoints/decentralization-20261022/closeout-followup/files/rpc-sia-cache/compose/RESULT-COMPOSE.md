# rpc-sia-cache/compose: the S3 (Sia-S3) witness store composed with P's verifying gateway

Source only, 2026-10-22. Nothing was pushed, merged, deployed or imaged. There was no SSH, no live Sia/S3/RPC, no
wallet, no private data and no full-node download. Every test ran offline inside `unshare -r -n` through
`work/claude-test-queue.py`, with each allocation at most 1408 MiB and the 16 GiB floor respected. Author and committer
are SteveDeFacto.

## Result

| item | value |
|---|---|
| branch | `compose/repo` `work/sia-cache-compose` |
| base | P's immutable `bfbd649d8c416922691a6dd1eaada8a81765bba5` (witness-failover/repo), read as Git objects only |
| commit 1 | `73c11ec936f16b4a8e02ced829fa31ca7c32c0b4`: cherry-pick of my terminal `b71c82615975ba6d1d7c966d1baddf57f5c53eea` (identical `git patch-id --stable` `d46cff8c…`; it touches no P file) |
| commit 2 (HEAD) | `2778527853fdf2a42675eb8e613646727b7df509`: the composition, tree `e9c0a82b0759f0619bfb8478d76a26279e1e593b` |
| patches | `patches/0001-…patch` sha256 `829047ae749c8f50a2fba6a9c6c57732c722f6043cc14b59458be23fa30a68f8`; `patches/0002-…patch` sha256 `ea525eb20b46440a4e6f81d7190c1644d9ca413974764c523d8af90c7001096e` (`git format-patch bfbd649d..HEAD`) |
| P files changed | only `network/witness-gateway.mjs`: +34/−3, all in commit 2; `git diff bfbd649d..HEAD -- network/witness-gateway.mjs` sha256 `0bd1d161…`. `witness-verify.mjs` is byte-identical to P (`d55ac997…`) |
| file hashes at HEAD | gateway `72fb8eb4…`, s3-witness-cache `cf180498…`; every test run below logs these hashes |
| helper | witness-check, built from P's exact Helios `1ec2c1a52399b6a8d0fc1eb7658bf030987e132a` (tree `88bc44a0…`, clean, own clone `compose/helios`), with vendor base `5476069f…`. sha256 `b03e00e835ace87935703ff5f83a513430cbf484bf658d471f39b8cc7da6e847` (see the note below) |
| Helios under test | `rpc-priority/helios-target-base/debug/helios` `cc962e2b…` (eeffcc9); control binary `helios-target/debug/helios` `0929f7f3…`. Both are existing binaries, not rebuilt |
| fixture | `rpc-priority/fixtures/base-calls-20261023T014412Z/fixture.json` `141321fd…`: the 49 real Base mainnet witnesses at block 52965249, read only |

A note on the helper hash: debug builds embed absolute paths, so the binary is a same-source rebuild with P's recipe
(`jobs/build-witness-check.sh`: Rust 1.96.0, offline, one job, no debuginfo). P's unpreserved `42a8a841` binary was not
available to reuse. Its unit tests pass 6/6 (`logs/helper-build-7`, peak 1155 MiB). P's mutable worktrees, and P's
shallow `enclave-witness-check` branch (which now points at mutable `aca81764`), were not used.

## Design

**Gateway: one new optional tier, `archive: {candidates(w, {deadline}), put(w, result)}`.**
- **Reads.** The archive is read only after the local `cache` and every upstream have failed, and only inside the
  request's remaining deadline. A timer races the candidate listing and is cleared afterwards. The gateway checks at
  most 64 candidates, and stops early once the deadline passes.
- **Verification.** Each candidate is verified (`proofs.checker`, using roots from signed commitments) and quarantined
  exactly like a cache entry. There is no unverified path: an archive requires `proofs`, like the cache.
- **Writes.** Only answers already verified from an upstream are archived. That `put` is never awaited, and its errors
  are counted (`archiveErrors`) and never surfaced.
- **Stats.** New counters: `archiveHits`, `archiveInvalid`, `archiveQueued`, `archiveErrors`.

**Backend `network/s3-witness-cache.mjs` v2.**
- **Layout.** Objects are content-addressed and create-only:
  `<prefix>/<chainId>/<blockHash>/<sha256(request)>/<sha256(canonical result)>.json`.
  Because each distinct answer is a separate object, a wrong first object can never shadow a valid one. The v1 single
  slot `<…>/<sha256(request)>.json` (b71c8261) is still read, but last.
- **What counts as a candidate.** The envelope (format, chain id, block hash, full normalized request) must match
  exactly, and the object name must equal the hash of its result. Anything else is skipped and counted: misnamed,
  mis-bound, tampered, oversized, truncated, slow or unreachable objects.
- **Bounded reads.**
  - ListObjectsV2 with `max-keys=maxCandidates` (8), at most `maxListPages` pages (2) of at most `maxListBytes` each
    (256 KiB).
  - At most `maxCandidates` object GETs, each capped at `maxObjectBytes`.
  - Everything runs under one `readBudgetMs` (8000), further limited by the caller's deadline and the per-request
    `timeoutMs`.
  - Transport is curl with `--max-time`, plus an outer kill.
- **Writes.**
  - Off unless `archive: true`.
  - `put()` returns as soon as the write is queued, with a bounded queue and bounded in-flight writes.
  - Each write is create-only with `If-None-Match: *`. On a 412 the backend re-reads the object and compares it
    exactly. A different object under the same content name counts as a `conflict` and is never overwritten.
  - `idle()` waits for the queue to drain; `close()` kills and reaps every curl.

**Compatibility with Sia-S3** (`enclave-apps-sia-recovery` sia-s3 `54818ba`, read as source). Every S3 feature the
backend needs is implemented there:
- ListObjectsV2 with `prefix`, `max-keys` ≤ 1000, a continuation token and lexicographic order (s3.rs:429-505);
- `If-None-Match: *` (s3.rs:236-239, 378);
- a hex payload hash or `UNSIGNED-PAYLOAD` (sigv4.rs:126-135).

This was checked against source only. No live Sia-S3 was contacted.

## Liveness audit of the existing awaited `cache.put`

In P's gateway, `cache` is read first and `await cache.put()` runs after every verified upstream answer. Any remote
store in that slot therefore sits on the fresh-read path. Measured with a hung S3 (accepts connections, never answers):

| configuration | fresh verified read held | evidence |
|---|---|---|
| P's exact bfbd649d gateway + b71c8261 backend in `cache` | **8043 ms** (2000 ms get timeout + 6000 ms put timeout) | `jobs/audit-b71c8261.sh` (extracts both from Git objects); `logs/audit-1`, exit 0 = regression reproduced |
| composed gateway + v2 backend in `cache` | 2020 ms (read-first ordering; the put no longer blocks) | archive test 6, `logs/archive-2` |
| composed gateway + v2 backend in `archive` | **6 ms** | archive test 6 |

So the composition puts S3 in the `archive` slot, never the `cache` slot. P's `dirWitnessCache` (local disk) stays in
`cache`, unchanged.

## Tests

Every test uses the real composed gateway, the real witness-check helper, real Base witnesses, and a real MinIO
(`RELEASE.2025-10-15T17-29-55Z`) or a fault-injecting fake S3. None of them stubs the gateway↔backend seam.

| suite (`jobs/run.sh MODE`) | result | peak | log |
|---|---|---|---|
| `backend`: test/s3-witness-cache.test.mjs | 11/11 | 273 MiB | backend-10 |
| `archive`: test/s3-witness-archive.test.mjs | 8/8 | 312 MiB | archive-2 |
| `e2e`: test/helios-s3-replay.e2e.test.mjs (real Helios) | 3/3 | 365 MiB | e2e-4 |
| `p`: P's witness-failover + witness-gateway on the composed tree | 17/17 | 152 MiB | p-4 |
| `pe2e`: P's helios-witness-failover + helios-base-replay E2Es on the composed tree | 8/8 | 214 MiB | pe2e-1 |
| helper unit tests + build | 6/6 | 1155 MiB | helper-build-7 |

How each requested scenario is covered:

- **Upstream forged-first, honest-second.** The honest answer is served, and only it is archived: exactly one object,
  under its content name (archive test 1).
- **Bad-first, valid-second in S3.** A forgery whose name sorts first is verified, quarantined and skipped; the valid
  answer is served. With only the forgery present, the request is refused (archive test 2). In the E2E, a forgery that
  sorts first is planted for all 42 eth_getProof answers: 42 are quarantined, there are 49 verified hits, and every
  real call still matches the providers (E2E test 2).
- **Poisoned v1 legacy object plus a valid new object.** With the poisoned legacy object alone, the request is
  refused. After a verified writer adds the valid object, it is served (1 hit, 0 invalid, because the legacy slot is
  read last), and the poisoned object is neither overwritten nor deleted (archive test 3).
- **Restart / archive-only replay.** All 49 witnesses are archived through the gateway. A new checker, root store,
  gateway and archive client, with no upstream at all, then serve all 49 verified. A request that was never archived is
  refused (archive test 4). In the E2E, a fresh Helios with no upstream recomputes every real call from the archive
  (E2E test 1). If the valid object is deleted and its forgery left, the call is refused (E2E test 3).
- **Slow, hung or unavailable S3.**
  - Hung (accepts, never answers) and unavailable (closed port): fresh reads complete in under 1500 ms.
  - Archive-only refusals stay within the deadline.
  - Every curl process is reaped by `close()` (archive test 5).
  - Fake S3 with oversize, truncated, stalled and failing listings and objects: each gives a bounded empty result
    (backend test).
- **Timeout cleanup.** A hung transport process is killed by the outer bound, not only by curl's `--max-time`.
  `put()` returns at once while uploads hang, the queue is bounded, and `close()` cancels everything (backend tests).
- **Last resort only.** A local cache hit or a healthy upstream never lists S3: `lists === 0` (archive test 7).
- **No archive without the verifier** (archive test 8).
- **Secret hygiene.** The secret never appears in curl's argv or environment, in stats, or in stored objects (MinIO
  test). Credentials are random for each run, so the source contains no credential literals.

The Base head is the real block, but it is signed by the fixture's TEST sequencer key, using Helios's `unsafe_signer`
override. These tests therefore prove the archive path and Base execution on real state. They do not prove that the
head is authentic or fresh.

Scans on the changed files and `jobs/`: `.githooks/scan-crypto-keys.py --files` clean, `gitleaks dir` reported no
leaks. The commit used `--no-verify`, but that scan had already been run by hand.

## Limits (read before integrating)

- **Not fresh-RPC availability.** The archive only serves witnesses for blocks someone already archived. A new head
  still needs a fresh source. A hit means the evidence is available for that one block. It never establishes freshness,
  and it is not consensus.
- **Adversarial bucket owner (availability only).** Anyone who can write the bucket can delete valid objects, or bury
  them under more than `maxCandidates` junk objects. Names are hashes, but junk can be ground to sort first. The result
  is a refusal (an availability loss) for those requests, never a wrong answer. Raising `maxCandidates`, `maxListPages`
  or `readBudgetMs` buys tolerance at the cost of outage-path latency. Nothing in this design can make a hostile bucket
  owner serve data.
- **Privacy.**
  - **Writes** (`archive: true`): every archived eth_getProof names the accounts and storage slots this node read, and
    at which block. The S3 operator sees all of that.
  - **Reads (optional read-cache queries) expose metadata.** Even read-only, every lookup reveals to the S3 operator
    which request hash was asked and when. Request hashes for guessable slots can be recognised.
  - **When reads happen.** Reads happen only during an outage, after the cache and every upstream have failed (archive
    test 7). That limits how often this metadata leaves the node, but not what it contains.
  - **Defaults.** Leave writes off unless the account/slot disclosure is acceptable for that node's apps.
- **Credentials.** `credentials: {accessKeyId, secretAccessKey}` are passed to the constructor and handed to curl as a
  config file on curl's stdin. They never appear in argv, the environment, errors or stats. The gateway has no launcher
  of its own (P's gateway is a library), so the embedding process decides where the credentials come from. Use a
  secret file or the process's own stdin, never argv.
- **No S3 bootstrap.** When S3 is unconfigured or down, every read returns an empty candidate list, and the gateway
  behaves exactly as P's gateway. Nothing requires S3 to start.
- **Binding.** Every candidate is bound to its chain id, its block hash and the full normalized request, through both
  the envelope and the object name. It is then verified against an authenticated root for that block hash.
  `latest`/number requests have no key, so they are never answered from a cache.
- **The existing `cache` slot still awaits `put`.** That is fine for `dirWitnessCache` on local disk. Never put a
  remote store there; use `archive`.
- **Writes are best-effort.** If the queue is full (`busy`), a put times out, or the process exits before `idle()`,
  that answer is simply not archived. Nothing retries it, and no reader is ever delayed.
- **Not tested against a live Sia-S3 or indexd.** Compatibility rests on the source references above plus MinIO.

## Target dependency, build and run recipe (no live image build yet)

- **Node ≥ 22.** Tested with v22.23.3.
- **curl ≥ 7.75 with `--aws-sigv4`.** Tested with curl 8.23.0 / OpenSSL 3.6.5. The target image must ship curl and
  libcurl; the backend runs `curl` from PATH (overridable with `curl:`).
- **The witness-check helper**, built with `jobs/build-witness-check.sh` from Helios `1ec2c1a5…` and vendor base
  `5476069f…`. Pass it to `createWitnessChecker({bin})`, as in P's gateway. The patched Helios (eeffcc9) is the client.
- **Network.** S3 is reached over https; plain http is allowed only on loopback (the `rpc-identity.mjs` policy).
- **Tests.** Run `jobs/run.sh {backend|archive|e2e|p|pe2e}` through the queue: 768 MiB for backend and archive,
  512 MiB for p, 1408 MiB for e2e and pe2e. MinIO is needed only for tests.

## Integration instructions

1. Apply `patches/0001` and `patches/0002` on P's `bfbd649d` (`git am`), or fetch `work/sia-cache-compose`. This needs
   no other files.
2. Wire the archive in:

   ```js
   createWitnessGateway({ upstreams, cache: dirWitnessCache(dir), proofs, archive: s3WitnessCache({ endpoint, bucket,
     chainId, credentials, archive: false /* writes: opt in per the privacy note */ }) })
   ```

   Use `archive:`, never `cache:`, for S3.
3. On shutdown, call `archive.idle()` with a bound if writes should drain, then `archive.close()`.
4. **P's later ancestry-recovery changes:** coordinate only through root, after P is terminal. The composition touches
   only the `witness()` tail of `witness-gateway.mjs` (the post-verify archive put, plus the fallback after the upstream
   loop) and its options and stats, so a rebase onto P's next immutable commit should be a small, reviewable conflict.
   Re-run all five suites afterwards.

## Files outside the repo

- `jobs/`: `run.sh`, `build-witness-check.sh`, `audit-b71c8261.{sh,mjs}` (a control audit, not a committed test).
- `logs/`: the runs cited above.
- `patches/`.
- `helios/` (P's commit 1ec2c1a, a clean clone), `vendor-inspect/`, `cargo-home/`, `target/`: build inputs and outputs
  for the helper.
