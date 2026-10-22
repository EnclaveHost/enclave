# Adapter lease expiry: renewal keeper (RESULT-renewal, 2026-10-22)

**Status: source only. Committed locally and tested offline. NOT deployed, NOT pushed.**
- No SSH, live RPC, keys, signatures, funds, restarts or production changes.
- No contract, fund, Windows-config or public-RPC change; the quorum is not weakened.
- Expired-lease serving is still refused. Ownership, admin moderation, registry state, host holds and rate caps are kept.
- The finished admission commit `ad4a72a` is unchanged. This is a separate commit on top of it.
- Stopping here for root review.

## 1. Commit, patch, hashes

| item | value |
|---|---|
| repo | `adapter-admission-review/candidate` (isolated, local git) |
| commit | `2afa6733fd8a4f45d3049f56fc42c22301752127`, tree `abe830c7fc95a62837284c5294dcdb67f48bff84`, parent `ad4a72a83de8…`; author and committer SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com> |
| patch | `adapter-lease-renewal-keeper.patch` = `git diff ad4a72a 2afa6733`, sha256 `c693b395ab49cbda68f1efeccb811b45d5bc908633870bdfd2fa2e1c86b881f5` (4 files, +627/−22) |

The committed blobs are exactly the bytes tested in the final runs (rfin*, rmut5):

| file | installed | ad4a72a | **2afa6733** |
|---|---|---|---|
| `windows/node/host.mjs` | `9634cb40…` | `637fbdf6…` | **`4bebf7dbfa4f779b792afcb5fe45e0c29485a35ab307e0e5a57dbdcce0bd4836`** |
| `windows/node/chain.mjs` | `86c81124…` | `86c81124…` | **`3e9fae0392497841f5c4e084c9d11f6c01243d339b0bdf3395b569f921a12938`** |
| `test/windows-node-lease-renewal-keeper.test.mjs` (new) | | | `39286d33c0cedd24e375cffc2773f5441d794f2bcc3bed0bc2f8aa4e27408191` |
| `test/helpers/windows-lease-scripted-fixture.mjs` (new, test-only) | | | `7f41a0147f62e7fa94e6f1c0045cbc29ff7dcf6e3a8a0f7e6d1f8d0c5ee9936b` |

**Unchanged:** wallet-admission `0fa7678f`, agent `76cac355`, host-admission bundle `6bef372d`, lease-gas-runtime bundle `159108d1`, privacy agent `cfb69370`. Neither `host.mjs` nor `chain.mjs` is an input of any bundle manifest (all 4 checked), so no bundle changes.

**Activation is a two-file control swap** (`host.mjs` and `chain.mjs`), not one. It is root's; nothing was done.

## 2. Exact findings (source and the live evidence root supplied)

**Timeline** (`host-renewal-diagnostic.json`, `reserves-preflight.json`, block 52958078):

| time (UTC) | event |
|---|---|
| 21:09:44 | renewed (rate 0: until = landing + 1800) → lease end 21:39:43 (1792705183) |
| 21:34:58 | the sponsored window opens: lead = min(15 min, renewWindow 300 − 15 s) = 285 s |
| 21:24:54, 21:30:48 | passes reached the adapter with 14:49 and 8:55 left: not due. Both still made a full lease-gas authority read for `renewLeadMs` |
| 21:37:50 | the ONE pass inside the window. `renewLeadMs` succeeded, then the send's own authority read failed: "app-funded renew not sent: lease-gas RPC quorum cannot read the configured chain; this host's ETH is never used instead" (the prefix shows the failure came from `renewDeployment`, not the lead read) |
| 21:44:42 | next pass: lease expired → retired (correct) |
| 21:45:19 | re-claimed `0xf3a2cd04…` → lease 1792707319 (more gas than a renew: claim quote 2.29e12 vs renew 1.39e12 wei, plus a VM restart) |

