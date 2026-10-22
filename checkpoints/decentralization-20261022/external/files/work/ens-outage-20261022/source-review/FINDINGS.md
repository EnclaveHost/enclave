# ENS outage 2026-10-22: source diagnosis (Claude, read-only; no production calls, no tests needed)

## Verdict
The outage cause is app-funded lease-gas reserve exhaustion on nucbox for deployment 0x7ae476a3 (s3-ipfs-adapter).
It is not `_media`, and not a host-runtime code bug. metal0's `_media` refusal is incidental. The adapter is
placement-pinned to nucbox, so no Linux box could claim it anyway.

## Evidence chain
1. Enrollment (work/lease-enrollment-signing/journals/op-07, op-08, both `confirmed`, 2026-10-20 ~23:43Z): reserve
   0x12a3f873…3639, `deposit(0x7ae476a3…)` = **1e14 wei (0.0001 ETH)**. Configure: self-hosted claimPolicy,
   maxPerOpWei 3.109e13, epochCapWei 3.109e14, epochSec 3600, renewWindow 300, minExtension 600, claimCooldown 1800,
   maxGasPrice 0.05 gwei, 4 claims/epoch. All 11 deployments (ops 01–23) got the identical 1e14 deposit.
2. Measured app-funded renew charges (windows-local-relay-postcutover/evidence/union-summary.json) are 1.13–1.46e12 wei.
   7ae476a3 has the highest, 1.462e12. At about 2 renews/h plus claims, 1e14 wei lasts roughly 30 h. The time from
   23:43Z 10-20 to 04:26Z 10-22 is 28.7 h. The per-op and epoch caps are 20–200× one charge, so they can't bind.
   Balance is the only limit that can.
3. Relay refusal source: client/lease-executor-client.mjs:271 `checkRelayRequest` returns `Unaffordable` when
   `expectedCharge > balanceWei || > maxPerOpWei || > epochLeftWei`. `expectedCharge` is the upper `quote()`
   (EST_GAS.renew 230k × effective fee + the L1 bound). The contract `_check` reports `EmptyReserve` only at
   balance 0, so a non-zero balance below one quote gives exactly the observed 422 from both relays (04:26:17, 04:29:01).
4. Deployed host (control-package/files/windows/node, host.mjs 9634cb40): renew lead = `renewWindow-15` = 285 s
   (`renewLeadMs`), and every attempt was refused. The 04:30:19 try came after leaseUntil 04:30:11 → `LeaseExpired`, so
   the domain stopped at 04:30:22. That is host.mjs:2238, correct per the "this host's ETH is never used" doctrine.
   Since then the claim retries fail. Their reason is stored in `/v1/host/state` deployments[].**reason** (the
   receipts read `error`/`lastError`, which are null). Expect an app-funded claim `Unaffordable` (EST_GAS.claim 380k > renew).

## `_media`: incidental, not the cause
- The on-chain envelope (ledger17-migration/snapshots/52841816.json and 52842154.json, record 27; it predates the rev-17
  import, which copied it verbatim) = `{network:{relay:"us-west"}, isolation:{cpuTee:false,gpuTee:false},
  placement:{hostId:0x2fcef48d…}, config:{…$PLACEHOLDER secrets…, wasi:"0.2", _media:{thumbnail,thumbnailSvg,banner,bannerSvg}}}`.
  The override config is the version config copied whole, routing keys included (wasi, _media).
- `placement.hostId 0x2fcef48d…` = nucbox's runner (control-package helper/runs/params-…f12f68.json). Pinned, so
  fallback is disabled. claimPolicy self-hosted also limits sponsorship to a runner whose payoutWallet is the owner.
- Linux supervisor.js:11489–11494 calls `parseDepOptions` (throws on `_media` at :2254) **before**
  `placementRefusal`. metal0 therefore shows the `_media` reason and hides the real refusal ("Pinned to host
  0x2fcef48d…; fallback is disabled"). Without `_media` it would still refuse, and the reserve would refuse its claim too.
- Windows `parseEnvelope` (chain.mjs:488) accepts `config` without checking reserved keys. node-bridge.mjs:72 strips
  `_media` before the app sees it. That is a pre-existing lenient parity gap. Site, CLI, relay MCP and secrets-release
  all refuse `_media` in an override. Do NOT weaken the Linux check. Leave Windows alone during the incident.
- Optional, owner-signed, NOT needed for recovery: a `setConfig` that drops `config._media` (and `config.wasi`)
  from the envelope. Only worthwhile if Linux failover is ever wanted, which also needs the placement pin removed.

## Actionable recovery (root/owner; one signed tx per reserve, no config or secret change)
- **Owner/user-authorized `deposit(bytes32 id)` on reserve 0x12a3f873041dec436daa0085b766a399a6fa3639** (selector
  0xb214faa5, payable, *anyone may pay*, credits the current owner's reserve). This touches no envelope, signed config,
  secret or catalog admin authority. Example: 0.001 ETH ≈ 700 renews ≈ 2 weeks at today's charges. The amount is the owner's call.
- **Fleet-wide urgency:** the other 10 reserves got the same 1e14 at the same time with charges of 1.1–1.4e12, so they
  are hours from the same failure. That includes d9798e4c (publisher) and 59f1273d (EnclaveDNS upstream). Run
  `RPC=<one base rpc> node work/ens-outage-20261022/source-review/reserve-runway.mjs` (read-only; reserveOf + quote
  only; syntax-checked and import-resolved offline, never executed against a chain) and top up every row whose
  `approxHoursLeft` is small, before its next renew window.
- After the 7ae476a3 deposit, nucbox re-claims on its own: the scan hold is 120 s. The claim gates that still apply
  are self-hosted payoutWallet == owner, ≤4 claims/epoch, and claimCooldown 1800 s from this operator's last
  sponsored claim (`lastClaimAt` in reserveOf). The relaunch then needs a fresh TLS cert for the adapter host. Watch the
  LE exact-set limit (5 per 168 h) seen in earlier relaunches.

## Code changes
None made, because no host-runtime defect caused this. Optional follow-ups for later (not incident work):
(a) supervisor.js: evaluate `placementRefusal` before `parseDepOptions` so a pinned-elsewhere row reports the pin.
(b) A low-reserve warning in renewal: log or record when `reserveOf.balanceWei < N × quote(renew)` before the window,
    so exhaustion isn't first seen at the last renew.
