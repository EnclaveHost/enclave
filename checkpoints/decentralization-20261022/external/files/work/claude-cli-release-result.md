# Independent move/release: result (2026-10-19)

The interface was written first: `work/independent-move-interface.txt`. It covers the scope checks, release
acknowledgement versus chain finality, the signed target hint, the stop/release failure and retry table, funds, and the
boundary.

Repo: `work/enclave`. HEAD is now `d0676ff3`; other workers committed during this round. Nothing is committed by me.

**What I did not do:** no production use, SSH, chain writes outside anvil, Wine, GUI or commits.

**What I did not edit:**
- Windows/Go, browser/site, SDK, sessions or custody files;
- deployed contracts;
- `cli/dist`.

**Previous evidence kept:** `work/claude-cli-validation-result.md` (GPU/config/F1) is unchanged.

## Ledger finding (why the design is what it is)

- `EnclaveDeployments.release(id)` is runner-operator-only. The owner has no call that ends a live lease.
- `setActive(false)` leaves the lease in place. It runs out within at most `leaseSec`, and the tail is not refunded.

So a move needs the cooperating current host to release, and then a steer toward the target. Any eligible host may claim
an open record, so placement can only be a steer, never a lock. Doing better would take a contract change, which was not
made.

## What was wrong before

- **The supervisor's DELETE `/v1/deployments/:id`:**
  - it ignores an unconfirmed stop;
  - it starts `proveAndRelease` without waiting for it;
  - it answers "lease released (unused lease time refunded)" before the release transaction is even signed.
- **The public `/v1/claim-hint`** is unauthenticated and reached through the relay.

Neither is exposed on the independent plane. DELETE stays refused by the management table.

## Implemented

### Shared management slice (`network/management-*.mjs`)

**`release`:** `POST …/release`, scope `api.restart`, mutation.
- It is classified `succeeded` only on `{id, released: true}`.
- Not-started refusals: auth refusals, `not_current_runner`, `not_releasable`, `release_in_progress`,
  `release_unavailable`.
- `stop_unconfirmed`, `release_unconfirmed`, a 5xx or a cut answer are outcome-unknown.
- **`reauthorize: false`:** the gateway does not cut a forwarded release's answer when its periodic re-authorization
  sees the lease gone, because the release itself ends that lease. It is still bounded by the operation's hard deadline.
- It counts in the gateway's long-answer pool.

**`claimHint`:** `POST …/claim-hint`, scope `api.placement`, not a mutation (idempotent), `host: 'named'`.
- **Gateway:** `decideAuthorization(…, {host: 'named'})` needs an existing, active row instead of "the lease names this
  runner". The session, key, liveness, scope and holder rules are unchanged, and no lease bounds its freshness. The
  "deployment not ours" refuse-only cache is neither consulted nor filled for it.
- **Client:** `ManagementClient.claimHint({runner})` resolves the owner-named host through `resolveHost`: the pinned
  registry entry (agreed: active and its operator), then that operator's signed record. It uses the same per-runner,
  per-operator floors and SPKI pinning. `ManagementClient.release()` was added too.

Everything else in the table is unchanged.

### Supervisor (`supervisor.js`, narrow, new routes only)

**`POST /v1/deployments/:id/release`** (`ownerAuth("api.restart")` + `mayAct`), in order:
1. Refusals before any effect:
   - not on-chain or not this ledger;
   - the ledger row does not name this operator;
   - a release is already running;
   - the ledger cannot be read.
2. It stands down from re-claiming (the move holdoff), then stops the app. **An unconfirmed stop restores the record and
   releases nothing:** 502 `stop_unconfirmed`.
3. The final proof, then **one** `release()` and its receipt.
4. The ledger decides:
   - `{released: true, txHash, blockNumber, standDownSec}` only when its own ledger read no longer names this operator;
   - otherwise 503 `release_unconfirmed`, with the app stopped. The existing `releaseLease` keeps retrying in the
     background under the same in-progress guard, so a repeat is refused.

**`POST /v1/deployments/:id/claim-hint`** (`ownerAuth("api.placement")`):
- the owner rule is judged against the **ledger** row (`sessionApi.refusal`), because the target holds no record;
- it then makes the same decision as the public hint: the public handler's body was moved unchanged into
  `claimHintAnswer`;
- the per-IP bucket is skipped for authenticated owners;
- the provision-failure cooldown override is never granted.

The public `/v1/claim-hint`, DELETE and every other route are unchanged.

### CLI (`cli/enclave.mjs`)

**`enclave --independent move <id> <host-id> --directories … [--wait SEC]`.**
- **Before anything is sent, the CLI checks:**
  - the target is a registry id (checked before any network use);
  - the session is live and holds **both** `api.restart` and `api.placement`, and the holder rule passes;
  - at one agreed block: the record is active, the target is an active, priced schema-4 host, `rateFor(id, target)` is
    within `capOf`, and balance plus tail is at least one second at the target's rate;
  - the target's management record resolves.
