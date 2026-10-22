# Queued claims: avoidable lease-gas RPC pressure (read-only source diagnosis, 2026-10-22 ~23:45Z)

Scope:
- Source and existing public receipts only. No SSH, network, transactions, live writes or new tests.
- Nothing proposed lowers the quorum or uses the host's ETH.
- The frozen 2afa candidate, node helpers, capture and git work were not touched.
- Requirements read (`effective-goal-requirements.txt` md5 658227d1): admin controls and fail-closed sponsored leases stay.

## 1. Exact shared source (the same bytes on both platforms)

| role | source | sha256 | Windows (final 2afa) | Linux |
|---|---|---|---|---|
| quorum authority | `client/lease-executor-authority.mjs` (`network/` copy identical) | `88dd8a6a…` | inside `windows/node/lease-gas-runtime.bundle.mjs` `159108d1` (manifest pins this input) | measured image input `app/client/lease-executor-authority.mjs` 88dd8a6a (`measured-composition/out/c/INPUT-MANIFEST.json`) |
| sponsored client (claim/renew/release, relay loop) | `client/lease-executor-client.mjs` | `bd082b00…` | same bundle | same image input `app/client/lease-executor-client.mjs` bd082b00 |

- The Linux supervisor's `deabf8f90` build was not available locally as source. The authority/client hashes above are the
  ones its measured composition pins. That is INFERENCE for the installed `deabf8f90`; root can confirm the two hashes.
- **Recorded config (Windows/minipc):** `ENCLAVE_LEASE_GAS_RPCS = publicnode, mainnet.base.org, blastapi`,
  `QUORUM = 2` (158 identical records in package files).
- **Linux:** the live guest lease-gas RPC list is in no public receipt. A two-RPC list in
  `test/fixtures/pinned-relay/absent-golden.json` is a TEST constant (`lease-pinned-relay-config.test.mjs` `RPCS`), not
  evidence of production.

## 2. Evidence (root's `relay-release-live/nucbox-queued-state.json`, 23:35:45Z; `queued-diagnosis.json`)

**Windows claims, three distinct failure points:**
- `a69dcbba`, `e64f7cba`, `c13d4b6a`: "lease-gas RPC quorum **cannot read the configured chain**". This is the HEAD step:
  fewer than 2 of 3 peers answered both `eth_chainId` and `eth_blockNumber` (authority.mjs :97–104).
- `d9798e4c`: "quorum **did not agree on the pinned reserve, executor and ledger bindings**". Heads and the target block
  agreed, then fewer than 2 peers completed the 7-read binding step (authority.mjs :120–135).
- `ef514ed3`, `59f1273d`, `38f368d6`: reached BOTH relays (`127.0.0.1:8549`, `134.209.248.172`) and got **422
  Unaffordable** each time. So they paid the full authority and read cost, and then the relays' own reads.

**Linux (last 20 min):** `9eb4e600` had 22 unaffordable and 16 RPC-quorum refusals; `da09d0f2` had 30 and 8.

**Not available:** the per-peer reasons. `rpc.agree` and the head step discard each peer's error, so no receipt says
whether a peer failed by 429, timeout, or an unknown block hash. This is a diagnostic gap (section 5 item E).

## 3. Request cost per claim, from source (an INFERENCE; not measured traffic)

`verifiedLeaseAuthority` (authority.mjs :91–160), per configured peer:
- the head step: `eth_chainId` then `eth_blockNumber` (2);
- one `eth_getBlockByNumber` (1);
- the binding step: **7 requests fired at once per peer** (`Promise.all`: 2 `eth_getCode` of the reserve and executor
  runtimes, plus 5 `eth_call`) (7);
- then every read through its client is one request per agreeing peer.

So one authority round is about 10 requests per peer, 7 of them in one same-instant burst per origin. `leaseRpcSet.request`
has **no 429 retry**: one 429 drops that peer from the round, and with 3 peers at quorum 2 two drops fail the operation.

`createLeaseClient.run` (client.mjs :655–776), per claim:
- `settledAuthority` (one round, plus the account code and nonce, plus head `eth_getTransactionCount` to every peer);
- `policy`, `nonceAt`, `reserveOf`, ledger `get`, `quote`, `getCode`, `getTransactionCount`.

That is about **22 requests per peer** before any relay is contacted.

**After EACH relay refusal** (:745–768), even a definitive 422:
- `findLanded` (`eth_getLogs` to every peer);
- `nonceOf(id)` = a **new full authority round** plus 2 reads;
- `policy` = **another full authority round** plus 1.

That is about 24 per peer per relay. The loop then tries the NEXT relay, although Unaffordable is a chain fact of the app's
reserve that every relay computes identically (client.mjs `checkRelayRequest` :262–275).

So a deployment whose reserve is below the claim charge costs about **70 requests per peer per attempt**: roughly 22, plus
24 per relay for the two relays. About 48 of those, plus both relays' own checks, are spent only to learn a fact the host
had already read in that run (`pol.availableWei`/`epochLeftWei`/`maxPerOpWei`, `r.balanceWei`/`maxPerOpWei`, `quote()`).
The host-local relay on 8549 shares the site's egress IP, so its check reads add to the same per-IP budget.

