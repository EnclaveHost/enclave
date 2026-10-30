# Attested provider AMD collateral: prepared fix (2026-10-25)

**Status: PREPARED, reviewed by root, NOT deployed.**
- Offline tests pass: 37/37 with no skips, and five assertion-only source-weakened mutants are killed.
- Nothing ran against live AMD KDS or SEV-SNP hardware, and no provider config, cache or route changed.
- The SNP hardware canary that passed separately did not exercise this composition.
- Root reviewed and committed the three source/test/doc files as `b3fde1812` on
  `fix/rpc-attested-route-composition-20261025`. Production activation remains pending.

## The defect

`network/wg-provider/attested-authority.mjs` `providerCollateral({ dir, kds: true })` was
`layeredCollateral(fileCollateral(dir), httpCollateral())`, and a layered adapter returns the **first** answer.
- **Effect:** an expired pre-seeded `amd/<product>-crl.der` shadowed a fresh AMD KDS CRL. The verifier (CRL
  `"required"`) correctly failed closed, so the attested authority stayed unavailable until an operator replaced the file.
- **Why the cache alone does not fix it:** wrapping that layered adapter in the existing cache would keep the defect.
  The cache's stale-CRL refresh would ask the same seed-first upstream.

## The fix (one production file)

**`source/attested-authority.mjs`** (`d94dd37d…`) replaces the original `ee1ce253…`; the diff is
`source/attested-authority.patch`.
- `{ dir }` is **unchanged**: files only, no network, no cache.
- `{ dir, cacheDir, kds? }` uses the existing authenticated, freshness-aware `verifier/collateral-cache.mjs` (unchanged)
  in a separate, writable `cacheDir`. Its upstream, per piece:

| Piece | Source order |
| --- | --- |
| chain | pre-seed **only**, so an ASK rotation stays an operator decision (`host-collateral --allow-ask-rotation`) |
| VCEK | pre-seed, then KDS |
| CRL | **KDS first**, then the pre-seed (outage fallback) |

- **Unchanged:** the verifier, the pinned AMD ARKs, the explicit TCB floors, CRL `"required"`, the
  authority/administrator/no-fallback paths, and the attested client.

## Config migration and rollback

**Migration.** `{ dir, kds: true }` without `cacheDir` is **refused at startup**, with a message naming the doc. To
migrate, add `cacheDir`: an absolute path, writable only by the provider (for example mode 0700), and separate from
`dir`. `{ dir }` users need no change.

**The separation check is lexical** (`path.resolve`, no symlink or mount resolution).
- Do not alias `cacheDir` and `dir` through symlinks, bind mounts or nested paths.
- The check catches configuration mistakes. It is not a defence against a hostile local user; the verifier's
  pinned-ARK checks are.

**Rollback.**
- **Option 1:** revert to the original file and to `{ dir }`, the unchanged no-network mode, with a fresh authenticated
  seed CRL.
- **Option 2:** keep the new file with `{ dir, cacheDir }` and no KDS.
- **Not available:** reverting to the original `{ dir, kds: true }` restores the shadowing defect, so it is not a
  supported rollback.
- **Cache directory:** it can be deleted while the provider is stopped. It refills from the seed and KDS, and every
  entry is re-authenticated.

The operator procedure (refresh, ASK rotation with cache invalidation, bounded restart, and an expiry/outage/recovery
table) is in `docs/attested-provider-collateral.md` (`5fbb84ff…`). That file is a copy of
`attested-route-source/docs/network/attested-provider-collateral.md`.

## Tests and evidence

**`test/attested-provider-collateral.test.mjs`** (`33ab66c1…`, 8 tests) uses real signed **synthetic** collateral:
`test/helpers/snp-synth.mjs`, with test ARK/ASK/VCEK and ARK-signed RSASSA-PSS CRLs, pinned only programmatically.
"KDS" is a local adapter with controllable availability. It covers:
- the old defect, reproduced;
- stale seed with fresh KDS;
- fresh, warm, offline and restart;
- stale with an outage, which is rejected;
- restoration without a restart;
- forged and revoked collateral, including a CRL independently signed under a **different** ARK. A positive control
  shows that CRL is valid under its own ARK and fails only the signature check under ours;
- defence in depth: the same forged CRL with **no cache** is rejected by the verifier itself;
- configuration and migration.

