# nucbox-k11 stopped serving apps — 2026-09-23 / 24

> **RESOLVED 2026-09-24 18:02 UTC.** Steven authorised funding from the agent wallet. 0.002 ETH sent
> from `0x29479Bf0…647C` to the operator key in tx
> `0x2d3202f73790d25a027fe8ad7514ba7d9f26215658556af6eb5848fc46bab120` (Base block 51741818). The node
> re-claimed all five deployments within 60 seconds with no intervention, and all five are running.
> The balance is smaller than the recommendation below: 0.002 ETH is about 1.5 days with all five
> leases live, longer as the small ones exhaust their USDC. See §9.

**Status at the time of writing (2026-09-24 16:20 UTC):** the box is attached, healthy and
answering; five deployments it was running are stopped; the single blocker is gas on its operator
key. Everything else about the box checks out.

**Root cause in one line:** the operator key that pays for this box's Base transactions ran out of
ETH, the five leases it held lapsed, and a lapsed lease can only be taken back by a `claim` — which
is a transaction the key cannot pay for.

This was **not** a security exclusion, and **not** a configuration or service failure. Both were
checked and both are ruled out below, because both were plausible and one of them was being
reported on the panel.

---

## 1. What stopped

| deployment | app | share | lease ended (UTC) | USDC balance | runway left |
|---|---|---|---|---|---|
| `0xe64f7cba` | catalog `0xa856a26b…/54` (RISC Box) | 35% | 2026-09-23 05:21:27 | $4.7770 | 265.4 h |
| `0x7ae476a3` | catalog `0x4306e588…/11` (s3-ipfs-adapter) | 2% | 2026-09-23 05:38:19 | $0.4046 | 112.4 h |
| `0xd9798e4c` | catalog `0x9afdfb40…/3` | 1% | 2026-09-23 05:38:23 | $0.1600 | 44.4 h |
| `0xa77d0c57` | catalog `0x550d4da9…/4` | 1% | 2026-09-23 05:38:27 | $0.1618 | 44.9 h |
| `0xa69dcbba` | catalog `0x5bca36b5…/0` | 1% | 2026-09-23 05:38:31 | $0.1618 | 44.9 h |

All five are `active`, `isPublic`, owned by `0x0b2d009c0c9Af05b12100D77F3c815fea822eE61`, and
`claimableBy(id, 0xd497d065…)` returns **true** for every one of them right now. The ledger would
let this box take them back today. Read from `EnclaveDeployments` at
`0xF9e71385C5cB49844F2457ba6567De0742f8B89a`, resolved through the address book.

The money side is fine: these leases are funded, and the ledger is willing.

## 2. Root cause

The operator key is `0x389C3f030a209D04D026228D2D053fEB75DbadcA` — read from the **registry**
(`EnclaveRegistry` `0x868eB7fc…CCAC`, `get(0xd497d065…)`), not from the box's own report, though the
two agree. Its balance:

```
241,586,700,503 wei  =  0.000000241587 ETH
```

The sequence:

1. Around 2026-09-22 19:53 UTC the key first failed a transaction with *"The total cost (gas \* gas
   fee + value) of executing this transaction exceeds the balance of the account."* The first to
   fail were proof-of-time checkpoints, which are the most frequent and most expensive thing this
   box sends.
2. The last successful on-chain heartbeat was 2026-09-23 06:04:41 UTC (the registry's own
   `lastSeen`). The last successful renewals were at 04:53 UTC.
3. The five leases ended between 05:21 and 05:38 UTC, 15 to 30 minutes later — one renewal cycle.
4. `renew` on a lapsed lease **reverts**: the ledger closes a lease on its own clock, and only
   `claim` starts a new one. So the box could not recover by renewing.
5. `claim` needs gas, and there is none.

The node also gates itself: `claimEnabled` is false because its own gas estimate
(`gasRenewalsLeft`) is 0, which is correct and is the behaviour we want. It is not a separate
fault.

## 3. What was ruled out

**A security exclusion is real, but it is not what stopped these apps.** The relay does not admit
this box for *market tenant compute*: `computeEligible` admits only a verified confidential attach
(`snp`), and this box attaches in `vbs` mode. That exclusion is correct and stays. But it is not
the cause here — the five deployments are the box owner's own apps, the box was claiming and
running them for days under that same exclusion, and the exclusion did not change on 09-23.

**The isolation-contract gate on `main` is not running on this box.** Commit `0e01901e`
(2026-09-23 17:38 -0700) added `meetsIsolationContract()` to `windows/node/host.mjs`, which is
hard-false on this build (`appTrafficInsideEnclave()` returns false, and the relay tier is
`vbs-dev`, not `vbs`). The **live** node predates it. Verified directly on the box:

