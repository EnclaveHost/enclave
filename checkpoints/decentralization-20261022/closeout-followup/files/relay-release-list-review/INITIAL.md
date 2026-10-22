# Queued apps: "the relay's release list could not be read" (INITIAL source trace, 2026-10-22)

> **Correction (r2, after root's live evidence):** the "every unlisted SNP deployment … fleet-wide" wording in section 3 was
> a hypothesis, NOT proven.
> - Root measured intermittent slowness (652 ms direct, one 15 s public timeout).
> - The journal shows `release unknown` refusals only for cron and c13d. eyesoff and da09d are 422 Unaffordable.
> - See RESULT.md "Scope of the finding". The source mechanism below stands.

Source only, plus root's own live reads in `../relay-release-live/`. I did no SSH, network probe, production change, wallet or
fund action.
- The Windows `2afa6733` candidate and `work/enclave` are untouched.
- The confidential release gate is not bypassed, and no deployment is assumed to have no secrets.

## 1. Where the message comes from (source trace)

**The Linux supervisor** (`work/enclave/supervisor.js` 5b94290b; the same functions are in main-repo `89ebb50a`).

**The claim sweep for a candidate deployment** (supervisor.js ~11755–11772):
- **The ask.** On an isolation host it asks the relay's list ONLY when all of these hold:
  - `ISOLATION_BACKEND` is set;
  - the deployment requires THIS backend (`claimOpts.isolation === ISOLATION_BACKEND`);
  - guestd's /health says it is that backend with release on (`isolationReleaseOn`);
  - there is no owner-committed bootstrap.

  So the message comes only from an SNP per-app host (metal0's class), for deployments requiring `snp-guest-per-app`.
  A Windows/Hyper-V deployment is refused earlier with a different message.
- **The call.** `releaseListedFor(id)` (2739) does `GET ${SECRETS_API}/v1/secrets/release-status?id=<id>` with
  `AbortSignal.timeout(5000)`. `SECRETS_API` defaults to `https://api.enclave.host` (7265). It returns one of three states:
  - **listed**: 200 `{id, listed:true}`;
  - **unlisted**: 200 `{id, listed:false}`, OR 503 `{error:"release_off"}`;
  - **unknown**: anything else: a timeout of 5 s or more, a network or TLS error, 429, any other 5xx/4xx (including 503
    `secrets_disabled`, 500 `secrets_error`, 404), a malformed body, or an id mismatch.
- **The refusal.** `isolationClaimVerdict` (2625–2626) refuses the claim on `unknown` with exactly this message. The spawn
  (2772) and CID-config (2759) gates refuse too. This is correct fail-closed behaviour: an unknown must never build a
  listed app on the legacy image, and no secret or config crosses the host.

**The relay** (`relay/secrets.js` 4c491271, `relay/secrets-release.mjs` be22b456 in both trees).
- **Installed** (root's copy, `../relay-release-live`): `secrets-release.mjs` 93d543e6 (an OLDER build: no writer-authority
  facts), `api-relay.js` 481f0041. `releaseListed` and `releaseStatus` are byte-identical to source; `ledgerRows` and
  `chain()` are identical too.
- **Routing.** `/v1/secrets/*` goes to `handleSecrets` (api-relay ~3041; a thrown error becomes 500 `secrets_error`). If
  secrets are disabled the answer is 503 `secrets_disabled`, before the status route. Otherwise `releaseStatus`
  (secrets-release.mjs 328 / installed 316):
  1. a per-IP rate limit: `rlRelease`, key `status:<clientIp>`, burst 30 (SECRETS_RELEASE_BURST), refill 1/s;
  2. `missingFor` → 503 `release_off` (read as unlisted);
  3. `releaseListed(ctx, cfg, id)`.
- **`releaseListed`** (secrets-release.mjs 188):
  - an id in `SECRETS_RELEASE_DEPLOYMENTS` returns `true` at once, with no I/O;
  - otherwise, if `SECRETS_RELEASE_APP_REFS` is set, it calls `rowOf(ctx, id)` (fleet-auth.js 60) =
    `ctx.ledgerRows()`. That is a FULL LEDGER SCAN:
    - api-relay `ledgerRows` does `count` plus `getPage` 50 at a time, serially;
    - through ONE client, `chain()` = viem `http(BASE_RPC)` with viem defaults (10 s timeout, 3 retries with backoff);
    - `BASE_RPC` defaults to `https://mainnet.base.org`;
    - it is cached only `LEDGER_TTL_MS = 10_000`; concurrent callers join one in-flight scan.

## 2. Live facts root already read (`relay-release-live/`, 23:09Z)

- `release-status` for the adapter `0x7ae476a3`, which IS in `SECRETS_RELEASE_DEPLOYMENTS`: HTTP 200 `listed:true`,
  immediately, via the front 134.209.248.172.
- `release-status` for `0x59f1273d`, which is NOT in the list: **curl exit 28, 0 bytes in 15 s**, the same front, in
  parallel.
- Relay env (enclave-api-relay on the control VM, `/opt/nan-relay`):
  - `SECRETS_ATTESTED_RELEASE=1`;
  - 10 listed ids;
  - `SECRETS_RELEASE_APP_REFS=catalog://0x962622b0…/0` is SET, so every UNLISTED id takes the ledger-scan path.
  - `BASE_RPC` was NOT in root's whitelist (its name contains no "URL"), so its value is unknown.

## 3. Suspected cause (source-proven mechanism; production attribution needs the probes in section 4)

**A. The primary suspect.** For any deployment not in `SECRETS_RELEASE_DEPLOYMENTS`, `release-status` waits on a
full-ledger scan over a single metered RPC with viem's default retries.
- The relay now runs on the minipc control VM, whose egress IP is the site's shared one. Public-RPC 429s were already
  measured there for the node's wallet and lease-gas paths.
- From that IP the scan can take well over the supervisor's 5 s, as root's probe shows (more than 15 s, no byte).
- Every such answer is `unknown`, so every unlisted SNP deployment is refused for claim on every sweep: a fleet-wide
  "queued" with exactly this message.
- A listed id never touches the chain, which is why the adapter's id answers at once.

**B. Fail-open defect, source-proven (secondary).**
- When the scan FAILS (throws), `rowOf` catches it and returns `null`, so `releaseListed` returns `false` and the relay
  answers 200 `listed:false`.
- An app-ref-listed deployment is then reported "unlisted" on a transient chain failure. This is exactly what the
  supervisor's three-state contract forbids ("an unknown is NEVER read as unlisted", supervisor 2733–2738).
- Secrets still fail closed: the spawn throws for staged or unknown secrets and config without a release guest. But a
  no-secret, no-config deployment of that app ref could be built on the legacy image instead of its release guest.

**C. Ruled less likely by root's probe (keep in view):**
- the rate limit (`clientIp` takes the LAST `X-Forwarded-For` entry and assumes exactly one trusted proxy; behind DO
  front + local Caddy all callers could share one 1/s bucket and get 429). The listed probe got a fast 200;
- `secrets_disabled` (the listed probe answered);
- `release_off` (not unknown).

**D. Not excluded without a probe from the supervisor host itself:** the SNP host's own reachability of `api.enclave.host`
(DNS, TLS or egress from inside its CVM).

## 4. Minimal live reads root needs (read-only; root runs them)

1. **The queued ids.** For each of the 10 queued deployments: its id, whether it is in `SECRETS_RELEASE_DEPLOYMENTS`, and
   its appRef (whether it equals the `SECRETS_RELEASE_APP_REFS` value). The hypothesis predicts all 10 are unlisted SNP
   deployments; a queued id that IS listed would falsify A.
2. **Timing at the relay itself.** One unlisted queued id and one listed id, over loopback on the control VM, then the same
   two via `https://api.enclave.host`. Record status, body code and elapsed time. A slow loopback means the relay's lookup
   (A); a fast loopback with a slow public answer means the front.
3. **The relay's RPC and ledger.**
   - `BASE_RPC` host only, from `/proc/<enclave-api-relay pid>/environ`;
   - `SECRETS_RELEASE_CATALOG_RPCS` hosts only (the count must be ≥ 2; release is on, so it should be);
   - the ledger `count()`, i.e. the scan's page count.
4. **The relay journal** (`journalctl -u enclave-api-relay --since -30min`): counts of 429 / timeout / `secrets_error`,
   any `[secrets]` lines, and the HTTP status distribution for `/v1/secrets/release-status`.
5. **The supervisor's own view.** On the SNP host whose claim sweep reports the message, grep its journal for "release list
   could not be read" (which ids, how often). Optionally use the supervisor's built-in read:
   `RELEASE_SELFTEST='{"listed":["0x…"]}' node supervisor.js` in its own environment (supervisor.js 9701–9704 prints
   exactly what `releaseListedFor` returns there). Run it only where root judges the module's startup side effects safe.
   Its `SECRETS_API` value too.

## 5. Proposed focused correction (prepared offline next, NOT activated; relay only, no supervisor change)

In `relay/secrets-release.mjs` `releaseStatus` only, for an id NOT in `SECRETS_RELEASE_DEPLOYMENTS` while
`SECRETS_RELEASE_APP_REFS` is set:
- **Read exactly that deployment's row** through the relay's existing `ctx.confirmRow(id)`: one `get(id)` agreed by two or
  more independent `SECRETS_RELEASE_CATALOG_RPCS`, already required while release is on, and already used by the release
  itself. This replaces the full-ledger scan over the single `BASE_RPC`.
- **Bound it below the supervisor's 5 s** (about 4 s).
- **A read that fails, times out or disagrees answers 503 `release_status_unavailable`, never `listed:false`.** That fixes
  defect B. The supervisor already reads it as `unknown` and refuses or retries: same safe semantics, now FAST and correct.
- **`no_deployment`** answers `listed:false`.

**Unchanged:**
- listed ids (no I/O), `release_off`, the rate limit and the 422;
- the release itself, tickets, attestation, predictions, custody and admin moderation;
- the supervisor.

If the probes show the front or the rate key instead (C or D), this correction alone will not clear the queue. The
alternatives are then root's decision: fix the trusted-hop count, or explicitly list the deployments (an owner/admin
listing decision, not mine).