**Run history (every attempt kept, in `logs/`):**

| Run | Harness | Result |
| --- | --- | --- |
| `test-20261025T204017Z` (worker) | `harness/jobs.sh` | rc **98**, NOT STARTED (memory) |
| `root-collateral-2104` (root, 256 MiB) | `harness/jobs.sh` | rc **99**: several NOT STARTED retries, then the memory guard STOPPED the run at 405 MiB, more than 256 MiB, mid-suite. Not a result |
| `root-collateral-2134-768` (root, 768 MiB) | `harness/jobs.sh` | rc **1**: 36 tests, **34 pass, 2 fail**, 0 skip; peak 433 MiB |
| **`repair-20261025T213818Z`** (worker, 768 MiB) | `harness/jobs2.sh` + `harness/mutants.mjs` | rc **0**: **37/37 pass**, 0 skip; **m1-m5 KILLED**; peak 432 MiB |

**The two 2134 failures** were test defects. The production code is unchanged between 2134 and the repair.
- **Chain locator.** The test expected `source: file:…`. The chain is legitimately served from the cache after the
  VCEK lookup authenticates it. The repaired test proves its origin from the seed instead: cached bytes, sidecar
  source and sha256, and zero KDS calls.
- **"Forged" CRL verified.** This was a fixture bug, not a security bug.
  - `FORGED.crls[400]` was `undefined`; the fixture's CRL is `FORGED.crlDer`.
  - The stub's destructuring default then served the genuine fresh CRL, so `verified` was correct.
  - Each `synthChain()` call generates its own RSA-4096 ARK; no key is shared.
  - The repaired test uses the independently signed CRL, and the fixture helpers now refuse `undefined`.

**Mutants (`mutants/*.tap`).** Each is the current file with one protection removed, run through a symlink farm
against the focused test. A kill requires each named test to fail with `ERR_ASSERTION` and the file to load.

| Mutant | Killed by |
| --- | --- |
| m1 CRL seed-first, cache kept (the original defect) | stale+fresh; restoration |
| m2 chain from KDS first (ASK-rotation bypass) | stale+fresh (chain origin) |
| m3 cache bypassed | warm restart (new KDS call) |
| m4 `kds` without `cacheDir` | configuration |
| m5 no `cacheDir`/`dir` separation | configuration |

**Original-file baseline (informational, not mutant evidence).** The original file run against the focused test:
- `logs/baseline-original-2134.out`: 7 tests, 1 pass, 6 fail;
- `logs/baseline-original-repair-213818Z.out`: 8 tests, 2 pass, 6 fail.

In each, the passes are the defect reproduction (which itself drives the old composition) and, in the second run, the
cache-free test. Of the 6 failures, 5 are the original's **config refusal of the unknown `cacheDir` key**
(`ERR_TEST_FAILURE`), so they are not counted as assertion kills; 1 is an assertion in the configuration test. m1-m5
are the real controls.

**Harness** (workstation layout and absolute paths, so it records what ran rather than being portable):
- `harness/jobs.sh` (`6572e428…`), used for 2104 and 2134;
- `harness/jobs2.sh` (`7e46cf49…`), used for the repair;
- `harness/mutants.mjs` (`3d7bb0e3…`);
- `harness/orig/attested-authority.mjs` (`ee1ce253…`), the original file the baselines run against.

**Excluded:** keys, certificate fixtures, temp directories and binaries. The logs and TAPs contain workstation temp
paths only.

## Remaining limits

- **Not live, not hardware, not deployed.** Deployment needs root review, a writable `cacheDir`, and the config
  migration.
- **Garbage KDS CRL.** A garbage or forged KDS CRL answer blocks that attempt's fallback to the seed. It fails closed:
  rejected, never stored.
- **Wrong seeded VCEK.** It fails closed and does not self-heal from KDS, because the VCEK is seed-first so seeded
  slots need no network. Re-run `host-collateral prepare`.
- **Chain from seed only.** An ASK rotation needs a new seed, removal of the cached chain and a restart (procedure in
  the doc).
- **Rollback window.** Any authentic, unexpired CRL is accepted (existing verifier policy).
- **Lexical separation.** The `cacheDir`/`dir` check is lexical only (see above).
- **Cache write failures.** These are reported, not fatal, which is existing cache behaviour.