```
C:\Users\claude\vbs\node\host.mjs   sha256 C7536E1345CD7A8D10204D76F53049276E683AC75895BFEBE868514C98B9A464
meetsIsolationContract   0 occurrences
appTrafficInsideEnclave  0 occurrences
contractGap              0 occurrences
gasRenewals              4 occurrences
```

`run-node.cmd` runs the local copy and does not pull from git, so a restart keeps this build.
**If this node is ever updated to current `main`, that gate becomes a second, independent blocker:**
`scope()` collapses to `owner-only`, and these five deployments belong to a different wallet than
the box's payout wallet, so it would refuse to take them at all. That is a product decision, not an
incident fix, and is left open below.

**No configuration or service failure.** The node task is Running; `ee-host`, `node` and
`shielded-worker` have been up since 2026-09-23 13:41 local; the enclave reports ABI 5 with
`enclave:app@0.1.0`, `wasi:http@0.2` and `wasi:cli@0.2`; 63.6 GB of enclave RAM free; the shielded
worker's proof is fresh; and inference answers end to end.

**Key placement is what the prose says — checked live, not trusted.** From the box's current
`/availability`:

```
apps.inTee          true          apps.traffic  "carried by the host"
appTls.terminatesIn "host-process"  appTls.keyIn "host-process"
session.keyIn       "host-process"
```

That is the accurate disclosure and it stays. Nothing in this repair moves a key, terminates app
TLS anywhere new, or opens tenant traffic.

## 4. The secondary defect this exposed, and the fix

With every lease lapsed and no gas, the node took the same five deployments off the ledger every
30 seconds and stopped them again: **18,767 takes and 18,761 stops** in 34 hours. The apps were not
actually restarting — `consider()` failed at the claim — but the only thing recorded against each
deployment was that `renew` had reverted with *"lease expired"*. True, and not the reason.

Fixed in `windows/node/host.mjs` (commit `8ab9f51c`):

- `claimGasBlock()` — a pure question ("can this box pay for a claim?") and the sentence to record
  when it cannot. It names the key, the chain, and what is *not* wrong.
- `consider()` asks it **before** `tracked.add`. Tracking a deployment it cannot claim is what
  brought it back round every tick.
- The ledger scan asks it before printing a take line, and `tick()` treats a lapsed lease as a
  lapse rather than a renewal that failed: no `renew` is sent to a lease the ledger has closed, and
  a stop is announced only when something was running.
- The reason is recorded every time and logged only when it changes.

This does not restore serving. It makes the box say what it is waiting for.

## 5. Panel honesty

`relay/fleet-status.mjs` (commit `11dd6c5f`) splits what was one word:

- `status` — `offline` / `online` / `serving`. A box the relay has not heard from is offline; one
  that is attached and answering but taking no tenant work is **online**, with the reason beside it.
- `ineligible` — still the relay's verdict, now derived from that box's own published facts (where
  app TLS terminates, where the app-zone and session keys live, the tier verified at attach) rather
  than one sentence about its mode. A box that fixes one property gets a shorter reason.
- `notClaiming` — the other half: a box can be admitted and still take nothing because it says it is
  not taking work. An empty operator key reads as exactly that.

`computeEligible` is unchanged. `vbs` is still not admitted for market tenant compute, and every
non-vbs reason is preserved word for word, including the Enclave Shield disclosure.

---

## 6. The gas top-up

**Recipient, verified against the live registry** (`EnclaveRegistry` `0x868eB7fc5B5A84B2FF082eafc9bf40b7AAc5CCAC`,
`get(0xd497d065ca395192db3630699dbc5a6418f2f028256212a4d9ab73288643fe1b)` → `operator`):

```
address   0x389C3f030a209D04D026228D2D053fEB75DbadcA
chain     Base mainnet, chainId 8453
type      plain EOA (eth_getCode = 0x), so a 21,000-gas transfer is all that is needed
balance   241,586,700,503 wei  (0.000000241587 ETH)
```

The registry entry is `active`, endpoint `https://api.enclave.host/t/nucbox-k11`, payout wallet
`0x29479Bf04ED889D46a7AfB7f292B9Bb26e12647C`, proof key `0x84f627aF…80f9`. Do not send to the payout
wallet or the proof key: neither pays for gas.

### Measured unit costs

At the current Base gas price of 6,000,000 wei (0.006 gwei), including the L1 data fee:

