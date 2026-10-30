# final-consumer-composition-stage/r2: KVM's committed reader composed into the RELAY (prepared; NOT run; no activation)

**Tree `20dbe573d68c063cd2677a39bd22dcf43bf57574`** (`FINAL-TREE`):
- = r1 `33e9cabc` + `patches/relay-reader-vs-r1.patch` (6 files);
- = base `64156dcd` + `patches/final-consumer-r2-vs-64156.patch` (45 A + 8 M);
- blobs in `R2-BLOBS.txt`. The r1 stage is unchanged and frozen (`inputs/r1-SHA256SUMS`).

## The gap closed
- **Before:** the lease writer selector (`ENCLAVE_WRITER_AUTHORITY_SOURCE=derived`, writer r2) loaded `./network-runtime.bundle.mjs`, which exports no reader. So every derived selection stopped with "not composed".
- **Choice: a SEPARATE, lazily loaded relay runtime** (the qualified provider pattern), not an export from the shared runtime:
  - `relay/network-runtime.mjs` stays exactly as it was;
  - its generated bundle stays byte-identical, and so do everything that pins it: the route-dns host package, the platform-api guest manifest's runtime input, and the challenge replicas;
  - otherwise each of those would have needed the reader's sidecar and new pins.

**Files:**
| file | change |
|---|---|
| `relay/derived-reader-runtime.mjs` (new) | Re-exports KVM's committed `startDerivedLifecycleReader` (lifecycle.mjs), `serveDerivedReader` (api.mjs) and `openLifecycleJournal` (deployment-lifecycle-journal.mjs). No new logic. |
| `relay/build-derived-reader-runtime.mjs` (new) | esbuild → `derived-reader-runtime.bundle.mjs` (+ manifest: sha, inputs) and a byte-for-byte copy of `schedule_reader.mjs`, after its provenance pin check (`688b7a1f…`). It refuses a bundle that carries the reader CLI or lacks the schedule bridge, and runs `checkBundle`. The same recipe as the provider's `derived-runtime.mjs`. |
| `relay/api-relay.js` | `loadRuntime` imports `./derived-reader-runtime.bundle.mjs` through a module-relative URL that no bundler inlines, and only under the derived selector. If the file is absent, it returns null, which gives the writer's own "not composed" refusal. Any other load failure (a reader that is not the frozen pin, a missing pinned file) stops the relay. |
| `relay/deploy.sh` | Runs `node build-derived-reader-runtime.mjs` after `build-network.mjs`, ships the 3 files to the API host, and loads the bundle in staging when present. |
| `.gitignore` | The 3 generated files. |
| `test/relay-derived-reader-runtime.test.mjs` (new) | 3 tests; see below. |

## What is real, what is a fixture, what stays refused
- **Real:**
  - the builder and bundle, with the committed 34a3 reader code inside and its own `verifyReaderPin` at load;
  - `api-relay.js`;
  - the writer module;
  - KVM's `startDerivedLifecycleReader` running in-process: it opens private state, starts its L1 runtime and exposes `readDerivedLogs` and `snapshot`.
- **Fixture (labelled):** KVM's own fake L1 and echo native (`test/derived-reader/helpers.mjs`), accepted only via programmatic test options. There is no derivation, no anchor and no fresh state.
- **Refused, by design:**
  - with no derived anchor, the writer answers `derived_unavailable`;
  - the 120 s ceiling (`MAX_ANCHOR_AGE_SEC`) is kept and cannot be raised;
  - an L1-finalized anchor is normally older than 120 s, so writer derivation remains unavailable in practice;
  - the recent-state / native branch is a known gap;
  - URLs are never a reader capability;
  - the unset selector behaves exactly as before.
- **The guest:** the regenerated platform-api guest bundle must contain no reader modules, so a guest derived selection stays "not composed".

## Root job (prepared; minimal affected scope)
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh relay-reader-r2        768 unshare -Urn bash final-consumer-composition-stage/r2/jobs/root-relay-reader-r2.sh relay-reader
bash jobs/q-exit-status.sh relay-reader-r2-relay 2560 unshare -Urn bash final-consumer-composition-stage/r2/jobs/root-relay-reader-r2.sh relay
```

**relay-reader PASS requires:**
- the tree reproduces two ways;
- r1 → r2 touches exactly the 6 files;
- the network runtime bundle is r1 == r2 byte for byte;
- host-package / MCP `--check` status == r1;
- CONTROL: before the build, the derived selector says "not composed";
- the release prerequisite `node relay/build-derived-reader-runtime.mjs` succeeds;
- the new test passes 3/3:
  1. reproducible build + pins;
  2. the packaged runtime starts the committed reader and the writer refuses;
  3. the real `api-relay.js` reaches KVM's own refusals (an unqualified pin, and the v3-shape assets absent), with URL refused and unset unchanged;
- writer r3's 3 non-composition startup cases;
- the writer's suites 23/23;
- `relay-deploy-closure` r1 == r2;
- the platform-api guest bundle is stale before, `--check` passes after regeneration, and it holds 0 reader modules;
- the release copies are hashed in `RELEASE.sha256`.

**relay PASS requires:** the 8 `api-relay.js`-dependent candidate tests, base == r2, with counts as in `TESTS.tsv`.

**Not rescheduled:** paid, KVM, provider package, Windows and the 32 unrelated candidate tests. Their closures are unchanged from r1, so r1's jobs (package 1320, etc.) apply.

## Deploy and rollback (delta to r1's recipe)
- **Build:**
  1. `node relay/build-network.mjs` (unchanged bytes);
  2. `node relay/build-derived-reader-runtime.mjs` (`deploy.sh` runs it);
  3. regenerate the platform-api guest bundle (a measured change, as in r1);
  4. `build-consumers` (unchanged).
- **Relay host:** `$API_STAGE/{api-relay.js, …, network-runtime.bundle.mjs(+manifest), derived-reader-runtime.bundle.mjs(+manifest), schedule_reader.mjs}`.
  - Derived mode additionally needs, inside the accepted image: the private reader config file, the anchor journal path, the native v3 binary `49f4d7e3…`, helios `cc962e2b…` and the pinned checkpoint.
- **Rollback:** redeploy the previous relay tree. The unset selector is identical, and nothing is migrated.
