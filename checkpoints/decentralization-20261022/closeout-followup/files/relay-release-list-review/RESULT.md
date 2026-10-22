# Queued apps "the relay's release list could not be read": RESULT r2 (2026-10-22)

> **r2 (root review 23:17, ROOT-REVIEW.md, incorporated):**
> - A null, mismatched-id or non-string-appRef confirmed row is now 503 `release_status_unavailable` (unknown), never
>   `listed:false`. The previous revision read a null row as unlisted and ANOTHER deployment's row as listed.
> - An agreed `no_deployment` stays `listed:false`.
> - Comments and claims are corrected: the evidence shows intermittent slow status reads for SOME unlisted deployments, not
>   all ten queued apps (see "Scope of the finding").
> - FINAL pins are in section 3; superseded r1 pins are marked.

**Status: source only.** A relay correction is committed locally in an isolated candidate and tested offline. It is NOT
deployed, NOT pushed and NOT activated.
- I did no SSH, network probe, production change, wallet or fund action.
- `work/enclave` and the final Windows `2afa6733` candidate are untouched.
- No secret or config release gate is bypassed. No deployment is assumed to have no secrets. Admin moderation and custody
  paths are unchanged. Root owns the live reads and activation.
- See `INITIAL.md` for the full source trace and the live reads requested.

## 1. Finding (source-proven mechanism, consistent with root's 23:09Z live reads)

**The message.**
- It comes from the Linux supervisor's per-app SNP claim gate (`isolationClaimVerdict`, supervisor.js 2625–2626) when
  `releaseListedFor(id)` returns `unknown`.
- That happens on any non-clean answer from `GET ${SECRETS_API}/v1/secrets/release-status`, or none within
  `AbortSignal.timeout(5000)`.
- This is correct fail-closed behaviour and is not changed.

**The relay** (`relay/secrets-release.mjs` `releaseStatus` → `releaseListed`; installed 93d543e6 has the identical
functions):
- An id in `SECRETS_RELEASE_DEPLOYMENTS` answers at once with no I/O.
- Any other id, while `SECRETS_RELEASE_APP_REFS` is set (live: `catalog://0x962622b0…/0`), waits on `rowOf` →
  `ctx.ledgerRows()`. That is a full-ledger scan: `count` plus `getPage` × 50, serially, over ONE viem client on
  `BASE_RPC` (default `mainnet.base.org`, viem defaults 10 s × 4 attempts), cached only 10 s.
- From the relay's egress on the minipc control VM (the site's shared IP, already measured as rate-limited) that exceeds the
  supervisor's 5 s.
- **Live (root):** the listed adapter id answered 200 `listed:true` at once. The unlisted `0x59f1273d` received no byte in
  15 s.
- When a scan is slow, an SNP deployment not explicitly listed reads `unknown` and is refused for that sweep with exactly this message. This happens intermittently, not for every such deployment or every sweep; see "Scope of the finding".

**Second defect.** A FAILED scan is caught by `rowOf` (→ `null`), so the relay answers 200 `listed:false`. "Unknown read as
unlisted" is exactly what the supervisor's three-state contract forbids. Secrets still fail closed at the spawn.

