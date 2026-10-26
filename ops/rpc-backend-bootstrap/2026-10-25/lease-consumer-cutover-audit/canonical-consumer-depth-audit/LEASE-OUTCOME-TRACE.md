# Lease release outcome: downstream trace and the concrete parity consequence (2026-10-25)

- **Source:** `relay-consumer-source` `81ba668531d17151db810e14562c77a672d742e4` (HEAD verified).
- **Method:** read-only. No execution, queue use, network access, SSH or source edits.
- **Follows:** `LEASE-RECOVERY-FOLLOWUP.md`. That document established that under `ENCLAVE_CHAIN_AUTHORITY=verifier` the canonical-gated verifier is the **sole** voter (`network/lease-gas-runtime.mjs:59-60, :96`), so a sponsored release receipt more than 256 blocks below the verified head cannot be verified (`canonical.rs:52-55`).

## 1. What the deep case produces (recap, exact lines)

- **Supervisor:**
  - `resolveSponsoredReleaseTx` (`supervisor.js:10614-10626`) → `resolveSigned` returns `consumed`/`expired` (never `landed`), which sets `tx.state` (`:10625`).
  - `acceptSponsoredLanding` (`:10556-10568`, the only writer of `tx.state = "success"`/`tx.released`) is never reached.
  - The loop `runRelease` (`:10695-10716`) then closes with one of:
    - **`not-retried`** (`:10706`, an intent without retry, e.g. a recovered one);
    - **`gave-up`** (`:10707`, attempts ≥ 4);
    - **`gone`** (`:10712`, the ledger row no longer holds this lease).

    It never closes with **`released`** (`:10703`). It signs again only if the ledger row still holds the same lease (`:10713-10714`), which is correct.
- **Windows node:** `resolvePendingReleases` (`windows/node/chain.mjs:319-336`) settles **`consumed`/`expired`** instead of **`released`** (`:330-331`).

## 2. Every consumer of `it.outcome` / `tx.released` / `tx.state === "success"` (complete for these files)

Found by grepping `supervisor.js`, `windows/node/chain.mjs`, `windows/node/host.mjs` and `network/lease-release-journal.mjs`.

| # | Consumer | Exact lines | Effect of `gone`/`gave-up`/`not-retried` instead of `released` |
|---|---|---|---|
| 1 | **Release loop** | `supervisor.js:10703` (`state === "success" && tx.released` → `released`) | The release is classified as not confirmed (see 1) |
| 2 | **`closeRelease` side effects** | `supervisor.js:10536-10548` | **Identical for every outcome except `cancelled`:** the evacuation hold-off (`:10541`), `noteLeaseFloor(id, block)` (`:10540`; a max-floor, `:10470-10475`; `gone` passes `row.block` ≥ the landing block, which is still a valid lower bound), intent removal and saving. Only the log line and the stored `it.outcome` string differ. |
| 3 | **`releaseLease()` boolean** | `supervisor.js:10728-10742` (`return out.outcome === "released"`) | The value is **ignored by every caller.** `proveAndRelease` (`:12808-12811`) is called fire-and-forget or with the result unused at `:757`, `:2360`, `:8191`, `:8282`, `:8647`, `:9846`, `:10889`, `:11006`, `:11069`, `:11151`, `:11212`, `:11261`, `:11317`, `:11326`, `:12203`, `:12246`, `:12322`. **No renewal, billing, re-claim or teardown decision reads it.** |
| 4 | **Owner-move HTTP route** | `supervisor.js:8345-8366`: waits at most `RELEASE_ANSWER_WAIT_MS = 90_000` (`:10453`); `released` → 200 `{released:true}` (`:8348-8356`); `gone`/`not-held` → 503 `release_unconfirmed`, `leaseHeld:false` (`:8358, :8363`); others → `leaseHeld:null` | The **only user-visible difference**: 503 "release not confirmed" instead of 200 "released". This occurs only if the resolution happens > 256 blocks after landing **within** that 90 s answer. A release that resolves later is answered as unresolved (`!out`, `:8357`) in **both** cases, and the later close does not rewrite `rec.error`. |
| 5 | **Release view** | `supervisor.js:10503-10505` (`releaseView`: per-transaction `state`) | Shown only for **open** intents (`:8320`, `:8364`). A closed intent is deleted from `_releaseIntents` (`:10538`). |
| 6 | **Windows journal** | `network/lease-release-journal.mjs:91-97` (`settle(id, outcome)` **removes** the entry; the outcome is only logged) | **Identical:** the hold lifts for `released`, `consumed` and `expired` alike (doc comment at `windows/node/chain.mjs:317-318`). |
| 7 | **Windows host** | `windows/node/host.mjs:2053` (logs `r.outcome`) | Only the log label differs (`consumed` vs `released`) |