- **Confirmation:** the prompt names the source, the target, the tail and both rates.
- **Release:** **one** `release`; it is never resent. Then the CLI's **own quorum** must show the lease gone: 90 s if the
  host reported success or the answer was lost, 15 s for a definite host state. Otherwise it exits 1 after a definite
  refusal, or 4 ("still held … run the move again").
- **Hint:** only after that, the signed `claimHint` to the target, repeated every 6 s while the quorum is polled. The
  result comes from the quorum: moved, claimed by another host ("placement is a steer"), or "released and queued".
- **Queued record** (no live lease): the CLI only hints.

**Refactor:** `independentManagementCall` was split into `independentManagementClient` (the checks and the client) and the
dispatch; its behaviour is unchanged. `move` was removed from `INDEPENDENT_REFUSALS`.

**Hosted `move`** keeps its flow. It now prints "release requested", and "lease released on chain" only after its own
chain check. It no longer reports a release that has not happened.

### Tests and fixtures

**`test/cli-independent-move.test.mjs` (new, 6 tests).**
- **Setup:**
  - real anvil, ledger, schema-4 registry (two registered hosts at different prices), pinned session factory, and
    3 RPC proxies with a quorum of 2;
  - the **source is the actual `supervisor.js`**: unmodified, `BASE_RPC` = anvil, operator key, `MANAGEMENT_GATEWAY` +
    token, a stub app manager. It sits behind the real gateway with `recheckMs: 100`;
  - the **target is a stand-in** behind its own gateway and signed record, whose `claimHint` sends the real `claim()`
    from its own operator;
  - the network guard maps only the two signed public addresses.
- **What the tests assert:**
  1. Refusals with no host contacted and nothing sent: a missing `api.placement` scope, an unknown host, an
     unreachable target (no record), a name instead of an id.
  2. **The actual supervisor with an unconfirmed stop:** 502 `stop_unconfirmed`, the CLI exits 4 from the quorum, no
     release transaction, the target never hinted, the record still `running` (`status --host`).
  3. **The actual supervisor releases**: the answer comes only after the ledger shows it, and carries the `txHash`; the
     quorum confirms; the signed hint makes the target claim.
     - Funds: one `Released` event with `refunded6 > 0` for the source, and one `Claimed` event by the target's operator.
       The record's rate now equals `rateFor(id, target)` and is above the old rate.
     - The supervisor logs exactly one confirmed stop and one release; both hosts were dialed only at their signed
       addresses.
  4. **Moving back:** a slow release answer (1.5 s after it lands, while the gateway re-authorizes every 100 ms) is
     **delivered**, not cut. The **actual supervisor's signed claim-hint route** authenticates the owner and then
     declines (`503 not_claiming`). The record ends released and queued.
  5. **A lost release answer** (the answer is dropped after it lands): outcome-unknown, then the quorum shows the
     release, and exactly one release transaction was sent.
  6. **A queued record:** the CLI only hints, and a declining target leaves the balance untouched.

  Every test checks: zero calls to the stand-in Enclave API and zero non-loopback connections.

**`test/management-move-unit.test.mjs` (new, 3 tests, pure):**
- the exact targets;
- DELETE, `?evacuate`, the public `/v1/claim-hint`, trailing slashes and other casing are all refused;
- the release outcome classes;
- the named-host versus current-lease authorization rules, including scope, liveness, holder and an inactive record
  (never cached).

**`test/helpers/cli-independent-rig.mjs`:**
- `startManagement` now takes `host`, `address`, `upstream`/`upstreamToken` and gateway options;
- the stand-in's `release` and `claimHint` send real anvil transactions, with `drop`, `slow` and `decline` modes;
- `startActualHost` is new.

**Existing tests adjusted:**
- the `move` expectations in `cli-independent` test 12 and the sessions suite (it is supported now; names are refused);
- the sessions Shield test now gives the host its own Shield-direct image pins. The Shield worker's uncommitted
  `windows/node/shield-startup.mjs` (F3) changed under this run and now requires them; the test is unchanged against the
  older file, which ignores the option.

## Exact runs

All runs were serial under `/tmp/s6/run-768.sh`. It kills only its own process group at >768 MiB own RSS,
<16384 MiB available, or after 900 s. No run was killed. "Peak" is the guard's sampled own-group RSS.

