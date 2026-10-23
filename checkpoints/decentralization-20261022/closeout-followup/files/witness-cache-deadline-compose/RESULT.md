# witness-cache-deadline-compose: E's S3 archive/history tier composed with whole-operation deadlines (RESULT, 2026-10-23 ~06:05Z)

**Status: SOURCE + OFFLINE TESTS ONLY.**
- Every run was inside `unshare -rn` (loopback only), through `work/claude-test-queue.py` with a 16 GiB floor, at
  most 512 MiB per run.
- No live S3, Sia, RPC, SSH, wallet, production, push, full sync, toolchain change or cache allocation.
- E's and B's working trees were not edited. E's commits were fetched read-only.
- Earlier immutable commits and evidence are untouched: P `d0775541`, `7b4e8c68`, `7b4dd692`; E `afc443e0`.
- No deployment or RPC-independence claim.

## 1. Final pins

| Item | Pin |
|---|---|
| **Composed source** `witness-cache-deadline-compose/repo`, branch `witness-cache-deadline-compose` | **`9e838ba758b96f96eb9858e35f4898a95fc5cba7`**, tree **`90ecef92d89783aaf8da58eb2e0eae2483abf546`** |
| Bases | P `d0775541db0a0cb599cfe5c7b3853e24242aaaec` (deadlines, on `7b4e8c68`, on `7b4dd692`) and E `afc443e032647c2d8ea31535f5ff0f6609d99ba6` (tree `9fe790e8…`, on `7b4dd692`) |
| Commits on `d0775541` | `8389e983` = E `96b877b7`; `e2ffb7aa` = E `6a058877`; `52bb57ff` = E `afc443e0` (all `cherry-pick -x`); **`9e838ba7`** = the composition |
| `network/witness-gateway.mjs` | `7209ef5b…89cb` (blob `f6a18de3`) |
| `network/witness-verify.mjs` | `729496b0…fd4b`: **unchanged** from `d0775541` |
| `network/s3-witness-cache.mjs` | `fa87083a…dd40` (blob `a72aaecf`) |
| `test/witness-archive-deadline.test.mjs` | `bcbff3d2…8b42` (new) |
| Helios / helper | `ef3202982b475212d9bb6adfdc3eed4ebb0b83c5` / **witness-check `4fe0cd3b1a9fd28fc324cd4d58079fea3bc41836dab86cddbcf83fe9c3023411`**: unchanged, no rebuild. It is a superset of E's `fab2f1ce`: it adds the `block` op |
| Patches | `patches/0001…0004` (`76bed7e8…`, `31e9eb45…`, `bfad0c8c…`, `40006c92…`): `git am` on `d0775541` |
| Provenance / evidence | `PROVENANCE.json` (`508f0676…`), `TEST-EVIDENCE.txt` (`a0e3a522…`), fixtures manifest `FIXTURES.sha256` (109 files, the same bytes as E's) |

## 2. Conflicts and resolutions

**Patch-ids:**
- E's `96b877b7` (the S3 backend) applied cleanly; its patch-id is equal to E's (`d46cff8c…`).
- E's `6a058877` and `afc443e0` conflicted **only in `network/witness-gateway.mjs`**. With that file excluded, both
  composed commits have exactly E's patch-ids (`patchIdExcludingGatewayEqual: true` in `PROVENANCE.json`; whole
  patch-ids `b96c81e9`→`954e42cd` and `650855b6`→`133a8640`). The conflicts were in four regions each, all where
  both sides edited the same lines.

| Region | Resolution |
|---|---|
| Header comments | Kept both: P's verified-`eth_getBlockByHash` bullet, and E's archive and archived-headers bullets. Kept P's "blocks by number" wording. |
| JSDoc + options | P's deadline JSDoc plus E's `archive` line. Options = P's (`maxQueued`, `minTryMs`, `cacheTimeoutMs`, `maxCacheOps`) plus E's `archive`. |
| Validation + stats | P's validations and op-context block, plus E's `archive` validation, `proofs` requirement and archive stats (`archiveHits/Invalid/HeaderHits/HeaderInvalid/Queued/Errors`). |
| Verified write | P's **background** `cacheWrite`, not 7b4dd692's awaited `cache.put` (the 8043 ms hazard E measured is gone), plus E's never-awaited `archivePut`. |
| Cleanly applied archive fallbacks | E's bare `deadline` adapted mechanically to the request context (`op.deadline`) so each picked commit is coherent. Deliberate semantics are in the composition commit. |

