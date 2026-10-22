# sia-s3 writer fencing: SDK and sia-s3 implementation result (Claude)

Date: 2026-10-20. This is implementation evidence. It does not prove the protocol and does not authorize activation.

**What I did not do:**
- no commits or staging;
- no production, SSH, wallet, real keys, chain writes, GUI or Wine;
- no edits to the shared companion repo, relay, indexd, the indexd worker's tree, or Enclave contracts.

Every heavy job ran in the foreground, was awaited, and went through the shared queue (`work/claude-test-queue.py`,
1024 MiB Rust cap, no swap, 16 GiB floor) or, earlier, my bounded runner with the same caps.

Read with `work/effective-goal-requirements.txt` (2026-10-20). Fencing is app-key and indexer level. It removes no
Enclave administration and adds no moderation bypass, and it needs no contract change. The generation fact uses the
live rev-16 `Claimed` ordinal; rev 17 (`leaseOf`) is optional and not a prerequisite.

## Decision

The candidate is implemented and tested natively. Its production code paths passed real indexd-fence interop, run
by the indexd owner on the R5 source.

It is not activation-ready:
- indexd-fence must be deployed on every listed indexer;
- the relay/front generation binding must be adopted by its owners;
- the runtime no-clone evidence is missing, so SNP, TDX and VBS are refused by default;
- one fixed driver case awaits a re-run on real indexd.

## Candidate

**Location:** `work/storage-fencing-implementation/sia-s3`. It is an isolated copy of the main tree
`work/enclave-apps-sia-recovery/sia-s3` (HEAD 54818ba plus the uncommitted integrated work; `replica.rs` e45eb2f0…).

**Base hashes:** `base-hashes/`.
- The U1 current-objects listing was ported from the indexd worker's isolated copy and verified against their
  `U1-sources.sha256`. The one exception is `real_indexd.rs`, which they had updated since; its actual hash is
  recorded.

**Final hashes:**
- `FINAL-source.sha256` (key files);
- `FINAL-tree.sha256` (98 files under `src/` and `vendor/`; manifest sha256
  `4ceb00b294bfe7597f5bcdce529ed40102b19151a955f2326f6d3c148ea54f1a`).

Key files:

| file | sha256 |
|---|---|
| src/fencing.rs | 99f036500ec67f5e9224beccfbf88dee227f853f9f40a6fec7162c5c9875da43 |
| src/replica.rs | 0a28dea135bbbf2b1b9ef2a6524ab0f94c277a087b54cf88c1921745ba07fe3f |
| src/real_fencing.rs | 298c2978b60384a14029a141d5f1de393dc9a267af26d9641cd7cdc3acfc2d6a |
| vendor/…/sia_storage/src/fence.rs | af0764662d6cb64b7cdd5dd1448aecb1515b6a95b520e703e68b6a45fdfea522 |
| vendor/…/app_client/mock.rs | 5bed4b200c7ca032f6815c0356e1a4201284cb45ab7ce92a4ab99870ce6952a8 |
| Cargo.lock | 9ea317cfd8915eeb459dc03da8ea655298b841ca518f0ba25a1340b82aecfe0f |

**Wire contract:** `work/storage-fencing-implementation-interface.txt` (v3, plus appended R5 and final sections).
- The fenced request hash is the indexd-fence **R5 "indexd/fence/v3"** injective stream.
- The raw v2 form is gone from the source.
- Without `sf` the hash is unchanged from 0.6.0.

## What is implemented

**Vendored SDK** (`sia_storage`, every change marked `PATCH (writer fencing)`):
- **Types:** token `gen‖counter‖iid` (strict parsing, top bits clear); receipt; credential.
- **Signing:** the R5 v3 request hash; `sf` = 96 hex.
- **Every account mutation carries the credential:** object pin and delete, slab pin and prune (including the pins
  made inside uploads), and the four sharing mutations.
- **409 Fenced** becomes `Error::Fenced` and is recorded.
- **Endpoints:** `GET /fence` and `POST /fence`. An equal raise is refused.
- **The mock indexer** applies the exact (token, receipt) check when the indexer processes a request, so deferred and
  late requests are judged at that moment.

**sia-s3:**
- **Instance id:** fresh randomness at every process start (WASI random in the guest). It is never persisted.
- **Ballot:** gen from the delivered writer-authority fact (lease16 or lease17, or owner-cold); counter one above
  installed fences of the same gen.