The reserve was never the problem: 945912014032722 wei enabled, renew and claim affordable, perOp and epoch caps ample.

**Root cause: scheduling, in source.**
- `Host.#tickOnce` is the only renewal path on Windows (installed `9634cb40` and `ad4a72a` alike). It is serial over every tracked deployment and takes ~7 min under rate limits.
- An app-funded renew is valid only in the last 285 s, and the reserve refuses earlier (`NotInRenewWindow`).
- With a pass period P > 285 s, a lease gets at most ONE attempt per window, and with probability (P − 285)/P it gets NONE: about 32 % at P = 420 s.
- The `RENEW_LEAD_MS` comment ("15 minutes gives three attempts") holds only for operator-paid leases.
- Linux already decoupled this: `supervisor.js` renewLeases has its own 60 s clock, per-record `_renewing`, a 60 s backoff and a 5-min lead cache.

**Quorum and load, in source (unmeasured):**
- `verifiedLeaseAuthority` has no 429 retry. One failed `eth_chainId` or `eth_blockNumber` drops a peer. The recorded config is 3 RPCs (publicnode, mainnet, blastapi), quorum 2, so two transient refusals fail the read.
- publicnode and mainnet are also the wallet path's busiest RPCs (rpc-budget-review).
- Each authority read is ~10 requests per peer, ~30 per read. The pass repeated one per deployment per pass in the last 15 min (2 per cycle at 7-min passes; up to ~30 per cycle when passes are fast).
- Root's 22:40 probe shows all three sponsored RPCs healthy. So the failure was transient, which is exactly what an independent retry inside the window covers.

## 3. The fix (`host.mjs` + an optional gate in `chain.mjs`)

**Keeper:**
- `Host.renewDue()` runs every 30 s (started in `init()` beside the tick).
- For each tracked deployment this box serves, whose lease is within its window, it renews outside the pass.
- It reuses the same lease semantics: `chain.renewLeadMs`, `chain.renewDeployment`, `leaseSend` and the release-journal holds.

