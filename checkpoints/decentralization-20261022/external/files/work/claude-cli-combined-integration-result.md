# Combined independent CLI integration: result (claude, 2026-10-20)

**Workspace:** `/home/steven/Documents/Codex/2026-10-18/wo`. **Repo:** `work/enclave` at HEAD `abe86262`.
- The integration was done ONLY in the isolated tree `work/cli-combined-integration/tree`, a snapshot of the working tree
  as found; its pristine copy is `base/`, with `base-manifest.sha256`.
- No main file was edited. Nothing was committed or staged, and `cli/dist` in main is untouched (`9db0f36a…`).
- No live chain, SSH, production, wallet, Wine or GUI.

**Deliverables (all under `work/cli-combined-integration/`):**

| Deliverable | File | sha256 |
|---|---|---|
| Full patch | `cli-combined.patch` (1226 lines) | `50ee1468c3376195e853746ec68ececc662d8f3ae18574da82e8df69616f6e56` |
| Add/modify inventory, dependencies, git states | `manifest.json` | `cc2d50275ca4feea5c3d8712eebb4fb573f35a89a0eaedd60cf07f742f5404f1` |
| Every guarded run | `logs/` (with `run-guard.sh`) | — |
| Interface | `work/cli-combined-integration-interface.txt` | — |

**Patch checks:**
- Applying the patch to a fresh copy of the base reproduces every tested file byte for byte.
- `git apply --check` passes on main as it is now: no file of the closure changed since the snapshot.

## Closure (the ONLY files root should apply)

| | path | base (main now) | after |
|---|---|---|---|
| M | `cli/enclave.mjs` | `5c21db40` (modified, unstaged) | `8ebe34114983a001fac385eef3f665cae38ba0dabb9a013f94073957f767a781` |
| M | `cli/independent.mjs` | `36b3a364` (untracked) | `82996c8c27e67217c21764ca8275643d5a2bef25678025d32d045e38386a72d1` |
| M | `cli/build.mjs` | `48e929dd` (tracked) | `55880f74cab9df8a2fc3c0e356422e1403bc19b4f7193f3e2f87b4a0d21df108` |
| M | `supervisor.js` | `8d1b9262` (move-fix freeze) | `b8149871f8e035bd5d61089825be5d82867e05cdd6c3aff6d9a9fc0dd4dea581` |
| M | `cli/host-independent-lifecycle.mjs` | `ad52747a` (coordinator) | `6ac708f61fd21ec9c7cfb9fc244820e3c627f213b69875ea1516dbaf8ed0aaa1` |
| M | `test/cli-host-independent-lifecycle.test.mjs` | `e223b36e` | `c17daebe64f1cb125411ed68b17e098e9a3dd08ea7d551ba72d60de6853bb097` |
| M | `docs/network/independent-cli.md` | `d3660d23` | `77ba9a802fe075ab882ff85badd8bdc76f76583cde6dcc5ba667b853abdac8e6` |
| M | `test/cli-independent.test.mjs` | `a5c2fed2` | `726940e769c3fc8fc9041a8c99d1a8cba2d294f9283834166e1deac8df23e355` |
| M | `test/cli-independent-sessions.test.mjs` | `1cc1d3e2` | `69929861f6b96cb884a60d4f44c05da0530383c21485ce7abc0c7b70c5b77248` |
| A | `test/cli-independent-signer-cli.test.mjs` | | `01179081daf036b10d90d17be422e7b88122d4238436abe37213088f92ccc2af` |
| A | `test/cli-capacity.test.mjs` | | `3cd21bb7a363a90ecde71036e408865fb77c60feb8a2eda82c4f7b404e0b71c9` |
| A | `test/cli-combined-independent.test.mjs` | | `a38de9fbeb0a227e1195fc9a9059f6c963ba15dfbd4e1835d7c3dc219232d495` |
| A | `test/cli-combined-custody.test.mjs` | | `795ea7ab2d987f5abc11a88a5f2a0f6c8f274bc64caa5b53ff89eb40d8730536` |

**Must be committed with the closure (unmodified dependencies).** `manifest.json` lists every one with its tested
hash, main's hash and its git state. Main still holds exactly the tested version of each, except as noted under
"Custody" below. They include:
- the untracked CLI helpers: `cli/independent-login{,-cli}.mjs`, `cli/independent-signer.mjs`,
  `cli/independent-capacity.mjs`, `cli/independent-host.mjs`;