**Billing:** the refund of the unused tail happens on chain through the landed release itself. No billing code in these files reads `tx.released` or `outcome`. The only other `.released` reads (`supervisor.js:3151-3152`) concern isolation volumes and are unrelated.

## 3. When the deep case occurs in practice

- **Normal flow:** the resolver polls every `RELEASE_POLL_MS = 3000` (`:10449`) and accepts after `RELEASE_CONFIRMATIONS = 2` (`:10451`). A live release is therefore verified within a few blocks of landing, far below 256.
- **The > 256-block case needs resolution to be delayed by more than 256 blocks after landing:**
  - a supervisor or Windows-node restart, or downtime;
  - a resolver or verifier outage spanning that interval;
  - or `RELEASE_CONFIRMATIONS` raised to 256 or more by env.

  That is about 8.5 min only if blocks are 2 s apart; Base block time was **not measured** here.

## 4. Concrete parity consequence (settled from code; no fixture needed)

- **Behaviour:** for a release that landed more than 256 blocks before it is resolved under a sole canonical verifier, **behaviour is unchanged**:
  - hold-off, lease floor, intent removal and journal removal;
  - no re-sign while the ledger shows the lease gone;
  - no consumer of the boolean.
- **Evidence and labels lose the success evidence:**
  - outcome `gone`/`gave-up`/`not-retried` (supervisor) or `consumed`/`expired` (Windows) instead of `released`;
  - `tx.released`/`success` is never recorded;
  - log lines say "not confirmed".
- **User-visible:** only the owner-move route can return **503 `release_unconfirmed` (`leaseHeld:false`)** instead of **200 `released`**, and only if a deep resolution falls inside its 90 s answer window. That is not reachable in the normal flow above; it needs a > 256-block delay before the route's resolution.
- **Classification:**
  - **a benign receipt and label degradation, not a functional parity blocker** in the traced code;
  - **never a wrong positive:** there is no false `released`, and no false "lease still held" that would block re-claims (`leaseHeld:false` for `gone`).

## 5. What this does NOT change

- **HOLD stays:** the actual lease-cutover config for the supervisor/Metal0 control (C2 leaves `leaseGas` on the public quorum) and the Windows node is **not prepared** (`LEASE-RECOVERY-FOLLOWUP.md` Q2). This trace does not substitute for it.
- **Policy untouched:** no canonical, finality, tier or admin guard is weakened or waived. The gate still refuses deep `requireCanonical` reads.
- **Not covered:**
  - other repos' readers of the owner-move API response (site, mobile, dashboard; not inventoried in `consumer-cutover-plan-2205`);
  - the non-sponsored operator-key release path (`resolveReleaseTx` `:10666+`), which does not use `resolveSigned` and was not traced for `requireCanonical`.

## 6. Recommended regression (specification only; optional, since the code trace settled the consequence)

The scenario: a supervisor under `ENCLAVE_CHAIN_AUTHORITY=verifier`, with a mocked sole verifier that returns `BlockNotCanonical` for the receipt block (300 below the head). A recovered sponsored intent whose release landed and whose ledger row is gone must:
1. close as `gone` (not `released`);
2. set the hold-off and the lease floor;
3. sign nothing new;
4. leave `releaseLease()` returning `false`.

The same intent with the row still held must sign exactly one new release. This pins the classification in §4 against future code changes.