**Gates (the pass's own):**
- A FRESH `readDeployment` row: active, our runner, a live lease, no placement refusal, no `heldReason`.
- The row's owner, visibility, appRef and configCid equal the identity the pass last SERVED.
- A FRESH `#walletPolicyState` decision for exactly that row.
- `#renewServing`: running, and not wallet-, boundary-, cap-, plan- or reboot-held, and not a capacity audit.
- No platform `serviceRefusal()`, no `releaseHold`, not giving up.
- A refusal or an unknown never renews; the keeper never stops, gives up or releases (the pass decides).

**Review 1 (eligibility after reconciliation):**
- `#leaseSeen` is cleared when the pass starts on a deployment. It is published only after envelope edit, resize and `ensureApp`.
- It is published only if none of them threw, and the record serves exactly this row: `served.appRef === d.appRef`, `served.envelope === d.configCid`, same owner and visibility.
- It holds the SERVED identity, not the latest observed one.

**Review 2 (permits):**
- `#renewPermit` is taken with the wallet decision. It is void once any hold, stop, give-up or wallet withdrawal of the deployment arrives (`#renewEpoch`, bumped in `#walletRevoke`, `#walletHold`, `#giveUpOnce`, `#stopApp`).
- It is also void once the deployment is no longer tracked, the platform refuses service, or the decision's own `validUntil` has passed.
- The keeper's permit also requires the pass to still publish the same served identity.
- It is checked after the lead read and again inside `chain.mjs` when the operator queue reaches the send (`renewDeployment(id, { gate })`). A void permit throws `superseded` before anything is signed or sent; this works for both app-funded and operator-paid sends.
- The chain's rules are NOT duplicated. The app-funded sender re-reads them at its verified block (reserve status Paused/Blocked/Inactive/expired/NotRunner/NotInRenewWindow/OverRateCap, the lease nonce, which a relay re-checks at the head). An operator-paid send simulates first.
- After the gate passes, a hold arriving mid-signature cannot stop that one send. At most one renewal of a lease the pass then stops; a release waits for it (below).

**Review 3 (no outer timeout):**
- `#renewTurn` allows one renewal per deployment. The pass joins one in flight, and its outcome counts for the pass (a joined failure is not ready).
- There is no `Promise.race`: the slot is held until the send settles, so a late landing can never overlap a retry.
- The authoritative bound is the sender's own:
  - app-funded: each RPC ≤ 10 s (`rpcTimeoutMs`), nonce settle ≤ 60 s, relays ≤ 180 s overall plus the last relay's checks, re-checks ≤ 30 s;
  - operator-paid: viem's 180 s receipt wait.
- A pass that joins a hanging send waits as the baseline pass waited for its own send. Other deployments' sends queue behind it on the operator (by design: one nonce).

**Also:**
- A verified renew records `#renewedFrom = old leaseUntil`. A lagging read of the old row is never renewed again.
- After a failure there is no retry for 60 s, about 4 tries in 285 s (Linux parity).
- An expired lease is never renewed or claimed by the keeper; the pass retires it.
- `#giveUpOnce` awaits a renewal in flight before its release.
- The window's lead is cached per (deployment, leaseUntil) for 5 min. The pass shares the cache, so ≤ 2–3 authority reads per lease cycle instead of one per pass.
- The keeper checks whether a lease is due before asking a wallet decision, so a lease outside its window costs no decision.

**Readiness (READINESS-REVIEW R1/R2):**
- A `ready` row now also requires `keeperEligible`: this pass reconciled (no caught edit or resize error) and the keeper is eligible for exactly this served lease and identity.
- A caught failure or a version or config not yet served is `not-ready`. The global completed-pass rule is unchanged.
- After a restart, `ensureApp` adoption records `envelope` from the row (host.mjs ~1469), so a healthy adopted app can be ready on the first pass.

## 4. Tests

All runs went through `claude-test-queue.py`, offline (`unshare -r -n`, loopback), with ssh/scp/sftp denial stubs proved first. Raw logs are in `logs/`.

**Harness** (`test/windows-node-lease-renewal-keeper.test.mjs`):
- the REAL Host and the REAL `chain.mjs` (leaseSend, journal holds, serialized operator queue, the "never this host's ETH" wrapper) on the fake Base RPC;
- the wallet channel on (as on minipc);
- only the lease-gas bundle replaced by a scripted sender applying the reserve's rules (live lease, 300 s window) and failing the quorum on demand;
- an in-test RPC proxy counting every operator `renew` simulation or raw transaction (the fake RPC would mine one).

**11 cases:**
1. the outage (pass failure at 113 s left → keeper renews after RPC recovery, no expiry, ready, no operator tx);
2. a 7-minute gap (one renewal at 280 s left, none on lagging reads, ≤ 3 lead reads);
3. pass and keeper concurrently in either order (ONE renewal, never two in flight);
4. **R1**: a paused reconcile with the ledger naming v2, a failed adoption, a caught edit failure (the keeper never renews) and the served-v2 control (it does);
5. **READINESS**: a caught edit failure, a caught resize failure and an unserved version are `not-ready`; recovery is `ready`;
6. **R2**:
   - a suspension, a pass wallet-unknown hold, a pass ban with give-up (its release waits for the keeper attempt, then exactly one release), and a ledger stop, each arriving during the deferred lead read;
   - the PASS's permit voided by a grant-refresher refusal during its lead read;
   - a send QUEUED behind another deployment's send, voided at the queue;
7. **R3**: a send hanging 1.5 s then timing out is never overlapped (the next keeper round and the pass join), then retried once after the 60 s pause, after the first settled;
8. never renewed by the keeper: suspension, wallet ban, wallet unknown, transfer, ledger stop, made private, new version not served, new config not applied, another runner, wallet hold, a pending sponsored release (shipped journal);
9. an expired lease (bounded 3–6 tries under quorum failure; none after expiry even when RPCs recover; the pass retires it; no claim or release; no operator tx);
10. the lead cache;
11. a new process renews nothing before its own pass served the row.

**Successful runs (final bytes 4bebf7db / 3e9fae03 / 39286d33):**

| run | cap | result |
|---|---|---|
| `rfin1` | 256 | **38/38**: keeper 11 + ad4 wallet-grant-refresh 11 + norenew + tick-single-flight + stopapp-tick + sponsor-retry; peak 192 MiB |
| `rfin3` | 256 | **33/33**: wallet-network-hold, wallet-policy, reboot-recovery, respawn, vanished-domain, platform-policy; peak 194 |
| `rfin4-live-edit-512` | 512 | **3/3** live-edit (3 node processes, 257 MiB peak; see rfin2); peak 257 |
| `rfin5-readiness-512` | 512 | **9/9** lease-readiness, including the Linux pwsh gate-integration case (PWSH + copied `cutover/`); peak 288 |
| `rmut5` | 256 | **mutation control, final bytes, 0 survivors.** BASE (ad4a72a host + chain, no keeper) FAILS (outage, gap, race, R1, R2, R3, READINESS, expiry, lead cache). Killed: H1 draft early publication, H2 no permit at all, H2a no after-lead check (killed only by log wording; the send gate covers it), H2b no send-time gate, H3 withdrawal does not void, H4 release does not wait, H5 no join, H6 no renewed fence, H7 outer timeout overlap, H8 wallet ignored, H9 identity ignored, H9b config-only ignored, H10 no lead cache, H11 walletHeld served, H12 expired acted on, H13 no retry pause, H14 readiness ignores eligibility, C1 operator-ETH fallback. H12a (only the local expiry pre-filter) survives as declared: the fresh-row check covers it |
| `rreg3-00`, `rreg3-01` | 256 | 62/62 and 69/69 (20 windows-node suites) on intermediate host `3881bd28`. The later edits change only keeper eligibility and readiness, which those suites do not read (only lease-readiness and the keeper test do; both re-ran on final bytes) |

**Earlier development runs (kept):**
- `rk1`–`rk4` 10/10 at each step;
- `rmut2`/`rmut3` found real test gaps: H9 (no config-only or version-only variant; my H9 mutant was also too narrow) and H12 (only one of two expiry checks removed, and the test kept the RPCs down after expiry). Both were fixed (variants added, mutants corrected, the RPCs answer after expiry) and are killed in `rmut4`/`rmut5`.

**Non-passes and non-results (all retained):**

| log | what | classification |
|---|---|---|
| `rreg1` | broad batch, exit 99 guard-stop at 309 MiB in `session-api-auth` (not a renewal path; dropped from scope) | non-result. Before the stop, 2 FAILURES: catalog-platform-enforcement "actual Windows wallet gate…" (SyntaxError: the test's source slice references `#walletPolicyState` outside its class slice) and registry-reconcile "both platforms load the same rule…" (supervisor heartbeat assertion) |
| `rbase1` | those 2 files on the ad4a72a host + chain | **identical 2 failures: pre-existing, not caused by this patch** |
| `rreg2-outer-timeout-killed` | batch killed by my own outer `timeout 595` (rc 124) | non-result; no orphans (checked) |
| `rreg3-02` | four hv-attach-relay failures, then the file hung > 10 min; **stopped by root** (no deadline in job-tests.sh) | NOT a pass. Root stopped the queue and producer; the batch was not repeated. `rreg3-03..05` never ran |
| `relay-compare1` | bounded single-case triage, exit 99 at 274 MiB (relay child) | non-result; it swapped files in place, so it was replaced (files verified unchanged) |
| `relay-compare2` (512) | the single case "a relay that offers NO v2" in the candidate and in `tmp/base-ad4-tree` (hard-linked copy with the ad4a72a host and chain as separate files; nothing swapped in place); `--test-timeout` 60 s, PID namespace `--kill-child`, outer `timeout -k` | **identical failure on both**: `daemon never claimed a port…` ← `ERR_MODULE_NOT_FOUND …/candidate/relay/network-runtime.bundle.mjs` imported from `relay/api-relay.js`. The gitignored relay bundle is absent from this tree: **environment, not the patch**. The hang is its after-hook waiting on the dead daemon (cut at 60 s here) |
| `rfin2` | 7 files, exit 99 at 259 MiB in `live-edit` (first alphabetically) | non-result; re-run as rfin3 (256) + rfin4 (512) |
| `rmut1-noop-mistake` | I queued `unshare -r -n true` under the mutant log name by mistake | no test content |

**Not run (scope, per root):**
- the other hv-attach-relay cases (same missing bundle);
- the remaining unrun windows-node and windows-shield suites from `reg-b-02..05`: hv-attach, hvcert, isolation-host, owner-set, preclaim, price-once, pricing, private-paths, private, prove-isolated, restart-gate, retired-engine, scan-slot, secrets-unknown, sni, waf-body, shield-startup, shield-verifier. None reads the renewal, eligibility or readiness paths beyond what ran;
- the Anvil suites: windows-host-app-funded, windows-release-journal, windows-current-runtime and lease-*relay. `chain.mjs`'s change is an optional `gate` that only renew passes; with none passed, `gate?.()` is a no-op;
- no native Windows run, no real reserve/relay end-to-end (the scripted sender stands in for the bundle; its rules mirror the reserve's window and expiry checks).

## 5. Limitations and open items

- **Sends are serialized per operator (one nonce)**, so a hanging send delays other deployments' sends. That is bounded by the sender (above), unchanged from baseline and from Linux. A pass that joins it waits too.
- **The keeper adds, per renewal attempt:** one single-RPC `readDeployment`, one fresh host wallet decision (only when due), and one post-renew read. **It removes** the per-pass lead reads (≤ 2–3 authority reads per lease cycle). ad4a72a's refresher load is separate (see RESULT.md).
- **Unchanged and worth root's decision:**
  - `verifiedLeaseAuthority` drops a peer on a single 429 and names no provider in its error. That is a bundle input (lease-gas-runtime and the metal conduit), not touched here.
  - The pass's "will not renew" wording matches every app-funded error, because the "app-funded" prefix contains "fund" (`/cap|balance|fund|rate/`). It is display only; behaviour retries as before. Not changed.
- **Readiness is stricter.** A deployment whose owner edit cannot be applied (parse error, kept old config) is now `not-ready` until the edit is applied or reverted, matching that the keeper will not renew it. The pass still renews it.
- **The keeper renews only `running` records** (Linux parity). A deployment still provisioning is renewed by the pass only, as before.
- **Activation is root's:**
  - swap `host.mjs` `9634cb40` → `4bebf7db` and `chain.mjs` `86c81124` → `3e9fae03` together, with the stop / swap / start node procedure and the lease-window and G-UPD gates;
  - ad4a72a's activation note named only `host.mjs`; this supersedes it;
  - rollback: restore both; a renewal in flight at stop is bounded by the sender, and the journal still covers releases.
- `tmp/base-ad4-tree` is a scratch hard-linked copy, used only by `relay-attach-compare-r2.py`.

## 6. Scripts (immutable)

| script | sha256 |
|---|---|
| `job-tests-r2.sh` (bounded runner) | `518f051e…` |
| `mutants-renew.py` (r3) | `136bfdd8…` |
| `relay-attach-compare-r2.py` | `3a6a3e8e…` |
| `base-run.py` | `47201ec3…` |

`job-tests.sh` (unbounded) and `relay-attach-compare.py` (r1) are retained for the record.