**Composition commit `9e838ba7`** (deliberate changes):
- **Abort reaches the actual S3 transport** (`s3-witness-cache.mjs`):
  - `s3Request({signal})` never starts curl for an aborted caller. On abort it **SIGKILLs that request's curl**
    process.
  - Read-slot waiters leave the queue on abort.
  - list and fetch check `closed` and the signal before every request.
  - Signature: `candidates(w, {deadline, signal})`.
  - Writes stay detached from any caller (bounded queue, `putTimeoutMs`, killed by `close()`).
- **Archive reads run under the request's context** (`archived(w, op)`):
  - For witnesses, that is the request; for ancestry headers, it is the reference-counted **shared walk** context.
  - op's deadline, its last walk caller leaving, or gateway close drops op's S3 work. **Other callers' reads
    continue.**
  - An expired op is a **deadline refusal**, never "no candidate".
- **Aggregate cache bound:** archive reads count against the same `maxCacheOps` as local cache reads.
- **Late callbacks cannot reopen closed services:** `archivePut` stops after `close()`. The archive's own `close()`
  stops puts and reads. The root store and checker close as in `d0775541`.
- **Local cache byte budget:** `dirWitnessCache(dir, {maxBytes})`.
  - It counts allocated bytes, including directories and the transient temp copy. The default is 1 GiB and must be
    set explicitly from the central budget.
  - Over the budget, writes are skipped (create-only: nothing is evicted or rewritten) and reads continue.
    `usage()` reports it.
  - It is a **configured share**, not a device reservation; S owns device enforcement. Nothing here assumes the
    250 GB aggregate.
  - The S3 archive is remote and holds no NVMe chainstate. The backend stages request bodies (verified witnesses
    only) in a 0700 `mkdtemp` scratch under `os.tmpdir()`, which is removed on `close()`. Point `TMPDIR` inside the
    budgeted area or tmpfs.

**Properties preserved:**
- Every candidate from the cache or archive is verified by the real helper against an authenticated root.
- Roots come only from signed heads and hash links (`witness-verify.mjs` unchanged).
- Archived ancestry headers are history below a current signed head, never freshness.
- Owner close is terminal, and per-request abort is isolated.

## 3. Terminal tests (digest in `TEST-EVIDENCE.txt`)

All final runs were on identical sources: gateway `7209ef5b`, verifier `729496b0`, S3 backend `fa87083a`. Pins and
fixtures were checked, and every run confirmed the external network unreachable.

| Run | Suites | Result | Peak |
|---|---|---|---|
| **compose-3** | **new `witness-archive-deadline` (composed path)** | **8/8** | 157 MiB |
| e-1 | E: `s3-witness-cache` (backend, real MinIO), `s3-witness-archive`, `s3-witness-history` | **24/24** | 377 MiB |
| ee2e-1 | E: `helios-s3-replay.e2e` (real Helios + MinIO) | **4/4** | 370 MiB |
| p-1 | P: `witness-deadline`, `witness-blocks`, `witness-ancestry`, `witness-failover`, `witness-gateway` | **40/40** | 190 MiB |
| pe2e-1 | P: block-failover, witness-failover, base-replay, real-history, (Anvil) witness E2Es | 13 pass, 1 skip, **1 file failed to load** | 213 MiB |
| anvil-1 | P: `helios-witness.e2e` alone | **5 pass, 1 skip** | 246 MiB |
| scan-2 | range `d0775541..HEAD` | crypto 0 findings, gitleaks "no leaks found" (4 commits) | |

**Failures and skips, disclosed:**
- **compose-1 and compose-2 (7/8):** my fake S3 also delayed the 404 of the backend's legacy single-slot probe,
  pushing the healthy caller past its deadline. The fix was in the stub only.
- **pe2e-1:** `helios-witness.e2e` could not load the ignored contract artifact, which is missing in a fresh clone.
  After copying the same artifact (`966f7662`), anvil-1 passed.
- **scan-1:** not a scan. The queue could not spawn the scan script, because an earlier command (refused by the
  harness) had not written it.
- **Skips:**
  - P's real-proof replay at a recovered real root: no recorded real proofs (`RESULT-REAL-HISTORY.md`).
  - The stock 0.12.0 comparison test: no binary.

**New composed-path tests** (REAL composed gateway; REAL curl SigV4 transport to loopback fake S3; REAL helper
`4fe0cd3b`; real recorded witnesses):
1. **Hung S3 archive, with every upstream down:** refused at the 600 ms deadline. **0 curl processes and 0 S3
   connections** remain afterwards.
2. **NEGATIVE CONTROL, E's exact `afc443e0`:** the request ends too (no late success), but **the abandoned curl
   transfer and connection are still running** afterwards.
