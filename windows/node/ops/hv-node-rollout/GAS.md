# The hv node's operator gas (read 2026-09-26 00:01:45Z, Base block 51795778)

The node signs its on-chain work (register/heartbeat, claim, renew, checkpoint) with the box's operator key. That is
the same key the retired legacy node used: `0x389C3f030a209D04D026228D2D053fEB75DbadcA`. The key file stays on the
box and is never copied off it. The legacy node ran this key dry on 09-22/23: its leases lapsed, `renew` on a lapsed
lease reverts, and the box churned 18,767 takes in 34 h (windows-vbs-node notes; the fix is in the node on main).

| wallet | balance | nonce (latest = pending) |
|---|---|---|
| operator `0x389C3f03…DbadcA` | **0.001456565 ETH** | 1893 = 1893 (nothing stuck) |
| agent wallet `0x29479Bf0…647C` (the payout wallet; it funded the 09-24 top-up) | 0.000171080 ETH | 325 = 325 |

Gas price at the read: 0.006 gwei.

**Measured costs at 0.006 gwei** (09-24 receipts):
- claim: 112,724 gas = 0.000000677 ETH;
- forced claim: 165,698 gas = 0.000000995 ETH;
- checkpoint: 138,532 gas = 0.000000833 ETH;
- heartbeat: ~33,121 gas = ~0.0000002 ETH;
- renew: ~0.00000036 ETH.

**Cadence:**
- heartbeat every 10 min;
- renew every 30 min per live lease;
- checkpoint every 5 min per live lease, but SKIPPED while the lease's rate is 0. Nothing is credited, and a
  deployment whose owner is the box's declared payout wallet is free self-hosting.

**What the owner-only hv node costs:**
- heartbeats: ~0.0000288 ETH/day;
- per rate-0 lease: renew ~0.0000173 ETH/day (no checkpoints);
- per charged lease: ~0.00024 ETH/day in checkpoints (this dominated the legacy node's bill: five leases, ~0.0013
  ETH/day, 91% checkpoints).

Which leases are charged: a lease is free (rate 0) only when the deployment's owner is the box's declared payout wallet
(`0x29479Bf0…`, free self-hosting). The served owners are the OPERATOR plus delegators (enclave-87's rule, ROLLOUT.md).
- ROLLOUT test 1's app is owned by the operator `0x389C…`, NOT the payout wallet, so it is CHARGED at the node's price
  (1% of 12 µUSDC/s → 1 µUSDC/s) and checkpointed every 5 min: ~0.00024 ETH/day, plus heartbeats about 0.00027 ETH/day
  in all. **0.001457 ETH covers about 5 days** of test 1; stop it once it has passed.
- A deployment owned by the payout wallet (test 2's agent-wallet deployment, via its delegation) is rate 0: renewals
  only, about 0.00005 ETH/day with heartbeats.

**What's needed:**
- no top-up to START: the preflight requires ≥ 0.0005 ETH, and the node publishes `claimEnabled:false` below its own
  `gasRenewalsLeft` floor, so it never takes a lease it can't renew;
- for the soak, a month of margin is ~0.0015 ETH with rate-0 leases only, or ~0.008 ETH while one charged lease (test
  1) runs. The agent wallet holds only 0.000171 ETH, so the ETH has to come from Steven (a Base transfer to
  `0x389C3f030a209D04D026228D2D053fEB75DbadcA`). No top-up is part of this procedure;
- monitoring: acceptance check R3 (hvnode-accept-remote.sh) reads the balance and the pending-vs-latest nonce, and the
  box's A4 checks `gasRenewalsLeft`. Under 0.0003 ETH, alert Steven.