- `network/host-capacity{,-http,-record,-producer}.mjs`;
- their docs and tests;
- `test/helpers/{cli-independent-rig,cli-network-guard,loopback-only-fetch,host-capacity-fixture}.mjs`;
- the move-fix freeze (`test/cli-independent-move.test.mjs`, `test/cli-move-same-operator.test.mjs`).

**Custody (owner-secrets 44340).**
- `cli/custody-independent.mjs` is NOT in the closure. Main holds `db712c1d`, owner-secrets' unfinished CRUD work. The
  tree ran the custody CLI freeze `1fac6dc4`, restored byte-exactly from its author's transcript and kept as
  `custody-independent.1fac6dc4.mjs`.
- The tree also ran HEAD's `custody/*` code, because main's `custody/rules.mjs` and `custody/v2/*` carry owner-secrets'
  unfinished measured edits.
- After the snapshot, main's `test/custody-cli-independent.test.mjs` changed (22:19) to `6f66e650…`. The tree ran
  `28550e42`.
- The glue only calls `cmdCustodyIndependent(rest, h)`, which both versions export with the same handles.
- Secret CRUD stays PENDING: `secrets` is refused independently and names the owner read.

## What was integrated, and what had to be resolved deliberately

| Feature | Applied |
|---|---|
| Login (`independent-login-cli-glue.patch`) | as is |
| External signer (`enclave`, `independent` and doc patches) | the `INDEPENDENT_COMMANDS` hunk conflicted with login and custody; merged by hand |
| Custody glue | same hunk conflict; merged by hand |
| Host lifecycle 01 (CLI) | as is |
| Host lifecycle 02 (supervisor key file + `BASE_RPCS`) | applied on the move-fix freeze `8d1b9262` (written for `2b7dd8b8`; the hunks are outside the move-fix region) |
| Host lifecycle 03 | rebased onto the coordinator's helper/test, preserving the exact installed-env comparison (`envFileText(supervisorEnv(…, localSecrets))`), the run spawn-error capture (`child.once("error")`, forwarders removed on every exit) and the attestation-URL UNKNOWN status; verified by diff |
| Capacity (CLI side only, from the published inventory) | `cli-enclave`, `cli-docs` and `cli-independent-test` patches |

Every one of the capacity inventory's 38 hashes was re-checked on disk, and all matched. The capacity worker's
`supervisor.patch`, `dockerfile.patch` and `windows-agent.patch` are not included (measured image scope), but all three
still `--dry-run` cleanly on top of the closure.

**Merged by hand:**
- `INDEPENDENT_COMMANDS` gains login, logout, account, signer and custody.
- The `custody`, `login`, `logout` and `account` refusals are removed.
- The `secrets` refusal is rewritten precisely: whole-map custody works; per-KEY CRUD needs the owner read, which is
  not integrated.
- Independent help lines added for host lifecycle, login, custody and move.
- The CLI doc's refusal list is rewritten.
- The doc says plainly that the supervisor's reads stay first-answer.

**Real defects found by the integrated tests, and fixed in the closure:**

