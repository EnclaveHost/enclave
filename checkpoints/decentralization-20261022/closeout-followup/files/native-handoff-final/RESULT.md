# Platform API handoff: real AMD collateral plus a fresh host policy decision before K is sealed (RESULT, 2026-10-22)

**Status: source committed locally in `native-front-abort/repo` and tested offline.**
- NOT bundled, NOT imaged, NOT measured, NOT pushed.
- No SSH, live RPC, keys, wallet, funds, hardware or policy changes.
- Every key is a disposable test key. The AMD chain is synthetic: nothing here proves AMD hardware.

## Source

| item | value |
|---|---|
| repo | `work/resume-after-checkpoint-20261022/native-front-abort/repo` (the combined tree), branch `work/native-front-abort` |
| base | `2a2dd38cc` (= `f59d67af2` issuer source + my request-lifecycle patch, on `ca311820` + `d9459aae`) |
| commit | `95defc2cd3a1686cb5ae568474d8445608b4ce14`, tree `dcc66616fbc890257073a99e29847a9fd853b5c8`, author and committer SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com> |
| patch | `native-handoff-final.patch` = `git diff 2a2dd38cc 95defc2cd`, sha256 `5e459d58cd548454784b9ff0f38240c56268cb98428f169c1fff6f0966a8d80d` (3 files, +330/−13) |
| `metal/guest/platform-api-role.mjs` | `06adf4bab382725411876a1277160acb7f52b3042907bcfe9ed303040c9bcee3` (+24/−11 in `main()` and the new `productionWiring`): **bundle input** |
| `metal/guest/platform-api-verify.mjs` | `4cadc6103590f02614c6ec1f300d416ab99e44aa73309c6b0bfd61eb25bf8fbb` (+15/−1): **bundle input** |
| `test/platform-api-handoff-production.test.mjs` | `87eabeaff37a3a7210d0f5534eca1bef798d3dcd7f511bcb7c1a92ee74225739` (NEW) |

Unchanged:
- `native-issuer.mjs`, `measured-control-verify.mjs`, `verifier/*`, `network/*` (policy, `nativeHostDecision`), and the
  front;
