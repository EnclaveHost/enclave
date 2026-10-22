# Ten queued apps: SMALL-BUDGET unsigned lease-reserve proposal (0.0001 ETH each, 0.001 ETH total) (RESULT, 2026-10-22, updated 23:39Z: bridge --state READY)

**Status: PROPOSAL ONLY.** The user chooses and signs.
- No wallet, signing, broadcast, nonce, intent, credential, SSH or production action. No server or UI started.
- Root owns `--prepare`, `--serve` and the approval.
- **Bridge `--state` is READY** (23:39Z, block 52961491, 2 of 3 agreeing, `canPrepare: true`) with per-origin request serialization (below).
- The 0.01 ETH review (`../queued-funding-review/`) and root's `root-queued-recovery-20261022` are untouched.

## Verdict

1. **The 0.001 ETH batch is affordable from the admin's actual balance.**
   - The admin `0x0b2d009c0c9Af05b12100D77F3c815fea822eE61` holds **1,853,872,178,228,523 wei (≈ 0.001854 ETH)**.
   - It needs value 1,000,000,000,000,000 + L2 fee 4,613,616,000,000 + L1 fee bound 9,704,334,215 =
     **1,004,623,320,334,215 wei** (likely), or **1,120,000,000,000,000** under the bridge's 1.2e14 fee allowance. Both fit.
   - Real `eth_call` from the admin with value 0.001 ETH (**no override**), on all three RPCs (mainnet.base.org,
     publicnode, polkachu), at the evidence block AND at latest: **10/10 deposits `success: true`**.
   - `eth_estimateGas`: **768,936** on all three.
2. **Runway is short.** After the deposit each reserve holds about **72–73 current renew quotes** (renew quote
   1,381,847,540,910 wei at block 52961219).
   - That is roughly 1.5 days at one renew per 30-minute lease.
   - It is **not guaranteed** for any fee or duration: quotes rise with gas price and L1 fees, and claims cost more
     (claim quote 2,282,239,371,703 wei).
   - This is a short bridge, **not perpetual free gas**. A further top-up will be needed.
3. **The bridge's own fresh check is READY.**
   - Run: `serve-small.mjs --state` at 23:39Z (queue 256, `logs/state-4.out`).
   - Result: `verdict: ready`, `canPrepare: true`, block **52961491** (`0x37ce3916…c149`), **2 of 3** agreeing
     (publicnode + polkachu), no blocking or unreadable intent, no journal created.
   - Facts: sender balance 1,853,872,178,228,523, total 1e15, Multicall3 `d5c15df6…0891`.
   - Its call-data sha256 `026ff9b9…d5d7` is **byte-identical** to the simulated proposal below.
   - **What made it ready:** the two earlier `--state` runs were `unavailable` (`logs/state-1`, `state-3`).
     mainnet.base.org rejects concurrent bursts from this IP (sequential requests pass: `logs/probe-basorg.mjs`, 20/20),
     and publicnode answered 429.
   - `serve-small.mjs` now injects the QuorumChain's peers (`clients`) built by `serial-fetch.mjs`:
     - viem http, `retryCount: 0`, 12 s, over the reviewed `boundedFetch` (byte cap, `redirect: 'error'`, its own deadline);
     - wrapped so each RPC origin runs ONE request at a time, in order;
     - a failed request releases the next; a request aborted while queued is never sent.
   - The shared `QuorumChain` code is unchanged: the same 3 RPCs, quorum 2, the same block, 2 confirmations, 120 s
     freshness. So are the code-hash, owner, balance and no-broadcast rules.
4. **Funding is necessary, not sufficient** (see *Remaining gates*).

## The proposal (all 10 rows; owners verified)

Fresh reads, both with all successful hosts identical:
- **Phase A** (owners, provenance, live labels, quotes, balance): block **52961219**, polkachu + publicnode;
  mainnet.base.org failed and is not counted.
- **Evidence** from the REVIEWED `collect-evidence.mjs`: block **52961234**, `0x4554e144…2dff7`, **2026-10-22T23:30:15Z**,
  polkachu + publicnode. **23 s old** when the proposal was built (limit 600 s). It is **stale after 23:40:15Z**; the
  bridge re-reads at prepare and before the wallet request anyway.