- **Boot (`fence_boot`):** raise on every listed indexer, re-ballot above a higher same-gen fence, then list only
  installed replicas (U1 listing) and attach them.
  - A later gen stops this instance as stale.
  - An equal ballot already installed means a duplicate: stop.
  - A lost raise answer leaves that replica unused until restart.
- **Late replicas:** `fence_join`.
- **Readiness:** the B1 membership readiness, computed over installed-and-listed replicas only.
- **Every S3 answer** waits for a confirmation round, started after the request arrived, that sees our exact fence and
  receipt hash on W voters of the acting set. That includes data, lists, 412, 404 and the DELETE of an absent key.
  Otherwise the answer is 503.
- **Supersede latch:** a refusal or mismatch stops the instance for good. A stopped instance does no repair and no
  compaction.
- **Re-read:** before swapping in a fresh listing, `reconcile` re-checks that our fence is still installed.
- **Membership:** records, ceilings, floors, parts and copies are all fenced, because the SDK fences every mutation.
- **Fail-closed policy:** a missing authority, a missing isolation fact, or isolation without recorded no-clone
  evidence is refused, unless `acceptUnevidencedIsolation` is set; `/healthz` then reports the accepted risk.
- **`writerFence: "off"`** keeps the old single-writer behaviour, explicitly. An unfenced writer on a fenced account
  is refused and stops. There is never a silent fallback.
- **Status:** `/healthz` and `/api/status` show `writerFence`.

**Listing.** The task text says "seq rebuild"; I used the U1 current listing instead of a sequence listing. Under an
exact fence nothing else can mutate the account, so the current-objects listing taken after install and before our
first write is the committed state at install. indexd-fence ported U1 with REPEATABLE READ pages (its R3), and the
real driver case showed an unpublished acknowledged pin being listed.

**No-clone (A2), honest status:**
- No runtime has recorded no-clone evidence in this workspace.
  - VBS type 1: Save-VM was refused once, and the repo says that is "not evidence of isolation".
  - SNP and TDX: their restore and migration models were not examined.
- So deployments are refused by default.
- A copy made after the raise holds the same credential and is indistinguishable. That case is tested and documented
  as the limit.
- A copy made before the raise, or a token without its receipt, is refused (tested).
- Owner app-key holders keep full authority by design. That is distinct from a host replaying or duplicating an
  instance.

## Tests (actual results)

**Native suite on the final source**, through the shared queue (debuginfo 0, 1 job, 1 test thread):
- **89 passed, 0 failed, 11 ignored.** The ignored ones are the real-indexd driver cases.
- Peak process tree 919 MiB (`logs/final-full.guard.log`, `logs/final-full.cargo.out`).
- An earlier run on the R5 source, before the last test was added: 88 / 0 / 11.

**The 21 fencing tests** (`cargo test fencing`) cover:
- the R5 wire vectors, equal to Go's `TestFenceHashVector` and independent Python;
- strict authority and policy parsing;
- ballot ordering;
- fresh iids;
- install-before-list;
- delayed old-writer pins refused once a new writer installed (plus an old-rules mutant test showing the unfenced
  failure);
- two same-counter starters with distinct iids, ending with exactly one writer;
- a duplicate ballot, and the after-raise clone limit;
- a lost raise answer;
- re-ballot above a dead predecessor's unread fence;
- a stale lease never preempts;
- owner cold recovery after acknowledged writes, then preempted by a later lease;
- reads and a conditional 412 confirmed against a newer writer;
- unavailable quorum;
- fail-closed policies;
- an uninstalled higher token is not authority;
- an unfenced writer on a fenced account;
- a re-read after preemption;
- a membership change {r0} → {r1,r2} under fencing, then a newer writer on the new set.

**Mutants** (`mutants/`, each applied to a fresh copy and rebuilt cleanly):

| Mutant | Failing fencing tests |
|---|---|
| M1 no read confirmation | 7 |
| M2 credential not presented | 14 |
| M3 stale lease preempts | 2 |
| M4 equal raise idempotent | 2 |
| M5 receipt not checked | 1 |
| M6 ≥ token accepted | 1 |
| M7 no re-ballot | 1 |
| M8 re-read without fence check | 1 |
| M9 ready ignores supersede | 3 |
| M10 mutations not fenced (mock) | 5 |

All ten are **killed**.