**Scope of the finding (corrected by root's live evidence: ROOT-LIVE-EVIDENCE.md, ROOT-REVIEW.md).** This does NOT
explain all ten queued apps, and it is not every unlisted deployment all the time.
- Effective `BASE_RPC` = publicnode.
- **Direct backend 23:12:** listed ids answer in 7 ms; EnclaveDNS (unlisted) answered in 652 ms, 200 `listed:false`. One
  public read (23:09) of the same unlisted id timed out at 15 s.
- **Four ingresses 23:14:** all 200, 0.38–1.91 s.
- **The Linux journal:**
  - cron and c13d: `release unknown` refusals;
  - eyesoff and da09d: reach a claim, then 422 Unaffordable (reserve/caps, plus transient quorum errors).
- **Catalog RPCs** publicnode/blast/tenderly are configured and healthy.
- So the full-scan wait is an intermittent cause for some unlisted SNP deployments. Funding is separate, and this change
  does not fund anything.

## 2. Correction (relay only; supervisor unchanged)

**Change** (`relay/secrets-release.mjs`, `releaseStatus` only; +30/−1). For an id NOT listed by id while app refs are set:
- read exactly that row by id with `ctx.confirmRow(id)`: one `get(id)` agreed by two or more independent
  `SECRETS_RELEASE_CATALOG_RPCS`. Release already requires this (`missingFor` → `predictorProblems`), and the release itself
  uses it;
- bound it at `STATUS_ROW_MS = 4000` (below the supervisor's 5000; tests may only shorten it via
  `SECRETS_RELEASE_STATUS_ROW_MS` 50..4000);
- a read that fails, disagrees or times out answers **503 `release_status_unavailable`**, never `listed:false`. So does a
  confirmed row that is not exactly this deployment's (null, a different id, or a non-string appRef). The public body names
  nothing of the relay's reads; a `[secrets-release]` line goes to the relay log;
- an agreed `no_deployment` answers `listed:false`.

**Unchanged:**
- id-listed answers (no I/O), `release_off`, 422 and the 429 rate limit;
- `releaseListed` as used by the ticket and release paths;
- tickets, attestation, prediction, custody and admin moderation;
- the supervisor's three-state reading. It already maps any non-`release_off` 503 to `unknown`, so no supervisor change or
  rollout is needed.

**Expected effect live:**
- an app-ref deployment answers within about 1–4 s from two agreeing single-row reads instead of a multi-page scan;
- if the catalog RPCs are ALSO limited, the answer is a fast 503 → `unknown`: still queued, but honest and cheap.

## 3. Commit, patches, hashes

| item | value |
|---|---|
| candidate | `relay-release-list-review/candidate`: an rsync copy of `source-checkpoint-20261022/main-repo` (e557a656b) without .git/checkpoints/shielded/docs; node_modules symlinked to `work/enclave` (read-only resolution) |
| baseline commit | `42ac956` (secrets-release.mjs `be22b456…` = work/enclave = main-repo) |
| r1 commit (SUPERSEDED) | `537471de…` (module `7d9c9f8e`, installed lineage `6ffa1b60`, test `42346c68`): do not deploy |
| **FINAL commit (r2)** | **`ad074e249532c0efe40b71f7ecb391039b33a3c6`**, tree `76fb81883e3a7036a3a59ce64bcd7e67fb000c38`, parent `537471de`; author and committer SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com> |
| `relay-release-status-lookup.patch` (`git diff 42ac956 ad074e24`) | `af1fcaff3aabf4c8baf2ed70b9c2d5bd53350c8ef2ef4c571ff705bb8c9b7423` (2 files, +163/−1) |
| `relay/secrets-release.mjs` (repo lineage) | `be22b456…` → **`1cb53b64470c54a2d21bfd2d19626c1afe82b7282345ed8170e48803e6fdd50e`** |
| **installed lineage (deploy this)** | root's `relay-release-live/installed-secrets-release.mjs` `93d543e61b5cb8254087fce04bf776832fb6215c9d08f8a05ddeb411d02582e2` + ONLY the reviewed `releaseStatus` hunk (1 hunk, 1 removed line, applies at offset −16) = **`secrets-release.mjs.installed-lineage` `48cf67ee80a088f3b713eaed401273a97aecb3aeca7204f320e0f22083405715`**. The diff `relay-release-status-lookup.installed.diff` is `2313c877d43fb05121a8202c2bef6c0d6688d1f713972d718077e5907113ed1e`; re-applying it to 93d543e6 reproduces 48cf67ee (checked) |
| `test/secrets-release-status-lookup.test.mjs` (new) | **`36d0ce82a3231f4ef32e89624e3ffea0fb3cb8be344b0a5256d380b74bb445cb`** |
| `job-tests.sh` (bounded runner) | `ef5270b6a55d06bed6d12def4d94cdba2f31b0a116abd6d9eb330ef4b394afcb` |

**Activation (root):**
- Replace `/opt/nan-relay/secrets-release.mjs` `93d543e6` → **`48cf67ee`** and restart only the `enclave-api-relay` service
  (not the VM). That is a single-module swap; the installed `api-relay.js` already passes `confirmRow` in the relay context.
- Then re-read INITIAL.md section 4 probe 2 (an unlisted queued id: 200 or a fast 503).
- Rollback: restore `93d543e6`.
- The relay is not part of the measured guest image.

## 4. Tests

All runs went through `claude-test-queue.py`, offline: `unshare -rn --pid --fork --kill-child`, `--test-timeout`, outer
`timeout -k`, with ssh/scp/sftp denial stubs proved first. Raw logs are in `logs/`.

**The new test:**
- **Part 1:** the REAL `handleSecrets` → `releaseStatus` with a relay context whose full-ledger scan answers only after 8 s
  (longer than the supervisor waits). Cases:
  - an id-listed deployment answers with no read;
  - an app-ref deployment reads ONE confirmed row and never the scan, at once; another version is unlisted;
  - agreed no-such-deployment is unlisted;
  - quorum failure, disagreement and a hanging read are each 503 `release_status_unavailable` within the bound, with no
    `listed` and no RPC detail;
  - `release_off`, 422 and 429 are unchanged;
  - the production bound is checked against the supervisor's own timeout, parsed from supervisor.js.
- **Part 2:** the REAL supervisor (`RELEASE_SELFTEST {"listed"}`) against the REAL handler over loopback HTTP.

**r2 FINAL** (`logs/r2-final-512`, one 512 MiB job; the supervisor child peaks around 250–263 MiB; test `36d0ce82`):

| tree | module | result |
|---|---|---|
| candidate | `1cb53b64` | **4/4** |
| installed lineage | **`48cf67ee`** | **4/4** |
| previous revision r1 (control) | `7d9c9f8e` | **FAILS the new cases as required.** The unreadable-row case got 200 instead of 503. The supervisor read null → `unlisted` and another deployment's row → **`listed`**, where r2 gives `unknown`, `unknown` |

New r2 cases: a null row, another deployment's row (of the listed version) and a non-string appRef each give 503 within the
bound, and the supervisor reads them as `unknown`. The agreed `no_deployment` → `listed:false` case is kept.

Per root, the unchanged existing release suites were NOT re-run (c3: 41/41 on r1; that diff touches only `releaseStatus`).

**r1 runs (superseded module, retained):**

| run | tree | cap | result |
|---|---|---|---|
| `c2` | candidate (7d9c9f8e, test 42346c68) | 256 | **4/4** (peak 252) |
| `b3-baseline-512` | `tmp/base-tree` (hard-linked; secrets-release `be22b456` as a separate file) | 512 | **FAILS as expected.** The app-ref case times out on the scan; the unreadable row gets **200 instead of 503** (the fail-open); the supervisor reads **`['unknown','listed','unknown','unknown']`** where the fix gives `['listed','listed','unlisted','unknown']`. That is the production symptom reproduced: the app-ref deployment unknown, the id-listed one fine |
| `i1-installed-lineage-512` | `tmp/installed-tree` (installed 93d543e6 + hunk = 6ffa1b60) | 512 | **4/4** (peak 254) |
| `c3-existing-512` | candidate | 512 | **41/41** existing `secrets-release.test.mjs` + `isolation-release-ticket.test.mjs` (peak 279) |

**Retained non-results:**
- `c1`: 4/4 on an earlier test revision whose scan never resolved.
- `b1-baseline`: that revision on the baseline gave 4 CANCELLED, not failed: a promise with no pending timer lets Node's
  event loop drain. That was a weak control, so the scan became an 8 s timer (c2/b3/i1).
- `b2-baseline`: two expected failures, then exit 99 at 269 MiB > 256 in the supervisor case; re-run at 512 as b3.

## 5. Limitations

- Attribution to the 10 queued apps is unconfirmed until root's reads in INITIAL.md section 4:
  - the queued ids versus the listings;
  - loopback versus front timing;
  - the `BASE_RPC` and catalog RPC hosts;
  - the relay journal;
  - the SNP host's journal and its `SECRETS_API`.
- If the catalog RPCs are also throttled from that IP, deployments stay queued, correctly. Fixing the relay's RPC egress is
  root's call; I proposed no RPC config change.
- Not changed, but reported:
  - `clientIp` assumes exactly one trusted proxy. Behind the DO front plus local Caddy, all callers may share one
    status/release rate bucket (burst 30, 1/s);
  - the release path's own lease-holder lookup (`rowOf` via the scan, secrets-release.mjs ~446) has the same full-scan
    cost, but it fails closed (no lease → refused);
  - the installed relay is an older build (no writer-authority facts) than `work/enclave` and main.
- Listing more deployments (`SECRETS_RELEASE_DEPLOYMENTS`) is an owner or admin enablement decision, not proposed here.
- Not run: the relay as a whole process, the hosted platform-API front, any real RPC.
