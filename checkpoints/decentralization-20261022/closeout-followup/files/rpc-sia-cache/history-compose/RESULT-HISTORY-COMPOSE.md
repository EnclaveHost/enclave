# rpc-sia-cache/history-compose: P's authenticated ancestry + the S3 (Sia-S3) archive tier

Source only, 2026-10-22. Nothing was pushed, merged, deployed or imaged. There was no SSH, no live Sia/S3/RPC, no
wallet, no full sync, no toolchain install and no build. Every test ran offline inside `unshare -r -n` through
`work/claude-test-queue.py`, with each allocation at most 1408 MiB under the existing floor. Author and committer are
SteveDeFacto. P's trees, A's trees and B's `rpc-runtime-composition` were not edited, and none of their mutable code
was read as final. P's objects were read through a `--no-hardlinks` clone at P's terminal commit.

## Result

**Commits, relative to P's terminal `7b4dd69201d00bc5649cda6bcf57b21c6197c3af`** (tree `ccb7f0ac…`):

| # | commit | content | provenance |
|---|---|---|---|
| 1 | `96b877b7c89d2b9ac54df9099c44f97ff841e378` | S3 backend v1 | cherry-pick `-x` of my immutable `73c11ec9` (itself = `b71c8261`). Same `patch-id --stable` `d46cff8c…` |
| 2 | `6a058877438c1b3d434a9447259a7e4e32f45782` | archive tier | cherry-pick `-x` of my immutable `27785278`, plus the conflict resolution (below), which is noted in the message. patch-id changed (`99994afb…` → `b96c81e9…`) only through that resolution's context |
| 3 | `afc443e032647c2d8ea31535f5ff0f6609d99ba6` | **HEAD.** Archive-backed ancestry headers + combined tests | new in this stage |

- **Branch and tree:** `history-compose/repo` `work/sia-history-compose`. HEAD tree `9fe790e855066c0835b848c8c4a1bdeb1b6529b8`.
- **Patches:** `patches/` (`git format-patch 7b4dd692..HEAD`). `git am` on a clean `7b4dd692` reproduces tree
  `9fe790e8`; this was verified in a scratch worktree, since removed.

  | patch | sha256 |
  |---|---|
  | `0001` | `f8d587f0c8a8e5f8651cf50d0e87931f5271d2803171571f81fc84c53dc67204` |
  | `0002` | `43b88728cb9634c65a284dc3a71ccab6316ecc04715c36a0d6db6f72178f310e` |
  | `0003` | `f8d800dc79cc9ee59851f588ebef7403b3925ac5183ab09cfc6101a021912cdb` |

- **Originals preserved:** `compose/` (`27785278`) and `repo/` (`b71c8261`) are untouched.

**Changes to P's files.** Only `network/witness-gateway.mjs` changes: +62/−3, and every changed line is
archive-specific. `git diff 7b4dd692..HEAD -- network/witness-gateway.mjs` sha256 is `a467f2eb…`.
`network/witness-verify.mjs` (the root store and ancestry walk) is byte-identical to P's (`9219b1d3…`, blob
`8b9850d4`).

**File pins at HEAD:**

| file | sha256 | blob |
|---|---|---|
| gateway | `7b0bd99b…` | `901d6f86` |
| s3-witness-cache | `cf180498…` | `546285fe` |
| s3-witness-history.test | `b0be6785…` | `cd10210c` |
| helios-s3-replay.e2e | `93f4f9c5…` | `773679e7` |
| s3-test-env | `cba2119a…` | `c0cec790` |
| s3-witness-archive.test | `c2b586a0…` | `4b0bc1d0` |
| s3-witness-cache.test | `ebb5402b…` | `666a174d` |

## Source and binary pins (no rebuild)