3. **Concurrent callers:**
   - caller A's archive list hangs and A is refused at its deadline (600 ms);
   - caller B's S3 object transfer was **in flight at that moment**, completed, and B was verified and served at
     676 ms;
   - only A's list was aborted (`list-aborted 1`).
4. **An expired queued call starts no transport:** 1 upstream try (the running call), and **0 S3 requests**.
5. **Failed optional caches:** a hung local cache (SEAM) plus an erroring archive (HTTP 500) fall back to upstreams.
   The liar's forged proof is still refused, and the liar alone is still refused.
6. **Terminal close:**
   - a request inside an archive read ends `closed` at once and its curl is killed;
   - after the archive's `close()`, `candidates` returns `[]`, `put` is skipped, and the gateway and root store refuse;
   - no S3 request happens after close.
7. **Background writes:** with S3 PUTs hung, 6 verified reads stay fast and the archive queue stays bounded
   (≤1 in flight, ≤2 queued, ≥3 dropped). Roots are unchanged (`verified 1, ancestors 0`): **writes advance no
   authority**.
8. **Local byte budget:** with `maxBytes` 1 MiB, writes are skipped beyond it, on-disk usage measures ≤ 1 MiB, reads
   continue, and a budget under 1 MiB is refused.

**Labels kept from E and P:**
- E's history suite recovers **actual Base ancestry headers** (blocks 52965055..106, real signed gossip) with every
  upstream down. That proves **header/ancestry binding only**.
- E's proof replay (history 4, e2e 4) and P's cold-ancestry E2E use the **test-signed synthetic block identity 249′**
  over real state: **synthetic authority**, labelled as such.

## 4. Ready-to-integrate instructions

**B (runtime composition, `rpc-runtime-composition`; not edited here):**
1. **Source:** take `9e838ba7`, or `git am patches/000{1..4}` on P's `d0775541`. The runtime files are
   `network/witness-gateway.mjs`, `network/witness-verify.mjs` and `network/s3-witness-cache.mjs`.
2. **Binaries:**
   - helper **`4fe0cd3b`** from Helios `ef320298`. It is needed for the `block` and `header` ops, and an older helper
     fails closed on blocks;
   - Helios `eeffcc9` builds;
   - Node ≥ 22;
   - a curl with `--aws-sigv4` support; credentials go to it via a stdin `--config -`, never argv.
3. **Wiring:**

   ```js
   const checker = createWitnessChecker({ bin, chainId: 8453, signer });
   const roots = createRootStore({ checker, consensusUrl });  // or roots.offer(commitment) from the gossip bridge
   const cache = dirWitnessCache(dir, { maxBytes: <this cache's share of the central budget> });
   const archive = s3WitnessCache({ endpoint, bucket, chainId: 8453, credentials, archive: false /* writes opt-in */ });
   const g = createWitnessGateway({ upstreams, cache, archive, proofs: { checker, roots } });
   ```

   - S3 belongs in `archive:`, never in `cache:`.
   - Credentials come from a 0600 file or stdin, never argv.
   - Set `maxBytes` explicitly; together with the other caches it must fit the central budget (target 200 GB, hard
     cap 250,000,000,000 bytes, enforced by S).
4. **Shutdown (owner closes):** `await g.close()`, then optionally `await archive.idle()` if writes should drain
   (each put is bounded by `putTimeoutMs`, but `idle()` has no timeout of its own, so race it against a shutdown
   timer), then `await archive.close()`, `roots.close()` and `checker.close()`.
5. **Regression:** in the composed tree, run `jobs/run.sh compose|e|ee2e|p|pe2e|anvil` or the equivalents. Copy the
   ignored contract artifact for the Anvil E2E.

**A (LeaseReader consumer wiring):**
- Construct the gateway as above.
- `g.root(hash)` gives authenticated **history**, never freshness; use Helios's head for freshness.
- Pass `{signal, deadline}` through any custom `headers()`.
- Close in the same order at shutdown.
- No other interface change since `d0775541`.

## 5. Limits

- Timing claims are loopback-measured (0.3–5 s deadlines), so host load adds timer latency.
- An abort kills curl on our side. A remote S3 server may still finish its own work.
- Sources that ignore abort (a custom fetch or cache) are bounded, not stopped.
- The archive tier still cannot serve Helios's EIP-2935 path (block bodies are not archived; E's limit stands).
- E's adversarial-bucket-owner limits stand: availability loss, never a wrong answer.
- **Not covered:**
  - fresh witness supply (an execution-data holder is still required);
  - transaction inclusion;
  - receipts and logs;
  - L1 finality;
  - real-proof history replay;
  - live Sia-S3 or indexd;
  - release builds.
- No deployment, image or production claim. Source checkpoint D publishes later.
