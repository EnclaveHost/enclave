# metal0 control image 7baabe2: read the lease from the chain before a cached expiry stops a guest

Status: **active on metal0 since 2026-11-15 00:39:18Z** (the operator ran `control-image.sh apply`); see "The run".
The new code path has not been exercised by a renewal that landed behind a relay error.

## Why: Enclave RPC was stopped on 2026-11-14 with a live lease

Times UTC. Ledger `EnclaveDeployments` `0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b` on Base, deployment
`0x5ff56a4d…454f`, events read from a public RPC (`eth_getLogs`):

| | block | transaction | |
|---|---|---|---|
| 21:45:02 | 57511635 | `0x8f2de0c2…` | Renewed, lease until 22:15:02 |
| 22:11:14 | 57519494 | `0x18beef7e…` | Renewed, lease until 22:41:14 |
| 22:18:22 | 57521636 | `0x03110e86…` | Released |
| 22:24:10 | 57523373 | `0x2d05aa7b…` | Claimed, lease until 22:54:10 |
| 22:29:37 | 57525008 | `0x83daf027…` | Released |
| 22:55:06 | | `0x8351fbcf…` | Claimed, lease until 23:25:06 |

metal0's journal for the same minutes:

- 22:11:14 the relay (`https://134.209.248.172`) answered 502 for the renewal; the supervisor logged "app-funded
  renew … not sent: no relay landed the renew". The transaction had landed in that second (second row above).
- 22:12:59, 22:13:00, 22:14:57 further renew attempts were refused by the reserve, correctly: "not yet inside the
  app's renew window" (the lease on chain ran until 22:41:14, the window opens 5 minutes before).
- 22:16:33 `[reaper] 0x5ff56a4d… lease over (not renewed) -> teardown`, on the cached 22:15:02. The guest had 24
  minutes and 41 seconds of paid lease left.
- 22:16:52 and 22:18:14 relaunches were refused: HTTP 409, "the bound disks are open in another process". The stop
  of the 48 GiB guest was not confirmed within 120 s (22:19:27 `[stop] … UNCONFIRMED`). The release landed 22:18:22;
  the next claim (22:24:10) could not launch for the same 409. That claim was released 22:29:37, and from 22:35:04 every claim was refused for the reserve's claim cooldown (30 minutes after
  this host's last sponsored claim, `contracts/EnclaveLeaseGasReserve.sol`).
- 22:55:06 claimed, 22:55:09 guest launching, 22:57:00 `https://5ff56a4d.app.enclave.host` answers 200. The app was
  away for 40 minutes. Ethereum was at head at 22:59; Base restarted from block 57521090 (the stop) and was at head
  at 23:21:21 (public Base is served from its providers while the guest lags). First renewal of the new lease
  23:21:02, until 23:51:01.

This is the failure `ops/lease-reaper-reconcile-20261028/` describes (relay 502 at 16:33:35, renewal landed
16:33:53, guest stopped 16:39:03 on 2026-10-28). Its fix is in main since e7ee6e34f and 822aa7cb8, and that record
says "source and tests only; no production rollout". metal0's control image is the deployed generation, not main's
`supervisor.js`, and never received it.

## What changes

`ops/lease-reaper-reconcile-20261028/production-supervisor.patch` applied to the supervisor of 66335ab, plus
main's `network/lease-expiry-reconcile.mjs`:

- before the reaper stops a guest on a cached expiry, it reads the deployment's row from two of the supervisor's
  RPC providers at one block (the second-highest head minus 2, at most 15 s old, 8 s deadline). When they agree that
  this host holds a later lease, the cached expiry is raised and the guest stays;
- a renewal whose relay answer was a failure is no longer taken as "not renewed": the next renew attempt reads the
  row first;
- an unreadable chain extends nothing: with no agreeing read the reaper acts on the cached expiry as before
  (`[lease] … expiry reconciliation unavailable; no lease extension inferred`). A total RPC outage past the grace
  period can still stop an app.

Not changed: admission, claim and renew authorization, the app-funded gas path, the free-lease rule of 66335ab, the
snpVm paths.

Checked on the deployed generation (scratch clone, commit 7baabe2 = 66335ab + this):

- the patch written for the 2026-10-28 supervisor (sha256 01ac9cb1…f951) applies to today's (8f44ccea…5533) with
  line offsets only; result sha256 bfd8a1704f867b755f8850d1ceab426cf7d5f860124b331a52d2f533fc0a2ae4, `node --check`
  clean, every identifier the added lines use is declared in that file;
- `SUPERVISOR_JS=<that file> node --test test/lease-expiry-reconcile.test.mjs`: 20 pass, 0 fail (same on main);
- the reader, run read-only on 2026-11-14 22:48:45–22:49:08Z against the supervisor's default provider pool and the
  live ledger: 14 of 16 reads agreed, in 350–650 ms; 2 returned "no fresh agreeing lease quorum". A failed read is
  "unknown" for that tick; the reaper asks again at the next one.

## The image

`/home/steven/enclave-prod/dist-snpvm-7baabe2`