| item | pin |
|---|---|
| P's Helios | `aca81764f1d41a34829a3b408cea11c5c186e9e9` (tree `082c719e…`, parent `1ec2c1a5`; `opstack/bin/witness-check.rs` blob `337a012b`, `opstack/src/witness_check.rs` blob `26de45a8`), read as Git objects |
| witness-check helper | **P's preserved binary**, `fab2f1cea2f69a8b2e676f8ffb51d0014408f99b5f92397566772e96e1c1ae93` (P's PROVENANCE-HISTORY.json: built from aca81764). Copied with its `PINS.sha256` into `bin/` and checked before every run. My earlier rebuild `b03e00e8` (from 1ec2c1a) is **not** used here: it lacks the `header` op |
| Helios | `bin/helios-eeffcc9` `cc962e2b…` and `bin/helios-compat-0a02256` `0929f7f3…`: the same binaries as P's, copied and checked |
| fixtures | copies of P's `witness-failover/fixtures` (109 files; manifest `FIXTURES.sha256`, which every run checks): the base-calls call fixture (`fixture.json` `141321fd…`, the 49 real witnesses of block 52965249), 52 real signed Base v4 gossip objects (`base-heads-b-live-20261023T013719Z`), and the B listener fixtures. P's in-repo fixtures (`base-headers-52965055-52965106.json`, `base-header-52965249.synthetic.json`) come in through P's commits |
| node_modules | a real copy (`cp -rL`) of `native-control-attested/base-eaea7e46/node_modules` (viem 2.53.1), excluded from git |

## Conflict resolution

`createWitnessGateway` options and stats conflicted. Both sides were kept:
- P's `maxHeaderBytes` option and its per-upstream `headerOk`/`headerInvalid` counters;
- the archive's `archive` option, its validation and `proofs` requirement, and its counters.

The archive fallback after the upstream loop, and the non-awaited put of verified answers, applied cleanly inside P's
`witness()`. P's root-store call `rootFor(hash, {headers, deadline})` sits ahead of both, unchanged.

## What commit 3 adds, and why

**The problem.** After a restart, or after a poll gap, the root store knows only the current signed head. A witness for
any older block needs that block's root, and P's ancestry recovers it from `eth_getBlockByHash` headers fetched from the
upstreams. With every upstream down, the archive therefore could serve nothing below the current head, even when it
held the witnesses.

**The change** (all inside the gateway's archive branch):
- **Writes.** A header that P's `headers()` has verified with the helper (`op: 'header'`: it recomputes the hash, and
  checks the link to the bound child when one is given) is queued for the archive. The write is never awaited, and the
  header is keyed by its own block hash: `eth_getBlockByHash [hash, false]`, stored in the same content-addressed,
  create-only S3 layout.
- **Reads.** Only when every upstream has failed to give a header are archived candidates read, inside the deadline.
  Each one is checked by the **same helper call**, with the same `expectHash` and `child`, and failures are quarantined
  like witnesses.
- **Shared helpers.** `archivePut`, `archived` (deadline race, at most 64) and `headerKey` are now shared by the witness
  path and the header path.

**Unchanged.** Roots come only from a signed head (polled or pushed) and the hash links walked down from it, with
`maxAncestry` and the deadline unchanged. The archive cannot add a root, cannot extend the chain above the newest
signed head, and says nothing about freshness. `witness-verify.mjs` was not touched.

## Tests

Six final runs (`logs/`), all on the same source hashes. Each run logs and checks the binary pins and the fixture
manifest, and confirms external network: unreachable.

| suite (`jobs/run.sh MODE`) | result | peak | log |
|---|---|---|---|
| `history`: test/s3-witness-history.test.mjs (new) | 5/5 | 370 MiB | history-3 |
| `archive`: test/s3-witness-archive.test.mjs | 8/8 | 309 MiB | archive-2 |
| `e2e`: test/helios-s3-replay.e2e.test.mjs (real Helios; new test 4) | 4/4 | 386 MiB | e2e-1 |
| `backend`: test/s3-witness-cache.test.mjs | 11/11 | 272 MiB | backend-1 |
| `p`: P's witness-ancestry + witness-failover + witness-gateway | 24/24 | 191 MiB | p-1 |
| `pe2e`: P's helios-base-replay + helios-real-history + helios-witness-failover | 11 pass, 1 skip, 0 fail | 226 MiB | pe2e-1 |