History, preserved:
- **M6 and M7 survived** the earlier suite. M6 was killed only after the uninstalled-higher-token test was added, and
  M7 only after the dead-predecessor re-ballot test.
- **Two outputs in `mutants/invalid-stale-build/` are invalid.** rsync restored older mtimes, so cargo reused the
  previous mutant's build of the other crate. Fixed by touching all sources on each apply.
- **The first M1–M5 runs were on pre-R5 source.** They were re-run on the final source with the same verdicts.

**Real interop**, run by the indexd owner (see the interface file "INDEXD-FENCE INTEROP GATE PASSED"). Their snapshot
matched my published R5 hashes, and they built my real driver against real indexd-fence with PostgreSQL:
- endpoint semantics: ok;
- an unpublished acknowledged pin is listed after install: ok;
- a delayed old writer's pins are refused (409) after a new install, and the DELETE holds: ok;
- two starters: safe, but neither confirmed.
  - Diagnosis: my driver case never committed the new record-less set, so neither instance had voters.
  - Evidence: starter 2 re-balloted to counter 2 and was installed on 3/3.
  - Driver fixed; re-run requested.

The production code is identical between their R5 snapshot and the final source: diffed, with changes only in tests,
the mock fault hook and the driver.

**WASM release** (`WASM-PROVENANCE.txt`):
- `target/wasm32-wasip2/release/sia-s3.wasm`, 4,405,465 B, sha256
  `651a05c78bd3d1a5578815bb45f7795d6f02d6f9048125f6795ad765d8e74b9a`;
- a component (magic `0061736d`, version `0d000100`);
- rustc 1.99.0-nightly (84b36a78a), offline, built after the native tests passed, peak 946 MiB;
- it is not deployed and not signed.

**Resource stops (not test results):**
- the memory guard stopped two early attempts (link-time process tree 1035 MiB; parallel rustc 2653 MiB);
- fixed with debuginfo 0 and one build job;
- several queue attempts exited 98 (not started).

## Patches for other owners (not applied)

- `patches/relay-front-generation-binding.patch` (sha256
  `0c9d4d8a36fad87f7bc9b26fac6b44c338fa1450c673b3b16dda65127f4d51a2`, against enclave abe86262):
  - **Relay:** adds `facts.writerAuthority` to the sealed release, from a `ctx.leaseGeneration` hook that reads the
    confirmed lease. On rev 16 that is the finalized `Claimed` ordinal; on rev 17, `leaseOf`. If the hook fails, the
    fact is omitted, and other apps are unaffected.
  - **Release struct:** a `facts` field.
  - **SNP front:** the reserved config names `ENCLAVE_WRITER_AUTHORITY` and `ENCLAVE_INSTANCE_ISOLATION` (`"snp"` from
    the front's own build). An owner secret that tries to shadow either is refused.
- `patches/direct-front-generation.md` (sha256 `5188f3a0…`): the relay-free direct and Shield fronts derive the same
  fact from their own measured chain reads.
  - **Open (operator decision):** the direct path has no per-lease restart bound.

## Remaining blockers

1. **Deploy indexd-fence** on every listed indexer: the indexd owner's patch, which needs review and an operator
   rollout.
2. **Adopt the generation-binding patches:** relay, release struct and front owners, plus direct fronts per the spec.
   - The relay needs the `ctx.leaseGeneration` implementation and a per-lease release rate limit.
3. **Runtime no-clone evidence (A2)** for SNP, TDX and VBS, or an explicit risk decision. Until then fenced deployments
   are refused by default.
4. **Re-run the fixed real two-starters driver case** (requested from the indexd owner).
5. **Liveness costs:**
   - reads need W voters;
   - a lost raise answer leaves that replica unused until restart;
   - a NEW record-less set with a lost raise answer cannot commit until restart;
   - concurrent same-lease starters can re-ballot against each other, bounded at 16 rounds.
6. **Not shown:** Byzantine indexers, production decentralization, and a full-system proof. The models and tests are
   bounded, one-writer-at-a-time and fail-stop.

## Update, 2026-10-20: blocked listing (PATCH U1-B)

The candidate hashes above are now the historical snapshot
`storage-fencing-implementation/history/fencing-final-2026-10-20/`. The current candidate, its tests and the
real-indexd run request are in `work/claude-sdk-blocked-listing-result.txt` (sha256 `bb4942bc847451e733f111f43f3748df2eeecb0e6da2ff211661dd0ddbe2aacc`).