- trust roots (the AMD ARK pins are the cache's default), the measurement and TCB checks, and the registry reader and
  its quorum;
- the policy semantics.

Every previous `2a2d`/`ca311`/`d945` behaviour is kept. The regression suites below pass.

## Both defects are real

1. **No collateral.** `main()` called `productionVerifier(cfg)`, so `collateral` was `null`.
   - `verifyMeasuredControl` then returns `unknown: AMD collateral could not be obtained` (`snp.mjs:257`: no AMD ASK/ARK
     chain).
   - No real newcomer could verify, so none could obtain the group key K.
   - Reproduced: the test's regression case calls exactly `productionVerifier(cfg)` and gets that reason.
2. **Admin bans bypassed at the handoff.**
   - `handoff()` sealed K after `verifyPeer` alone, which checks measurement + the original `registry.active` + operator +
     proof key. Nothing in `platform-api-role.mjs` consulted the platform host policy. Native leaf issuance did, twice
     (`native-issuer.mjs` steps 4 and 6).
   - So a host, operator or chip the admin banned, but still configured as a member and registry-active, received K when
     new or after a reboot.
   - Reproduced on the base: `HANDOFF_WIRING=legacy`, which is the base verifier GIVEN collateral. A registryId ban, an
     operator ban, a chip ban, a policy RPC outage, an unloadable new anchor, a policy-inactive row, and a policy row of
     another operator each got **HTTP 200 with `sealed`**. A banned member that rebooted obtained K.

## The fix (narrow)

`productionWiring(cfg)` is new in `platform-api-role.mjs`. `main()` now does
`startRole({ cfg, recoverMessageAddress, ...(await productionWiring(cfg)) })`. It provides:
- **ONE AMD collateral source:** `cachedCollateral({ dir: <dirs.root>/collateral, upstream: httpCollateral() })`, the
  same factory, directory and KDS upstream the issuer already used. It is shared by the handoff verifier and the
  issuer.
- **ONE lazily built `issuerDeps`:** the same arguments as before, with the same `policyEnv` = `relayEnvBase` +
  `platformApi.relayEnv` and no credentials. It is memoized and reset on failure, and shared by
  `nativeIssuer.deps` and the handoff.
- **Test fixtures only** (`upstream`, `roots`, `registry`, `fetch`). Production passes none.

`productionVerifier(…, { decideHost })` runs after the unchanged verification and the pinned statement re-read (same
bootId). It calls `decideHost(v.identity.registryId, { chipId: v.identity.chipId ?? null })` FRESH, which is
`freshAdmissions`, then `nativeHostDecision` with the verified chip. This is the **last await**: `handoff()` seals
synchronously after it returns.

It refuses (`{ ok: false }`, and the role answers `403 not_verified` with no `sealed` field) when:
- the call throws (`platform host policy unreadable`);
- `admit !== true`: ban, chip-unproven, behind, authority, inactive, or explicitly `off`;
- there is no host row, the row names another operator than the attested one, or it has `active === false`.

These are the issuer's checks.

Admin powers are intact: bans, delisting, and contract or admin migration act on the handoff through the existing book,
policy and registry. No new contract, authority, trust root or bypass.

## Tests

All runs used `work/claude-test-queue.py` with a fresh log each. They ran inside a private network namespace plus a pid
namespace (`run-test.sh`: `unshare -rn --pid --fork --kill-child --mount-proc`, loopback only, `timeout`), serial.

### The new test: `test/platform-api-handoff-production.test.mjs` (queue 512)

What it runs, all real:
- The holder (member 0) and the newcomer are **real roles started through `productionWiring`**.
- Every member is a **real control front** (`createControlFront`, local TLS) with statements from `mintControlKeys` /
  `controlStatement`.
- The handoff requests go **through the holder's front**.
- The AMD collateral is the role's `cachedCollateral` on its root dir. Only its upstream is synthetic: 2 chips, an ARK
  pinned by the test.
- The original registry is the real `quorumRegistry` over 3 loopback JSON-RPC servers.
- The policy is the real `issuerDeps` runtime over `platform-policy-world`, with admin-signed, anchored policies.

Four members, so two roles never make a majority: there is no relay child.

| run | tree | result | guard peak |
|---|---|---|---|
| base-default-1 | `2a2dd38c` + test | 0 / 9 (`productionWiring` does not exist) | 154 MiB |
| **base-legacy-1** | `2a2dd38c` + test, base verifier given collateral | **3 pass / 6 fail**: every ban, policy, operator and reboot case got HTTP 200 with `sealed`; the original-registry-inactive subcase was already refused | 162 |
| **fix-1** | fix (same bytes as the commit) | **9 / 9, EXIT 0** | 177 |
| **fix-2** | commit `95defc2cd` | **9 / 9, EXIT 0** | 176 |
| fix-legacy-1 | commit, legacy wiring | 3 / 6 (the same bypass, so the cases test the wiring, not the tree) | 161 |

The cases, each passing on the fix:
1. **Missing-collateral regression.** The pre-fix `productionVerifier(cfg)` refuses with `AMD collateral could not be
   obtained`. The production wiring verifies the same newcomer:
   - identity `registryId`, and `chipId` = chip b;
   - the chain is cached at `<root>/collateral/Genoa/chain.pem`;
   - a second verification makes no upstream chain fetch.
2. **Admitted handoff.** A real newcomer role (chip b) obtains K by itself, and the holder logs the handoff. A direct
   handoff answer opens, with the newcomer's attested handoff key and statement hash, to exactly the genesis K.
3. **Host and operator bans.**
   - A registryId ban and an operator ban each refuse.
   - Another member is still admitted.
   - Nothing is logged as handed to the banned member.
   - Lifting the ban admits it.
4. **Chip ban.** A ban on chip a refuses member 2 (chip a) and admits member 3 (chip b). A ban on an unrelated chip
   admits member 2.
5. **Unknown or unreadable policy.** Each refuses:
   - a policy RPC outage;
   - a new anchor whose document no mirror serves;
   - `ENCLAVE_PLATFORM_HOST_POLICY=off`, "explicitly off".

   After recovery, the member is admitted again.
6. **Inactive.** Each refuses: an inactive row in the ORIGINAL registry, and an inactive row in the policy's registry
   facts.
7. **Wrong identity.** A policy row naming another operator than the attested one refuses ("another registry row"). A
   non-member identity refuses (`not_a_member`).
8. **Reboot.** A banned member reboots, with its RAM state removed, and gets no K for 4 s (~13 asks) with no handoff
   logged. Once the admin lifts the ban, it obtains K.

Every refusal asserts three things:
- HTTP 403;
- no `sealed` field;
- K appears neither in hex nor in base64 anywhere in the answer.

### Regression suites against the fix

| suite | queue | result | peak |
|---|---|---|---|
| `platform-api-native-issuer` | 512 | **11/11** | 314 MiB |
| `platform-api-hosted` | 512 | **6/6** | 289 |
| `platform-api-forward` | 256 | 6/6 | 207 |
| `platform-api-replica` | 256 | 12/12 | 130 |
| `platform-api-config` | 256 | 5/5 | — |
| `platform-api-registry` | 256 | 0 run, 1 skipped (needs anvil and the Foundry build; not run here) | — |
| `native-control-attested` | 256 | 9/9 | 196 |
| `control-front-abort` (d945) | 256 | 17/17 | 160 |
| `native-certificate-request-abort` (2a2d) | 256 | 8/8 | 135 |
| `native-certificate-leaf` | 256 | 5/5 | 136 |
| `verifier-collateral-cache` | 256 | 11/11 | 136 |

Logs: `logs/`. Hashes: `EVIDENCE.sha256`.

Test environment (untracked, never committed):
- the repo's `node_modules` and `relay/node_modules` are symlinks to the `native-control-attested/base-eaea7e46` real
  copies, used read-only;
- `relay/network-runtime.bundle.mjs` is gitignored, pin `8399d143`;
- `base-2a2dd38c/` is `git archive 2a2dd38cc` plus the same symlinks, this bundle and the new test, used for the
  baseline. It is 182 MiB and can be deleted.

## For root (build, then activation)

1. **Bundle.** `metal/guest/platform-api.bundle.mjs` (`d2d89f01…`) is stale. Its manifest still lists
   `platform-api-role.mjs` `835ddc67…` and `platform-api-verify.mjs` `16754866…`, and it contains no `productionWiring`.
   - The bundle entry `platform-api-entry.mjs` calls `main()`, so production takes this path only after root's rebuild.
   - Rebuild it once with the recipe in the front-abort RESULT, then `--check`, then re-measure. I did not touch it.
2. **Image.** Image inputs change through the bundle.

## Remaining limitations (honest)

- **The admin CLI has the same missing collateral. Not fixed (out of scope).**
  - `scripts/platform-api-admin.mjs:100` calls `productionVerifier({ config })` with no collateral. On real hardware,
    genesis, import and recover therefore refuse every target with `AMD collateral could not be obtained`.
  - One-line fix: pass
    `{ collateral: cachedCollateral({ dir: <a local cache dir>, upstream: httpCollateral() }) }`.
  - It needs no policy decision: the admin is the policy authority.
- **`decideHost` is optional in `productionVerifier`.** When it is absent, the behaviour is as before. This keeps the
  existing injected-test callers and the admin CLI working.
  - `main()` always passes it, and the new test runs `main()`'s wiring.
  - A future caller that omits it gets no policy check. Making it required would mean editing those callers.
- **K already held.** A member that held K before a ban keeps it until it reboots. Its replica traffic is K-encrypted,
  and it stays in the configured member list. A ban stops every future handoff, including after a reboot.
  - Full removal remains the admin's existing power: change the group's `platformApi` members, or migrate.
  - There is no key rotation here.
- **Not activated.** An unanchored book under activation "anchor" still admits ("not-activated"), as the issuer does.
  That is the existing policy semantics, not a bypass.
- **Window.** The decision is the last await. Between it and the seal there is only synchronous code. A ban landing
  while the HTTP answer is in flight is not observable.
- **Not exercised here:**
  - real AMD KDS reachability and rate limits from the guest. A KDS failure refuses closed, and the newcomer re-asks
    every `askMs`;
  - the production policy configuration and RPC resolution, which match the issuer's;
  - `mcp-hosted-control` and the Foundry or anvil suites;
  - real hardware.
- **Scope.** No files outside the repo and this directory were changed. No production or policy action.