Checks:
- Multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11` code re-read = **`0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891`**.
- Reserve and ledger code are pinned; `paused = false`.
- Every row: active, enabled under its current owner, not blocked.
- **Owners:**
  - 9 are the admin EOA.
  - `0x59f1273d` is the admin's SessionVault `0xB794C4DD0e1C5E6B72281799F282BfdE7654345D`: factory
    `0x1F5c887c…9C9C` `vaultFor(admin)` = the vault, `vault.owner()` = admin, and the code is an EIP-1167 clone.
  - They are identical to root's `root-queued-recovery-20261022/manifest.json`. Nobody unrelated is credited.

| # | app (live catalog) | id | credited owner | reserve now (wei) | deposit | after ≈ renew quotes |
|---|---|---|---|---|---|---|
| 0 | Jot 1.0.4 | `0xa77d0c57…8371` | admin EOA | 1,171,161,869,710 | 0.0001 ETH | 73 |
| 1 | IPNS Publisher 1.0.5 | `0xd9798e4c…bb9a` | admin EOA | 1,016,277,190,539 | 0.0001 ETH | 73 |
| 2 | RISC Box 0.6.69 | `0xe64f7cba…569b` | admin EOA | 1,017,666,736,286 | 0.0001 ETH | 73 |
| 3 | API MCP Adapter 1.0.0 | `0xa69dcbba…ed77` | admin EOA | 812,572,514,527 | 0.0001 ETH | 72 |
| 4 | Sia S3 0.1.8 | `0xef514ed3…b238` | admin EOA | 359,879,005,798 | 0.0001 ETH | 72 |
| 5 | Cron 1.0.3 | `0x38f368d6…215c` | admin EOA | 216,033,940,371 | 0.0001 ETH | 72 |
| 6 | Depot 0.1.5 | `0xc13d4b6a…7681` | admin EOA | 1,242,671,026,630 | 0.0001 ETH | 73 |
| 7 | EnclaveDNS 0.1.5 | `0x59f1273d…778c` | admin's SessionVault `0xB794…345D` | 1,364,175,002,269 | 0.0001 ETH | 73 |
| 8 | Image Generator 1.1.16 | `0xda09d0f2…68d9` | admin EOA | 1,225,205,548,185 | 0.0001 ETH | 73 |
| 9 | EyesOff AI 1.0.85 | `0x9eb4e600…871c` | admin EOA | 462,360,721,036 | 0.0001 ETH | 72 |

- All 10 leases are expired and below one claim quote today.
- The adapter `0x7ae476a3` stays excluded: its own deposit is confirmed, and the generator refuses it.

**Exact call** (`batch-proposal.json`, `call-inventory.json`). ONE unsigned transaction:
- **To:** Multicall3, `aggregate3Value` (`0x174dea71`).
- **Value:** **1,000,000,000,000,000 wei (0.001 ETH)**.
- **Data:** sha256 `026ff9b9a7398aae3ac0aa2f62a6c0fbbc36f32fcb999c0638c577551346d5d7`, keccak
  `0xb51be0cc4af00548dd53762a47d4f6ae76231b91585e8b534ef415b1d6c32456`.
- **Calls:** 10, each: target reserve `0x12A3f873041Dec436DaA0085B766a399A6fA3639`, **allowFailure false**, value
  **100,000,000,000,000**, `deposit(bytes32)` of the row's id, in the order above. All-or-nothing.
- Nothing else: no approval, withdrawal, configure, ownership, catalog or admin call.

**Cost:**
- Gas 768,936 × (base 5,000,000 + priority 1,000,000) = **4,613,616,000,000 wei** L2.
- Plus the L1 data-fee upper bound **9,704,334,215 wei** (`getL1FeeUpperBound(2728)`, two RPCs agree).
- **≈ 0.0000046 ETH.** The bridge's fee ceiling is gasCap 1.2M × 0.1 gwei = 1.2e14.
- **Total ≈ 1,004,623,320,334,215 wei (≈ 0.0010046 ETH); balance after ≈ 849,248,857,894,308 wei (≈ 0.000849 ETH).**
- **Time:** Base 2 s blocks; the bridge waits for 2 confirmations.

## What changed (isolated fixed-budget variant; `variant.diff`, 60 changed lines)

| file | from (reviewed, unchanged) | the only differences |
|---|---|---|
| `batch-topup-small.mjs` | `batch-topup-review/batch-topup.mjs` aee7bd99 | `AMOUNT_WEI = 1e14` (was 1e15), its refusal text, a header |
| `batch-plan-small.mjs` | `root-queued-recovery-20261022/batch-plan.mjs` 2cae0c98 | the work-root path, the generator import (the small one), a header |
| `serve-small.mjs` | `root-queued-recovery-20261022/serve.mjs` c5b1feda | paths, the small plan, port **39693**, one more refusal (below), the injected serialized peers (above), corrected usage comments |
| `serial-fetch.mjs` | NEW (27 lines) | `serializeFetch` (one request per origin at a time) and `serialPeers` (viem clients over the reviewed `boundedFetch`) |
| `manifest.json` | — | the same 10 ids and owners as root's manifest, `amountWei` "100000000000000", live labels |

Everything else is identical and reused unchanged:
- the 600 s freshness;
- the 2-distinct-host agreement;
- the pinned reserve and ledger code;
- the root-supplied Multicall3 hash;
- owner, active, enabled, blocked and paused;
- the exact total;
- the `verifyProposal` decode;
- the receipt-proved "done";
- the "never paid twice" rule (the same `PLAN_PREFIX`);
- the bridge, page and QuorumChain code (only its peers are injected).
- The small-plan comments now say 0.0001 ETH per row, matching the code (`AMOUNT_WEI = 1e14`).

**Added refusal:** `serve-small.mjs` refuses if the 0.01 ETH package's journal (`root-queued-recovery-20261022/journal`)
holds ANY batch-plan intent, and it also scans that journal for unresolved intents. So the two batches are never both
paid. The plan id is `queued-recovery-batch-topup-20261022-4ce53f7e74391c60`.

## Tests (`run-tests.sh`: private network namespace, `timeout 240`; queue 256)

**10/10 pass** (`logs/test-1.out`, peak 146 MiB; re-run on the final comment-corrected bytes: `logs/test-2.out`). The 7 root batch-plan tests are ported with small amounts:
- ready: one call, 10 deposits, 0.001 ETH;
- wrong amount, adapter, duplicate and wrong total refused before any read;
- owner changed, unknown, inactive, paused, blocked, disabled, Multicall3 code, stale and low balance all block;
- quorum outvoting;
- tampered allowFailure, value, target and double pay refused;
- done only with a receipt-proved 10 deposits;
- the bridge offers no prepare when done.

Plus 3 small-budget cases:
- the 0.001-ETH rows (root's manifest), a 0.01 ETH total and one mixed row are refused; the reviewed 0.01 generator
  still refuses 0.0001 rows;
- `ready` at the admin's exact balance 1,853,872,178,228,523 wei, and blocked at 1.1e15;
- a proposal carrying 0.001 rows or a 0.01 total is refused by the small verifier.

**Serializer tests** (`run-serial-tests.sh`: private network namespace, `timeout 120`; queue 256): **5/5 pass**
(`logs/serial-2.out`, peak 157 MiB). They cover:
- concurrency max 1 and arrival order;
- a rejected request releases the next; a request aborted while queued is never sent;
- `boundedFetch`'s byte cap, `redirect: 'error'` and own deadline signal are retained; a 429 through the viem client is
  exactly one request (no retry);
- the REAL `QuorumChain` over serialized peers: max 1 in flight per peer, 2 of 3 agree with one peer rate-limited, at
  block head−2;
- disagreement: no two agreeing peers still raises `no 2 RPCs agreed`, and two failing peers still raise
  `quorum unavailable`.

`logs/serial-1` failed on a defect in my test fake (`r.params[0]` on a no-params method), not in the code; it was fixed
in the test.

**Live read-only runs** (queue 512 for the reviewer, 256 for `--state`):
- `logs/review-1`, `review-2`: refused, phase-A quorum failed (rate limits);
- `logs/review-3`: OK;
- `logs/l1fee-1`;
- `logs/state-1`, `state-3`: bridge `unavailable` before serialization;
- **`logs/state-4`: READY** (after serialization; `state.json`).

## Root commands (after the user chooses this option; from `work/resume-after-checkpoint-20261022/queued-funding-small`)

```
node serve-small.mjs --multicall3-codehash 0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891 --expect-total-wei 1000000000000000 --state     # the "--check": must say ready
node serve-small.mjs --multicall3-codehash 0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891 --expect-total-wei 1000000000000000 --prepare   # ONE journaled intent; nothing sent
node serve-small.mjs --multicall3-codehash 0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891 --expect-total-wei 1000000000000000 --serve     # 127.0.0.1:39693, URL in local-url.txt
```

- Use the 0.01 ETH package OR this one, never both; the refusal above enforces it.
- `--state` answered **ready** at 23:39Z. Root's `--prepare` re-checks fresh, and creates its one intent only if still ready.
- After inclusion, the page shows done only on a receipt proving 10 `Deposited(id, owner, Multicall3, 1e14)`.

## Remaining gates (funding alone does not fix the apps)

- **Re-claim:** every lease is expired, so each host must claim again after inclusion. A claim costs ≈ 2.28e12, about
  1.6 renew quotes of the ~72.
- **Publisher:** the seq-0 startup hazard applies (`ens-public-site-20261021/publisher/recovery-plan.txt`).
- **Release status: fixed and deployed by root.** The final relay ad074e24 (module `93d543e6` → **`48cf67ee`**) was
  **DEPLOYED_VERIFIED at 2026-10-22T23:30:28Z** (`relay-release-live/deployment-result-r2.json`, 0 guest restarts).
  - All ten of these apps' public release status is `listed: true`.
  - The four owned IDs that were missing and are now listed: `0xef514ed3…b238` (Sia S3), `0x38f368d6…215c` (Cron),
    `0xc13d4b6a…7681` (Depot), `0x59f1273d…778c` (EnclaveDNS).
- **Not proven by this review:** host/VM re-admission, placement, host wallet policy quorum, and release/config
  resolution.
- **Runway:** about 1.5 days at today's quote; the next top-up must follow soon.
- **Owner-change window:** an owner change between the last recheck and inclusion would credit the new owner. This is
  unchanged from the original review.

## Files (sha256)

| file | sha256 |
|---|---|
| `batch-topup-small.mjs` | `824f20d5097becba1e2cca04a92d1b70370e9a6e24bdf5557efc37a1d8fb64ed` |
| `batch-plan-small.mjs` | `f0908a9864c7b7c933687398060307817eb2d025ab9da2faee2f595e72a7ec7c` |
| `serve-small.mjs` | `44a9333c35c7144b2f53874b28a9b549876b8c19ca889b9b4237f8e4cbf01bca` |
| `manifest.json` | `b7606a5e3228ba26b41bd846c8f60c9e6bf1583dfcf826f456dcb00b780d1857` |
| `test/batch-plan-small.test.mjs` | `de7996c24faabd13433ff7a6a5e0c95bdbc88edbfc0f4d1e7b049e1811fc351f` |
| `run-tests.sh` | `6b78b361286519816b3edaddc4a64cad201db095ad61f00358f82df3e111ed40` |
| `review-small.mjs` (read-only reviewer; serialized per-endpoint reads) | `49d7f2986f0b9e83c18738b362a4974b1c8b15741a6e33856b7ea79c64b4a824` |
| `l1fee.mjs` | `2776d063118e64c35a795d02bc143a49fb094b15e78f0095610e4963aff7f81e` |
| `variant.diff` | `ac0644b4ebbbe79394fa56c2ceaa1907413409c2723b6d8e9fc818e545a7f208` |
| `batch-evidence.json` | `4eaccbb331e99dbc570f70a444eaf2bdaf39604d4dea63d5226b45ec338df161` |
| `batch-proposal.json` | `7d41c668b600f400618e0fe4f115212fc1c339180ee72398d212ed42d8610b06` |
| `call-inventory.json` | `88aac59d3a3846380292a8cba7ce769e7a916f9be7493560ebb8145b3dbd0617` |
| `simulation.json` (actual balance, no override) | `136ecfdbc27cd3b74cc3aeb56b6f3162fb9cee436b8b4a29efe613b0d47f7a4e` |
| `phase-a-reads.json` | `c44c1a3920bf4b542c4d9e663210860f1efd13268795c957c9cb2d91f4c93893` |
| `summary.json` | `cf01b4bf56242348def051e2835c5b44ced41bf61174afc078c3a964100c5a27` |
| `l1-fee.json` | `6114f4af8bb6e4f3a18d00118fa8c8742a337ddedeb78a364a0d01be47ec8477` |
| `state.json` (bridge `--state` **READY**, block 52961491) | `f05999abbf9db0156a3c72f13b0ceb2c6d4f7468ee4f5b2e0b54769d1c730880` |
| `serial-fetch.mjs` | `76dce40475e9ca38a4b9f2623f7c334659a18e54b3248d6626ca78a57a286004` |
| `test/serial-fetch.test.mjs` | `bda72e34065460aea9bf55c63cd5b1016ba0390f9fbcea9824b7ce8b70454ae8` |
| `run-serial-tests.sh` | `54e5467d94db8443a5d4e0f68e893dc621e1a33d4f588f130475aefceffb8ca3` |