| | 66335ab (running) | 7baabe2 |
|---|---|---|
| initramfs sha256 | 1a6e0cf05e28fb983619df35e721f8455c84225e29852892076070b961679ae1 | 565013a883e18db4539f656e266a8ef9851e2933ee96e5d820e60145891e42c2 |
| launch measurement | 5d91b40202371dd8ece935953f2d353d8587eda0e9c87f1772858077c8d1f6fae21f26e65e8c0cace007342ef63a536a | 6fac97810228e0dfd3dee933cde28005ab9fe0383bc9ba109d85b1595e210a801f3b0e211ac928c360ab5e324731c19e |

Differences inside the initramfs, compared entry by entry (29,064 and 29,065 entries): `/app/supervisor.js`
(bfd8a170…2ae4), the added `/app/network/lease-expiry-reconcile.mjs` (b848f853…dee7, main's file), and the image's
own `/opt/metal/manifest.json`. Kernel and kernel command line are the same files; firmware as before.

Built in the scratch clone (6b054e6 export, b4446c3 snpVm, 16520ea quorum, 66335ab free lease, 7baabe2 this):

    python3 metal/overlay-control-image.py ~/enclave-prod/dist-leasegas-deabf8f90 ~/enclave-prod/dist-snpvm-7baabe2 HEAD

Measured with the command in `../control-image-66335ab/README.md`. The relay has not seen this measurement yet.

## Activating it

    ops/rpc-snp-prod-r7/control-image-7baabe2/control-image.sh apply
    ops/rpc-snp-prod-r7/control-image-7baabe2/control-image.sh rollback

`apply` is the script of 66335ab with two more conditions before the restart: the app answers 200, and the lease
in hand has at least 15 minutes left (otherwise it waits for the next renewal, up to 20 minutes). In order, stopping
at the first thing that is not as expected:

1. the image on disk is the recorded one (initramfs hash, `MEASUREMENT`);
2. the operator key can pay a registration (it held 9.35e-4 ETH at 22:58Z; a restart cost 5.0e-7 ETH on 11-13);
3. the app answers and its lease is long enough;
4. the relay's allowlist on the control VM gets the measurement (previous file kept as
   `linux-leasegas-measurements.env.before-snpvm-7baabe2`, relay restarted); 66335ab's measurement stays listed;
5. metal0's config (kept as `config.json.before-snpvm-7baabe2`) names the new image and `enclave-metal.service` is
   restarted; if the relay does not accept the new measurement within 5 minutes the previous image is put back;
6. it waits for the policy admission, the registration, the adoption of the running app, the free-lease line, and
   the next lease renewal (up to 35 minutes), then reports the app address and the key's balance.

The Enclave RPC guest is not restarted: the supervisor adopts the running VM by name, as on 2026-11-13 00:13Z.

The new code path runs only when a cached expiry passes; the restart itself does not exercise it. What the run can
show is that the supervisor starts with the new file, is accepted on the new measurement, and holds and renews the
lease as before.

## The run (2026-11-15, UTC)

The operator ran `apply`. From metal0's journal:

- 00:39:02 the lease of `0x5ff56a4d…` was renewed until 01:09:02 (the renewal the script waits for).
- 00:39:16-00:39:18 `enclave-metal.service` stopped and started with `dist-snpvm-7baabe2`.
- 00:39:33 "this host is ADMITTED: serving and taking work"; `attest ACCEPTED meas=6fac97810228e0df…`.
- 00:40:42-00:40:48 cron, depot and Enclave RPC adopted; the RPC guest "already running on this host" (not
  restarted). 00:45:30 the free-lease line for all three.
- 00:46:39 cron renewed through the relay.
- 00:59:32-01:03:31 renewals of Enclave RPC and depot were not sent: "lease-gas RPC quorum did not agree on account
  code" (three endpoints, quorum 2). After a failed renewal the supervisor asks the new reader before it tries
  again, and the reader answered "expiry reconciliation unavailable; no lease extension inferred" on the passes of
  01:01:33, 01:02:31, 01:03:31 and 01:04:30; such a pass sends no renewal. Two of the public endpoints in the
  supervisor's default pool (drpc, 1rpc) answered rate-limit errors to this host's address at 01:03.
  01:04:39 depot and 01:04:47 Enclave RPC renewed, until 01:34:38 and 01:34:46.
  Enclave RPC had 4 minutes 15 seconds of lease left. Asked from the host at 01:07, the three endpoints answered
  the same account code three times out of three; why they did not agree for five minutes is not established.
  The same refusal occurred under 66335ab on 11-13 and 11-14, one or two passes at a time.
- The app answered 200 at 01:02. The operator key held 9.34e-4 ETH at 01:06.

A cached expiry did not pass during the run, so the reader's "live" answer has not been seen in production. Its
"unavailable" answer has, before expiry: it extends nothing and stops nothing, and it holds back the retry of a
failed renewal for that pass.

## Not covered

- The relaunch after a teardown collided with the stopping guest (409, the bound disks open in another process),
  which spent a claim and brought the 30-minute claim cooldown. With this image the teardown that started it does
  not happen for a landed renewal; the collision itself is not fixed.
- Why the relay answered 502 for a renewal that landed (and again at 22:24:19) is not established.
- Other fleet hosts' control images are older generations and are not rebuilt here. The Windows node is a different
  supervisor.
- Renewals depend on two of three public endpoints agreeing in the same pass. Five minutes without agreement left
  4 minutes of lease on 2026-11-15; thirty would end the lease, and then the guest is stopped correctly.