| transaction | gas | cost | how measured |
|---|---|---|---|
| `claim` | 112,724 | 0.000000677 ETH | receipt `0x1c195dab…` |
| `claim` (forced) | 165,698 | 0.000000995 ETH | receipt `0x438e92e1…` |
| `checkpoint` | 138,532 | 0.000000833 ETH | receipt `0x874c2820…` |
| `heartbeat` | 33,121 | ≈0.000000200 ETH | `eth_estimateGas` |
| `renew` | ≈60,000 | ≈0.000000361 ETH | the node's own calibration in `warnLowGas` |

### What it costs to run

Cadence: checkpoint every 5 min per live lease (`PROOF_MS`), renew every 30 min per lease,
heartbeat every 10 min for the box.

| leases live | per day |
|---|---|
| 5 | 0.001314 ETH |
| 2 | 0.000543 ETH |
| 1 | 0.000286 ETH |
| 0 (heartbeats only) | 0.000029 ETH |

Checkpoints are 91% of that. The five leases will not all stay live for long anyway: on their
current USDC balances, three exhaust in about 45 hours, a fourth in 4.7 days, and `0xe64f7cba` in
11 days. Taking that into account, **30 days of the current workload costs about 0.0063 ETH**. If
the apps are also topped up with USDC so all five run for 30 days, it is about 0.0394 ETH.

### Recommendation

**Send 0.01 ETH.** That is the minimum practical amount with a real buffer:

- pays all five `claim` transactions immediately (0.0000034 ETH total);
- clears the node's own gate — it re-enables claiming when `balance / 4e11 > 0`, and warns below
  200 renewals' worth (0.00008 ETH); 0.01 ETH is well clear of both;
- covers the five apps for their whole remaining USDC runway and the box for ~30 days after
  (~0.0063 ETH), leaving ~0.0037 ETH spare;
- leaves roughly 2.5x headroom if Base gas rises from today's unusually low 0.006 gwei.

Smaller and larger, if preferred: **0.005 ETH** covers the current runway with little margin;
**0.02 ETH** covers ~15 days even if every lease is re-funded and all five stay live.

### Wallet-ready unsigned transaction

A plain value transfer. Fees are left to the wallet (EIP-1559).

```json
{
  "chainId": 8453,
  "to": "0x389C3f030a209D04D026228D2D053fEB75DbadcA",
  "value": "0x2386f26fc10000",
  "data": "0x",
  "gas": "0x5208"
}
```

`value` is 10,000,000,000,000,000 wei = 0.01 ETH. For the alternatives:
`0x11c37937e08000` = 0.005 ETH, `0x470de4df820000` = 0.02 ETH.

**Signing and broadcasting is Steven's.** Nothing in this repo sends it, and no agent should. No
approvals, no swaps, no bridging, no change of node identity: a bare ETH transfer to the address
above is the whole action.

### What happens after the funds land

No intervention needed. Within one heartbeat interval (≤10 min) `warnLowGas` re-reads the balance
and `gasRenewalsLeft` goes positive; on the next 30-second tick the ledger scan claims all five
(the ledger already says `claimableBy` is true) and the apps start. Expected inside 11 minutes.

One rule was checked specifically, because it would have silently blocked this. All five
deployments were created *before* this box was listed on 2026-09-21 20:45 UTC — between 2026-08-11
and 2026-09-04 — and `claimPolicy` normally refuses a stranger's older deployment unless its owner
points at this box. The live node sets `CLAIM_LEGACY=1`, which waives exactly that rule, so the
scan will take them without an invitation. Do not clear that setting while recovering.

Verify with:

```
curl -s https://api.enclave.host/enclaves | jq '.enclaves[]|select(.name=="nucbox-k11")
  |{status,serving,eligible,notClaiming,claim:.availability.claimEnabled,gas:.availability.gasRenewalsLeft}'
```

and on the box, `C:\Users\claude\vbs\node\agent.log` should show `claimed 0x…` lines and then
`renewed 0x…` every 30 minutes, with no `ledger: taking` / `stopped` pairs.

---

## 7. Rolling out the relay change

Three commits on `windows/custom-vbs-like-hyperv`: `11dd6c5f` (fleet status), `8ab9f51c` (node gas
block), `2e480ae6` (relay deploy payload).

**What a merge to `main` deploys.** `.github/workflows/deploy.yml` diffs the push and runs only the
surfaces whose files changed. `relay/*` sets `relay=true`, which scps the relay bundle to the API
relay box (`nan`) and the data-plane relays and restarts `enclave-api-relay`. Nothing in these
commits matches `Dockerfile`, `supervisor.js`, `worker/*`, `mps-daemon/*`, `wasm/*`, `metal/*` or
`enclaves/*`, so `release` and `cpu_release` both stay false: **no measured release is cut and the
fleet is not repointed.** `windows/*`, `test/*` and `docs/*` match no case at all.