1. **Bundle-only double execution.** Four helpers decide "am I main?" by comparing `process.argv[1]` with
   `import.meta.url`: `cli/independent-capacity.mjs`, `cli/host-independent-lifecycle.mjs`,
   `windows/node/host-identity.mjs` and `scripts/network/fetch-runtime.mjs`.
   - Inlined into ONE `cli/dist/enclave.mjs`, that is true for every module.
   - Evidence: the built CLI ran the capacity tool's own `main` under `enclave availability` (`independent-capacity:
     unknown flag --independent`, then `process.exit(1)`), and ran `hostLifecycle` a second time under `enclave host`
     (`host: unknown command --independent`, exit 1 after a successful `init`).
   - Source runs could not show this.
   - Fix: the bundle banner (`cli/build.mjs`) hides `argv[1]` before any bundled module runs. The CLI never reads it.
     This also covers lazy imports.
   - Recommended to the owners: an own-filename guard.
2. **Global-flag collisions.** `enclave`'s global parser removes `--json`, `--yes` and `--from` wherever they appear,
   so:
   - `custody migrate --from FILE` became the signer wallet address;
   - `custody clear --yes` could never confirm;
   - `host check --json` never reached the lifecycle.

   Fix in the glue: `commandFlag()` hands back the value written after the command word (custody `--from`); either
   `--yes` confirms; `check` receives `--json`.

   Limitation, stated: one invocation cannot carry BOTH `--signer --from ADDR` and `custody migrate --from FILE`. It
   refuses with the signer's precise `--from` error.
3. **Lifecycle defaults in the bundle.** The default `--supervisor` and `--isolation` paths came from
   `dirname(import.meta.url)/..`, which is `cli/` in a bundle. The helper now finds the checkout from `cli/` or
   `cli/dist/`; without one, `run` refuses until `--supervisor`/`--isolation` are given.
4. **Existing tests asserted the old refusals.** These are deliberate behaviour changes:
   - `login`/`account`: `login` now refuses with "--frontend"; `account` reports local state;
   - `session resume-wait`/`top-up-link`: no relayer; each refuses precisely;
   - `host init|run|install`: need `--dir`.

   The assertions were updated with precise new expectations; nothing was removed.
5. **Moved test adaptations.** `cli-capacity.test.mjs` moved into `test/` with its paths re-rooted. It and the signer
   CLI test now accept `ENCLAVE_CLI_ENTRY`, so the same cases run against the bundle.

## Tests actually run

**Run conditions:**
- Serial and foreground under `logs/run-guard.sh`. It refuses to START below 18432 MiB MemAvailable (once it refused,
  and the run waited for capacity), kills at a 768 MiB process-group RSS (512 for small suites), below 16384 MiB
  available, or after 900 s.
- No run was killed. The lowest MemAvailable during any run was 17414 MiB, above the 16 GiB floor.
- Swap was already fully used on this host by other processes; the guard measures RSS, not swap.
- Real local anvil throughout. No mocked CLI: every "CLI" suite spawns `cli/enclave.mjs`, or the built bundle, as a
  subprocess.

**Freshness:** every result below ran on the final closure source. The last source edit was at 22:01:45; the doc-only
caveat added afterwards is read by no test. The bundle runs used the final build.

| Suite | Source | Built bundle `tree/cli/dist/enclave.mjs` (`4d3019d3…`, 3,853,239 B) | Peak RSS (src / bundle) |
|---|---|---|---|
| `cli-combined-independent` (new: login grant→approve→resume/account/top-up-link/logout; hand-back with the CLI's gas key; host init/install/run/check via `enclave host`; dispatch) | **4/4** | **4/4** | 384 / 507 MiB |
| `cli-combined-custody` (new: create, rotate, pause/resume, recover via transfer+claim, migrate `--from` sealed, clear `--yes`) | **3/3** | **3/3** | 506 / 486 MiB |
| `cli-independent-signer-cli` (signer through the real CLI) | **3/3** | **3/3** | 572 / 553 MiB |
| `cli-capacity` (capacity listing through the real CLI; without `--independent`, byte-identical to the pristine base) | **3/3** | **3/3** | 282 / 280 MiB |
| `cli-independent` (shared) | **14/14** | **14/14** | 535 / 536 MiB |
| `cli-independent-sessions` (shared) | **13/13** | **13/13** | 533 / 510 MiB |
| `cli-independent-move` (rerun: shared CLI changed) | **6/6** | **6/6** | 651 / 619 MiB |
| `cli-move-same-operator` | **1/1** | **1/1** | 507 / 507 MiB |
| `custody-cli-independent` (11 in-process + entry point, `CUSTODY_GLUE_CLI=cli/enclave.mjs`) | **12/12** | — | 503 MiB |
| `cli-host-independent-lifecycle` (patched; the real supervisor with patch 02's key file) | **10/10** | — | 308 MiB |
| `cli-independent-login` / `cli-independent-signer` / `host-capacity` (modules) | **8/8 · 13/13 · 9/9** | — | ≤ 406 MiB |
| hosted `cli.test` · `direct-only-supervisor` | **76/76 · 4/4** | — | 267 / 237 MiB |

**First runs that failed** (before the fixes):
- `cli-combined-independent`: 2/4 (hand-back needed `--yes`; `check --json` collision), then 3/4 (a nonce baseline in
  my test), then 4/4.
- `cli-independent`: 13/14, and `sessions`: 12/13 (old refusal assertions). Updated, then passing.

**Negative controls** (temporary files in the tree only, removed afterwards):
- CLI without the flag hand-back: custody `migrate` fails with `migrate needs --from`, and host `check` prints no JSON.
- Bundle without the banner: the host test fails with `host: unknown command --independent`; capacity fails 2 of 3
  with `independent-capacity: unknown flag --independent`.

**Not run here:**
- the site/browser bundle (account-first 85677 owns it);
- the capacity supervisor/Windows/Dockerfile tests (not in the closure; apply checks only);
- live wallets (signer fixtures only, as in their worker's report);
- a real custodian.

Four short probe invocations of the CLI (no anvil, about 100 MB each) were run outside the guard while diagnosing the
bundle defect.

## First-answer supervisor reads that REMAIN (not hidden by the CLI's quorum)

`supervisor.js` (`after` hash above) reads through `chainClient` = viem `fallback` over `RPC_POOL` (lines 308-313,
3497). That is the FIRST answering RPC, never an agreement. Patch 02's `BASE_RPCS` only narrows the pool to the
operator's own RPCs.

**Decisions taken on first-answer reads:**
- **ledger:**
  - `syncLedger`/getPage and its log scan (10528, 10494): sweep, audit teardown/re-acquire, renewal decisions;
  - `readLedgerContract` (9475);
  - the move-fix `pinnedLedgerRow` (9598): block-pinned, so a lagging node errors instead of answering stale, but still
    ONE RPC's word;
  - release receipts and nonces (`awaitReceipt` 9378, `resolveReleaseTx` 9701, `checkBootTxFence`);
- **registry:** `registryRev` (538), `registryEntry` (686), price and proof-key sync;
- **catalog and admission:** `gateAppReference` (6426: approval), `feeGate` (6640), `hostChargeWaived` (6544),
  `rateCapRefusal` (6564), `openForUs` (11127), `claimBondReady` (9430), `depsAbi` (9213);
- **owner and session authorization on the supervisor itself:** `sessionApi` (3529, `pc: chainClient`). The management
  gateway in front re-authorizes against a quorum, but the supervisor's own `mayAct` and signed claim-hint decisions
  are first-answer;
- **payments and proofs:** the forwarder `getLogs` (7256), `planCheckpoints` (11621, 11707), payout and settle.

**Already agreement-based:** host wallet admission (`hostAdmissionFromEnv` → `agreed()` over at least 2 HTTPS
origins).

**Closing these** needs a quorum reader in the supervisor (or the measured control guest) for every decision above. It
belongs to the measured-control integration (31818). It is not claimed here.

## Remaining blockers (precise)

1. **Owner-secrets CRUD** (`secrets ls/show/rm/set KEY`): not integrated. It waits for owner-secrets' final source and
   a new measured custodian image. Once frozen, `cli/custody-independent.mjs` and the custody code must be
   re-integrated with this glue and the combined custody test re-run.
2. **Same-operator move parity:** OPEN. The CLI still refuses it. It needs the lease-generation contract ABI and
   migration, which are not wired.
3. **Host readiness:** not claimed. `host check` reports the control attestation as UNKNOWN or missing; measured
   control boot is open (31818).
4. **The supervisor's first-answer reads** listed above.
5. **Signer:** no real wallet, Clef binary, Frame or MetaMask was tested; Frame's `eth_signTransaction` is unverified;
   EOAs only.
6. **Login:** passkey-only first deployment (ERC-6492 or a gas payer), hosted credit and order history, and budgeted
   hand-back remain open, per the login report. No real Safe or passkey was tested.
7. **Capacity:** the supervisor, Dockerfile and Windows producer patches (a measured image change) are not in this
   closure.
8. **Browser bundle** (`site/vendor/management.js`, account-first 85677): it stays with that worker and root.
9. **Owner follow-up (not blocking):** use an own-filename main guard in the four standalone-capable helpers. The banner
   already protects the bundle.
10. **Cosmetic:** the lifecycle's `next:` hints still name `node cli/host-independent-lifecycle.mjs …` when run through
    `enclave host`.