| Run | Result | Peak RSS | Min avail |
| --- | --- | --- | --- |
| move suite, source, 1st | 4/6: a message regex and a test-side claim count, both test expectations, both fixed | 658 MiB | 16905 MiB |
| **move suite, source** | **6/6** | 660 MiB | 17308 MiB |
| negative control: `reauthorize: false` removed | 5/6 as intended. Test 4 fails, and the confirmed release becomes "outcome unknown (the gateway lost the supervisor)". Restored afterwards. | 545 MiB | 17577 MiB |
| **management-move-unit** | **3/3** | 44 MiB | 17943 MiB |
| **management-plane** (incl. actual supervisor) | **38/38** | 348 MiB | 17647 MiB |
| **management-directory-rotation** | **1/1** | 38 MiB | 17756 MiB |
| site-independent-management-unit | 27/28: the vendored browser bundle is stale (see gap 3). The same check passes with HEAD's routes/outcome. | 37 MiB | 17748 MiB |
| **claim-open-for-us / claim-sweep / isolation-guest-pool / supervisor-wallet-policy / tenant-compute-eligibility / direct-only-supervisor** | **4/4, 4/4, 14/14, 4/4, 10/10, 4/4** | ≤236 MiB | ≥17127 MiB |
| **cli-independent, source** | **14/14** | 534 MiB | 17351 MiB |
| **cli-independent-sessions, source** (before F3 landed) | **13/13** | 398 MiB | 17360 MiB |
| **move suite, source** (after the target-first reorder) | **6/6** | 653 MiB | 17570 MiB |
| staging build | `work/cli-staging/enclave.mjs`, 2011311 bytes, sha256 `adc4c0cf2209f4c653f600dadbb92899476e79aef45c1badd7ce8f309e414267` | 43 MiB | 18341 MiB |
| **move suite, staged bundle** | **6/6** | 618 MiB | 17229 MiB |
| **cli-independent, staged bundle** | **14/14** | 533 MiB | 17053 MiB |
| cli-independent-sessions, staged bundle, 1st | 12/13: the Shield test's `materialize()` refused, because the uncommitted F3 change landed at 19:43 | 518 MiB | 17435 MiB |
| **cli-independent-sessions, source** (F3 pins in test) | **13/13** | 545 MiB | 17055 MiB |
| **cli-independent-sessions, staged bundle** | **13/13** | 373 MiB | 17557 MiB |
| **hosted cli.test** | **76/76** | 264 MiB | 17479 MiB |
| **hosted cli-session / deploy-visibility / deploy-isolation / attest-verifier** | **3/3, 7/7, 12/12, 3/3** | 743 / 267 / 244 / 212 MiB | ≥16906 MiB |

- **Highest peak:** 743 MiB, in hosted `cli-session`, under the 768 MiB cap.
- **Lowest availability:** 16905 MiB, so the floor was never crossed.
- **`cli/dist/enclave.mjs`** is unchanged (`9db0f36a…`). The staged bundle was built only after the source suites passed.
- **Cleanup:** no process from these runs remains.

## Remaining gaps and boundary

1. **The ledger boundary.** A dead or hostile source cannot be moved off; it can only be waited out (stop, then resume,
   at most `leaseSec`, with the tail forfeit). Placement is a steer. Both need a contract change to go further, and none
   was made.
2. **The positive claim by an actual supervisor is not exercised.** It needs a confidential-CPU attestation (`teeOk`) and
   `CLAIM_READY`. The target that claimed was a stand-in sending the real `claim()`. The actual supervisor's signed hint
   route is covered for authentication and its decline path.
3. **The browser bundle is stale.** `site/…` vendored management is browser-owned; its owner should run
   `node scripts/build-management-vendor.mjs`. Also, `management-browser.mjs` sends every operation to the current
   lease's endpoint. It needs a named-host resolver before it offers `claimHint`; until then such a hint only reaches the
   current host, which answers "already serving". Not edited.
4. **Shield F3 (the Shield worker, uncommitted).** The CLI's `bootstrap prepare --target shield` does not yet compare the
   `--shield-manager` file's `images.shieldDirect.runtimeId` with `--runtime-id`. A mismatched package is still refused
   by the host. This is for the next round, once F3 is committed.
5. **Paths not exercised end to end:**
   - `release_unconfirmed` with its background retry on the actual supervisor (only the classification is
     unit-tested);
   - `proveFinalPeriod` (the rig has no proof key);
   - a wallet-held deployment with delegation (the move tests use a vault-held record).
6. **The supervisor's release answer comes from its single RPC.** The CLI treats it as host-reported and acts only on
   its own quorum.
7. **The legacy DELETE** keeps its early answer for the hosted relay path. It is not exposed independently, and the
   hosted CLI no longer repeats its claim.
8. **Still not complete:**
   - hosted accounts and passkeys remain architecture backlog; the browser account worker is researching passkeys, and
     device flow comes later;
   - the wallet-only path is not declared equivalent;
   - `secrets`, `custody` and `availability` stay as mapped in `work/cli-remaining-interface.txt`.

## Files

**Code:**
- `cli/enclave.mjs`: the independent move, the management-client split, the hosted move message;
- `network/management-routes.mjs`, `-outcome.mjs`, `-auth.mjs`, `-gateway.mjs`, `-client.mjs`;
- `supervisor.js`: the two new routes and the `claimHintAnswer` extraction.

**Tests:**
- new: `test/cli-independent-move.test.mjs`, `test/management-move-unit.test.mjs`;
- edited: `test/helpers/cli-independent-rig.mjs`, `test/cli-independent.test.mjs`, `test/cli-independent-sessions.test.mjs`.

**Docs:**
- `docs/network/independent-management.md` (table, rules, outcomes);
- `docs/network/independent-cli.md` (`move`);
- `work/cli-remaining-interface.txt` §4;
- `work/independent-move-interface.txt` (new).

**Staging:** `work/cli-staging/enclave.mjs`, rebuilt.