**Preflight.** `node --test` on `test/fleet-status.test.mjs` (9), `test/tenant-compute-eligibility.test.mjs`
(10), `test/api-relay.test.mjs` (24), `test/tunnel.test.mjs` (22), `test/pricing.test.mjs` (60),
`test/fleet-partial-capability.test.mjs` (5) and `test/windows-node-gas-block.test.mjs` (5), plus
the 21 `windows-node-*` suites and `tenant-lease`, `claim-open-for-us`, `claim-sweep`, `boxhost`.
All pass.

**Rollback.** `git revert 2e480ae6 11dd6c5f && git push origin main`. The relay job redeploys the
previous `api-relay.js` and restarts the unit; `fleet-status.mjs` is left on the box, unimported and
inert. Recovery time is one deploy run. If the relay will not start, `relay/deploy.sh` already fails
the run and prints the last 25 journal lines; the manual equivalent on `nan` is to restore the
previous `/opt/nan-relay/api-relay.js` and `systemctl restart enclave-api-relay`.

**Not deployed to the node.** `8ab9f51c` changes `windows/node/host.mjs`, which the live box runs
from a local copy under `C:\Users\claude\vbs\node\`. Nothing ships it automatically. Applying it
means copying the file and restarting the node task, which would not restore serving — gas is the
blocker — so it is left for a maintenance window.

## 8. Open decisions, not taken here

1. **Gas.** The top-up above. Steven's to sign.
2. **The isolation contract.** Current `main` will refuse these five deployments once this node is
   updated, because `appTrafficInsideEnclave()` is hard-false and the tier is `vbs-dev`. Either the
   app-zone TLS key and session key move inside the enclave and the tier becomes production-signed,
   or the node keeps running a build that predates the gate, or the gate gains an explicit
   owner-consented exception. Do not update the node until this is decided.
3. **Checkpoint cadence.** `PROOF_MS` is 5 minutes and the contract's window is 15. Checkpoints are
   91% of this box's gas. Moving to ~12 minutes would cut the running cost roughly in half and stay
   inside the window. It changes how earnings are proved, so it is a decision, not a repair.
4. **`AllowFirmwareLoadFromFile`.** Unrelated, still pending, still unapplied. Nothing here touches
   it.

---

## 9. Resolution, 2026-09-24

**Funded.** `0x29479Bf04ED889D46a7AfB7f292B9Bb26e12647C` (the agent wallet, which is also this box's
payout wallet) held 0.002186869 ETH — less than the 0.01 ETH recommended above, so 0.002 ETH was
sent and ~0.000187 ETH left behind for that wallet's own gas.

```
tx     0x2d3202f73790d25a027fe8ad7514ba7d9f26215658556af6eb5848fc46bab120
block  51741818   status success   fee 0.000000163 ETH
after  operator 0.001999522 ETH   agent wallet 0.000186707 ETH
```

The recipient was re-derived from `EnclaveRegistry.get()` inside the sending script rather than
retyped, and the script refused to send unless the entry was active, its endpoint was exactly
`https://api.enclave.host/t/nucbox-k11`, the address had no code, and the chain id was 8453.

**Recovery was automatic and took under a minute.** The ledger scan claimed all five between
18:03:13 and 18:03:41 UTC, each app loaded into the enclave, and leases now run to 18:33 UTC.

| deployment | claim tx | state |
|---|---|---|
| `0xe64f7cba` | `0x07d21a13…` | running; its RISC-V guest restores from a snapshot, so the gateway 502s for a few minutes after a cold claim |
| `0x7ae476a3` | (re-claimed) | running, HTTP 200 |
| `0xd9798e4c` | (re-claimed) | running, HTTP 200 |
| `0xa77d0c57` | `0xcc9223a8…` | running, HTTP 200 |
| `0xa69dcbba` | `0xcc551c0a…` | running, HTTP 200 |

**Two things this confirmed about the analysis above.** `CLAIM_LEGACY=1` did what §6 said it would:
all five predate the listing and were taken without an invitation. And the live build claims through
`consider()` without consulting `gasRenewalsLeft` — that flag only gates what the box *publishes* —
so the apps came back before the next heartbeat had even refreshed it.

**The retry loop is still there on the live build.** At 18:03:42, one second after `0xa69dcbba` was
claimed, the tick still logged "the lease expired and renew failed" against it from a stale read,
then reloaded it two seconds later. Harmless here, and exactly the path commit `8ab9f51c` rewrites.

**What 0.002 ETH buys**, at the measured costs in §6: about 1.5 days with all five leases live, ~3.7
days at two, ~7 days at one. Three of the five exhaust their USDC in about 44 hours anyway, so the
burn falls on its own. This is a reprieve, not a month — §6's sizing and the `PROOF_MS` question
both still stand.