**Windows retries this every pass** (host.mjs `scanLedger` :2040–2071; final 2afa unchanged here):
- a failed claim is held only after 2 consecutive failures, for `SCAN_CLAIMFAIL_HOLD_MS` = 2 min;
- the hold key is the LEDGER row, which a lease-gas reserve shortfall does not change;
- tracked expired leases re-enter `consider()` from the tick's not-ours branch with no hold.

So the 3 to 4 currently unaffordable apps cost about 200–300 requests per peer per pass, on publicnode and mainnet. Those
are the same providers the wallet-admission path already loads (`claude-resumed-20261022/rpc-budget-review/REVIEW.txt`),
from the same IP. That is a plausible driver of the head- and binding-step quorum failures seen on the other claims. It is
an INFERENCE: no per-request trace exists.

**"Inconsistent latest-block reads" (possible, unproven).**
- The authority pins the binding reads to `{ blockHash, requireCanonical: true }` at head − 2 (EIP-1898).
- A load-balanced public RPC whose backend has not yet imported that block answers "unknown block" or "header not found".
  That peer then fails the binding step without any 429, exactly like `d9798e4c`.
- Source cannot tell this apart from a 429 without the per-peer reasons (item E).

## 4. What is NOT the problem (source)

- **Duplicate binding or cache reads across processes:** none. Each process verifies per operation by design. Caching
  bindings across blocks would weaken the admin-migration check, so it is NOT proposed.
- **The 2afa renewal path:** it already caches the lead per lease, at most one authority read per 5 min.
- **Quorum/peer config:** 3 peers at quorum 2 is the strict-majority minimum. Adding a 4th peer would force quorum 3 (the
  strict-majority rule in `leaseRpcSet`), so it does not help. Lowering the quorum is excluded.

## 5. Smallest compatible fixes, ranked (proposals; no fix is claimed proven without a test)

**A. Refuse an unaffordable lease before signing or relaying** (client.mjs `run`, after `maxChargeWei`, before the relay
loop). Most benefit, smallest change.
- It uses the relay's own rule and the same `quote()` at `fees.effective`: `expectedCharge > r.balanceWei ||
  > r.maxPerOpWei || > pol.epochLeftWei`, which throws `LeaseRefusal("Unaffordable")`.
- No signature, no relay POST, no `findLanded`/`nonceOf`/`policy` re-rounds. It saves about 48+ requests per peer per
  unaffordable attempt, plus both relays' check reads.
- **Semantics:** the same refusal the relay gives, read at the host's verified block (≤ 2 blocks older than the relay's
  head). A top-up landing inside those ~4 s is seen next pass. Nothing is weakened; the relay still re-checks everything.

**B. Stop trying further relays after a definitive reserve-state refusal** (422 `Unaffordable`, `Paused`, `Blocked`,
`Disabled`, `LeaseLive`, `NotInRenewWindow`, `ClaimCooldown`, `EpochCapReached`, `EmptyReserve`: chain facts every relay
computes the same).
- Keep the `findLanded` / nonce re-check only for lost or ambiguous answers, never for a 422.
- This halves the relay rounds even when A misses a race.

**C. One bounded 429 retry per request inside `leaseRpcSet.request`**, plus memoizing `eth_chainId` per client (constant
per transport; re-verified on a mismatch). Agreement, freshness and timeouts are unchanged. This stops a single transient
429 from dropping a peer and saves about 10 % of head requests. The `rpc-budget-review` F1 pattern, applied here.

**D. Read the 7 binding reads sequentially per peer** (still concurrent ACROSS peers) inside the same per-member timeout.
Each origin's burst goes from 7 to 1, for about 1–2 s more latency inside the existing 10–15 s bound. The same idea as the
other worker's sequential-per-peer wallet bridge.

**E. Diagnostics only:** carry each peer's failure class (HTTP status / timeout / unknown block / mismatch) in the
authority errors (`cannot read …`, `did not agree …`), naming the provider host only. This is what would PROVE whether 429
or block lag dominates before D is chosen.

**F. Host-only, no bundle change (Windows; NOT applied: 2afa is frozen).** After a claim fails with `Unaffordable`, hold the
row for about 10 min in `scanHold` and in the tick's re-claim path. A top-up is then noticed up to 10 min late. This trims
Windows load immediately but is not shared with Linux. A is the shared fix.

**Migration impact:**
- A–E change `client/lease-executor-client.mjs` / `lease-executor-authority.mjs`, both inputs of the Windows
  `lease-gas-runtime.bundle.mjs` (manifest-pinned; one rebuilt control file beside 2afa's host and chain) and of the Linux
  measured image (`app/client/*`, plus `metal/guest/lease-gas-conduit.bundle.mjs`). So: a Windows bundle rebuild and swap,
  and a new Linux measured image with measurement.
- A and B are behaviour-compatible with every relay and contract (no protocol change).
- F is a host.mjs-only change, but it would need a new revision on top of 2afa.
- **Recommended order:** E plus A first (one small client change, provable with the existing anvil lease suites and one new
  Unaffordable case), then C/D if E's reasons show 429 bursts or block lag.

## 6. Not done / limits

- No tests, no builds, no live reads.
- The request counts are source arithmetic, not traffic. The per-peer failure causes are unknown (item E).
- Linux installed `deabf8f90` authority/client hashes are inferred from the composition manifest. The Linux lease-gas RPC
  list is unknown from public receipts.
- Funding the ten reserves remains the actual unblocker for the unaffordable apps. A to F only remove avoidable load that
  also hurts the funded ones.