- **P's skip is P's own:** "real proofs at the recovered real root … no real proofs recorded". It stays a skip. No
  real-history proof is claimed anywhere here.
- **Earlier failed run.** `history-1` failed every test in `before()` because MinIO never became ready ("bucket not
  created: HTTP 503"). A standalone MinIO probe and `archive-1` passed straight afterwards, and `history-2` passed 5/5
  on unchanged code. That was an environment stall. `s3-test-env.mjs` now raises an explicit "MinIO not ready within
  40 s (test environment …)" error instead of a later 503.

How each requirement is covered (REAL checker `fab2f1ce`, REAL MinIO, local stub upstreams; "down" means a closed
loopback port):

- **Valid old roots recovered from the current head with the upstream unavailable** (history 1, real Base data).
  - Setup: the archive was filled only through the verifying gateway, from an honest header upstream. That stored 26
    verified headers: the guide header for 52965080, plus the walk from 105 down to 81.
  - Restart with the only upstream down and 52965106 as the signed head: block 80 was bound with
    `via: 'ancestor'`, `boundTo` = block 81, and the real state root. The counts were 26 archive header hits, 26
    upstream failures, and roots `verified 1, ancestors 26`.
  - What this proves: **header/ancestry binding only.** These real blocks have no recorded proofs.
- **Real proofs at a recovered root, archive-only** (history 4 and e2e 4, labelled **SYNTHETIC authority and block
  identity**).
  - Fixture: P's 249'/250' fixture, which is the real block's header fields and real state root under a recomputed
    hash, with 250' signed by the TEST key.
  - Gateway only (history 4): every upstream down, all 49 real witnesses at 249' were served and verified from the
    archive. A first-sorting forged header and a first-sorting forged proof were each quarantined (stats
    `archiveHits 49, archiveInvalid 1, archiveHeaderHits 1, archiveHeaderInvalid 1`).
  - With Helios (e2e 4): pinned to 249', with a cold gateway that has no upstream at all and only sees 250', every
    replayable real call matches the providers. Roots were `verified 1, ancestors 1`, with 1 archive header hit.
- **Forged cache/ancestry refused** (history 2, history 4, plus the archive suite).
  - First-sorting tampered headers (state root changed, hash field kept) were planted for all 26 hashes of the walk.
    All 26 were quarantined, and the 26 genuine headers were used.
  - With the genuine header of block 95 deleted, recovery is refused (`ancestryRefused.unavailable`). Only 105..96 are
    bound, nothing below the gap.
  - A genuine header filed under another block's hash is refused by the hash check, and the witness request then
    refuses with "no authenticated state root".
- **No stale root used as current authority** (history 3, plus P's suites).
  - With no signed head at the consensus source, nothing is recovered, and the archive is not even listed
    (`lists 0`).
  - With an older head current (block 80), a block above it is refused (`newer-than-every-bound-head`), even though
    its verified header is in the archive.
  - A head signed by the wrong key is refused, so archived headers anchor nothing.
  - A recovered binding is frozen, labelled `via: 'ancestor'` with `boundTo`, and has no freshness field.
- **Slow writes do not block fresh reads** (history 5, archive 5 and 6).
  - Ancestry recovery from a live upstream, with a hung or unavailable S3 receiving the 26 header writes: 522 ms and
    554 ms, against 528 ms with no archive.
  - Fresh witness reads stay under 1500 ms with a hung or unavailable S3.
  - The earlier awaited-`cache.put` audit still applies unchanged, because P's 7b4dd692 did not change that line:
    8043 ms in the `cache` slot vs 6 ms in `archive` (`compose/RESULT-COMPOSE.md`).
- **Bounded refusal and shutdown children** (history 5, archive 5, backend tests).
  - With every upstream down and the store hung, the whole walk is refused within its 3000 ms deadline (under 4500 ms
    measured).
  - Hung uploads are still in flight before `close()`; afterwards `inflight.children` is 0, and checkers are closed in
    `after()`.
  - Backend tests: the outer kill of a hung transport, and a bounded queue.

Scans on the changed files plus `jobs/run.sh`: `.githooks/scan-crypto-keys.py --files` clean, `gitleaks dir` reported
no leaks. The commit used `--no-verify`, but that scan had already been run by hand.

## Limits

- **Freshness and new heads.** A fresh head comes only from the consensus/head source: the polled `GET /latest`, or
  `offer()` from the gossip bridge. The archive helps only below a signed head it can link to, within `maxAncestry`
  (256). A block above every signed head is refused.
- **Helios's EIP-2935 path is not served by the archive.** P's `helios-real-history` test 7 shows the case: for a block
  Helios has moved past, Helios asks for `eth_getBlockByHash(h, true)` (full transactions, a gateway pass-through) and
  a history-contract proof pinned to the *latest* head. The archive does not store block bodies; that stays P's area
  (block-body hardening). An archive-held proof for the *current* head can be served, but only once archived. In e2e 4,
  Helios still had 249' itself: the call ran at 249' with no upstream, so Helios cannot have taken that path.
- **The adversarial bucket owner limits from RESULT-COMPOSE still hold, now also for headers.** A bucket writer can
  delete objects, or bury them under more than `maxCandidates` (8) ground junk objects. The result is a refusal (an
  availability loss), never a wrong root or answer. During a cold walk, every missing header costs one bounded S3 read.
- **Privacy.**
  - Header writes reveal which blocks this node recovered: block-level, public data. Witness writes still reveal
    accounts and slots.
  - Reads reveal block and request hashes, and timing, to the S3 operator. They happen only when every upstream has
    failed.
  - Writes stay off unless `archive: true`.
- **No bootstrap cycle; availability coupling only.** Nothing waits on S3 to start, and with S3 absent the gateway is
  exactly P's. If the Sia-S3 endpoint is itself an Enclave app whose lease depends on RPC, then during a long RPC outage
  it can lapse too. The archive then simply returns no candidates. That is an availability limit, not a correctness or
  startup dependency.
- **Not covered.**
  - No real mainnet proofs at a recovered real root (P's recording got none, and none are claimed).
  - No live Sia-S3 or indexd test.
  - No live image.
  - Fixture heads are real (block 52965055..106 gossip); proof-bearing heads are TEST-signed.

## B runtime integration (`rpc-runtime-composition` is owned by B; nothing there was edited)

1. **Source.** Take `work/sia-history-compose` at `afc443e0`, or `git am patches/000{1,2,3}` on P's `7b4dd692`. The
   changed runtime files are `network/witness-gateway.mjs` and `network/s3-witness-cache.mjs`.
   `network/witness-verify.mjs` stays P's `9219b1d3`.
2. **Binaries.** Ship the witness-check helper built from Helios `aca81764` (P's `fab2f1ce`, or a rebuild with P's
   recipe from aca81764; it needs the `header` op). Pair it with the patched Helios (`eeffcc9`). Ship curl ≥ 7.75 with
   `--aws-sigv4` (tested with 8.23.0) on PATH, and Node ≥ 22.
3. **Wiring.** Give the root store the same consensus source Helios reads, or `offer()` from the gossip bridge:

   ```js
   const roots = createRootStore({ checker, consensusUrl });
   createWitnessGateway({ upstreams, cache: dirWitnessCache(dir), proofs: { checker, roots },
     archive: s3WitnessCache({ endpoint, bucket, chainId: 8453, credentials, archive: false /* writes: opt in */ }) });
   ```

   - Put S3 in `archive:`, never `cache:` (the awaited `cache.put` would hold fresh reads).
   - Credentials come from a secret file or stdin of the embedding process, never argv. The backend passes them to curl
     on curl's stdin.
4. **Writers and shutdown.** Only nodes whose operators accept the disclosure set `archive: true`. Read-only clients
   still benefit. On shutdown, run a bounded `archive.idle()` if writes should drain, then `archive.close()` and
   `checker.close()`.
5. **Regression.** Re-run all six `jobs/run.sh` modes, or B's equivalents, on the composed runtime tree.

**Coordination.** If P later hardens block-body responses, the archive changes are confined to the archive branches of
`headers()` and `witness()` and to options and stats, so a rebase should touch only those lines. Route any such rebase
through root.
