# Admin CLI cold bootstrap: AMD collateral, a pinned submit, and a package bound to the verified boot (RESULT, 2026-10-22)

**Status: source committed locally in `native-front-abort/repo` and tested offline.**
- NOT pushed. No rebuild or image needed: the admin CLI is not a guest bundle input.
- No SSH, live RPC, real keys, real signing, funding or activation.
- Every key is a disposable test key. The AMD chain is synthetic: nothing here proves AMD hardware.

## Source

| item | value |
|---|---|
| repo | `work/resume-after-checkpoint-20261022/native-front-abort/repo`, branch `work/native-front-abort` |
| parent | `493ee9ee07497c94159ec4f6916e9ea920d31959` (root's "Rebuild the combined native platform API guest bundle", on `95defc2cd`) |
| **final commit** | **`0eac0d60bc489d3b9567e1c35d90ac5efa788a6e`**, tree `d22422385cca2df944f072d60ebb68479589382e`, author and committer SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com> |
| patch | `platform-api-admin-final.patch` = `git diff 493ee9ee0 0eac0d60`, sha256 `daeedbb2278d3ebc92aa7d7466f5d6d8c89ef4010552262c7d21cee50851db15` (3 files, +379/−17) |
| `scripts/platform-api-admin.mjs` | `204a3bf3f074f42a06c04168083da52546259bcb3f5cfac3ecc5cba5325286da` |
| `test/platform-api-admin-cli.test.mjs` | `772e4119788b277f5d29f61cd9bab056ef46e0d999d11f278d97030f74177da7` (NEW) |
| `docs/network/hosted-platform-api.md` | `f3fc46bbda6d21d38505b6455fbacb50e7a65ff7852de629f560050e5b00abee` (+12: collateral cache, pinned submit, `status` unauthenticated) |

**Outside my scope, untouched:** guest, network and verifier modules, the bundle and its manifest.
- Root's `493ee9ee0` touched only the bundle and manifest. My commit sits on top and changes none of root's files.
- The admin CLI is **not** among the 2219 bundle manifest inputs. It only imports `native-certificate.mjs`,
  `collateral-cache.mjs` and `collateral.mjs`, unmodified.
- `pinnedSocket` (`native-certificate.mjs`) is reused, not changed.

## The defect

`main()` verified every target with `productionVerifier({ config })`, with no collateral. On real hardware, every
genesis, import, recover and credentials run therefore refused the right boot with
`unknown: … AMD collateral could not be obtained`. A group could never be bootstrapped.

Root-cause case, passing on both trees: that exact call refuses a correct boot, and the same call given collateral
verifies it.

## The fix (CLI only)

1. **Collateral.** `cachedCollateral({ dir, upstream: httpCollateral() })`:
   - AMD KDS, behind a local cache of public data;
   - `--collateral-dir D` (already named in the usage text, never wired before), default
     `$XDG_CACHE_HOME/enclave/amd-collateral`, else `~/.cache/enclave/amd-collateral`;
   - the default AMD ARK pins in both the cache (`AMD_ARK_SHA256`) and the verifier. Every cache entry is authenticated
     against those pins when it is read.

   There is **no CLI or env option** for other roots, another upstream, or skipping verification. Fixtures reach only
   `main(argv, { upstream, roots, registry, afterVerify, io })`, which is in-process and test-only. The entry calls
   `main(process.argv)`.
2. **Package binding.** A package, whether freshly built or a `--package` prepared earlier, is sent only if:
   - its `kind` matches the command;
   - its `groupId` is this group's;
   - its `targetStatementSha256` is the statement of the boot **just verified**.

   Otherwise it is refused locally with `… nothing sent`. A package prepared for an earlier or another boot never leaves
   the machine.
3. **Pinned submit.**
   - `pinnedPostJson` opens `pinnedSocket(target, v.identity.controlTlsSpkiSha256)`, so the attested control key is
     compared on the secure socket before any byte.
   - It then sends one bounded JSON POST over it: one deadline, a 1 MiB answer cap, and a cut-off answer is an error.
   - The old `postJson` (unpinned, `rejectUnauthorized: false`) is now used only by `status`.
4. **Success.** The exit code is 0 only if the verified boot itself answers 200 with `ok: true`. For bootstrap, the
   answer's `groupId` must also equal the package's.
   - `main()` returns the exit code instead of setting `process.exitCode` itself.
   - `--print-message` prints only the exact EIP-191 text. It sends nothing and reports no success.

**Unchanged:** `buildPackage`, `signPackage`, `genesis`, `recover`, `initialState`, the EIP-191 message, HPKE sealing,
recovery escrow (envelope to `platformApi.recovery`), and the registry, measurement and TCB checks inside
`productionVerifier` / `verifyMeasuredControl`. No contract, trust root or policy override.

## Tests (`work/claude-test-queue.py --mib 512`, private network + pid namespace via `run-test.sh`, serial)

`test/platform-api-admin-cli.test.mjs` sets up:
- three REAL roles behind REAL control fronts (local TLS);
- statements from `mintControlKeys` / `controlStatement`;
- the original registry through the real `quorumRegistry` over three loopback JSON-RPC servers;
- one guest of another group that pins a different measurement.

The CLI runs two ways:
- **In process** through `main()`, with its own `productionVerifier` and `cachedCollateral`. Only the cache upstream
  (the synthetic chain), its ARK and the registry reader are fixtures.
- **As a child process** through the real entry, with nothing injected.

| case | what it proves |
|---|---|
| root cause | `productionVerifier({ config })` refuses the right boot ("AMD collateral could not be obtained"). Given collateral, the same call verifies it |
| **real entry, no injection** | `node scripts/platform-api-admin.mjs genesis …` with a cache SEEDED with the synthetic chain exits 1 with `did not verify: unknown: … AMD collateral could not be obtained`. Its pinned AMD roots reject the cached chain, and offline KDS is unreachable. stdout is empty, no envelope is written and the target has no K, so there is no runtime path to synthetic roots |
| no collateral | KDS down and an empty cache: refused before anything is written or sent |
| wrong measurement / registry inactive | a measured guest outside the pinned measurements is `rejected: … measurement`. An inactive original-registry row is refused. No output, no envelope, no K at the target |
| genesis prepare / sign / submit | the prepare run prints exactly `packageMessage(pkg)`, writes the unsigned package and the envelope, sends nothing (the target has no K), and caches the AMD chain. The test signs with a disposable wallet. The package aimed at ANOTHER verified member is refused locally (`not a genesis package for this group and the boot just verified … nothing sent`), and so is a submit under the wrong command. The real submit succeeds (`groupId` matches) and the target holds K. The envelope opens with the recovery key to exactly the K sealed to that boot's handoff key |
| credentials | sent to a non-primary: the boot's own 409, exit 1, no success. Sent to the verified primary with `--admin-key`: 200 with `names: ['STRIPE_WEBHOOK_SECRET']`, and the value appears in no output |
| **wrong key at submit** | a TCP switch in front of the primary is flipped to an impostor TLS key right after verification. The impostor accepts the connection and receives **0 bytes**. The CLI throws `not the attested key` and prints nothing |
| total loss / recover | all roles stopped and RAM state removed, one fresh boot. `recover` with the recovery key, envelope and a sink's latest archive returns 200, the boot holds K, and its role logs `recover package from admin … accepted` |

| run | tree | result | peak |
|---|---|---|---|
| **final-1** | **`0eac0d60` (final commit)** | **9 / 9, EXIT 0** | 282 MiB |
| fix-r2 | same bytes before the amend | 9 / 9 | 287 |
| base-493ee9ee-1 | parent `493ee9ee0` + the new test | **3 pass / 6 fail**: every in-process case fails `ADMIN_CLI.main is not a function` (the base exports none). The real-entry case PASSES on base: the base CLI refuses the right boot with `AMD collateral could not be obtained`, which is the defect. Root cause passes | 232 |
| **mutant-nopin-r2** | final commit with ONE line reverted to the old unpinned `postJson` submit (`mutant-nopin/`) | **8 pass / 1 fail**: the wrong-key case, `638 !== 0`. The signed credentials package reached the impostor, and the CLI waited 30 s for its answer. So the 0-bytes assertion is meaningful | 294 |
| mutant-nopin-1 | same mutant, the earlier assertion order | 8/1 (`timeout` instead of `not the attested key`) | 292 |
| fix-1, fix-2, fix-4, fix-5, fix-6 | development runs | fix-1 not started (exit 98); fix-2 fixture error (my guest X was not a member of its group); fix-4 8/1 (my impostor counted only established sessions); fix-5 8/8; fix-6 9/9 with the root-cause case added | — |

Several retries returned exit 98 (lane held) and were rerun with fresh logs; those empty logs were removed.

### Regression (against the fix, 512)

| suite (imports the admin library functions) | result | peak |
|---|---|---|
| `platform-api-hosted` | 6/6 | 289 |
| `platform-api-native-issuer` | 11/11 | 318 |
| `platform-api-handoff-production` | 9/9 | 178 |

Not rerun, because their sources are untouched by this commit: the front, request-abort, collateral-cache and replica
suites (all green in `native-handoff-final`).

Logs: `logs/`. Hashes: `EVIDENCE.sha256`.

Test trees, untracked:
- `base-493ee9ee/` is `git archive 493ee9ee0` plus the new test;
- `mutant-nopin/` is `git archive` of the commit plus the one-line mutant.

Both have `node_modules` symlinks and the gitignored network-runtime bundle (`8399d143`). Each is about 180 MiB and
can be deleted.

## Limitations (honest)

- **KDS.** Real AMD KDS reachability and rate limits (429) are not exercised, because the tests are offline. A KDS
  failure with an empty cache refuses closed. After one successful run the cache serves later runs, re-authenticated
  against the AMD pins on each read.
- **`status`.** It is still an unauthenticated, unpinned GET (`rejectUnauthorized: false`) and is advisory only. Its
  answer is never used to decide anything.
- **URLs.** `--envelope` / `--archive` may be fetched over plain `fetch` URLs. Both are ciphertext: the envelope is
  under the recovery keys and the archive under K. The role AEAD-opens the archive and checks its group, so a forged
  one is refused there, not by the CLI.
- **Envelope timing.** `genesis` writes the recovery envelope when the package is built, at prepare time or before
  signing, as before. If the run then stops before submitting, the envelope escrows a key that was never installed. It
  is harmless and is overwritten by the next genesis.
- **What 200 proves.** A pinned 200 proves the answer came from the attested control key's front. It does not prove the
  admin's signature was valid; the role checks that against `platformApi.admins`, and the test covers both admit and
  refuse.
- **Policy.** The admin path does not consult the platform host policy: the admin is that policy's authority. This is
  unchanged.
- **Not run:** real hardware or KDS, and real wallets. Root handles all real wallet steps.
